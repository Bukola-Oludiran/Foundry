use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{compile, Interface, Ir, Node};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArchitectureRevisionRequest {
    pub revision_version: u32,
    pub accepted_ir_revision: String,
    pub target_node: String,
    pub reason: String,
    #[serde(default)]
    pub failure_history: Vec<String>,
    pub boundary_interface: Interface,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructuralDiff {
    pub accepted_ir_revision: String,
    pub target_node: String,
    pub replaced_nodes: Vec<String>,
    pub rebuilt_nodes: Vec<String>,
    pub unchanged_nodes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RevisionError {
    #[error("unsupported architecture revision version `{0}` (expected `1`)")]
    UnsupportedVersion(u32),
    #[error("accepted IR digest mismatch: expected `{expected}`, got `{got}`")]
    AcceptedDigestMismatch { expected: String, got: String },
    #[error("revision target `{0}` does not exist")]
    UnknownTarget(String),
    #[error("revision reason must not be empty")]
    EmptyReason,
    #[error("revision boundary does not equal target `{0}`'s accepted interface")]
    BoundaryMismatch(String),
    #[error("proposed IR is invalid: {0}")]
    InvalidProposal(String),
    #[error("proposed IR removed affected node `{0}` without a replacement using that stable id")]
    MissingAffectedNode(String),
    #[error("revision changed out-of-scope node `{0}`")]
    OutOfScopeChange(String),
    #[error("revision changed the target's parent-owned acceptance mandate")]
    AcceptanceMandateChanged,
}

pub fn ir_digest(ir: &Ir) -> String {
    let bytes = serde_json::to_vec(ir).expect("serializing IR is infallible");
    format!("{:x}", Sha256::digest(bytes))
}

pub fn validate_revision(
    accepted: &Ir,
    proposed: &Ir,
    request: &ArchitectureRevisionRequest,
) -> Result<StructuralDiff, Vec<RevisionError>> {
    let mut errors = Vec::new();
    if request.revision_version != 1 {
        errors.push(RevisionError::UnsupportedVersion(request.revision_version));
    }
    if request.reason.trim().is_empty() {
        errors.push(RevisionError::EmptyReason);
    }
    let digest = ir_digest(accepted);
    if request.accepted_ir_revision != digest {
        errors.push(RevisionError::AcceptedDigestMismatch {
            expected: digest.clone(),
            got: request.accepted_ir_revision.clone(),
        });
    }
    let Some(target) = accepted
        .nodes
        .iter()
        .find(|node| node.id == request.target_node)
    else {
        errors.push(RevisionError::UnknownTarget(request.target_node.clone()));
        return Err(errors);
    };
    if request.boundary_interface != target.provides {
        errors.push(RevisionError::BoundaryMismatch(request.target_node.clone()));
    }
    let accepted_plan = match compile(accepted) {
        Ok(plan) => plan,
        Err(diagnostics) => {
            errors.extend(
                diagnostics
                    .into_iter()
                    .map(|error| RevisionError::InvalidProposal(error.to_string())),
            );
            return Err(errors);
        }
    };
    if let Err(diagnostics) = compile(proposed) {
        errors.extend(
            diagnostics
                .into_iter()
                .map(|error| RevisionError::InvalidProposal(error.to_string())),
        );
    }

    let affected: BTreeSet<String> = std::iter::once(request.target_node.clone())
        .chain(accepted_plan.invalidation_set(&request.target_node))
        .collect();
    let accepted_nodes: BTreeMap<&str, &Node> = accepted
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();
    let proposed_nodes: BTreeMap<&str, &Node> = proposed
        .nodes
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect();

    for (id, node) in &accepted_nodes {
        if affected.contains(*id) {
            if !proposed_nodes.contains_key(id) {
                errors.push(RevisionError::MissingAffectedNode((*id).to_owned()));
            }
        } else if proposed_nodes.get(id).copied() != Some(*node) {
            errors.push(RevisionError::OutOfScopeChange((*id).to_owned()));
        }
    }
    for id in proposed_nodes.keys() {
        if !accepted_nodes.contains_key(id) && !affected.contains(*id) {
            errors.push(RevisionError::OutOfScopeChange((*id).to_owned()));
        }
    }
    if let Some(proposed_target) = proposed_nodes.get(request.target_node.as_str()) {
        if proposed_target.provides != request.boundary_interface {
            errors.push(RevisionError::BoundaryMismatch(request.target_node.clone()));
        }
        if proposed_target.acceptance != target.acceptance {
            errors.push(RevisionError::AcceptanceMandateChanged);
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }

    let mut replaced_nodes: Vec<_> = affected
        .iter()
        .filter(|id| {
            accepted_nodes.get(id.as_str()).copied() != proposed_nodes.get(id.as_str()).copied()
        })
        .cloned()
        .collect();
    let mut rebuilt_nodes: Vec<_> = affected.into_iter().collect();
    let mut unchanged_nodes: Vec<_> = accepted_nodes
        .keys()
        .filter(|id| !rebuilt_nodes.iter().any(|affected| affected == **id))
        .map(|id| (*id).to_owned())
        .collect();
    replaced_nodes.sort();
    rebuilt_nodes.sort_by_key(|id| {
        accepted_plan
            .order
            .iter()
            .position(|candidate| candidate == id)
            .unwrap_or(usize::MAX)
    });
    unchanged_nodes.sort();
    Ok(StructuralDiff {
        accepted_ir_revision: digest,
        target_node: request.target_node.clone(),
        replaced_nodes,
        rebuilt_nodes,
        unchanged_nodes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example() -> Ir {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../ir/examples/string-utils.ir.json");
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    fn request(ir: &Ir) -> ArchitectureRevisionRequest {
        let target = ir.nodes.iter().find(|node| node.id == "hyphenate").unwrap();
        ArchitectureRevisionRequest {
            revision_version: 1,
            accepted_ir_revision: ir_digest(ir),
            target_node: target.id.clone(),
            reason: "acceptance failure".into(),
            failure_history: vec!["collapse case failed".into()],
            boundary_interface: target.provides.clone(),
        }
    }

    #[test]
    fn permits_only_interface_preserving_blast_radius_changes() {
        let accepted = example();
        let mut proposal = accepted.clone();
        proposal
            .nodes
            .iter_mut()
            .find(|node| node.id == "hyphenate")
            .unwrap()
            .implementation
            .write_target = "src/hyphenate-v2.py".into();
        let diff = validate_revision(&accepted, &proposal, &request(&accepted)).unwrap();
        assert_eq!(diff.replaced_nodes, ["hyphenate"]);
        assert_eq!(diff.rebuilt_nodes, ["hyphenate", "string-utils"]);
        assert_eq!(diff.unchanged_nodes, ["lowercase", "trim"]);

        proposal
            .nodes
            .iter_mut()
            .find(|node| node.id == "trim")
            .unwrap()
            .implementation
            .write_target = "src/trim-v2.py".into();
        let errors = validate_revision(&accepted, &proposal, &request(&accepted)).unwrap_err();
        assert!(errors
            .iter()
            .any(|error| matches!(error, RevisionError::OutOfScopeChange(node) if node == "trim")));
    }
}
