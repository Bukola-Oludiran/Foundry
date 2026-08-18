//! Deterministic Architecture Studio edits for IR v2 external contracts.
//!
//! These commands replace complete, typed declaration sets. Proposal-head CAS
//! remains the service's responsibility; this module guarantees that a batch
//! either compiles as a complete IR v2 document or returns diagnostics without
//! advancing semantic state.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::compile_v2;
use crate::studio::{BoundaryLockScopeV1, BoundaryLockV1, StudioCommandErrorV1, StudioRationaleV1};
use crate::v2::{
    IntegrationBindingV2, IntegrationDeclV2, IrV2, PackageDependencyV2, PackageRootV2,
    ResourceBindingV2, ResourceDeclV2, SecretRefV2, TestEnvironmentV2,
};

const STUDIO_V2_COMMAND_VERSION: u32 = 2;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum StudioExternalOperationV2 {
    SetPackageRoots {
        package_roots: Vec<PackageRootV2>,
    },
    SetPackages {
        packages: Vec<PackageDependencyV2>,
    },
    SetResources {
        resources: Vec<ResourceDeclV2>,
    },
    SetResourceBindings {
        resource_bindings: Vec<ResourceBindingV2>,
    },
    SetIntegrations {
        integrations: Vec<IntegrationDeclV2>,
    },
    SetIntegrationBindings {
        integration_bindings: Vec<IntegrationBindingV2>,
    },
    SetSecretRefs {
        secret_refs: Vec<SecretRefV2>,
    },
    SetTestEnvironments {
        test_environments: Vec<TestEnvironmentV2>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudioExternalCommandV2 {
    pub command_version: u32,
    pub command_id: String,
    pub proposal_id: String,
    pub expected_head_digest: String,
    pub actor_pubkey: String,
    pub operations: Vec<StudioExternalOperationV2>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudioExternalCommandOutcomeV2 {
    pub ir: IrV2,
    pub semantic_digest: String,
    pub changed_nodes: Vec<String>,
    pub rebuild_nodes: Vec<String>,
}

pub fn studio_v2_semantic_digest(
    ir: &IrV2,
    rationale: &StudioRationaleV1,
    locks: &[BoundaryLockV1],
) -> String {
    let bytes = serde_json::to_vec(&(ir, rationale, locks))
        .expect("Studio IR v2 contracts always serialize");
    format!("{:x}", Sha256::digest(bytes))
}

fn operation_nodes(operation: &StudioExternalOperationV2) -> BTreeSet<&str> {
    match operation {
        StudioExternalOperationV2::SetPackageRoots { .. }
        | StudioExternalOperationV2::SetIntegrations { .. }
        | StudioExternalOperationV2::SetSecretRefs { .. } => BTreeSet::new(),
        StudioExternalOperationV2::SetPackages { packages } => packages
            .iter()
            .map(|item| item.owner_node.as_str())
            .collect(),
        StudioExternalOperationV2::SetResources { resources } => resources
            .iter()
            .filter_map(|item| item.migration_owner.as_deref())
            .collect(),
        StudioExternalOperationV2::SetResourceBindings { resource_bindings } => resource_bindings
            .iter()
            .map(|item| item.node.as_str())
            .collect(),
        StudioExternalOperationV2::SetIntegrationBindings {
            integration_bindings,
        } => integration_bindings
            .iter()
            .map(|item| item.node.as_str())
            .collect(),
        StudioExternalOperationV2::SetTestEnvironments { test_environments } => test_environments
            .iter()
            .map(|item| item.node.as_str())
            .collect(),
    }
}

fn existing_operation_nodes<'a>(
    ir: &'a IrV2,
    operation: &StudioExternalOperationV2,
) -> BTreeSet<&'a str> {
    match operation {
        StudioExternalOperationV2::SetPackageRoots { .. }
        | StudioExternalOperationV2::SetPackages { .. } => ir
            .packages
            .iter()
            .map(|item| item.owner_node.as_str())
            .collect(),
        StudioExternalOperationV2::SetResources { .. }
        | StudioExternalOperationV2::SetResourceBindings { .. } => ir
            .resource_bindings
            .iter()
            .map(|item| item.node.as_str())
            .chain(
                ir.resources
                    .iter()
                    .filter_map(|item| item.migration_owner.as_deref()),
            )
            .collect(),
        StudioExternalOperationV2::SetIntegrations { .. }
        | StudioExternalOperationV2::SetIntegrationBindings { .. }
        | StudioExternalOperationV2::SetSecretRefs { .. } => ir
            .integration_bindings
            .iter()
            .map(|item| item.node.as_str())
            .collect(),
        StudioExternalOperationV2::SetTestEnvironments { .. } => ir
            .test_environments
            .iter()
            .map(|item| item.node.as_str())
            .collect(),
    }
}

fn protected_node<'a>(locks: &'a [BoundaryLockV1], node_id: &str) -> Option<&'a BoundaryLockV1> {
    locks
        .iter()
        .find(|lock| lock.node_id == node_id && lock.scope == BoundaryLockScopeV1::Node)
}

