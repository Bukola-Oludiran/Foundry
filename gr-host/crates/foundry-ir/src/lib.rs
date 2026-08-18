//! Foundry dyad IR — the artifact an architecture role emits and everything downstream
//! compiles from. `types` mirrors `Foundry/ir/schema.json`; `compile` validates the
//! integrity rules and lowers the flat node list into a build plan (topological order,
//! per-node read-sets, and the invalidation adjacency) that the GraphReact host drives.

pub mod architecture;
pub mod compile;
pub mod compile_v2;
pub mod environment;
pub mod evidence;
pub mod generated;
pub mod resolution;
pub mod revision;
pub mod studio;
pub mod types;
pub mod v2;

pub use architecture::{validate_architecture_request, ArchitectureRequestError};
pub use compile::{compile, BuildPlan, CompileError};
pub use compile_v2::{compile_v2, BuildPlanV2, CompileV2Error};
pub use environment::{plan_test_environment, EnvironmentPlanV1};
pub use evidence::{
    AcceptanceCaseResultV1, AcceptanceCaseStatusV1, ContractMappingStatusV1,
    ContractSymbolMappingV1, EvidenceCompletenessV1, EvidenceFailureV1, EvidenceMeasurementsV1,
    EvidenceSourceFileV1, EvidenceSymbolKindV1, EvidenceSymbolV1, EvidenceVisibilityV1,
    NodeImplementationEvidenceV1,
};
pub use generated::{
    generate_resource_files, DeploymentResourceManifestV1, GeneratedResourceFilesV1,
    SecretBindingManifestV1, GENERATED_RESOURCES_VERSION,
};
pub use resolution::{
    plan_dependency_resolution, verify_resolution_evidence, DependencyResolutionEvidenceV1,
    DependencyResolutionPlanV1, ResolutionError, SupplyChainPolicyV1,
};
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
pub use v2::{ir_v2_digest, IrDocument, IrV2};
