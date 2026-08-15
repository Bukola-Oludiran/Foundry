use std::path::Path;

use foundry_ir::{compile, validate_architecture_request, ArchitectureRequest, Ir};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::http::http_post_json;

const MAX_ARCHITECT_ATTEMPTS: u32 = 3;

pub trait ArchitectureAgent {
    fn propose(
        &self,
        request: &ArchitectureRequest,
        attempt: u32,
        diagnostics: &[String],
    ) -> Result<(Value, String), String>;
}

pub struct WorkerArchitectureAgent<'a> {
    pub base: &'a str,
    pub token: &'a str,
}

impl ArchitectureAgent for WorkerArchitectureAgent<'_> {
    fn propose(
        &self,
        request: &ArchitectureRequest,
        attempt: u32,
        diagnostics: &[String],
    ) -> Result<(Value, String), String> {
        let digest = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!({
                    "request": request,
                    "attempt": attempt,
                    "diagnostics": diagnostics,
                }))
                .map_err(|error| error.to_string())?
            )
        );
        let response = http_post_json(
            self.base,
            "/architect",
            &json!({
                "protocol_version": 1,
                "job_id": format!("architect-{digest}"),
                "attempt": attempt,
                "diagnostics": diagnostics,
                "request": request,
            }),
            self.token,
        )?;
        let proposal = response
            .get("proposal")
            .cloned()
            .ok_or_else(|| "architecture worker omitted proposal".to_string())?;
        let rationale = response
            .get("rationale")
            .and_then(Value::as_str)
            .ok_or_else(|| "architecture worker omitted rationale".to_string())?
            .to_owned();
        Ok((proposal, rationale))
    }
}

pub fn architect(
    agent: &dyn ArchitectureAgent,
    request: &ArchitectureRequest,
    output: &Path,
) -> Result<Ir, String> {
    if let Err(errors) = validate_architecture_request(request) {
        return Err(errors
            .into_iter()
            .map(|error| error.to_string())
            .collect::<Vec<_>>()
            .join("\n"));
    }
    let mut diagnostics = Vec::new();
    for attempt in 1..=MAX_ARCHITECT_ATTEMPTS {
        let (proposal, rationale) = agent.propose(request, attempt, &diagnostics)?;
        match serde_json::from_value::<Ir>(proposal) {
            Ok(ir) => {
                let disallowed: Vec<_> = ir
                    .nodes
                    .iter()
                    .filter_map(|node| {
                        node.implementation
                            .language
                            .as_ref()
                            .or(ir.spec.language.as_ref())
                            .filter(|language| !request.allowed_languages.contains(language))
                            .map(|language| {
                                format!("node `{}` uses disallowed language `{language}`", node.id)
                            })
                    })
                    .collect();
                if !disallowed.is_empty() {
                    diagnostics = disallowed;
                    continue;
                }
                match compile(&ir) {
                    Ok(_) => {
                        let encoded = serde_json::to_vec_pretty(&ir).map_err(|e| e.to_string())?;
                        std::fs::write(output, encoded).map_err(|error| error.to_string())?;
                        let rationale_path = output.with_extension(format!(
                            "{}.rationale.md",
                            output
                                .extension()
                                .and_then(|value| value.to_str())
                                .unwrap_or("ir")
                        ));
                        std::fs::write(rationale_path, rationale)
                            .map_err(|error| error.to_string())?;
                        return Ok(ir);
                    }
                    Err(errors) => {
                        diagnostics = errors.into_iter().map(|error| error.to_string()).collect();
                    }
                }
            }
            Err(error) => diagnostics = vec![format!("IR JSON contract violation: {error}")],
        }
    }
    Err(format!(
        "architecture remained invalid after {MAX_ARCHITECT_ATTEMPTS} attempts:\n{}",
        diagnostics.join("\n")
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct RepairingAgent {
        proposals: Mutex<Vec<Value>>,
    }

    impl ArchitectureAgent for RepairingAgent {
        fn propose(
            &self,
            _request: &ArchitectureRequest,
            _attempt: u32,
            diagnostics: &[String],
        ) -> Result<(Value, String), String> {
            let mut proposals = self.proposals.lock().map_err(|e| e.to_string())?;
            if proposals.len() == 1 && diagnostics.is_empty() {
                return Err("repair loop failed to feed diagnostics back".into());
            }
            Ok((proposals.remove(0), "bounded rationale".into()))
        }
    }

    #[test]
    fn invalid_proposal_is_repaired_before_output() {
        let example = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../ir/examples/string-utils.ir.json");
        let valid: Value = serde_json::from_slice(&std::fs::read(example).unwrap()).unwrap();
        let agent = RepairingAgent {
            proposals: Mutex::new(vec![json!({"ir_version": 99}), valid]),
        };
        let request = ArchitectureRequest {
            architecture_version: 1,
            product_spec: "string utilities".into(),
            repository: ".".into(),
            base_revision: "HEAD".into(),
            allowed_languages: vec!["python".into()],
            policy_constraints: Vec::new(),
            existing_ir: None,
        };
        let output =
            std::env::temp_dir().join(format!("foundry-architecture-{}.json", std::process::id()));
        let built = architect(&agent, &request, &output).unwrap();
        assert_eq!(built.ir_version, 1);
        assert!(output.is_file());
        let _ = std::fs::remove_file(&output);
        let _ = std::fs::remove_file(output.with_extension("json.rationale.md"));
    }
}
