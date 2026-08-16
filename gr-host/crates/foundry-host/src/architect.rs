use std::path::Path;

use foundry_ir::{
    compile, validate_architecture_request, validate_revision, ArchitectureRequest,
    ArchitectureRevisionRequest, Ir, StructuralDiff,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::agent_runtime::{AgentJobRequestV1, AgentRoleV1, AgentRuntime};
use crate::http::http_post_json;

// Compiler repair is deliberately separate from the three architect/critic
// collaboration rounds in Studio. A complex but otherwise sound ownership
// tree often needs more than one mechanical compiler correction before it is
// ready for independent review.
const MAX_COMPILER_REPAIR_ATTEMPTS: u32 = 5;
const IR_SCHEMA: &str = include_str!("../../../../ir/schema.json");

pub trait ArchitectureAgent {
    fn propose(
        &self,
        request: &ArchitectureRequest,
        attempt: u32,
        diagnostics: &[String],
    ) -> Result<(Value, String), String>;

    fn report_diagnostics(&self, _attempt: u32, _diagnostics: &[String]) {}
}

pub struct WorkerArchitectureAgent<'a> {
    pub base: &'a str,
    pub token: &'a str,
}

/// Architecture agent backed by a provider-neutral runtime.
pub struct RuntimeArchitectureAgent<'a> {
    pub runtime: &'a dyn AgentRuntime,
    pub run_id: &'a str,
    pub conversation_id: Option<&'a str>,
    pub event_sink: Option<&'a (dyn Fn(Value) + Send + Sync)>,
}

fn architecture_job_id(run_id: &str, request: &Value) -> Result<String, String> {
    let digest_input = json!({"run_id": run_id, "request": request});
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&digest_input).map_err(|error| error.to_string())?)
    );
    Ok(format!("architect-{digest}"))
}

impl ArchitectureAgent for RuntimeArchitectureAgent<'_> {
    fn propose(
        &self,
        request: &ArchitectureRequest,
        attempt: u32,
        diagnostics: &[String],
    ) -> Result<(Value, String), String> {
        let request_value = json!({
            "request": request,
            "attempt": attempt,
            "diagnostics": diagnostics,
        });
        let job_id = architecture_job_id(self.run_id, &request_value)?;
        let job = AgentJobRequestV1::new(
            &job_id,
            self.run_id,
            AgentRoleV1::Architect,
            "architect",
            json!({
                "protocol_version": 1,
                "job_id": job_id,
                "attempt": attempt,
                "diagnostics": diagnostics,
                "request": request,
                "proposal_schema": serde_json::from_str::<Value>(IR_SCHEMA)
                    .map_err(|error| format!("embedded IR schema is invalid: {error}"))?,
            }),
        )
        .with_conversation_id(self.conversation_id);
        let response = match self.event_sink {
            Some(event_sink) => self.runtime.execute_with_events(&job, event_sink),
            None => self.runtime.execute(&job),
        }?;
        if let Some(question) = response.get("question") {
            let question_id = question
                .get("question_id")
                .and_then(Value::as_str)
                .ok_or_else(|| "architecture question omitted question_id".to_string())?;
            let prompt = question
                .get("prompt")
                .and_then(Value::as_str)
                .ok_or_else(|| "architecture question omitted prompt".to_string())?;
            return Err(format!(
                "ARCHITECT_QUESTION:{}",
                serde_json::to_string(&json!({
                    "question_id": question_id,
                    "prompt": prompt,
                }))
                .map_err(|error| error.to_string())?
            ));
        }
        let proposal = response
            .get("proposal")
            .cloned()
            .ok_or_else(|| "architecture runtime omitted proposal".to_string())?;
        let rationale = response
            .get("rationale")
            .and_then(Value::as_str)
            .ok_or_else(|| "architecture runtime omitted rationale".to_string())?
            .to_owned();
        Ok((proposal, rationale))
    }

    fn report_diagnostics(&self, attempt: u32, diagnostics: &[String]) {
        let Some(event_sink) = self.event_sink else {
            return;
        };
        let digest = Sha256::digest(
            serde_json::to_vec(&(self.run_id, attempt, diagnostics)).unwrap_or_default(),
        );
        event_sink(json!({
            "protocol_version": 2,
            "event_id": format!("compiler-{:x}", digest),
            "job_id": format!("{}:compiler", self.run_id),
            "kind": "compiler_diagnostics",
            "diagnostics": diagnostics,
        }));
    }
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
    let mut current_request = request.clone();
    for attempt in 1..=MAX_COMPILER_REPAIR_ATTEMPTS {
        let (proposal, rationale) = agent.propose(&current_request, attempt, &diagnostics)?;
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
                    current_request = compiler_repair_request(request, &ir, attempt);
                    agent.report_diagnostics(attempt, &diagnostics);
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
                        current_request = compiler_repair_request(request, &ir, attempt);
                        agent.report_diagnostics(attempt, &diagnostics);
                    }
                }
            }
            Err(error) => {
                diagnostics = vec![format!("IR JSON contract violation: {error}")];
                agent.report_diagnostics(attempt, &diagnostics);
            }
        }
    }
    Err(format!(
        "architecture remained invalid after {MAX_COMPILER_REPAIR_ATTEMPTS} attempts:\n{}",
        diagnostics.join("\n")
    ))
}

