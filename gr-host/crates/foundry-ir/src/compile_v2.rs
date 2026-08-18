//! Validation and lowering for IR v2 infrastructure and supply-chain contracts.

use crate::v2::{IrV2, PackageEcosystemV2, ResourceKindV2, ResourcePermissionV2, IR_V2_VERSION};
use crate::{compile, BuildPlan, CompileError};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CompileV2Error {
    #[error("unsupported IR version `{got}` (expected `2`)")]
    UnsupportedVersion { got: u32 },
    #[error("v1 core: {0}")]
    Core(CompileError),
    #[error("{path}: {message}")]
    Invalid { path: String, message: String },
}

#[derive(Debug, Clone)]
pub struct BuildPlanV2 {
    pub core: BuildPlan,
    pub packages_by_node: BTreeMap<String, Vec<String>>,
    pub resources_by_node: BTreeMap<String, Vec<String>>,
    pub integrations_by_node: BTreeMap<String, Vec<String>>,
}

fn invalid(errors: &mut Vec<CompileV2Error>, path: impl Into<String>, message: impl Into<String>) {
    errors.push(CompileV2Error::Invalid {
        path: path.into(),
        message: message.into(),
    });
}

fn safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || (byte == b'-' && index > 0)
        })
        && !id.ends_with('-')
        && !id.contains("--")
}

fn safe_relative_path(raw: &str) -> bool {
    let path = Path::new(raw);
    !raw.is_empty()
        && !raw.contains('\\')
        && !raw.contains(':')
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn exact_version(version: &str) -> bool {
    let normalized = version.to_ascii_lowercase();
    !version.trim().is_empty()
        && version == version.trim()
        && !matches!(
            normalized.as_str(),
            "latest" | "next" | "stable" | "head" | "main" | "master"
        )
        && !version
            .bytes()
            .any(|byte| matches!(byte, b'*' | b'^' | b'~' | b'<' | b'>' | b'=' | b',' | b' '))
        && !version.contains('/')
        && !version.contains("://")
}

fn valid_integrity(integrity: &str) -> bool {
    ["sha256-", "sha512-", "h1:"]
        .iter()
        .any(|prefix| integrity.starts_with(prefix) && integrity.len() > prefix.len() + 8)
}

fn valid_environment_name(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_uppercase()
                || byte.is_ascii_digit() && index > 0
                || byte == b'_' && index > 0
        })
}

fn contains_secret(value: &Value) -> bool {
    const SECRET_KEYS: &[&str] = &[
        "password",
        "passwd",
        "secret",
        "token",
        "credential",
        "private_key",
        "authorization",
        "cookie",
    ];
    const SECRET_MARKERS: &[&str] = &[
        "bearer ",
        "begin private key",
        "nsec1",
        "ghp_",
        "github_pat_",
        "sk-",
    ];
    match value {
        Value::Object(map) => map.iter().any(|(key, value)| {
            let key = key.to_ascii_lowercase();
            SECRET_KEYS.iter().any(|marker| key.contains(marker)) || contains_secret(value)
        }),
        Value::Array(values) => values.iter().any(contains_secret),
        Value::String(value) => {
            let value = value.to_ascii_lowercase();
            SECRET_MARKERS.iter().any(|marker| value.contains(marker))
                || (value.contains("://") && value.contains('@'))
        }
        _ => false,
    }
}

