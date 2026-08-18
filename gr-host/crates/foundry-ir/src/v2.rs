//! Strict Foundry IR v2 wire types.
//!
//! IR v1 remains represented by [`crate::Ir`]. `IrDocument` is the explicit
//! compatibility boundary: callers must choose the matching compiler and may
//! never silently reinterpret one version as the other.

use crate::types::Spec;
use crate::Node;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const IR_V2_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum IrDocument {
    V1(crate::Ir),
    V2(IrV2),
}

impl IrDocument {
    pub fn version(&self) -> u32 {
        match self {
            Self::V1(ir) => ir.ir_version,
            Self::V2(ir) => ir.ir_version,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IrV2 {
    pub ir_version: u32,
    pub spec: Spec,
    pub root: String,
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub package_roots: Vec<PackageRootV2>,
    #[serde(default)]
    pub packages: Vec<PackageDependencyV2>,
    #[serde(default)]
    pub resources: Vec<ResourceDeclV2>,
    #[serde(default)]
    pub resource_bindings: Vec<ResourceBindingV2>,
    #[serde(default)]
    pub integrations: Vec<IntegrationDeclV2>,
    #[serde(default)]
    pub integration_bindings: Vec<IntegrationBindingV2>,
    #[serde(default)]
    pub secret_refs: Vec<SecretRefV2>,
    #[serde(default)]
    pub test_environments: Vec<TestEnvironmentV2>,
}

impl IrV2 {
    pub fn v1_core(&self) -> crate::Ir {
        crate::Ir {
            ir_version: 1,
            spec: self.spec.clone(),
            root: self.root.clone(),
            nodes: self.nodes.clone(),
        }
    }
}

pub fn ir_v2_digest(ir: &IrV2) -> String {
    let bytes = serde_json::to_vec(ir).expect("serializing IR v2 is infallible");
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PackageEcosystemV2 {
    Npm,
    Pypi,
    Go,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageScopeV2 {
    Runtime,
    Build,
    Development,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackageRootV2 {
    pub id: String,
    pub language: String,
    pub manifest_path: String,
    pub lockfile_path: String,
    pub resolver: ResolverConfigurationV2,
    #[serde(default)]
    pub workspace_members: Vec<String>,
    #[serde(default)]
    pub registry_allowlist: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolverConfigurationV2 {
    pub mode: ResolverModeV2,
    #[serde(default)]
    pub allow_prereleases: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolverModeV2 {
    Locked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackageDependencyV2 {
    pub id: String,
    pub ecosystem: PackageEcosystemV2,
    pub name: String,
    pub version: String,
    pub integrity: String,
    pub scope: PackageScopeV2,
    pub owner_node: String,
    pub package_root: String,
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default)]
    pub extras: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKindV2 {
    Postgresql,
    Redis,
    S3,
    Nats,
    Smtp,
    Oidc,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceDeclV2 {
    pub id: String,
    pub kind: ResourceKindV2,
    pub version: String,
    #[serde(default)]
    pub configuration: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration_owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration_path: Option<String>,
    #[serde(default)]
    pub require_repeatable_migrations: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourcePermissionV2 {
    Read,
    Write,
    Publish,
    Consume,
    Admin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceBindingV2 {
    pub resource: String,
    pub node: String,
    pub permissions: Vec<ResourcePermissionV2>,
    #[serde(default)]
    pub environment: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationKindV2 {
    Http,
    Webhook,
    Stripe,
    Openai,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntegrationDeclV2 {
    pub id: String,
    pub kind: IntegrationKindV2,
    pub operations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_path: Option<String>,
    #[serde(default)]
    pub sensitive_fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetryPolicyV2 {
    pub max_attempts: u32,
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RateLimitV2 {
    pub requests: u32,
    pub per_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntegrationBindingV2 {
    pub integration: String,
    pub node: String,
    pub operations: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
    pub timeout_ms: u64,
    pub retry: RetryPolicyV2,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit: Option<RateLimitV2>,
    pub idempotency: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretProviderV2 {
    Environment,
    WorkloadIdentity,
    Operator,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecretRefV2 {
    pub id: String,
    pub provider: SecretProviderV2,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DatabaseSeedV2 {
    pub resource: String,
    pub fixture: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntegrationExpectationV2 {
    pub integration: String,
    pub operation: String,
    pub request: Value,
    pub response: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TestEnvironmentV2 {
    pub node: String,
    #[serde(default)]
    pub resources: Vec<String>,
    #[serde(default)]
    pub integrations: Vec<String>,
    #[serde(default)]
    pub fixtures: BTreeMap<String, Value>,
    #[serde(default)]
    pub database_seeds: Vec<DatabaseSeedV2>,
    #[serde(default)]
    pub integration_expectations: Vec<IntegrationExpectationV2>,
    #[serde(default)]
    pub verify_migrations: Vec<String>,
}