fn compiler_repair_request(
    original: &ArchitectureRequest,
    previous_candidate: &Ir,
    attempt: u32,
) -> ArchitectureRequest {
    let mut request = original.clone();
    request.existing_ir = Some(previous_candidate.clone());
    request.policy_constraints.push(format!(
        "Compiler repair continuity: this is repair attempt {attempt}. Treat existing_ir as the previous candidate, preserve all unaffected nodes, interfaces, acceptance mandates, and write scopes, and make the smallest complete-IR change that resolves every supplied diagnostic. Do not regenerate the architecture from scratch."
    ));
    request
}

pub fn revise(
    agent: &dyn ArchitectureAgent,
    accepted: &Ir,
    revision: &ArchitectureRevisionRequest,
    repository: &str,
    base_revision: &str,
    output: &Path,
) -> Result<(Ir, StructuralDiff), String> {
    let mut languages: Vec<String> = accepted
        .nodes
        .iter()
        .filter_map(|node| {
            node.implementation
                .language
                .clone()
                .or_else(|| accepted.spec.language.clone())
        })
        .collect();
    languages.sort();
    languages.dedup();
    let request = ArchitectureRequest {
        architecture_version: 1,
        product_spec: format!(
            "Revise ownership subtree `{}` because: {}",
            revision.target_node, revision.reason
        ),
        repository: repository.to_owned(),
        base_revision: base_revision.to_owned(),
        allowed_languages: languages,
        policy_constraints: vec![
            format!(
                "Preserve this exact boundary interface: {}",
                serde_json::to_string(&revision.boundary_interface).map_err(|e| e.to_string())?
            ),
            format!(
                "Failure history: {}",
                serde_json::to_string(&revision.failure_history).map_err(|e| e.to_string())?
            ),
            "Change only the compiler-calculated target blast radius".into(),
        ],
        existing_ir: Some(accepted.clone()),
    };
    let mut diagnostics = Vec::new();
    let mut current_request = request.clone();
    for attempt in 1..=MAX_COMPILER_REPAIR_ATTEMPTS {
        let (proposal, rationale) = agent.propose(&current_request, attempt, &diagnostics)?;
        let proposed: Ir = match serde_json::from_value(proposal) {
            Ok(ir) => ir,
            Err(error) => {
                diagnostics = vec![format!("IR JSON contract violation: {error}")];
                continue;
            }
        };
        match validate_revision(accepted, &proposed, revision) {
            Ok(diff) => {
                std::fs::write(
                    output,
                    serde_json::to_vec_pretty(&proposed).map_err(|e| e.to_string())?,
                )
                .map_err(|error| error.to_string())?;
                std::fs::write(
                    output.with_extension(format!(
                        "{}.rationale.md",
                        output
                            .extension()
                            .and_then(|value| value.to_str())
                            .unwrap_or("ir")
                    )),
                    rationale,
                )
                .map_err(|error| error.to_string())?;
                return Ok((proposed, diff));
            }
            Err(errors) => {
                diagnostics = errors.into_iter().map(|error| error.to_string()).collect();
                current_request = compiler_repair_request(&request, &proposed, attempt);
            }
        }
    }
    Err(format!(
        "revision remained invalid after {MAX_COMPILER_REPAIR_ATTEMPTS} attempts:\n{}",
        diagnostics.join("\n")
    ))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct RepairingAgent {
        proposals: Mutex<Vec<Value>>,
        saw_previous_candidate: Mutex<Vec<bool>>,
    }

    impl ArchitectureAgent for RepairingAgent {
        fn propose(
            &self,
            request: &ArchitectureRequest,
            _attempt: u32,
            diagnostics: &[String],
        ) -> Result<(Value, String), String> {
            self.saw_previous_candidate
                .lock()
                .map_err(|e| e.to_string())?
                .push(request.existing_ir.is_some());
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
            saw_previous_candidate: Mutex::new(Vec::new()),
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

    #[test]
    fn compiler_repair_receives_the_previous_candidate() {
        let example = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../ir/examples/string-utils.ir.json");
        let valid: Ir = serde_json::from_slice(&std::fs::read(example).unwrap()).unwrap();
        let mut invalid = valid.clone();
        invalid
            .nodes
            .iter_mut()
            .find(|node| node.id == "trim")
            .unwrap()
            .owner = Some("lowercase".into());
        let agent = RepairingAgent {
            proposals: Mutex::new(vec![
                serde_json::to_value(invalid).unwrap(),
                serde_json::to_value(valid).unwrap(),
            ]),
            saw_previous_candidate: Mutex::new(Vec::new()),
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
        let output = std::env::temp_dir().join(format!(
            "foundry-architecture-continuity-{}.json",
            std::process::id()
        ));

        architect(&agent, &request, &output).unwrap();

        assert_eq!(
            *agent.saw_previous_candidate.lock().unwrap(),
            vec![false, true]
        );
        let _ = std::fs::remove_file(&output);
        let _ = std::fs::remove_file(output.with_extension("json.rationale.md"));
    }

    #[test]
    fn runtime_job_identity_is_stable_within_a_run_and_distinct_across_runs() {
        let request = json!({"spec": "same"});
        let first = architecture_job_id("run-one", &request).unwrap();
        assert_eq!(first, architecture_job_id("run-one", &request).unwrap());
        assert_ne!(first, architecture_job_id("run-two", &request).unwrap());
    }

    #[test]
    fn out_of_scope_revision_is_repaired_before_output() {
        let example = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../ir/examples/string-utils.ir.json");
        let accepted: Ir = serde_json::from_slice(&std::fs::read(example).unwrap()).unwrap();
        let mut invalid = accepted.clone();
        invalid
            .nodes
            .iter_mut()
            .find(|node| node.id == "trim")
            .unwrap()
            .implementation
            .write_target = "src/out-of-scope.py".into();
        let mut valid = accepted.clone();
        valid
            .nodes
            .iter_mut()
            .find(|node| node.id == "hyphenate")
            .unwrap()
            .implementation
            .write_target = "src/hyphenate-v2.py".into();
        let target = accepted
            .nodes
            .iter()
            .find(|node| node.id == "hyphenate")
            .unwrap();
        let request = ArchitectureRevisionRequest {
            revision_version: 1,
            accepted_ir_revision: foundry_ir::ir_digest(&accepted),
            target_node: target.id.clone(),
            reason: "failed acceptance".into(),
            failure_history: vec!["collapse failed".into()],
            boundary_interface: target.provides.clone(),
        };
        let agent = RepairingAgent {
            proposals: Mutex::new(vec![
                serde_json::to_value(invalid).unwrap(),
                serde_json::to_value(valid).unwrap(),
            ]),
            saw_previous_candidate: Mutex::new(Vec::new()),
        };
        let output =
            std::env::temp_dir().join(format!("foundry-revision-{}.json", std::process::id()));
        let (_, diff) = revise(&agent, &accepted, &request, ".", "HEAD", &output).unwrap();
        assert_eq!(diff.replaced_nodes, ["hyphenate"]);
        let _ = std::fs::remove_file(&output);
        let _ = std::fs::remove_file(output.with_extension("json.rationale.md"));
    }
}
