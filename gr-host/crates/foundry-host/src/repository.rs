use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

#[derive(Debug, Clone)]
pub struct RunWorktree {
    pub path: PathBuf,
    pub branch: String,
    pub base_commit: String,
}

#[derive(Debug, Clone)]
pub struct DiffPolicy {
    pub allowed_paths: BTreeSet<String>,
    pub max_file_bytes: u64,
}

/// Writes the approved architecture contract only inside Foundry's isolated worktree.
pub fn materialize_architecture_files(
    worktree: &RunWorktree,
    ir: &foundry_ir::Ir,
    rationale: &serde_json::Value,
    layout: &serde_json::Value,
    locks: &serde_json::Value,
) -> Result<Vec<String>, String> {
    let foundry_dir = worktree.path.join(".foundry");
    let architecture_dir = foundry_dir.join("architecture");
    for candidate in [&foundry_dir, &architecture_dir] {
        if candidate
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(format!(
                "refusing architecture materialization through symlink `{}`",
                candidate.display()
            ));
        }
    }
    std::fs::create_dir_all(&architecture_dir).map_err(|error| error.to_string())?;
    let root = worktree
        .path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let target = architecture_dir
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !target.starts_with(&root) {
        return Err("architecture materialization escaped the isolated worktree".into());
    }

    fn atomic_json(path: &Path, value: &impl serde::Serialize) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
        let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        use std::io::Write;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, path).map_err(|error| error.to_string())
    }

    atomic_json(&architecture_dir.join("ir.json"), ir)?;
    atomic_json(
        &architecture_dir.join("rationale.json"),
        &serde_json::json!({ "rationale": rationale, "boundary_locks": locks }),
    )?;
    atomic_json(&architecture_dir.join("layout.json"), layout)?;
    Ok(vec![
        ".foundry/architecture/ir.json".into(),
        ".foundry/architecture/rationale.json".into(),
        ".foundry/architecture/layout.json".into(),
    ])
}

pub trait RepositoryProvider {
    fn prepare_worktree(
        &self,
        repository: &Path,
        destination: &Path,
        base_revision: &str,
        run_id: &str,
    ) -> Result<RunWorktree, String>;

    fn validate_diff(
        &self,
        worktree: &RunWorktree,
        policy: &DiffPolicy,
    ) -> Result<Vec<String>, String>;

    fn commit(
        &self,
        worktree: &RunWorktree,
        paths: &[String],
        message: &str,
    ) -> Result<String, String>;
}

#[derive(Debug, Default)]
pub struct LocalGitRepository;

pub trait PullRequestPublisher {
    fn publish_draft(
        &self,
        repository: &Path,
        run_id: &str,
        base_branch: &str,
        title: &str,
        body: &str,
    ) -> Result<String, String>;
}

#[derive(Debug, Default)]
pub struct GitHubRepositoryProvider;

