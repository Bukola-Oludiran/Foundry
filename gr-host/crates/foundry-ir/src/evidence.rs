use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Component, Path};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSymbolKindV1 {
    Function,
    Method,
    Type,
    Constant,
    State,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceVisibilityV1 {
    Public,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceCompletenessV1 {
    Complete,
    Partial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContractMappingStatusV1 {
    Matched,
    Missing,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcceptanceCaseStatusV1 {
    Passed,
    Failed,
    NotRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceSourceFileV1 {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceSymbolV1 {
    pub name: String,
    pub kind: EvidenceSymbolKindV1,
    pub signature: Option<String>,
    pub visibility: EvidenceVisibilityV1,
    pub path: String,
    pub line: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContractSymbolMappingV1 {
    pub operation: String,
    pub status: ContractMappingStatusV1,
    pub symbols: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceFailureV1 {
    pub case: String,
    pub expected: Value,
    pub actual: Option<Value>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcceptanceCaseResultV1 {
    pub name: String,
    pub status: AcceptanceCaseStatusV1,
    pub failure: Option<EvidenceFailureV1>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceMeasurementsV1 {
    pub duration_ms: u64,
    pub memory_mb: Option<f64>,
}

/// Immutable, bounded source metadata for one exact accepted node attempt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NodeImplementationEvidenceV1 {
    pub evidence_version: u32,
    pub node_id: String,
    pub build_run_id: String,
    pub proposal_id: Option<String>,
    pub revision_id: Option<String>,
    pub semantic_digest: String,
    pub base_commit: String,
    pub attempt: u64,
    pub language: String,
    pub source_snapshot_digest: String,
    pub source_files: Vec<EvidenceSourceFileV1>,
    pub symbols: Vec<EvidenceSymbolV1>,
    pub contract_mappings: Vec<ContractSymbolMappingV1>,
    pub case_results: Vec<AcceptanceCaseResultV1>,
    pub measurements: EvidenceMeasurementsV1,
    pub completeness: EvidenceCompletenessV1,
    pub diagnostics: Vec<String>,
    pub created_at_ms: u64,
}

impl NodeImplementationEvidenceV1 {
    /// Validates the worker's bounded, repository-relative evidence envelope.
    pub fn validate_shape(&self) -> Result<(), &'static str> {
        if self.evidence_version != 1
            || self.source_files.len() > 64
            || self.symbols.len() > 500
            || self.contract_mappings.len() > 256
            || self.case_results.len() > 1024
            || self.diagnostics.len() > 50
        {
            return Err("implementation evidence exceeds its versioned bounds");
        }
        let safe_path = |value: &str| {
            !value.is_empty()
                && Path::new(value).is_relative()
                && Path::new(value)
                    .components()
                    .all(|part| matches!(part, Component::Normal(_)))
        };
        let digest =
            |value: &str| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
        if !digest(&self.source_snapshot_digest)
            || self
                .source_files
                .iter()
                .any(|file| !safe_path(&file.path) || !digest(&file.sha256))
            || self.symbols.iter().any(|symbol| {
                symbol.name.is_empty()
                    || symbol.name.len() > 512
                    || symbol
                        .signature
                        .as_ref()
                        .is_some_and(|value| value.len() > 512)
                    || !safe_path(&symbol.path)
                    || symbol.line == 0
            })
            || self
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.len() > 512)
            || self.measurements.duration_ms > 86_400_000
            || self
                .measurements
                .memory_mb
                .is_some_and(|memory| !memory.is_finite() || memory < 0.0)
        {
            return Err("implementation evidence contains unsafe or unbounded metadata");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::NodeImplementationEvidenceV1;

    #[test]
    fn evidence_contract_is_strict_and_versioned() {
        let value = serde_json::json!({
            "evidence_version": 1,
            "node_id": "service",
            "build_run_id": "run-1",
            "proposal_id": "proposal-1",
            "revision_id": "revision-1",
            "semantic_digest": "a".repeat(64),
            "base_commit": "base",
            "attempt": 1,
            "language": "python",
            "source_snapshot_digest": "b".repeat(64),
            "source_files": [],
            "symbols": [],
            "contract_mappings": [],
            "case_results": [],
            "measurements": {"duration_ms": 10, "memory_mb": null},
            "completeness": "complete",
            "diagnostics": [],
            "created_at_ms": 1,
        });
        let evidence: NodeImplementationEvidenceV1 =
            serde_json::from_value(value.clone()).expect("valid evidence");
        assert_eq!(evidence.evidence_version, 1);
        assert!(evidence.validate_shape().is_ok());
        let mut invalid = value;
        invalid["source"] = serde_json::json!("must not be accepted");
        assert!(serde_json::from_value::<NodeImplementationEvidenceV1>(invalid).is_err());

        let mut traversal = evidence;
        traversal.source_files.push(super::EvidenceSourceFileV1 {
            path: "../secret".into(),
            sha256: "c".repeat(64),
        });
        assert!(traversal.validate_shape().is_err());
    }
}
