//! Foundry dyad IR — the artifact an architecture role emits and everything downstream
//! compiles from. `types` mirrors `Foundry/ir/schema.json`; `compile` validates the
//! integrity rules and lowers the flat node list into a build plan (topological order,
//! per-node read-sets, and the invalidation adjacency) that the GraphReact host drives.

pub mod architecture;
pub mod compile;
pub mod revision;
pub mod studio;
pub mod types;

pub use architecture::{validate_architecture_request, ArchitectureRequestError};
pub use compile::{compile, BuildPlan, CompileError};
pub use revision::{
    ir_digest, validate_revision, ArchitectureRevisionRequest, RevisionError, StructuralDiff,
};
pub use studio::{
    apply_generated_studio_candidate, apply_studio_command, studio_semantic_digest,
    ArchitectureBuildHandoffV1, ArchitectureLayoutV1, ArchitectureProposalV1,
    ArchitectureRevisionV1, BoundaryLockScopeV1, BoundaryLockV1, CriticReviewV1, CriticVerdictV1,
    HumanArchitectureApprovalV1, LayoutPointV1, ProposalStatusV1, RationaleEntryV1,
    StudioBindingV1, StudioCommandErrorV1, StudioCommandOutcomeV1, StudioCommandV1,
    StudioOperationV1, StudioRationaleV1, StudioRevisionPhaseV1,
};
pub use types::{ArchitectureRequest, Interface, Ir, Kind, Node, Operation, TestBundle};