fn output(command: &mut Command) -> Result<Output, String> {
    let rendered = format!("{command:?}");
    let output = command
        .output()
        .map_err(|error| format!("{rendered}: {error}"))?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(format!(
            "{rendered}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn stdout(command: &mut Command) -> Result<String, String> {
    output(command).map(|result| String::from_utf8_lossy(&result.stdout).trim().to_owned())
}

pub fn git_revision(repository: &Path, revision: &str) -> Result<String, String> {
    stdout(
        Command::new("git")
            .args(["rev-parse", "--verify", &format!("{revision}^{{commit}}")])
            .current_dir(repository),
    )
}

fn safe_run_id(run_id: &str) -> Result<String, String> {
    if run_id.is_empty()
        || run_id.len() > 128
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("run ID is not safe for a branch name".into());
    }
    Ok(run_id.to_owned())
}

impl RepositoryProvider for LocalGitRepository {
    fn prepare_worktree(
        &self,
        repository: &Path,
        destination: &Path,
        base_revision: &str,
        run_id: &str,
    ) -> Result<RunWorktree, String> {
        let repository = repository
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let safe_id = safe_run_id(run_id)?;
        let branch = format!("foundry/{safe_id}");
        let base_commit = stdout(
            Command::new("git")
                .args([
                    "rev-parse",
                    "--verify",
                    &format!("{base_revision}^{{commit}}"),
                ])
                .current_dir(&repository),
        )?;
        if destination.exists() {
            let actual = stdout(
                Command::new("git")
                    .args(["rev-parse", "--show-toplevel"])
                    .current_dir(destination),
            )?;
            if Path::new(&actual)
                .canonicalize()
                .map_err(|e| e.to_string())?
                != destination.canonicalize().map_err(|e| e.to_string())?
            {
                return Err("existing attempt path is not the expected Git worktree".into());
            }
        } else {
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            let branch_exists = Command::new("git")
                .args([
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{branch}"),
                ])
                .current_dir(&repository)
                .status()
                .map_err(|error| error.to_string())?
                .success();
            let mut command = Command::new("git");
            command.arg("worktree").arg("add");
            if !branch_exists {
                command.arg("-b").arg(&branch);
            }
            command.arg(destination);
            command.arg(if branch_exists { &branch } else { &base_commit });
            output(command.current_dir(&repository))?;
        }
        Ok(RunWorktree {
            path: destination.to_owned(),
            branch,
            base_commit,
        })
    }

    fn validate_diff(
        &self,
        worktree: &RunWorktree,
        policy: &DiffPolicy,
    ) -> Result<Vec<String>, String> {
        let raw = output(
            Command::new("git")
                .args(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
                .current_dir(&worktree.path),
        )?
        .stdout;
        let mut paths = Vec::new();
        for entry in raw
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
        {
            if entry.len() < 4 {
                return Err("malformed git status output".into());
            }
            let path = String::from_utf8(entry[3..].to_vec())
                .map_err(|_| "non-UTF-8 paths are not publishable".to_string())?;
            if !policy.allowed_paths.contains(&path) {
                return Err(format!(
                    "diff path `{path}` is outside the accepted IR write scopes"
                ));
            }
            let absolute = worktree.path.join(&path);
            if absolute.is_symlink() {
                return Err(format!("symlink `{path}` is not publishable"));
            }
            if absolute.is_file() {
                let bytes = std::fs::read(&absolute).map_err(|error| error.to_string())?;
                if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > policy.max_file_bytes {
                    return Err(format!("file `{path}` exceeds the publication size limit"));
                }
                if bytes.contains(&0) {
                    return Err(format!("binary file `{path}` is not publishable"));
                }
                let text = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
                for marker in ["-----begin private key-----", "github_pat_", "sk-ant-"] {
                    if text.contains(marker) {
                        return Err(format!("possible secret in `{path}` ({marker})"));
                    }
                }
            }
            paths.push(path);
        }
        paths.sort();
        paths.dedup();
        Ok(paths)
    }

    fn commit(
        &self,
        worktree: &RunWorktree,
        paths: &[String],
        message: &str,
    ) -> Result<String, String> {
        if paths.is_empty() {
            return Err("refusing to create an empty Foundry commit".into());
        }
        for key in ["user.name", "user.email"] {
            if stdout(
                Command::new("git")
                    .args(["config", "--get", key])
                    .current_dir(&worktree.path),
            )?
            .trim()
            .is_empty()
            {
                return Err(format!("repository Git identity `{key}` is not configured"));
            }
        }
        let mut add = Command::new("git");
        add.arg("add")
            .arg("--")
            .args(paths)
            .current_dir(&worktree.path);
        output(&mut add)?;
        output(
            Command::new("git")
                .args(["diff", "--cached", "--check"])
                .current_dir(&worktree.path),
        )?;
        output(
            Command::new("git")
                .args(["commit", "-m", message])
                .stdin(Stdio::null())
                .current_dir(&worktree.path),
        )?;
        stdout(
            Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(&worktree.path),
        )
    }
}

impl PullRequestPublisher for GitHubRepositoryProvider {
    fn publish_draft(
        &self,
        repository: &Path,
        run_id: &str,
        base_branch: &str,
        title: &str,
        body: &str,
    ) -> Result<String, String> {
        let branch = format!("foundry/{}", safe_run_id(run_id)?);
        let existing = stdout(
            Command::new("gh")
                .args([
                    "pr",
                    "list",
                    "--head",
                    &branch,
                    "--state",
                    "all",
                    "--json",
                    "url,isDraft",
                    "--limit",
                    "1",
                ])
                .current_dir(repository),
        )?;
        let records: Vec<serde_json::Value> =
            serde_json::from_str(&existing).map_err(|error| error.to_string())?;
        if let Some(pr) = records.first() {
            if pr.get("isDraft").and_then(serde_json::Value::as_bool) != Some(true) {
                return Err("Foundry's existing pull request is no longer a draft".into());
            }
            return pr
                .get("url")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| "GitHub response omitted pull request URL".into());
        }

        output(
            Command::new("git")
                .args(["push", "--set-upstream", "origin", &branch])
                .current_dir(repository),
        )?;
        stdout(
            Command::new("gh")
                .args([
                    "pr",
                    "create",
                    "--draft",
                    "--base",
                    base_branch,
                    "--head",
                    &branch,
                    "--title",
                    title,
                    "--body",
                    body,
                ])
                .current_dir(repository),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_and_secret_validation_fail_closed() {
        let root = std::env::temp_dir().join(format!("foundry-git-test-{}", std::process::id()));
        let repo = root.join("repo");
        let worktree = root.join("attempt");
        std::fs::create_dir_all(&repo).unwrap();
        output(Command::new("git").arg("init").current_dir(&repo)).unwrap();
        output(
            Command::new("git")
                .args(["config", "user.name", "Foundry Test"])
                .current_dir(&repo),
        )
        .unwrap();
        output(
            Command::new("git")
                .args(["config", "user.email", "foundry@example.invalid"])
                .current_dir(&repo),
        )
        .unwrap();
        std::fs::write(repo.join("README.md"), "base\n").unwrap();
        output(
            Command::new("git")
                .args(["add", "README.md"])
                .current_dir(&repo),
        )
        .unwrap();
        output(
            Command::new("git")
                .args(["commit", "-m", "base"])
                .current_dir(&repo),
        )
        .unwrap();

        let provider = LocalGitRepository;
        let attempt = provider
            .prepare_worktree(&repo, &worktree, "HEAD", "run-test")
            .unwrap();
        std::fs::write(worktree.join("README.md"), "safe change\n").unwrap();
        let policy = DiffPolicy {
            allowed_paths: BTreeSet::from(["README.md".into()]),
            max_file_bytes: 1024,
        };
        assert_eq!(
            provider.validate_diff(&attempt, &policy).unwrap(),
            ["README.md"]
        );
        let commit = provider
            .commit(
                &attempt,
                &["README.md".into()],
                "intentional Foundry change",
            )
            .unwrap();
        assert_eq!(commit.len(), 40);
        let resumed = provider
            .prepare_worktree(&repo, &worktree, "HEAD", "run-test")
            .unwrap();
        assert_eq!(resumed.branch, "foundry/run-test");
        std::fs::write(worktree.join("README.md"), "github_pat_not-a-real-token\n").unwrap();
        assert!(provider.validate_diff(&attempt, &policy).is_err());

        output(
            Command::new("git")
                .args(["worktree", "remove", "--force"])
                .arg(&worktree)
                .current_dir(&repo),
        )
        .unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}
