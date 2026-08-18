//! Credential-free local and deployment-neutral resource manifests for IR v2.

use crate::v2::IrV2;
use crate::{compile_v2, plan_test_environment, CompileV2Error, EnvironmentPlanV1};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const GENERATED_RESOURCES_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecretBindingManifestV1 {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeploymentResourceManifestV1 {
    pub manifest_version: u32,
    pub ir_digest: String,
    pub environment_plan: EnvironmentPlanV1,
    pub resource_environment: BTreeMap<String, BTreeMap<String, String>>,
    pub integration_secret_refs: BTreeMap<String, String>,
    pub secrets: Vec<SecretBindingManifestV1>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedResourceFilesV1 {
    pub manifest: DeploymentResourceManifestV1,
    pub compose: String,
}

fn image_variable(key: &str) -> String {
    format!(
        "FOUNDRY_RESOURCE_IMAGE_{}",
        key.chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() {
                    character.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect::<String>()
    )
}

fn compose(plan: &EnvironmentPlanV1) -> String {
    let mut output = String::from("services:\n");
    for resource in &plan.resources {
        let image = image_variable(&resource.image_key);
        output.push_str(&format!(
            "  {}:\n    image: \"${{{image}:?set {image} to a digest-pinned image}}\"\n    networks:\n      foundry-integration:\n        aliases: [{}]\n    read_only: true\n    cap_drop: [ALL]\n    security_opt: [no-new-privileges:true]\n    tmpfs: [/tmp]\n",
            resource.resource_id, resource.private_alias
        ));
    }
    for integration in &plan.integrations {
        output.push_str(&format!(
            "  emulator-{}:\n    image: \"${{FOUNDRY_EMULATOR_IMAGE:?set FOUNDRY_EMULATOR_IMAGE to a digest-pinned image}}\"\n    command: [\"serve\", \"--integration\", \"{}\"]\n    networks:\n      foundry-integration:\n        aliases: [{}]\n    read_only: true\n    cap_drop: [ALL]\n    security_opt: [no-new-privileges:true]\n    tmpfs: [/tmp]\n",
            integration.integration_id,
            integration.integration_id,
            integration.private_alias
        ));
    }
    output.push_str("networks:\n  foundry-integration:\n    internal: true\n");
    output
}

pub fn generate_resource_files(ir: &IrV2) -> Result<GeneratedResourceFilesV1, Vec<CompileV2Error>> {
    compile_v2(ir)?;
    let environment_plan = plan_test_environment(ir)?;
    let resource_environment = ir
        .resource_bindings
        .iter()
        .map(|binding| {
            (
                format!("{}:{}", binding.node, binding.resource),
                binding.environment.clone(),
            )
        })
        .collect();
    let integration_secret_refs = ir
        .integration_bindings
        .iter()
        .filter_map(|binding| {
            binding.secret_ref.as_ref().map(|secret| {
                (
                    format!("{}:{}", binding.node, binding.integration),
                    secret.clone(),
                )
            })
        })
        .collect();
    let mut secrets = ir
        .secret_refs
        .iter()
        .map(|secret| SecretBindingManifestV1 {
            id: secret.id.clone(),
            provider: serde_json::to_value(&secret.provider)
                .expect("secret provider serializes")
                .as_str()
                .expect("secret provider is a string")
                .to_owned(),
            name: secret.name.clone(),
            version: secret.version.clone(),
        })
        .collect::<Vec<_>>();
    secrets.sort_by(|left, right| left.id.cmp(&right.id));
    let manifest = DeploymentResourceManifestV1 {
        manifest_version: GENERATED_RESOURCES_VERSION,
        ir_digest: environment_plan.ir_digest.clone(),
        environment_plan: environment_plan.clone(),
        resource_environment,
        integration_secret_refs,
        secrets,
    };
    Ok(GeneratedResourceFilesV1 {
        manifest,
        compose: compose(&environment_plan),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_files_are_internal_and_credential_free() {
        let ir: IrV2 = serde_json::from_str(include_str!(
            "../../../../ir/examples/service-stack.ir-v2.json"
        ))
        .unwrap();
        let generated = generate_resource_files(&ir).unwrap();
        assert!(generated.compose.contains("internal: true"));
        assert!(!generated.compose.contains("ports:"));
        assert!(!generated.compose.contains("password"));
        assert!(generated
            .compose
            .contains("FOUNDRY_RESOURCE_IMAGE_POSTGRESQL"));
        let manifest = serde_json::to_string(&generated.manifest).unwrap();
        assert!(manifest.contains("stripe-key"));
        assert!(!manifest.contains("sk-"));
        assert!(!manifest.contains("localhost"));
    }
}