pub fn apply_external_studio_command_v2(
    accepted: &IrV2,
    rationale: &StudioRationaleV1,
    locks: &[BoundaryLockV1],
    command: &StudioExternalCommandV2,
) -> Result<StudioExternalCommandOutcomeV2, Vec<StudioCommandErrorV1>> {
    if command.command_version != STUDIO_V2_COMMAND_VERSION {
        return Err(vec![StudioCommandErrorV1 {
            code: "INVALID_COMMAND".into(),
            message: format!(
                "unsupported external Studio command version `{}` (expected `{STUDIO_V2_COMMAND_VERSION}`)",
                command.command_version
            ),
            operation_index: None,
        }]);
    }
    if command.command_id.trim().is_empty()
        || command.proposal_id.trim().is_empty()
        || command.expected_head_digest.trim().is_empty()
        || command.actor_pubkey.trim().is_empty()
        || command.operations.is_empty()
    {
        return Err(vec![StudioCommandErrorV1 {
            code: "INVALID_COMMAND".into(),
            message: "command id, proposal, expected head, actor, and operations must not be empty"
                .into(),
            operation_index: None,
        }]);
    }

    let mut candidate = accepted.clone();
    let mut changed = BTreeSet::new();
    for (index, operation) in command.operations.iter().enumerate() {
        let mut touched = operation_nodes(operation);
        touched.extend(existing_operation_nodes(accepted, operation));
        if let Some(lock) = touched.iter().find_map(|node| protected_node(locks, node)) {
            return Err(vec![StudioCommandErrorV1 {
                code: "BOUNDARY_LOCKED".into(),
                message: format!(
                    "external contract edit changes node protected by lock `{}`: {}",
                    lock.lock_id, lock.reason
                ),
                operation_index: Some(index),
            }]);
        }
        changed.extend(touched.into_iter().map(str::to_owned));
        match operation {
            StudioExternalOperationV2::SetPackageRoots { package_roots } => {
                candidate.package_roots.clone_from(package_roots);
            }
            StudioExternalOperationV2::SetPackages { packages } => {
                candidate.packages.clone_from(packages);
            }
            StudioExternalOperationV2::SetResources { resources } => {
                candidate.resources.clone_from(resources);
            }
            StudioExternalOperationV2::SetResourceBindings { resource_bindings } => {
                candidate.resource_bindings.clone_from(resource_bindings);
            }
            StudioExternalOperationV2::SetIntegrations { integrations } => {
                candidate.integrations.clone_from(integrations);
            }
            StudioExternalOperationV2::SetIntegrationBindings {
                integration_bindings,
            } => candidate
                .integration_bindings
                .clone_from(integration_bindings),
            StudioExternalOperationV2::SetSecretRefs { secret_refs } => {
                candidate.secret_refs.clone_from(secret_refs);
            }
            StudioExternalOperationV2::SetTestEnvironments { test_environments } => {
                candidate.test_environments.clone_from(test_environments);
            }
        }
    }

    let plan = compile_v2(&candidate).map_err(|diagnostics| {
        diagnostics
            .into_iter()
            .map(|diagnostic| StudioCommandErrorV1 {
                code: "COMPILER_REJECTED".into(),
                message: diagnostic.to_string(),
                operation_index: None,
            })
            .collect::<Vec<_>>()
    })?;
    let accepted_json: BTreeMap<&str, serde_json::Value> = accepted
        .nodes
        .iter()
        .map(|node| {
            (
                node.id.as_str(),
                serde_json::to_value(node).expect("node serializes"),
            )
        })
        .collect();
    let candidate_json: BTreeMap<&str, serde_json::Value> = candidate
        .nodes
        .iter()
        .map(|node| {
            (
                node.id.as_str(),
                serde_json::to_value(node).expect("node serializes"),
            )
        })
        .collect();
    changed.extend(
        accepted_json
            .keys()
            .chain(candidate_json.keys())
            .filter(|id| accepted_json.get(**id) != candidate_json.get(**id))
            .map(|id| (*id).to_owned()),
    );
    let changed_nodes: Vec<_> = changed.iter().cloned().collect();
    for node in &changed_nodes {
        changed.extend(plan.core.invalidation_set(node));
    }
    let order: BTreeMap<&str, usize> = plan
        .core
        .order
        .iter()
        .enumerate()
        .map(|(index, node)| (node.as_str(), index))
        .collect();
    let mut rebuild_nodes: Vec<_> = changed.into_iter().collect();
    rebuild_nodes.sort_by_key(|node| order.get(node.as_str()).copied().unwrap_or(usize::MAX));

    Ok(StudioExternalCommandOutcomeV2 {
        semantic_digest: studio_v2_semantic_digest(&candidate, rationale, locks),
        ir: candidate,
        changed_nodes,
        rebuild_nodes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> IrV2 {
        serde_json::from_str(include_str!(
            "../../../../ir/examples/service-stack.ir-v2.json"
        ))
        .expect("fixture parses")
    }

    fn command(operation: StudioExternalOperationV2) -> StudioExternalCommandV2 {
        StudioExternalCommandV2 {
            command_version: 2,
            command_id: "command-1".into(),
            proposal_id: "proposal-1".into(),
            expected_head_digest: "digest".into(),
            actor_pubkey: "human".into(),
            operations: vec![operation],
        }
    }

    #[test]
    fn rejects_invalid_external_edit_without_returning_a_candidate() {
        let ir = fixture();
        let mut packages = ir.packages.clone();
        packages[0].version = "latest".into();
        let errors = apply_external_studio_command_v2(
            &ir,
            &StudioRationaleV1::default(),
            &[],
            &command(StudioExternalOperationV2::SetPackages { packages }),
        )
        .expect_err("unpinned package must fail");
        assert!(errors.iter().any(|error| error.code == "COMPILER_REJECTED"));
    }

    #[test]
    fn valid_edit_changes_digest_and_rebuilds_the_owner() {
        let ir = fixture();
        let mut integrations = ir.integration_bindings.clone();
        integrations[0].timeout_ms += 1;
        let outcome = apply_external_studio_command_v2(
            &ir,
            &StudioRationaleV1::default(),
            &[],
            &command(StudioExternalOperationV2::SetIntegrationBindings {
                integration_bindings: integrations,
            }),
        )
        .expect("valid edit compiles");
        assert_ne!(
            outcome.semantic_digest,
            studio_v2_semantic_digest(&ir, &StudioRationaleV1::default(), &[])
        );
        assert!(!outcome.changed_nodes.is_empty());
        assert!(!outcome.rebuild_nodes.is_empty());
    }
}
