//! Serde types mirroring `Foundry/ir/schema.json`. Unknown fields are rejected so the
//! host cannot accidentally accept an IR dialect that the author-facing schema rejects.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ir {
    pub ir_version: u32,
    pub spec: Spec,
    pub root: String,
    pub nodes: Vec<Node>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
pub struct Node {
    pub id: String,
    pub kind: Kind,
    pub owner: Option<String>,
    pub provides: Interface,
    #[serde(default)]
    pub requires: Vec<InterfaceRef>,
    pub implementation: Implementation,
    pub acceptance: TestBundle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Interface {
    pub name: String,
    pub operations: Vec<Operation>,
    #[serde(default)]
    pub types: Vec<TypeDef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub name: String,
    pub signature: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub properties: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TypeDef {
    pub name: String,
    pub definition: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InterfaceRef {
    pub node: String,
    pub interface: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Implementation {
    #[serde(default)]
    pub language: Option<String>,
    pub write_target: String,
    #[serde(default)]
    pub entrypoint: Option<String>,
    #[serde(default)]
    pub children: Option<Vec<String>>,
    #[serde(default)]
    pub composition: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestBundle {
    pub mandate_owner: String,
    pub language: String,
    pub cases: Vec<TestCase>,
    #[serde(default)]
    pub properties: Vec<String>,
    #[serde(default)]
    pub perf: Option<Perf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestCase {
    pub name: String,
    #[serde(default)]
    pub call: Option<String>,
    #[serde(default)]
    pub expect: Option<Value>,
    #[serde(default)]
    pub harness: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Perf {
    #[serde(default)]
    pub time_ms: Option<u64>,
    #[serde(default)]
    pub mem_mb: Option<u64>,
}
