//! Foundry dyad IR — the artifact an architecture role emits and everything downstream
//! compiles from. `types` mirrors `Foundry/ir/schema.json`; `compile` validates the
//! integrity rules and lowers the flat node list into a build plan (topological order,
//! per-node read-sets, and the invalidation adjacency) that the GraphReact host drives.

pub mod compile;
pub mod product_compile;
pub mod types;

pub use compile::{compile, BuildPlan, CompileError};
pub use product_compile::compile_product;
pub use types::{AcceptanceScenario, AcceptanceStep, Architecture, Interface, Ir, Kind, Node, Operation, OperationParameter, ProductArchitectureV5, TestBundle};
