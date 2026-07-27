//! Foundry dyad IR — the artifact an architecture role emits and everything downstream
//! compiles from. `types` mirrors `Foundry/ir/schema.json`; `compile` validates the
//! integrity rules and lowers the flat node list into a build plan (topological order,
//! per-node read-sets, and the invalidation adjacency) that the GraphReact host drives.

pub mod compile;
pub mod types;

pub use compile::{compile, BuildPlan, CompileError};
pub use types::{Interface, Ir, Kind, Node, Operation, TestBundle};
