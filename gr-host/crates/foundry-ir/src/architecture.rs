use std::collections::BTreeSet;

use crate::{compile, ArchitectureRequest};

const CURRENT_ARCHITECTURE_VERSION: u32 = 1;
const SUPPORTED_LANGUAGES: &[&str] = &["python", "typescript", "go"];

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ArchitectureRequestError {
    #[error("unsupported architecture request version `{0}` (expected `1`)")]
    UnsupportedVersion(u32),
    #[error("architecture request `{0}` must not be empty")]
    EmptyField(&'static str),
    #[error("architecture request must allow at least one language")]
    NoAllowedLanguages,
    #[error("architecture request contains duplicate language `{0}`")]
    DuplicateLanguage(String),
    #[error("architecture request contains unsupported language `{0}`")]
    UnsupportedLanguage(String),
    #[error("existing IR is invalid: {0}")]
    InvalidExistingIr(String),
}

pub fn validate_architecture_request(
    request: &ArchitectureRequest,
) -> Result<(), Vec<ArchitectureRequestError>> {
    let mut errors = Vec::new();
    if request.architecture_version != CURRENT_ARCHITECTURE_VERSION {
        errors.push(ArchitectureRequestError::UnsupportedVersion(
            request.architecture_version,
        ));
    }
    for (name, value) in [
        ("product_spec", request.product_spec.as_str()),
        ("repository", request.repository.as_str()),
        ("base_revision", request.base_revision.as_str()),
    ] {
        if value.trim().is_empty() {
            errors.push(ArchitectureRequestError::EmptyField(name));
        }
    }
    if request.allowed_languages.is_empty() {
        errors.push(ArchitectureRequestError::NoAllowedLanguages);
    }
    let mut languages = BTreeSet::new();
    for language in &request.allowed_languages {
        if !languages.insert(language.as_str()) {
            errors.push(ArchitectureRequestError::DuplicateLanguage(
                language.clone(),
            ));
        }
        if !SUPPORTED_LANGUAGES.contains(&language.as_str()) {
            errors.push(ArchitectureRequestError::UnsupportedLanguage(
                language.clone(),
            ));
        }
    }
    if let Some(ir) = &request.existing_ir {
        if let Err(diagnostics) = compile(ir) {
            errors.extend(
                diagnostics
                    .into_iter()
                    .map(|error| ArchitectureRequestError::InvalidExistingIr(error.to_string())),
            );
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

    #[test]
    fn validates_strict_versioned_request() {
        let request: ArchitectureRequest = serde_json::from_value(serde_json::json!({
            "architecture_version": 1,
            "product_spec": "Build a deterministic slugifier",
            "repository": ".",
            "base_revision": "HEAD",
            "allowed_languages": ["python", "typescript", "go"],
            "policy_constraints": ["no network"]
        }))
        .unwrap();
        assert!(validate_architecture_request(&request).is_ok());
    }

    #[test]
    fn rejects_unknown_fields_and_unsupported_languages() {
        let unknown = serde_json::from_value::<ArchitectureRequest>(serde_json::json!({
            "architecture_version": 1,
            "product_spec": "x",
            "repository": ".",
            "base_revision": "HEAD",
            "allowed_languages": ["python"],
            "surprise": true
        }));
        assert!(unknown.is_err());

        let request = ArchitectureRequest {
            architecture_version: 9,
            product_spec: "x".into(),
            repository: ".".into(),
            base_revision: "HEAD".into(),
            allowed_languages: vec!["rust".into(), "rust".into()],
            policy_constraints: Vec::new(),
            existing_ir: None,
        };
        let errors = validate_architecture_request(&request).unwrap_err();
        assert!(errors
            .iter()
            .any(|error| matches!(error, ArchitectureRequestError::UnsupportedVersion(9))));
        assert!(errors.iter().any(|error| matches!(
            error,
            ArchitectureRequestError::UnsupportedLanguage(language) if language == "rust"
        )));
        assert!(errors.iter().any(|error| matches!(
            error,
            ArchitectureRequestError::DuplicateLanguage(language) if language == "rust"
        )));
    }
}
