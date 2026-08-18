use std::collections::BTreeSet;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::durable::DurableEnvironmentEvidence;
use crate::repository::RunWorktree;

const MAX_SERVICES: usize = 256;
const MAX_MIGRATIONS: usize = 256;
const MAX_ARTIFACT_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactRefV1 {
    sha256: String,
    size: u64,
    media_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ServiceHealthV1 {
    id: String,
    healthy: bool,
    detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EnvironmentHealthV1 {
    environment_id: String,
    plan_digest: String,
    healthy: bool,
    services: Vec<ServiceHealthV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MigrationOutcomeV1 {
    resource_id: String,
    owner_node: String,
    migration_digest: String,
    applied: bool,
    repeatable_verified: bool,
    duration_ms: u64,
    diagnostic: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MigrationResultV1 {
    environment_id: String,
    plan_digest: String,
    green: bool,
    outcomes: Vec<MigrationOutcomeV1>,
    artifact: ArtifactRefV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EnvironmentSnapshotV1 {
    environment_id: String,
    plan_digest: String,
    snapshot_digest: String,
    artifact: ArtifactRefV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EnvironmentTeardownV1 {
    environment_id: String,
    plan_digest: String,
    stopped: bool,
    cleanup_complete: bool,
    diagnostic_artifact: Option<ArtifactRefV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EnvironmentLifecycleEvidenceV1 {
    evidence_version: u32,
    environment_id: String,
    plan_digest: String,
    health: EnvironmentHealthV1,
    migrations: Option<MigrationResultV1>,
    snapshot: EnvironmentSnapshotV1,
    teardown: EnvironmentTeardownV1,
}

fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'.' | b':' | b'-'))
        })
}

fn validate_artifact(artifact: &ArtifactRefV1) -> Result<(), String> {
    if !is_digest(&artifact.sha256)
        || artifact.size > MAX_ARTIFACT_BYTES
        || artifact.media_type.is_empty()
        || artifact.media_type.len() > 200
    {
        return Err("environment evidence contains invalid artifact metadata".into());
    }
    Ok(())
}

fn contains_secret_material(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    [
        "authorization",
        "bearer ",
        "cookie",
        "password",
        "private_key",
        "private key",
        "nsec1",
        "ghp_",
        "github_pat_",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn validate_evidence(
    evidence: &DurableEnvironmentEvidence,
) -> Result<EnvironmentLifecycleEvidenceV1, String> {
    let health: EnvironmentHealthV1 =
        serde_json::from_value(evidence.health.clone()).map_err(|error| error.to_string())?;
    let migrations: Option<MigrationResultV1> = evidence
        .migrations
        .clone()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| error.to_string())?;
    let snapshot: EnvironmentSnapshotV1 =
        serde_json::from_value(evidence.snapshot.clone()).map_err(|error| error.to_string())?;
    let teardown: EnvironmentTeardownV1 =
        serde_json::from_value(evidence.teardown.clone()).map_err(|error| error.to_string())?;

    if !is_safe_id(&health.environment_id) || !is_digest(&health.plan_digest) {
        return Err("environment evidence has an invalid identity".into());
    }
    let identity_matches = |environment_id: &str, plan_digest: &str| {
        environment_id == health.environment_id && plan_digest == health.plan_digest
    };
    if !identity_matches(&snapshot.environment_id, &snapshot.plan_digest)
        || !identity_matches(&teardown.environment_id, &teardown.plan_digest)
        || migrations
            .as_ref()
            .is_some_and(|result| !identity_matches(&result.environment_id, &result.plan_digest))
    {
        return Err("environment lifecycle evidence does not share one identity".into());
    }
    if !health.healthy
        || health.services.len() > MAX_SERVICES
        || health.services.iter().any(|service| !service.healthy)
    {
        return Err("environment health evidence is not complete and green".into());
    }
    let mut service_ids = BTreeSet::new();
    for service in &health.services {
        if !is_safe_id(&service.id)
            || !service_ids.insert(&service.id)
            || service
                .detail
                .as_ref()
                .is_some_and(|detail| detail.len() > 512 || contains_secret_material(detail))
        {
            return Err("environment health evidence is invalid or unsafe".into());
        }
    }
    if evidence.migrations_required != migrations.is_some() {
        return Err("environment migration evidence does not match the accepted plan".into());
    }
    if let Some(result) = &migrations {
        let mut resource_ids = BTreeSet::new();
        if !result.green
            || result.outcomes.is_empty()
            || result.outcomes.len() > MAX_MIGRATIONS
            || result.outcomes.iter().any(|outcome| {
                !is_safe_id(&outcome.resource_id)
                    || !resource_ids.insert(&outcome.resource_id)
                    || !is_safe_id(&outcome.owner_node)
                    || !is_digest(&outcome.migration_digest)
                    || !outcome.applied
                    || outcome.duration_ms > 86_400_000
                    || outcome.diagnostic.as_ref().is_some_and(|diagnostic| {
                        diagnostic.len() > 1024 || contains_secret_material(diagnostic)
                    })
            })
        {
            return Err("migration evidence is not complete and green".into());
        }
        validate_artifact(&result.artifact)?;
    }
    if !is_digest(&snapshot.snapshot_digest) {
        return Err("environment snapshot digest is invalid".into());
    }
    validate_artifact(&snapshot.artifact)?;
    if !teardown.stopped || !teardown.cleanup_complete {
        return Err("environment teardown evidence is incomplete".into());
    }
    if let Some(artifact) = &teardown.diagnostic_artifact {
        validate_artifact(artifact)?;
    }

    Ok(EnvironmentLifecycleEvidenceV1 {
        evidence_version: 1,
        environment_id: health.environment_id.clone(),
        plan_digest: health.plan_digest.clone(),
        health,
        migrations,
        snapshot,
        teardown,
    })
}

pub fn materialize_environment_evidence(
    worktree: &RunWorktree,
    evidence: &DurableEnvironmentEvidence,
) -> Result<Vec<String>, String> {
    let evidence = validate_evidence(evidence)?;
    let bytes = serde_json::to_vec_pretty(&evidence).map_err(|error| error.to_string())?;
    let serialized = String::from_utf8_lossy(&bytes);
    if contains_secret_material(&serialized) {
        return Err("environment evidence contains secret-shaped material".into());
    }

    let root = worktree
        .path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let foundry_dir = root.join(".foundry");
    let resources_dir = foundry_dir.join("resources");
    for candidate in [&foundry_dir, &resources_dir] {
        if candidate
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(format!(
                "refusing environment evidence through symlink `{}`",
                candidate.display()
            ));
        }
        if !candidate.exists() {
            std::fs::create_dir(candidate).map_err(|error| error.to_string())?;
        }
    }
    let canonical_resources = resources_dir
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical_resources.starts_with(&root) {
        return Err("environment evidence escaped the isolated worktree".into());
    }

    let path = resources_dir.join("evidence.json");
    match std::fs::read(&path) {
        Ok(existing) if existing == bytes => {
            return Ok(vec![".foundry/resources/evidence.json".into()]);
        }
        Ok(_) => return Err("refusing to replace conflicting environment evidence".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    use std::io::Write;
    if let Err(error) = file.write_all(&bytes).and_then(|()| file.sync_all()) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    if let Err(error) = std::fs::hard_link(&temporary, &path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    std::fs::remove_file(&temporary).map_err(|error| error.to_string())?;
    std::fs::File::open(Path::new(&resources_dir))
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(vec![".foundry/resources/evidence.json".into()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn worktree(label: &str) -> RunWorktree {
        let path = std::env::temp_dir().join(format!(
            "foundry-environment-evidence-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir(&path).unwrap();
        RunWorktree {
            path,
            branch: "foundry/test".into(),
            base_commit: "b".repeat(40),
        }
    }

    fn artifact(character: &str) -> serde_json::Value {
        json!({
            "sha256": character.repeat(64),
            "size": 12,
            "media_type": "application/json"
        })
    }

    fn evidence() -> DurableEnvironmentEvidence {
        DurableEnvironmentEvidence {
            health: json!({
                "environment_id": "environment-run-1",
                "plan_digest": "a".repeat(64),
                "healthy": true,
                "services": [{"id": "primary-db", "healthy": true, "detail": null}]
            }),
            migrations: Some(json!({
                "environment_id": "environment-run-1",
                "plan_digest": "a".repeat(64),
                "green": true,
                "outcomes": [{
                    "resource_id": "primary-db",
                    "owner_node": "api",
                    "migration_digest": "b".repeat(64),
                    "applied": true,
                    "repeatable_verified": true,
                    "duration_ms": 12,
                    "diagnostic": null
                }],
                "artifact": artifact("c")
            })),
            migrations_required: true,
            snapshot: json!({
                "environment_id": "environment-run-1",
                "plan_digest": "a".repeat(64),
                "snapshot_digest": "d".repeat(64),
                "artifact": artifact("e")
            }),
            teardown: json!({
                "environment_id": "environment-run-1",
                "plan_digest": "a".repeat(64),
                "stopped": true,
                "cleanup_complete": true,
                "diagnostic_artifact": null
            }),
        }
    }

    #[test]
    fn materializes_complete_evidence_idempotently() {
        let worktree = worktree("green");
        let paths = materialize_environment_evidence(&worktree, &evidence()).unwrap();
        assert_eq!(paths, vec![".foundry/resources/evidence.json"]);
        materialize_environment_evidence(&worktree, &evidence()).unwrap();
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(worktree.path.join(&paths[0])).unwrap()).unwrap();
        assert_eq!(persisted["evidence_version"], 1);
        let _ = std::fs::remove_dir_all(worktree.path);
    }

    #[test]
    fn rejects_mismatched_or_incomplete_lifecycle() {
        let worktree = worktree("mismatch");
        let mut mismatched = evidence();
        mismatched.snapshot["plan_digest"] = json!("f".repeat(64));
        assert!(materialize_environment_evidence(&worktree, &mismatched).is_err());
        let mut missing = evidence();
        missing.migrations = None;
        assert!(materialize_environment_evidence(&worktree, &missing).is_err());
        let mut incomplete = evidence();
        incomplete.teardown["cleanup_complete"] = json!(false);
        assert!(materialize_environment_evidence(&worktree, &incomplete).is_err());
        let _ = std::fs::remove_dir_all(worktree.path);
    }

    #[test]
    fn rejects_secrets_and_conflicting_recovery_output() {
        let worktree = worktree("unsafe");
        let mut unsafe_evidence = evidence();
        unsafe_evidence.health["services"][0]["detail"] = json!("Authorization: Bearer hidden");
        assert!(materialize_environment_evidence(&worktree, &unsafe_evidence).is_err());

        materialize_environment_evidence(&worktree, &evidence()).unwrap();
        let mut changed = evidence();
        changed.health["services"][0]["detail"] = json!("ready");
        assert!(materialize_environment_evidence(&worktree, &changed).is_err());
        let _ = std::fs::remove_dir_all(worktree.path);
    }
}