fn validate_resource_configuration(
    errors: &mut Vec<CompileV2Error>,
    path: &str,
    kind: &ResourceKindV2,
    configuration: &BTreeMap<String, Value>,
) {
    let allowed: &[&str] = match kind {
        ResourceKindV2::Postgresql => &["database"],
        ResourceKindV2::Redis => &["maxmemory_mb"],
        ResourceKindV2::S3 => &["buckets"],
        ResourceKindV2::Nats => &["subjects"],
        ResourceKindV2::Smtp => &["inboxes"],
        ResourceKindV2::Oidc => &["realm", "clients"],
    };
    for key in configuration.keys() {
        if !allowed.contains(&key.as_str()) {
            invalid(
                errors,
                format!("{path}.configuration.{key}"),
                format!("unsupported configuration key for {kind:?}"),
            );
        }
    }
    for (key, value) in configuration {
        let valid = match key.as_str() {
            "database" | "realm" => value.as_str().is_some_and(|value| !value.is_empty()),
            "maxmemory_mb" => value.as_u64().is_some_and(|value| value > 0),
            "buckets" | "subjects" | "inboxes" | "clients" => {
                value.as_array().is_some_and(|values| {
                    !values.is_empty()
                        && values
                            .iter()
                            .all(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                })
            }
            _ => false,
        };
        if !valid {
            invalid(
                errors,
                format!("{path}.configuration.{key}"),
                "invalid bounded configuration value",
            );
        }
    }
}

fn insert_unique<'a>(
    errors: &mut Vec<CompileV2Error>,
    seen: &mut BTreeSet<&'a str>,
    id: &'a str,
    path: &str,
) {
    if !safe_id(id) {
        invalid(errors, path, "must be a safe kebab-case identifier");
    }
    if !seen.insert(id) {
        invalid(errors, path, format!("duplicate identifier `{id}`"));
    }
}

