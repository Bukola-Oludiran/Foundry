import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function sha256(input: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

export class ArtifactStore {
  private readonly quarantine: string;
  constructor(private readonly root: string) { mkdirSync(root, { recursive: true }); this.quarantine = join(root, ".quarantine"); mkdirSync(this.quarantine, { recursive: true }); for (const name of readdirSync(root).filter((entry) => entry.includes(".tmp-"))) rmSync(join(root, name), { force: true }); }

  put(content: string | Uint8Array): { digest: string; path: string; size: number } {
    const bytes = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    const digest = sha256(bytes);
    const path = join(this.root, digest.slice(7));
    if (!existsSync(path)) {
      const temporary = join(this.root, `${digest.slice(7)}.tmp-${randomUUID()}`);
      const fd = openSync(temporary, "wx", 0o600); try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      try { renameSync(temporary, path); } catch (error) { rmSync(temporary, { force: true }); if (!existsSync(path)) throw error; }
      const dir = openSync(this.root, "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
    }
    return { digest, path, size: bytes.length };
  }

  get(digest: string): Buffer {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("invalid artifact digest");
    const bytes = readFileSync(join(this.root, digest.slice(7)));
    if (sha256(bytes) !== digest) throw new Error("artifact digest mismatch");
    return bytes;
  }

  scrub(): { checked: number; corrupt: string[]; bytes: number } { let checked = 0, bytes = 0; const corrupt: string[] = []; for (const name of readdirSync(this.root)) { if (!/^[a-f0-9]{64}$/.test(name)) continue; checked++; const path = join(this.root, name); bytes += statSync(path).size; const bytesRead = readFileSync(path); if (sha256(bytesRead) !== `sha256:${name}`) corrupt.push(`sha256:${name}`); } return { checked, corrupt, bytes }; }

  collect(reachable: Set<string>, dryRun = true): { candidates: string[]; quarantined: string[] } { const candidates = readdirSync(this.root).filter((name) => /^[a-f0-9]{64}$/.test(name) && !reachable.has(`sha256:${name}`)).map((name) => `sha256:${name}`); const quarantined: string[] = []; if (!dryRun) for (const digest of candidates) { renameSync(join(this.root, digest.slice(7)), join(this.quarantine, `${digest.slice(7)}-${Date.now()}`)); quarantined.push(digest); } return { candidates, quarantined }; }
}
