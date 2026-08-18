import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { RequestError } from "./validation.ts";

const DIGEST = /^[a-f0-9]{64}$/;
export const MAX_DEPENDENCY_ARTIFACT_BYTES = 16 * 1024 * 1024;

export interface DependencyArtifactStore {
  readiness?(): Promise<{ ready: boolean; reason: string | null }>;
  read(sha256: string, signal: AbortSignal): Promise<Buffer>;
}

export class FilesystemDependencyArtifactStore implements DependencyArtifactStore {
  private readonly directory: string;

  constructor(directory: string) {
    if (!isAbsolute(directory) || /[\r\n,]/.test(directory)) {
      throw new Error(
        "dependency artifact directory must be a safe absolute path",
      );
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(
        "dependency artifact directory must be a regular directory",
      );
    }
    this.directory = realpathSync(directory);
  }

  async readiness(): Promise<{ ready: boolean; reason: string | null }> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await realpath(this.directory);
      return { ready: true, reason: null };
    } catch {
      return {
        ready: false,
        reason: "dependency artifact directory is unavailable",
      };
    }
  }

  async read(sha256: string, signal: AbortSignal): Promise<Buffer> {
    if (!DIGEST.test(sha256)) {
      throw new RequestError(
        400,
        "INVALID_ARTIFACT_DIGEST",
        "invalid artifact digest",
      );
    }
    if (signal.aborted) {
      throw new RequestError(
        409,
        "JOB_CANCELLED",
        "artifact read was cancelled",
      );
    }
    const root = await realpath(this.directory);
    const path = join(root, sha256);
    let metadata;
    try {
      metadata = await lstat(path);
    } catch {
      throw new RequestError(
        404,
        "ARTIFACT_NOT_FOUND",
        "dependency artifact was not found",
      );
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new RequestError(
        409,
        "ARTIFACT_UNSAFE",
        "dependency artifact is not a regular file",
      );
    }
    if (metadata.size > MAX_DEPENDENCY_ARTIFACT_BYTES) {
      throw new RequestError(
        413,
        "ARTIFACT_TOO_LARGE",
        "dependency artifact exceeds its bound",
      );
    }
    const bytes = await readFile(path, { signal });
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== sha256) {
      throw new RequestError(
        409,
        "ARTIFACT_CHECKSUM_MISMATCH",
        "dependency artifact checksum failed",
      );
    }
    return bytes;
  }
}