pub fn compile_v2(ir: &IrV2) -> Result<BuildPlanV2, Vec<CompileV2Error>> {
    let mut errors = Vec::new();
    if ir.ir_version != IR_V2_VERSION {
        errors.push(CompileV2Error::UnsupportedVersion { got: ir.ir_version });
    }
    let core = match compile(&ir.v1_core()) {
        Ok(plan) => Some(plan),
        Err(core_errors) => {
            errors.extend(core_errors.into_iter().map(CompileV2Error::Core));
            None
        }
    };
    let node_ids: BTreeSet<_> = ir.nodes.iter().map(|node| node.id.as_str()).collect();
    let node_languages: BTreeMap<_, _> = ir
        .nodes
        .iter()
        .map(|node| {
            (
                node.id.as_str(),
                node.implementation
                    .language
                    .as_deref()
                    .or(ir.spec.language.as_deref())
                    .unwrap_or("python"),
            )
        })
        .collect();

    let mut root_ids = BTreeSet::new();
    let mut root_paths = BTreeSet::new();
    for (index, root) in ir.package_roots.iter().enumerate() {
        let path = format!("package_roots[{index}]");
        insert_unique(&mut errors, &mut root_ids, &root.id, &format!("{path}.id"));
        if !matches!(root.language.as_str(), "python" | "typescript" | "go") {
            invalid(
                &mut errors,
                format!("{path}.language"),
                "unsupported language",
            );
        }
        for (name, candidate) in [
            ("manifest_path", root.manifest_path.as_str()),
            ("lockfile_path", root.lockfile_path.as_str()),
        ] {
            if !safe_relative_path(candidate) {
                invalid(
                    &mut errors,
                    format!("{path}.{name}"),
                    "unsafe repository path",
                );
            }
            if !root_paths.insert(candidate) {
                invalid(
                    &mut errors,
                    format!("{path}.{name}"),
                    "path must be globally unique",
                );
            }
        }
        let expected_files = match root.language.as_str() {
            "typescript" => ("package.json", "package-lock.json"),
            "python" => ("pyproject.toml", "requirements.lock"),
            "go" => ("go.mod", "go.sum"),
            _ => ("", ""),
        };
        if !expected_files.0.is_empty()
            && (!root.manifest_path.ends_with(expected_files.0)
                || !root.lockfile_path.ends_with(expected_files.1))
        {
            invalid(
                &mut errors,
                &path,
                format!(
                    "{} package roots require `{}` and `{}`",
                    root.language, expected_files.0, expected_files.1
                ),
            );
        }
        for member in &root.workspace_members {
            if !safe_relative_path(member) {
                invalid(
                    &mut errors,
                    format!("{path}.workspace_members"),
                    "unsafe member path",
                );
            }
        }
        for registry in &root.registry_allowlist {
            let valid = registry.starts_with("https://")
                && !registry.contains('@')
                && !registry.contains('#');
            if !valid {
                invalid(
                    &mut errors,
                    format!("{path}.registry_allowlist"),
                    "registries must be credential-free HTTPS origins",
                );
            }
        }
    }

    let roots: BTreeMap<_, _> = ir
        .package_roots
        .iter()
        .map(|root| (root.id.as_str(), root))
        .collect();
    let mut package_ids = BTreeSet::new();
    let mut package_coordinates = BTreeSet::new();
    let mut package_root_by_node: BTreeMap<&str, &str> = BTreeMap::new();
    let mut packages_by_node: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (index, package) in ir.packages.iter().enumerate() {
        let path = format!("packages[{index}]");
        insert_unique(
            &mut errors,
            &mut package_ids,
            &package.id,
            &format!("{path}.id"),
        );
        if package.name.trim().is_empty() {
            invalid(
                &mut errors,
                format!("{path}.name"),
                "package name must not be empty",
            );
        }
        if !exact_version(&package.version) {
            invalid(
                &mut errors,
                format!("{path}.version"),
                "must be one exact registry version, not a range or source URL",
            );
        }
        if !valid_integrity(&package.integrity) {
            invalid(
                &mut errors,
                format!("{path}.integrity"),
                "must use sha256-, sha512-, or h1: integrity",
            );
        }
        if !node_ids.contains(package.owner_node.as_str()) {
            invalid(&mut errors, format!("{path}.owner_node"), "unknown node");
        }
        match roots.get(package.package_root.as_str()) {
            None => invalid(
                &mut errors,
                format!("{path}.package_root"),
                "unknown package root",
            ),
            Some(root) => {
                let expected = match package.ecosystem {
                    PackageEcosystemV2::Npm => "typescript",
                    PackageEcosystemV2::Pypi => "python",
                    PackageEcosystemV2::Go => "go",
                };
                if root.language != expected {
                    invalid(
                        &mut errors,
                        format!("{path}.ecosystem"),
                        format!("requires a `{expected}` package root"),
                    );
                }
                if node_languages.get(package.owner_node.as_str()) != Some(&expected) {
                    invalid(
                        &mut errors,
                        format!("{path}.owner_node"),
                        format!("owner must use `{expected}`"),
                    );
                }
                if !root.resolver.allow_prereleases && package.version.contains('-') {
                    invalid(
                        &mut errors,
                        format!("{path}.version"),
                        "prerelease version is forbidden by the package-root resolver policy",
                    );
                }
            }
        }
        if !package_coordinates.insert((package.package_root.as_str(), package.name.as_str())) {
            invalid(&mut errors, &path, "duplicate package in package root");
        }
        if package_root_by_node
            .insert(package.owner_node.as_str(), package.package_root.as_str())
            .is_some_and(|existing| existing != package.package_root)
        {
            invalid(
                &mut errors,
                format!("{path}.package_root"),
                "one node may consume packages from only one package root",
            );
        }
        packages_by_node
            .entry(package.owner_node.clone())
            .or_default()
            .push(package.id.clone());
    }

    let mut resource_ids = BTreeSet::new();
    for (index, resource) in ir.resources.iter().enumerate() {
        let path = format!("resources[{index}]");
        insert_unique(
            &mut errors,
            &mut resource_ids,
            &resource.id,
            &format!("{path}.id"),
        );
        if !exact_version(&resource.version) {
            invalid(
                &mut errors,
                format!("{path}.version"),
                "resource version must be exact",
            );
        }
        if contains_secret(&Value::Object(
            resource.configuration.clone().into_iter().collect(),
        )) {
            invalid(
                &mut errors,
                format!("{path}.configuration"),
                "secret values and secret-shaped keys are forbidden",
            );
        }
        validate_resource_configuration(
            &mut errors,
            &path,
            &resource.kind,
            &resource.configuration,
        );
        match (&resource.migration_owner, &resource.migration_path) {
            (Some(owner), Some(migration_path)) => {
                if resource.kind != ResourceKindV2::Postgresql {
                    invalid(
                        &mut errors,
                        &path,
                        "only PostgreSQL resources accept migrations",
                    );
                }
                if !node_ids.contains(owner.as_str()) {
                    invalid(
                        &mut errors,
                        format!("{path}.migration_owner"),
                        "unknown node",
                    );
                }
                if !safe_relative_path(migration_path) {
                    invalid(&mut errors, format!("{path}.migration_path"), "unsafe path");
                }
            }
            (None, None) => {}
            _ => invalid(
                &mut errors,
                &path,
                "migration_owner and migration_path must be declared together",
            ),
        }
    }

    let resources: BTreeMap<_, _> = ir
        .resources
        .iter()
        .map(|resource| (resource.id.as_str(), resource))
        .collect();
    let mut resource_bindings = BTreeSet::new();
    let mut resources_by_node: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (index, binding) in ir.resource_bindings.iter().enumerate() {
        let path = format!("resource_bindings[{index}]");
        let Some(resource) = resources.get(binding.resource.as_str()) else {
            invalid(&mut errors, format!("{path}.resource"), "unknown resource");
            continue;
        };
        if !node_ids.contains(binding.node.as_str()) {
            invalid(&mut errors, format!("{path}.node"), "unknown node");
        }
        if !resource_bindings.insert((binding.resource.as_str(), binding.node.as_str())) {
            invalid(&mut errors, &path, "duplicate resource binding");
        }
        let permissions: BTreeSet<_> = binding.permissions.iter().copied().collect();
        if permissions.is_empty() || permissions.len() != binding.permissions.len() {
            invalid(
                &mut errors,
                format!("{path}.permissions"),
                "must be non-empty and unique",
            );
        }
        if permissions.contains(&ResourcePermissionV2::Admin)
            && resource.migration_owner.as_deref() != Some(binding.node.as_str())
        {
            invalid(
                &mut errors,
                format!("{path}.permissions"),
                "admin is reserved for the declared migration owner",
            );
        }
        if resource.kind != ResourceKindV2::Nats
            && (permissions.contains(&ResourcePermissionV2::Publish)
                || permissions.contains(&ResourcePermissionV2::Consume))
        {
            invalid(
                &mut errors,
                format!("{path}.permissions"),
                "publish and consume permissions apply only to NATS",
            );
        }
        for environment_name in binding.environment.values() {
            if !valid_environment_name(environment_name) {
                invalid(
                    &mut errors,
                    format!("{path}.environment"),
                    "values must be uppercase environment-variable names",
                );
            }
        }
        resources_by_node
            .entry(binding.node.clone())
            .or_default()
            .push(binding.resource.clone());
    }

    let mut integration_ids = BTreeSet::new();
    for (index, integration) in ir.integrations.iter().enumerate() {
        let path = format!("integrations[{index}]");
        insert_unique(
            &mut errors,
            &mut integration_ids,
            &integration.id,
            &format!("{path}.id"),
        );
        let operations: BTreeSet<_> = integration.operations.iter().map(String::as_str).collect();
        if operations.is_empty()
            || operations.len() != integration.operations.len()
            || operations
                .iter()
                .any(|operation| operation.trim().is_empty())
        {
            invalid(
                &mut errors,
                format!("{path}.operations"),
                "must be non-empty and unique",
            );
        }
        if integration
            .contract_path
            .as_deref()
            .is_some_and(|path| !safe_relative_path(path))
        {
            invalid(&mut errors, format!("{path}.contract_path"), "unsafe path");
        }
    }
    let integrations: BTreeMap<_, _> = ir
        .integrations
        .iter()
        .map(|integration| (integration.id.as_str(), integration))
        .collect();

    let mut secret_ids = BTreeSet::new();
    for (index, secret) in ir.secret_refs.iter().enumerate() {
        let path = format!("secret_refs[{index}]");
        insert_unique(
            &mut errors,
            &mut secret_ids,
            &secret.id,
            &format!("{path}.id"),
        );
        if !valid_environment_name(&secret.name) {
            invalid(
                &mut errors,
                format!("{path}.name"),
                "must be a logical uppercase secret name, never a value",
            );
        }
    }

    let mut integration_bindings = BTreeSet::new();
    let mut integrations_by_node: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (index, binding) in ir.integration_bindings.iter().enumerate() {
        let path = format!("integration_bindings[{index}]");
        let Some(integration) = integrations.get(binding.integration.as_str()) else {
            invalid(
                &mut errors,
                format!("{path}.integration"),
                "unknown integration",
            );
            continue;
        };
        if !node_ids.contains(binding.node.as_str()) {
            invalid(&mut errors, format!("{path}.node"), "unknown node");
        }
        if !integration_bindings.insert((binding.integration.as_str(), binding.node.as_str())) {
            invalid(&mut errors, &path, "duplicate integration binding");
        }
        let declared: BTreeSet<_> = integration.operations.iter().map(String::as_str).collect();
        let requested: BTreeSet<_> = binding.operations.iter().map(String::as_str).collect();
        if requested.is_empty() || requested.len() != binding.operations.len() {
            invalid(
                &mut errors,
                format!("{path}.operations"),
                "must be non-empty and unique",
            );
        }
        for operation in requested.difference(&declared) {
            invalid(
                &mut errors,
                format!("{path}.operations"),
                format!("undeclared operation `{operation}`"),
            );
        }
        if binding
            .secret_ref
            .as_deref()
            .is_some_and(|secret| !secret_ids.contains(secret))
        {
            invalid(
                &mut errors,
                format!("{path}.secret_ref"),
                "unknown secret reference",
            );
        }
        if matches!(
            integration.kind,
            crate::v2::IntegrationKindV2::Stripe | crate::v2::IntegrationKindV2::Openai
        ) && binding.secret_ref.is_none()
        {
            invalid(
                &mut errors,
                format!("{path}.secret_ref"),
                "this integration kind requires a logical authentication reference",
            );
        }
        if integration.kind == crate::v2::IntegrationKindV2::Stripe && !binding.idempotency {
            invalid(
                &mut errors,
                format!("{path}.idempotency"),
                "payment operations require idempotency",
            );
        }
        if binding.timeout_ms == 0 {
            invalid(
                &mut errors,
                format!("{path}.timeout_ms"),
                "must be positive",
            );
        }
        if binding.retry.max_attempts == 0
            || binding.retry.initial_backoff_ms == 0
            || binding.retry.max_backoff_ms < binding.retry.initial_backoff_ms
        {
            invalid(
                &mut errors,
                format!("{path}.retry"),
                "invalid bounded retry policy",
            );
        }
        if binding
            .rate_limit
            .as_ref()
            .is_some_and(|limit| limit.requests == 0 || limit.per_seconds == 0)
        {
            invalid(
                &mut errors,
                format!("{path}.rate_limit"),
                "values must be positive",
            );
        }
        integrations_by_node
            .entry(binding.node.clone())
            .or_default()
            .push(binding.integration.clone());
    }

    let mut test_nodes = BTreeSet::new();
    for (index, environment) in ir.test_environments.iter().enumerate() {
        let path = format!("test_environments[{index}]");
        if !node_ids.contains(environment.node.as_str()) {
            invalid(&mut errors, format!("{path}.node"), "unknown node");
        }
        if !test_nodes.insert(environment.node.as_str()) {
            invalid(
                &mut errors,
                format!("{path}.node"),
                "duplicate test environment",
            );
        }
        let bound_resources: BTreeSet<_> = resources_by_node
            .get(&environment.node)
            .into_iter()
            .flatten()
            .map(String::as_str)
            .collect();
        for resource in &environment.resources {
            if !bound_resources.contains(resource.as_str()) {
                invalid(
                    &mut errors,
                    format!("{path}.resources"),
                    format!("resource `{resource}` is not bound to the node"),
                );
            }
        }
        let bound_integrations: BTreeSet<_> = integrations_by_node
            .get(&environment.node)
            .into_iter()
            .flatten()
            .map(String::as_str)
            .collect();
        for integration in &environment.integrations {
            if !bound_integrations.contains(integration.as_str()) {
                invalid(
                    &mut errors,
                    format!("{path}.integrations"),
                    format!("integration `{integration}` is not bound to the node"),
                );
            }
        }
        if contains_secret(&serde_json::to_value(environment).unwrap_or(Value::Null)) {
            invalid(
                &mut errors,
                &path,
                "fixtures and expectations must not contain secret material",
            );
        }
        for seed in &environment.database_seeds {
            if !resources
                .get(seed.resource.as_str())
                .is_some_and(|resource| resource.kind == ResourceKindV2::Postgresql)
            {
                invalid(
                    &mut errors,
                    format!("{path}.database_seeds"),
                    "database seed must target a declared PostgreSQL resource",
                );
            }
        }
    }

    if !errors.is_empty() {
        return Err(errors);
    }
    Ok(BuildPlanV2 {
        core: core.expect("core plan exists when validation has no errors"),
        packages_by_node,
        resources_by_node,
        integrations_by_node,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v2::IrDocument;

    fn fixture() -> IrV2 {
        let raw = include_str!("../../../../ir/examples/service-stack.ir-v2.json");
        match serde_json::from_str::<IrDocument>(raw).expect("v2 fixture parses strictly") {
            IrDocument::V2(ir) => ir,
            IrDocument::V1(_) => panic!("fixture was reinterpreted as v1"),
        }
    }

    #[test]
    fn compiles_v2_without_reinterpreting_v1() {
        let plan = compile_v2(&fixture()).expect("fixture compiles");
        assert_eq!(plan.packages_by_node["api"], vec!["json-codec"]);
        assert_eq!(plan.resources_by_node["api"], vec!["primary-db"]);
        assert_eq!(plan.integrations_by_node["api"], vec!["payments"]);
    }

    #[test]
    fn rejects_secret_literals_and_undeclared_test_bindings() {
        let mut ir = fixture();
        ir.resources[0]
            .configuration
            .insert("password".into(), Value::String("do-not-store".into()));
        ir.test_environments[0]
            .resources
            .push("missing-cache".into());
        let errors = compile_v2(&ir).expect_err("invalid v2 must fail closed");
        assert!(errors
            .iter()
            .any(|error| error.to_string().contains("secret")));
        assert!(errors
            .iter()
            .any(|error| error.to_string().contains("not bound")));
    }

    #[test]
    fn rejects_kind_incompatible_configuration_and_authority() {
        let mut ir = fixture();
        ir.resources[0]
            .configuration
            .insert("buckets".into(), serde_json::json!(["wrong-kind"]));
        ir.resource_bindings[0]
            .permissions
            .push(ResourcePermissionV2::Publish);
        ir.integration_bindings[0].secret_ref = None;
        ir.integration_bindings[0].idempotency = false;
        let errors = compile_v2(&ir).expect_err("kind-specific policy must fail closed");
        let diagnostics = errors
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        assert!(diagnostics.contains("unsupported configuration key"));
        assert!(diagnostics.contains("apply only to NATS"));
        assert!(diagnostics.contains("authentication reference"));
        assert!(diagnostics.contains("require idempotency"));
    }

    #[test]
    fn v1_fixture_remains_v1() {
        let raw = include_str!("../../../../ir/examples/string-utils.ir.json");
        assert!(matches!(
            serde_json::from_str::<IrDocument>(raw).unwrap(),
            IrDocument::V1(_)
        ));
    }
}
