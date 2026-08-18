//! Deterministic package-resolution plans and fail-closed supply-chain policy.
//!
//! This module is deliberately transport-neutral. A durable host effect executes
//! the plan in a pinned resolver container and returns the evidence types here.

use crate::v2::{IrV2, PackageDependencyV2, PackageEcosystemV2, ResolverConfigurationV2};
use crate::{compile_v2, CompileV2Error};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const DEPENDENCY_RESOLUTION_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackageResolutionInputV1 {
    pub package_root: String,
    pub ecosystem: PackageEcosystemV2,
    pub language: String,
    pub manifest_path: String,
    pub lockfile_path: String,
    pub resolver: ResolverConfigurationV2,
    pub registry_allowlist: Vec<String>,
    pub packages: Vec<PackageDependencyV2>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DependencyResolutionPlanV1 {
    pub resolution_version: u32,
    pub ir_digest: String,
    pub plan_digest: String,
    pub roots: Vec<PackageResolutionInputV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VulnerabilitySeverityV1 {
    Unknown,
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VulnerabilityFindingV1 {
    pub package_id: String,
    pub advisory_id: String,
    pub severity: VulnerabilitySeverityV1,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResolvedPackageV1 {
    pub package_id: String,
    pub name: String,
    pub version: String,
    pub integrity: String,
    pub licenses: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DependencyResolutionEvidenceV1 {
    pub resolution_version: u32,
    pub plan_digest: String,
    pub resolver_image: String,
    pub platform: String,
    pub manifest_sha256: String,
    pub lockfile_sha256: String,
    pub dependency_layer_sha256: String,
    pub sbom_sha256: String,
    pub packages: Vec<ResolvedPackageV1>,
    pub vulnerabilities: Vec<VulnerabilityFindingV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupplyChainPolicyV1 {
    pub allowed_licenses: BTreeSet<String>,
    pub deny_at_or_above: VulnerabilitySeverityV1,
}

impl Default for SupplyChainPolicyV1 {
    fn default() -> Self {
        Self {
            allowed_licenses: [
                "Apache-2.0",
                "BSD-2-Clause",
                "BSD-3-Clause",
                "ISC",
                "MIT",
                "MPL-2.0",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            deny_at_or_above: VulnerabilitySeverityV1::High,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ResolutionError {
    #[error("IR v2 is invalid: {0}")]
    InvalidIr(CompileV2Error),
    #[error("resolution evidence targets plan `{got}`, expected `{expected}`")]
    PlanMismatch { expected: String, got: String },
    #[error("resolved package `{0}` was not declared")]
    UndeclaredPackage(String),
    #[error("declared package `{0}` is missing from resolution evidence")]
    MissingPackage(String),
    #[error("package `{package}` resolved to `{got}`, expected `{expected}`")]
    ResolutionDrift {
        package: String,
        expected: String,
        got: String,
    },
    #[error("package `{package}` has disallowed license `{license}`")]
    DisallowedLicense { package: String, license: String },
    #[error("package `{package}` has {severity:?} vulnerability `{advisory}`")]
    Vulnerability {
        package: String,
        advisory: String,
        severity: VulnerabilitySeverityV1,
    },
    #[error("resolution evidence `{0}` must be a lowercase SHA-256 digest")]
    InvalidDigest(&'static str),
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn plan_dependency_resolution(
    ir: &IrV2,
) -> Result<DependencyResolutionPlanV1, Vec<ResolutionError>> {
    if let Err(errors) = compile_v2(ir) {
        return Err(errors.into_iter().map(ResolutionError::InvalidIr).collect());
    }
    let mut packages_by_root: BTreeMap<&str, Vec<PackageDependencyV2>> = BTreeMap::new();
    for package in &ir.packages {
        packages_by_root
            .entry(package.package_root.as_str())
            .or_default()
            .push(package.clone());
    }
    let mut roots = Vec::new();
    for root in &ir.package_roots {
        let mut packages = packages_by_root
            .remove(root.id.as_str())
            .unwrap_or_default();
        packages.sort_by(|left, right| left.id.cmp(&right.id));
        let ecosystem = packages.first().map(|package| package.ecosystem).unwrap_or(
            match root.language.as_str() {
                "python" => PackageEcosystemV2::Pypi,
                "go" => PackageEcosystemV2::Go,
                _ => PackageEcosystemV2::Npm,
            },
        );
        let mut registry_allowlist = root.registry_allowlist.clone();
        registry_allowlist.sort();
        roots.push(PackageResolutionInputV1 {
            package_root: root.id.clone(),
            ecosystem,
            language: root.language.clone(),
            manifest_path: root.manifest_path.clone(),
            lockfile_path: root.lockfile_path.clone(),
            resolver: root.resolver.clone(),
            registry_allowlist,
            packages,
        });
    }
    roots.sort_by(|left, right| left.package_root.cmp(&right.package_root));
    let ir_digest = crate::ir_v2_digest(ir);
    let plan_bytes = serde_json::to_vec(&(DEPENDENCY_RESOLUTION_VERSION, &ir_digest, &roots))
        .expect("resolution plan serialization is infallible");
    Ok(DependencyResolutionPlanV1 {
        resolution_version: DEPENDENCY_RESOLUTION_VERSION,
        ir_digest,
        plan_digest: sha256(&plan_bytes),
        roots,
    })
}

pub fn verify_resolution_evidence(
    plan: &DependencyResolutionPlanV1,
    evidence: &DependencyResolutionEvidenceV1,
    policy: &SupplyChainPolicyV1,
) -> Result<(), Vec<ResolutionError>> {
    let mut errors = Vec::new();
    if evidence.plan_digest != plan.plan_digest {
        errors.push(ResolutionError::PlanMismatch {
            expected: plan.plan_digest.clone(),
            got: evidence.plan_digest.clone(),
        });
    }
    for (name, digest) in [
        ("manifest_sha256", evidence.manifest_sha256.as_str()),
        ("lockfile_sha256", evidence.lockfile_sha256.as_str()),
        (
            "dependency_layer_sha256",
            evidence.dependency_layer_sha256.as_str(),
        ),
        ("sbom_sha256", evidence.sbom_sha256.as_str()),
    ] {
        if !is_digest(digest) {
            errors.push(ResolutionError::InvalidDigest(name));
        }
    }
    let declared: BTreeMap<_, _> = plan
        .roots
        .iter()
        .flat_map(|root| root.packages.iter())
        .map(|package| (package.id.as_str(), package))
        .collect();
    let resolved: BTreeMap<_, _> = evidence
        .packages
        .iter()
        .map(|package| (package.package_id.as_str(), package))
        .collect();
    for (id, package) in &declared {
        match resolved.get(id) {
            None => errors.push(ResolutionError::MissingPackage((*id).to_owned())),
            Some(actual) => {
                if actual.name != package.name
                    || actual.version != package.version
                    || actual.integrity != package.integrity
                {
                    errors.push(ResolutionError::ResolutionDrift {
                        package: (*id).to_owned(),
                        expected: format!(
                            "{}@{}#{}",
                            package.name, package.version, package.integrity
                        ),
                        got: format!("{}@{}#{}", actual.name, actual.version, actual.integrity),
                    });
                }
                for license in &actual.licenses {
                    if !policy.allowed_licenses.contains(license) {
                        errors.push(ResolutionError::DisallowedLicense {
                            package: (*id).to_owned(),
                            license: license.clone(),
                        });
                    }
                }
            }
        }
    }
    for id in resolved.keys() {
        if !declared.contains_key(id) {
            errors.push(ResolutionError::UndeclaredPackage((*id).to_owned()));
        }
    }
    for vulnerability in &evidence.vulnerabilities {
        if vulnerability.severity >= policy.deny_at_or_above {
            errors.push(ResolutionError::Vulnerability {
                package: vulnerability.package_id.clone(),
                advisory: vulnerability.advisory_id.clone(),
                severity: vulnerability.severity,
            });
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::IrDocument;

    fn plan() -> DependencyResolutionPlanV1 {
        let raw = include_str!("../../../../ir/examples/service-stack.ir-v2.json");
        let IrDocument::V2(ir) = serde_json::from_str(raw).unwrap() else {
            panic!("expected v2")
        };
        plan_dependency_resolution(&ir).unwrap()
    }

    fn evidence(plan: &DependencyResolutionPlanV1) -> DependencyResolutionEvidenceV1 {
        let package = &plan.roots[0].packages[0];
        DependencyResolutionEvidenceV1 {
            resolution_version: 1,
            plan_digest: plan.plan_digest.clone(),
            resolver_image: "resolver@sha256:fixture".into(),
            platform: "linux/amd64".into(),
            manifest_sha256: "a".repeat(64),
            lockfile_sha256: "b".repeat(64),
            dependency_layer_sha256: "c".repeat(64),
            sbom_sha256: "d".repeat(64),
            packages: vec![ResolvedPackageV1 {
                package_id: package.id.clone(),
                name: package.name.clone(),
                version: package.version.clone(),
                integrity: package.integrity.clone(),
                licenses: vec!["MIT".into()],
            }],
            vulnerabilities: Vec::new(),
        }
    }

    #[test]
    fn plans_are_deterministic_and_bind_the_ir() {
        let first = plan();
        let second = plan();
        assert_eq!(first, second);
        assert_eq!(first.plan_digest.len(), 64);
        assert_eq!(first.roots[0].packages[0].id, "json-codec");
    }

    #[test]
    fn policy_fails_closed_on_drift_license_and_high_vulnerability() {
        let plan = plan();
        let mut evidence = evidence(&plan);
        evidence.packages[0].version = "9.9.9".into();
        evidence.packages[0].licenses = vec!["Proprietary".into()];
        evidence.vulnerabilities.push(VulnerabilityFindingV1 {
            package_id: "json-codec".into(),
            advisory_id: "TEST-1".into(),
            severity: VulnerabilitySeverityV1::High,
            summary: "fixture".into(),
        });
        let errors = verify_resolution_evidence(&plan, &evidence, &SupplyChainPolicyV1::default())
            .unwrap_err();
        assert!(errors
            .iter()
            .any(|error| matches!(error, ResolutionError::ResolutionDrift { .. })));
        assert!(errors
            .iter()
            .any(|error| matches!(error, ResolutionError::DisallowedLicense { .. })));
        assert!(errors
            .iter()
            .any(|error| matches!(error, ResolutionError::Vulnerability { .. })));
    }
}
