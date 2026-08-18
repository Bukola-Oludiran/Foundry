use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::repository::RunWorktree;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DependencyFileKind {
    Manifest,
    Lockfile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DependencyFileV1 {
    path: String,
    sha256: String,
    content_base64: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DependencyFileBundleV1 {
    bundle_version: u32,
    kind: DependencyFileKind,
    files: Vec<DependencyFileV1>,
}

fn decode_dependency_bundle(
    bytes: &[u8],
    kind: DependencyFileKind,
    expected_paths: &BTreeSet<String>,
) -> Result<Vec<(String, Vec<u8>)>, String> {
    use base64::Engine as _;
    let bundle: DependencyFileBundleV1 =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    if bundle.bundle_version != 1 || bundle.kind != kind {
        return Err("dependency file bundle has the wrong version or kind".into());
    }
    let actual_paths = bundle
        .files
        .iter()
        .map(|file| file.path.clone())
        .collect::<BTreeSet<_>>();
    if actual_paths.len() != bundle.files.len() || &actual_paths != expected_paths {
        return Err("dependency file bundle does not match the accepted package roots".into());
    }
    bundle
        .files
        .into_iter()
        .map(|file| {
            let content = base64::engine::general_purpose::STANDARD
                .decode(file.content_base64)
                .map_err(|_| format!("dependency file `{}` is not valid base64", file.path))?;
            let digest = format!("{:x}", Sha256::digest(&content));
            if digest != file.sha256 {
                return Err(format!(
                    "dependency file `{}` failed its checksum",
                    file.path
                ));
            }
            let lower = String::from_utf8_lossy(&content).to_ascii_lowercase();
            if ["authorization: bearer", "nsec1", "ghp_", "github_pat_"]
                .iter()
                .any(|marker| lower.contains(marker))
            {
                return Err(format!(
                    "dependency file `{}` contains secret-shaped material",
                    file.path
                ));
            }
            Ok((file.path, content))
        })
        .collect()
}

fn ensure_safe_parent(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    let parent = relative
        .parent()
        .ok_or_else(|| "dependency file has no parent".to_string())?;
    let mut current = root.to_path_buf();
    for component in parent.components() {
        let std::path::Component::Normal(component) = component else {
            return Err("dependency file path is not safe and relative".into());
        };
        current.push(component);
        match current.symlink_metadata() {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "refusing dependency file through symlink `{}`",
                    current.display()
                ));
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(format!(
                    "dependency parent `{}` is not a directory",
                    current.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current).map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let canonical = current.canonicalize().map_err(|error| error.to_string())?;
    if !canonical.starts_with(root) {
        return Err("dependency file parent escaped the isolated worktree".into());
    }
    Ok(current)
}

pub fn materialize_native_dependency_files(
    worktree: &RunWorktree,
    ir: &foundry_ir::IrV2,
    manifest_bundle: &[u8],
    lockfile_bundle: &[u8],
) -> Result<Vec<String>, String> {
    let manifests = ir
        .package_roots
        .iter()
        .map(|root| root.manifest_path.clone())
        .collect::<BTreeSet<_>>();
    let lockfiles = ir
        .package_roots
        .iter()
        .map(|root| root.lockfile_path.clone())
        .collect::<BTreeSet<_>>();
    let mut files =
        decode_dependency_bundle(manifest_bundle, DependencyFileKind::Manifest, &manifests)?;
    files.extend(decode_dependency_bundle(
        lockfile_bundle,
        DependencyFileKind::Lockfile,
        &lockfiles,
    )?);
    let root = worktree
        .path
        .canonicalize()
        .map_err(|error| error.to_string())?;

    for (relative, content) in &files {
        let target = root.join(relative);
        ensure_safe_parent(&root, Path::new(relative))?;
        if let Ok(metadata) = target.symlink_metadata() {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!(
                    "refusing dependency file at unsafe target `{relative}`"
                ));
            }
        }
        match std::fs::read(&target) {
            Ok(existing) if existing == *content => {}
            Ok(_) => {
                return Err(format!(
                    "refusing to replace conflicting dependency file `{relative}`"
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }

    for (relative, content) in &files {
        let target = root.join(relative);
        if target.exists() {
            continue;
        }
        let temporary = target.with_extension(format!("tmp-{}", std::process::id()));
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        use std::io::Write;
        if let Err(error) = file.write_all(content).and_then(|()| file.sync_all()) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.to_string());
        }
        if let Err(error) = std::fs::hard_link(&temporary, &target) {
            let _ = std::fs::remove_file(&temporary);
            return Err(error.to_string());
        }
        std::fs::remove_file(&temporary).map_err(|error| error.to_string())?;
        let parent = target
            .parent()
            .ok_or_else(|| "dependency target has no parent".to_string())?;
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
    }
    Ok(files.into_iter().map(|(path, _)| path).collect())
}
