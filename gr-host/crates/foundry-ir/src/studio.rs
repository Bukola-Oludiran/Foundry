//! Versioned Architecture Studio contracts and deterministic IR transformations.
//!
//! The graph shown by Buzz is a projection of [`Ir`]. Layout is deliberately
//! separate from semantic state, and every semantic command compiles the full
//! candidate before it can become a proposal head.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::types::InterfaceRef;
use crate::{compile, Interface, Ir, Node, TestBundle};

const STUDIO_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudioBindingV1 {
    pub studio_version: u32,
    pub community_id: String,
    pub repository_coordinate: String,
    #[serde(default)]
    pub base_commit: String,
    pub target_branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StudioRevisionPhaseV1 {
    Draft,
    AwaitingCritic,
    AwaitingHumanApproval,
    Approved,
    Building,
    Delivered,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatusV1 {
    Open,
    Approved,
    Rejected,
    Stale,
    Superseded,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CriticVerdictV1 {
    Approved,
    ChangesRequested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CriticReviewV1 {
    pub studio_version: u32,
    pub review_id: String,
    pub proposal_id: String,
    pub revision_id: String,
    pub semantic_digest: String,
    pub reviewer_pubkey: String,
    pub verdict: CriticVerdictV1,
    #[serde(default)]
    pub diagnostics: Vec<String>,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HumanArchitectureApprovalV1 {
    pub studio_version: u32,
    pub event_id: String,
    pub proposal_id: String,
    pub revision_id: String,
    pub semantic_digest: String,
    pub signer_pubkey: String,
    pub foundry_run_id: String,
    pub verified_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchitectureBuildHandoffV1 {
    pub studio_version: u32,
    pub build_run_id: String,
    pub proposal_id: String,
    pub revision_id: String,
    pub semantic_digest: String,
    pub base_commit: String,
    pub operation_key: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchitectureRevisionV1 {
    pub studio_version: u32,
    pub revision_id: String,
    pub parent_revision_id: Option<String>,
    pub proposal_id: String,
    pub author_pubkey: String,
    pub ir_digest: String,
    pub rationale_digest: String,
    pub locks_digest: String,
    pub semantic_digest: String,
    pub phase: StudioRevisionPhaseV1,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchitectureProposalV1 {
    pub studio_version: u32,
    pub proposal_id: String,
    pub title: String,
    pub creator_pubkey: String,
    pub base_revision_id: String,
    pub head_revision_id: String,
    pub head_semantic_digest: String,
    pub status: ProposalStatusV1,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BoundaryLockScopeV1 {
    Node,
    Interface,
    Acceptance,
    WriteScope,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BoundaryLockV1 {
    pub lock_id: String,
    pub node_id: String,
    pub scope: BoundaryLockScopeV1,
    pub reason: String,
    pub locked_by_pubkey: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RationaleEntryV1 {
    pub summary: String,
    #[serde(default)]
    pub responsibilities: Vec<String>,
    #[serde(default)]
    pub constraints: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudioRationaleV1 {
    pub entries: BTreeMap<String, RationaleEntryV1>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayoutPointV1 {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchitectureLayoutV1 {
    pub layout_version: u32,
    #[serde(default)]
    pub positions: BTreeMap<String, LayoutPointV1>,
    #[serde(default)]
    pub collapsed: BTreeSet<String>,
    pub selected_view: String,
    #[serde(default)]
    pub selected_element: Option<String>,
    #[serde(default)]
    pub inspector_section: Option<String>,
    #[serde(default)]
    pub show_internal_evidence: bool,
    pub zoom: f64,
    pub viewport: LayoutPointV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum StudioOperationV1 {
    AddNode {
        node: Node,
    },
    RemoveNode {
        node_id: String,
    },
    ReplaceNode {
        node_id: String,
        node: Node,
    },
    MoveNode {
        node_id: String,
        new_owner: String,
    },
    AddRequirement {
        node_id: String,
        requirement: InterfaceRef,
    },
    RemoveRequirement {
        node_id: String,
        provider_node: String,
        interface: String,
    },
    SetInterface {
        node_id: String,
        interface: Interface,
    },
    SetLanguage {
        node_id: String,
        language: String,
    },
    SetWriteTarget {
        node_id: String,
        write_target: String,
    },
    SetAcceptance {
        node_id: String,
        acceptance: TestBundle,
    },
    SetRationale {
        element_id: String,
        rationale: RationaleEntryV1,
    },
    RemoveRationale {
        element_id: String,
    },
    AddBoundaryLock {
        lock: BoundaryLockV1,
    },
    RemoveBoundaryLock {
        lock_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudioCommandV1 {
    pub command_version: u32,
    pub command_id: String,
    pub proposal_id: String,
    pub expected_head_digest: String,
    pub actor_pubkey: String,
    pub operations: Vec<StudioOperationV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudioCommandErrorV1 {
    pub code: String,
    pub message: String,
    pub operation_index: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudioCommandOutcomeV1 {
    pub ir: Ir,
    pub rationale: StudioRationaleV1,
    pub locks: Vec<BoundaryLockV1>,
    pub semantic_digest: String,
    pub changed_nodes: Vec<String>,
    pub rebuild_nodes: Vec<String>,
}

fn json_digest<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).expect("Studio contracts serialize");
    format!("{:x}", Sha256::digest(bytes))
}

pub fn studio_semantic_digest(
    ir: &Ir,
    rationale: &StudioRationaleV1,
    locks: &[BoundaryLockV1],
) -> String {
    json_digest(&(ir, rationale, locks))
}

fn locked<'a>(
    locks: &'a [BoundaryLockV1],
    node_id: &str,
    scopes: &[BoundaryLockScopeV1],
) -> Option<&'a BoundaryLockV1> {
    locks.iter().find(|lock| {
        lock.node_id == node_id
            && (lock.scope == BoundaryLockScopeV1::Node || scopes.contains(&lock.scope))
    })
}

fn lock_error(index: usize, lock: &BoundaryLockV1) -> StudioCommandErrorV1 {
    StudioCommandErrorV1 {
        code: "BOUNDARY_LOCKED".into(),
        message: format!(
            "node `{}` is protected by lock `{}`: {}",
            lock.node_id, lock.lock_id, lock.reason
        ),
        operation_index: Some(index),
    }
}

fn missing(index: usize, node_id: &str) -> StudioCommandErrorV1 {
    StudioCommandErrorV1 {
        code: "INVALID_COMMAND".into(),
        message: format!("node `{node_id}` does not exist"),
        operation_index: Some(index),
    }
}

/// Applies a batch atomically. The caller performs proposal-head CAS before
/// calling this function; a compiler failure returns diagnostics and no state.
pub fn apply_studio_command(
    accepted: &Ir,
    accepted_rationale: &StudioRationaleV1,
    accepted_locks: &[BoundaryLockV1],
    command: &StudioCommandV1,
) -> Result<StudioCommandOutcomeV1, Vec<StudioCommandErrorV1>> {
    if command.command_version != STUDIO_VERSION {
        return Err(vec![StudioCommandErrorV1 {
            code: "INVALID_COMMAND".into(),
            message: format!(
                "unsupported Studio command version `{}` (expected `{STUDIO_VERSION}`)",
                command.command_version
            ),
            operation_index: None,
        }]);
    }
    if command.command_id.trim().is_empty()
        || command.proposal_id.trim().is_empty()
        || command.actor_pubkey.trim().is_empty()
        || command.operations.is_empty()
    {
        return Err(vec![StudioCommandErrorV1 {
            code: "INVALID_COMMAND".into(),
            message: "command id, proposal id, actor, and operations must not be empty".into(),
            operation_index: None,
        }]);
    }

    let mut ir = accepted.clone();
    let mut rationale = accepted_rationale.clone();
    let mut locks = accepted_locks.to_vec();
    let mut errors = Vec::new();

    for (index, operation) in command.operations.iter().enumerate() {
        let node_index = |id: &str| ir.nodes.iter().position(|node| node.id == id);
        match operation {
            StudioOperationV1::AddNode { node } => ir.nodes.push(node.clone()),
            StudioOperationV1::RemoveNode { node_id } => {
                if let Some(lock) = locked(&locks, node_id, &[]) {
                    errors.push(lock_error(index, lock));
                } else if let Some(position) = node_index(node_id) {
                    ir.nodes.remove(position);
                } else {
                    errors.push(missing(index, node_id));
                }
            }
            StudioOperationV1::ReplaceNode { node_id, node } => {
                if let Some(lock) = locked(&locks, node_id, &[]) {
                    errors.push(lock_error(index, lock));
                } else if let Some(position) = node_index(node_id) {
                    ir.nodes[position] = node.clone();
                } else {
                    errors.push(missing(index, node_id));
                }
            }
            StudioOperationV1::MoveNode { node_id, new_owner } => {
                if let Some(lock) = locked(&locks, node_id, &[]) {
                    errors.push(lock_error(index, lock));
                    continue;
                }
                let Some(position) = node_index(node_id) else {
                    errors.push(missing(index, node_id));
                    continue;
                };
                let old_owner = ir.nodes[position].owner.replace(new_owner.clone());
                if let Some(old_owner) = old_owner {
                    if let Some(owner) = ir.nodes.iter_mut().find(|node| node.id == old_owner) {
                        if let Some(children) = owner.implementation.children.as_mut() {
                            children.retain(|child| child != node_id);
                        }
                    }
                }
                if let Some(owner) = ir.nodes.iter_mut().find(|node| node.id == *new_owner) {
                    if let Some(children) = owner.implementation.children.as_mut() {
                        if !children.contains(node_id) {
                            children.push(node_id.clone());
                        }
                    }
                }
            }
            StudioOperationV1::AddRequirement {
                node_id,
                requirement,
            } => {
                if let Some(lock) = locked(&locks, node_id, &[]) {
                    errors.push(lock_error(index, lock));
                } else if let Some(position) = node_index(node_id) {
                    ir.nodes[position].requires.push(requirement.clone());
                } else {
                    errors.push(missing(index, node_id));
                }
            }
            StudioOperationV1::RemoveRequirement {
                node_id,
                provider_node,
                interface,
            } => {
                if let Some(lock) = locked(&locks, node_id, &[]) {
                    errors.push(lock_error(index, lock));
                } else if let Some(position) = node_index(node_id) {
                    ir.nodes[position].requires.retain(|requirement| {
                        requirement.node != *provider_node || requirement.interface != *interface
                    });
                } else {
                    errors.push(missing(index, node_id));
                }
            }
            StudioOperationV1::SetInterface { node_id, interface } => {
                if let Some(lock) = locked(&locks, node_id, &[BoundaryLockScopeV1::Interface]) {
                    errors.push(lock_error(index, lock));
                } else if let Some(position) = node_index(node_id) {
                    ir.nodes[position].provides = interface.clone();
                } else {
                    errors.push(missing(index, node_id));
                }
            }
            StudioOperationV1::SetLanguage { node_id, language } => {
                if let Some(lock) = locked(&locks, node_id, &[]) {
                    errors.push(lock_error(index, lock));
                } else if let Some(position) = node_index(node_id) {
                    ir.nodes[position].implementation.language = Some(language.clone());
                } else {
                    errors.push(missing(index, node_id));
                }
            }
            StudioOperationV1::SetWriteTarget {
                node_id,
                write_target,
            } => {
                if let Some(lock) = locked(&locks, node_id, &[BoundaryLockScopeV1::WriteScope]) {
                    errors.push(lock_error(index, lock));
                } else if let Some(position) = node_index(node_id) {
                    ir.nodes[position].implementation.write_target = write_target.clone();
                } else {
                    errors.push(missing(index, node_id));
                }
            }
            StudioOperationV1::SetAcceptance {
                node_id,
                acceptance,
            } => {
                if let Some(lock) = locked(&locks, node_id, &[BoundaryLockScopeV1::Acceptance]) {
                    errors.push(lock_error(index, lock));
                } else if let Some(position) = node_index(node_id) {
                    ir.nodes[position].acceptance = acceptance.clone();
                } else {
                    errors.push(missing(index, node_id));
                }
            }
            StudioOperationV1::SetRationale {
                element_id,
                rationale: entry,
            } => {
                rationale.entries.insert(element_id.clone(), entry.clone());
            }
            StudioOperationV1::RemoveRationale { element_id } => {
                rationale.entries.remove(element_id);
            }
            StudioOperationV1::AddBoundaryLock { lock } => {
                if locks
                    .iter()
                    .any(|existing| existing.lock_id == lock.lock_id)
                {
                    errors.push(StudioCommandErrorV1 {
                        code: "INVALID_COMMAND".into(),
                        message: format!("duplicate boundary lock `{}`", lock.lock_id),
                        operation_index: Some(index),
                    });
                } else {
                    locks.push(lock.clone());
                }
            }
            StudioOperationV1::RemoveBoundaryLock { lock_id } => {
                let before = locks.len();
                locks.retain(|lock| lock.lock_id != *lock_id);
                if locks.len() == before {
                    errors.push(StudioCommandErrorV1 {
                        code: "INVALID_COMMAND".into(),
                        message: format!("boundary lock `{lock_id}` does not exist"),
                        operation_index: Some(index),
                    });
                }
            }
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }

    finish_candidate(accepted, ir, rationale, locks)
}

/// Validates a complete agent-generated candidate against compiler invariants
/// and every human boundary lock before it may advance a proposal head.
pub fn apply_generated_studio_candidate(
    accepted: &Ir,
    accepted_rationale: &StudioRationaleV1,
    accepted_locks: &[BoundaryLockV1],
    candidate: Ir,
    rationale: StudioRationaleV1,
) -> Result<StudioCommandOutcomeV1, Vec<StudioCommandErrorV1>> {
    let accepted_by_id: BTreeMap<&str, &Node> = accepted
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let candidate_by_id: BTreeMap<&str, &Node> = candidate
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let mut errors = Vec::new();
    for lock in accepted_locks {
        let before = accepted_by_id.get(lock.node_id.as_str()).copied();
        let after = candidate_by_id.get(lock.node_id.as_str()).copied();
        let changed = match lock.scope {
            BoundaryLockScopeV1::Node => before != after,
            BoundaryLockScopeV1::Interface => {
                before.map(|node| &node.provides) != after.map(|node| &node.provides)
            }
            BoundaryLockScopeV1::Acceptance => {
                before.map(|node| &node.acceptance) != after.map(|node| &node.acceptance)
            }
            BoundaryLockScopeV1::WriteScope => {
                before.map(|node| node.implementation.write_target.as_str())
                    != after.map(|node| node.implementation.write_target.as_str())
            }
        };
        if changed {
            errors.push(StudioCommandErrorV1 {
                code: "BOUNDARY_LOCKED".into(),
                message: format!(
                    "generated candidate changes lock `{}` on node `{}`",
                    lock.lock_id, lock.node_id
                ),
                operation_index: None,
            });
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    let rationale = if rationale.entries.is_empty() {
        accepted_rationale.clone()
    } else {
        rationale
    };
    finish_candidate(accepted, candidate, rationale, accepted_locks.to_vec())
}

fn finish_candidate(
    accepted: &Ir,
    ir: Ir,
    rationale: StudioRationaleV1,
    locks: Vec<BoundaryLockV1>,
) -> Result<StudioCommandOutcomeV1, Vec<StudioCommandErrorV1>> {
    let plan = compile(&ir).map_err(|diagnostics| {
        diagnostics
            .into_iter()
            .map(|diagnostic| StudioCommandErrorV1 {
                code: "COMPILER_REJECTED".into(),
                message: diagnostic.to_string(),
                operation_index: None,
            })
            .collect::<Vec<_>>()
    })?;

    let accepted_by_id: BTreeMap<&str, &Node> = accepted
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let proposed_by_id: BTreeMap<&str, &Node> = ir
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let mut changed: BTreeSet<String> = accepted_by_id
        .keys()
        .chain(proposed_by_id.keys())
        .filter(|id| accepted_by_id.get(**id) != proposed_by_id.get(**id))
        .map(|id| (*id).to_owned())
        .collect();
    let changed_nodes: Vec<_> = changed.iter().cloned().collect();
    for node in &changed_nodes {
        changed.extend(plan.invalidation_set(node));
    }
    let order: BTreeMap<&str, usize> = plan
        .order
        .iter()
        .enumerate()
        .map(|(index, node)| (node.as_str(), index))
        .collect();
    let mut rebuild_nodes: Vec<_> = changed.into_iter().collect();
    rebuild_nodes.sort_by_key(|node| order.get(node.as_str()).copied().unwrap_or(usize::MAX));

    Ok(StudioCommandOutcomeV1 {
        semantic_digest: studio_semantic_digest(&ir, &rationale, &locks),
        ir,
        rationale,
        locks,
        changed_nodes,
        rebuild_nodes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn example() -> Ir {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../ir/examples/string-utils.ir.json");
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    fn command(operation: StudioOperationV1) -> StudioCommandV1 {
        StudioCommandV1 {
            command_version: 1,
            command_id: "command-one".into(),
            proposal_id: "proposal-one".into(),
            expected_head_digest: "head".into(),
            actor_pubkey: "human".into(),
            operations: vec![operation],
        }
    }

    #[test]
    fn valid_semantic_edit_compiles_and_calculates_rebuild_closure() {
        let ir = example();
        let result = apply_studio_command(
            &ir,
            &StudioRationaleV1::default(),
            &[],
            &command(StudioOperationV1::SetWriteTarget {
                node_id: "hyphenate".into(),
                write_target: "src/hyphenate-v2.py".into(),
            }),
        )
        .unwrap();
        assert_eq!(result.changed_nodes, ["hyphenate"]);
        assert_eq!(result.rebuild_nodes, ["hyphenate", "string-utils"]);
    }

    #[test]
    fn compiler_failure_does_not_return_candidate_state() {
        let ir = example();
        let errors = apply_studio_command(
            &ir,
            &StudioRationaleV1::default(),
            &[],
            &command(StudioOperationV1::SetLanguage {
                node_id: "hyphenate".into(),
                language: "rust".into(),
            }),
        )
        .unwrap_err();
        assert!(errors.iter().any(|error| error.code == "COMPILER_REJECTED"));
    }

    #[test]
    fn boundary_lock_fails_before_mutation() {
        let ir = example();
        let lock = BoundaryLockV1 {
            lock_id: "lock-one".into(),
            node_id: "hyphenate".into(),
            scope: BoundaryLockScopeV1::WriteScope,
            reason: "human locked the path".into(),
            locked_by_pubkey: "human".into(),
        };
        let errors = apply_studio_command(
            &ir,
            &StudioRationaleV1::default(),
            &[lock],
            &command(StudioOperationV1::SetWriteTarget {
                node_id: "hyphenate".into(),
                write_target: "src/changed.py".into(),
            }),
        )
        .unwrap_err();
        assert_eq!(errors[0].code, "BOUNDARY_LOCKED");
    }

    #[test]
    fn generated_candidates_cannot_cross_granular_boundary_locks() {
        let ir = example();
        let mut candidate = ir.clone();
        candidate
            .nodes
            .iter_mut()
            .find(|node| node.id == "hyphenate")
            .unwrap()
            .implementation
            .write_target = "src/hyphenate-v2.py".into();
        let errors = apply_generated_studio_candidate(
            &ir,
            &StudioRationaleV1::default(),
            &[BoundaryLockV1 {
                lock_id: "write-lock".into(),
                node_id: "hyphenate".into(),
                scope: BoundaryLockScopeV1::WriteScope,
                reason: "human decision".into(),
                locked_by_pubkey: "human".into(),
            }],
            candidate,
            StudioRationaleV1::default(),
        )
        .unwrap_err();
        assert!(errors.iter().any(|error| error.code == "BOUNDARY_LOCKED"));
    }

    #[test]
    fn layout_is_excluded_from_semantic_digest() {
        let ir = example();
        let rationale = StudioRationaleV1::default();
        let before = studio_semantic_digest(&ir, &rationale, &[]);
        let _layout = ArchitectureLayoutV1 {
            layout_version: 1,
            positions: BTreeMap::from([("hyphenate".into(), LayoutPointV1 { x: 100.0, y: 40.0 })]),
            collapsed: BTreeSet::new(),
            selected_view: "component".into(),
            selected_element: Some("hyphenate".into()),
            inspector_section: Some("contract".into()),
            show_internal_evidence: false,
            zoom: 1.2,
            viewport: LayoutPointV1 { x: 2.0, y: 3.0 },
        };
        assert_eq!(before, studio_semantic_digest(&ir, &rationale, &[]));
    }

    #[test]
    fn legacy_layout_defaults_rich_inspector_preferences() {
        let layout: ArchitectureLayoutV1 = serde_json::from_value(serde_json::json!({
            "layout_version": 1,
            "positions": {},
            "collapsed": [],
            "selected_view": "component",
            "zoom": 1.0,
            "viewport": {"x": 0.0, "y": 0.0}
        }))
        .expect("legacy layout remains readable");
        assert_eq!(layout.selected_element, None);
        assert_eq!(layout.inspector_section, None);
        assert!(!layout.show_internal_evidence);
    }

    proptest! {
        #[test]
        fn arbitrary_layout_coordinates_never_change_semantics(x in -1.0e6f64..1.0e6, y in -1.0e6f64..1.0e6, zoom in 0.01f64..10.0) {
            let ir = example();
            let rationale = StudioRationaleV1::default();
            let locks = Vec::new();
            let before = studio_semantic_digest(&ir, &rationale, &locks);
            let _layout = ArchitectureLayoutV1 {
                layout_version: 1,
                positions: BTreeMap::from([("hyphenate".into(), LayoutPointV1 { x, y })]),
                collapsed: BTreeSet::new(),
                selected_view: "dependency".into(),
                selected_element: None,
                inspector_section: None,
                show_internal_evidence: false,
                zoom,
                viewport: LayoutPointV1 { x: -x, y: -y },
            };
            prop_assert_eq!(studio_semantic_digest(&ir, &rationale, &locks), before);
        }

        #[test]
        fn traversal_write_targets_are_always_compiler_rejected(depth in 1usize..8) {
            let ir = example();
            let unsafe_target = format!("{}secret.py", "../".repeat(depth));
            let result = apply_studio_command(
                &ir,
                &StudioRationaleV1::default(),
                &[],
                &command(StudioOperationV1::SetWriteTarget {
                    node_id: "hyphenate".into(),
                    write_target: unsafe_target,
                }),
            );
            prop_assert!(result.is_err());
            prop_assert!(result.unwrap_err().iter().any(|error| error.code == "COMPILER_REJECTED"));
        }
    }
}
