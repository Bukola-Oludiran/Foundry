//! Serde types mirroring `Foundry/ir/schema.json`. Parsing is lenient (unknown fields
//! ignored) — the JSON Schema is the strict author-facing guard; `compile` enforces the
//! load-bearing integrity rules.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ir {
    #[serde(default)]
    pub version: Option<u32>,
    pub spec: Spec,
    pub root: String,
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub requirements: Vec<Requirement>,
    #[serde(default)]
    pub scenarios: Vec<Scenario>,
    #[serde(default)]
    pub deployment: Option<Deployment>,
    #[serde(default, rename = "stateModels")]
    pub state_models: Vec<StateModel>,
    #[serde(default)]
    pub layouts: Vec<ViewLayout>,
    #[serde(default)]
    pub research: Vec<ResearchNote>,
    #[serde(default)]
    pub delivery: Option<DeliveryProfile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Architecture {
    Product(ProductArchitectureV5),
    Legacy(Ir),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductArchitectureV5 {
    pub version: u32,
    pub product: ProductNode,
    #[serde(default)] pub requirements: Vec<Requirement>,
    #[serde(default)] pub scenarios: Vec<Scenario>,
    #[serde(default)] pub deployment: Option<Deployment>,
    #[serde(default, rename = "stateModels")] pub state_models: Vec<StateModel>,
    #[serde(default)] pub layouts: Vec<ViewLayout>,
    #[serde(default)] pub research: Vec<ResearchNote>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductNode {
    pub id: String,
    pub kind: ProductNodeKind,
    pub mandate: ProductMandate,
    #[serde(default)] pub contracts: Vec<ProductContract>,
    #[serde(default)] pub constraints: Vec<ProductConstraint>,
    #[serde(default)] pub acceptance: Vec<AcceptanceScenario>,
    #[serde(default, rename = "capabilityRefs")] pub capability_refs: Vec<CapabilityRef>,
    #[serde(default)] pub deliverables: Vec<ProductDeliverable>,
    #[serde(default)] pub supersedes: Option<String>,
    #[serde(default)] pub implementation: Option<ProductImplementation>,
    #[serde(default)] pub children: Vec<ProductNode>,
    #[serde(default)] pub dependencies: Vec<ScopedDependency>,
    #[serde(default, rename = "dependencyExceptions")] pub dependency_exceptions: Vec<DependencyException>,
    #[serde(default)] pub allocations: Vec<RequirementAllocation>,
    #[serde(default)] pub integration: Option<ProductIntegration>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProductNodeKind { Leaf, Composite }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductMandate { pub outcome: String, #[serde(default, rename = "requirementIds")] pub requirement_ids: Vec<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductContract {
    pub id: String,
    pub name: String,
    #[serde(default)] pub operations: Vec<Operation>,
    #[serde(default)] pub types: Vec<TypeDef>,
    #[serde(default)] pub visibility: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductConstraint { pub id: String, pub kind: String, pub value: Value, #[serde(default)] pub mode: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilityRef { pub id: String, pub version: String, #[serde(default)] pub config: BTreeMap<String, Value> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductDeliverable {
    #[serde(rename = "deliverableId")] pub deliverable_id: String,
    pub kind: String,
    #[serde(rename = "capabilityRef")] pub capability_ref: CapabilityRef,
    #[serde(default, rename = "inputArtifacts")] pub input_artifacts: Vec<ArtifactInput>,
    #[serde(default)] pub required: bool,
    #[serde(default)] pub output: Option<ArtifactOutput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactInput { pub node: String, #[serde(rename = "artifactId")] pub artifact_id: String }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactOutput { #[serde(rename = "artifactId")] pub artifact_id: String, #[serde(rename = "mediaType")] pub media_type: String, #[serde(default, rename = "maxBytes")] pub max_bytes: Option<u64> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductImplementation { pub targets: Vec<Target>, #[serde(default, rename = "primaryTargetId")] pub primary_target_id: Option<String>, #[serde(default)] pub entrypoint: Option<String> }

impl ProductImplementation {
    pub fn primary_target(&self) -> String { self.primary_target_id.as_ref().and_then(|id| self.targets.iter().find(|target| &target.target_id == id)).or_else(|| self.targets.first()).map(|target| target.path.clone()).unwrap_or_default() }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductIntegration { #[serde(default)] pub scenarios: Vec<AcceptanceScenario>, #[serde(default, rename = "capabilityRefs")] pub capability_refs: Vec<CapabilityRef>, #[serde(default)] pub glue: Option<ProductImplementation> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScopedDependency { pub provider: String, pub consumer: String, #[serde(rename = "contractId")] pub contract_id: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DependencyException { #[serde(rename = "providerPath")] pub provider_path: String, #[serde(rename = "consumerPath")] pub consumer_path: String, #[serde(rename = "contractId")] pub contract_id: String, pub reason: String, #[serde(rename = "responsibleOwnerPath")] pub responsible_owner_path: String, #[serde(default, rename = "reviewId")] pub review_id: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequirementAllocation { #[serde(rename = "requirementId")] pub requirement_id: String, #[serde(default)] pub targets: Vec<AllocationTarget>, #[serde(default, rename = "integrationScenarioIds")] pub integration_scenario_ids: Vec<String> }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllocationTarget { pub node: String, pub responsibility: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryProfile {
    pub profile: String,
    #[serde(rename = "integrationNode")] pub integration_node: String,
    pub runtime: DeliveryRuntime,
    #[serde(rename = "sourceRoot")] pub source_root: String,
    #[serde(rename = "distributionName")] pub distribution_name: String,
    #[serde(rename = "publicModule")] pub public_module: String,
    #[serde(rename = "dependencyPolicy")] pub dependency_policy: String,
    #[serde(rename = "metadataTargetId")] pub metadata_target_id: String,
    #[serde(rename = "readmeTargetId")] pub readme_target_id: String,
    #[serde(default, rename = "lockfileTargetId")] pub lockfile_target_id: Option<String>,
    #[serde(default, rename = "serviceEntrypointTargetId")] pub service_entrypoint_target_id: Option<String>,
    #[serde(default)] pub entrypoint: Option<ServiceEntrypoint>,
    #[serde(default, rename = "healthRoute")] pub health_route: Option<String>,
    #[serde(default)] pub persistence: Option<ServicePersistence>,
    #[serde(default, rename = "migrationOperationId")] pub migration_operation_id: Option<String>,
    #[serde(default, rename = "readinessOperationId")] pub readiness_operation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceEntrypoint { pub module: String, pub symbol: String }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServicePersistence { pub engine: String, #[serde(rename = "schemaVersion")] pub schema_version: u32 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryRuntime { pub language: String, #[serde(rename = "versionRange")] pub version_range: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Requirement { pub id: String, pub kind: String, pub text: String, #[serde(default)] pub priority: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scenario { pub id: String, pub name: String, #[serde(default)] pub critical: bool, pub steps: Vec<ScenarioStep> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScenarioStep { pub from: String, pub to: String, pub message: String, pub order: u32 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Deployment { pub nodes: Vec<DeploymentNode>, pub links: Vec<DeploymentLink> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentNode { pub id: String, pub name: String, pub kind: String, #[serde(default)] pub hosts: Vec<String>, #[serde(default)] pub boundary: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeploymentLink { pub from: String, pub to: String, #[serde(default)] pub protocol: Option<String>, #[serde(default)] pub label: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateModel { pub id: String, pub subject: String, pub initial: String, pub states: Vec<String>, pub transitions: Vec<StateTransition> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateTransition { pub from: String, pub to: String, pub event: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewLayout { #[serde(rename = "viewId")] pub view_id: String, pub positions: BTreeMap<String, LayoutBox> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutBox { pub x: f64, pub y: f64, #[serde(default)] pub width: Option<f64>, #[serde(default)] pub height: Option<f64> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchNote { pub claim: String, pub source: String, #[serde(rename = "accessedAt")] pub accessed_at: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Spec {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Leaf,
    Integrator,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub kind: Kind,
    pub owner: Option<String>,
    #[serde(deserialize_with = "deserialize_interface")]
    pub provides: Interface,
    #[serde(default)]
    pub requires: Vec<InterfaceRef>,
    pub implementation: Implementation,
    pub acceptance: TestBundle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Interface {
    pub name: String,
    pub operations: Vec<Operation>,
    #[serde(default)]
    pub types: Vec<TypeDef>,
}

fn deserialize_interface<'de, D>(deserializer: D) -> Result<Interface, D::Error>
where D: serde::Deserializer<'de> {
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::String(name) => Ok(Interface { operations: vec![Operation { name: name.clone(), signature: name.clone(), description: Some("Normalized from legacy string interface".into()), properties: Vec::new(), parameters: Vec::new(), returns: None, http: None }], name, types: Vec::new() }),
        other => serde_json::from_value(other).map_err(serde::de::Error::custom),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Operation {
    pub name: String,
    pub signature: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub properties: Vec<String>,
    #[serde(default)]
    pub parameters: Vec<OperationParameter>,
    #[serde(default)]
    pub returns: Option<String>,
    #[serde(default)]
    pub http: Option<HttpOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationParameter { pub name: String, #[serde(rename = "type")] pub type_name: String }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpOperation { pub method: String, pub path: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TypeDef {
    pub name: String,
    pub definition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InterfaceRef {
    pub node: String,
    pub interface: String,
}

/// Lenient union of leaf + integrator implementation shapes; `compile` enforces which
/// fields must be present for each `Kind`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Implementation {
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub write_target: String,
    #[serde(default)]
    pub targets: Vec<Target>,
    #[serde(default, rename = "primaryTargetId")]
    pub primary_target_id: Option<String>,
    #[serde(default)]
    pub entrypoint: Option<String>,
    #[serde(default)]
    pub children: Option<Vec<String>>,
    #[serde(default)]
    pub composition: Option<String>,
}

impl Implementation {
    pub fn primary_target(&self) -> String {
        self.primary_target_id.as_ref().and_then(|id| self.targets.iter().find(|target| &target.target_id == id)).or_else(|| self.targets.first()).map(|target| target.path.clone()).unwrap_or_else(|| self.write_target.clone())
    }
    pub fn all_targets(&self, node_id: &str) -> Vec<Target> { if self.targets.is_empty() { vec![Target { target_id: node_id.to_string(), path: self.write_target.clone(), media_type: "text/plain".into(), role: "source".into() }] } else { self.targets.clone() } }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Target { #[serde(rename = "targetId")] pub target_id: String, pub path: String, #[serde(rename = "mediaType")] pub media_type: String, pub role: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestBundle {
    pub mandate_owner: String,
    pub language: String,
    pub cases: Vec<TestCase>,
    #[serde(default)]
    pub scenarios: Vec<AcceptanceScenario>,
    #[serde(default)]
    pub properties: Vec<String>,
    #[serde(default)]
    pub perf: Option<Perf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcceptanceScenario { pub id: String, pub name: String, #[serde(default)] pub covers: Vec<String>, pub steps: Vec<AcceptanceStep> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcceptanceStep {
    pub id: String,
    pub operation: String,
    #[serde(default)] pub receiver: Option<String>,
    #[serde(default)] pub arguments: Vec<Value>,
    #[serde(default)] pub bind: Option<String>,
    #[serde(default)] pub expect: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestCase {
    pub name: String,
    #[serde(default)]
    pub call: Option<String>,
    #[serde(default)]
    pub expect: Option<Value>,
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub covers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Perf {
    #[serde(default)]
    pub time_ms: Option<u64>,
    #[serde(default)]
    pub mem_mb: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::Ir;

    #[test]
    fn normalizes_legacy_string_interfaces() {
        let mut value: serde_json::Value = serde_json::from_str(include_str!("../../../../ir/examples/string-utils.ir.json")).unwrap();
        value["nodes"][0]["provides"] = serde_json::Value::String("LegacyApi".into());
        let ir: Ir = serde_json::from_value(value).unwrap();
        assert_eq!(ir.nodes[0].provides.name, "LegacyApi");
        assert_eq!(ir.nodes[0].provides.operations[0].signature, "LegacyApi");
    }
}
