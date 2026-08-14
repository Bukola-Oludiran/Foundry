import { backup, DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { AnyFoundryArchitecture, ArchitectMode, FoundryArchitecture } from "./types.ts";

export class FoundryStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
    this.migrate();
  }

  close(): void { this.db.close(); }
  async backup(path: string): Promise<{ pages: number; integrity: string }> { const pages = await backup(this.db, path); const check = this.db.prepare("PRAGMA integrity_check").get() as Record<string, string>; return { pages, integrity: Object.values(check)[0] ?? "unknown" }; }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS projects(
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
        active_revision_id TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE, root_id TEXT NOT NULL,
        relative_path TEXT NOT NULL, internal_path TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS specs(
        project_id TEXT PRIMARY KEY, version INTEGER NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS drafts(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, base_revision_id TEXT,
        version INTEGER NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL,
        document_json TEXT NOT NULL, warnings_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS revisions(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
        document_json TEXT NOT NULL, digest TEXT NOT NULL, manifest_digest TEXT,
        provenance_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS reviews(
        id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, kind TEXT NOT NULL, reviewer TEXT NOT NULL,
        verdict TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS review_contexts(
        review_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL, context_id TEXT NOT NULL,
        FOREIGN KEY(review_id) REFERENCES reviews(id)
      );
      CREATE TABLE IF NOT EXISTS draft_authors(
        draft_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL, context_id TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(draft_id) REFERENCES drafts(id)
      );
      CREATE TABLE IF NOT EXISTS waivers(
        id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, reason TEXT NOT NULL, client_id TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS draft_council_roles(
        draft_id TEXT NOT NULL, role TEXT NOT NULL,
        PRIMARY KEY(draft_id,role), FOREIGN KEY(draft_id) REFERENCES drafts(id)
      );
      CREATE TABLE IF NOT EXISTS builds(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision_id TEXT NOT NULL,
        status TEXT NOT NULL, state_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempts(
        id TEXT PRIMARY KEY, build_id TEXT NOT NULL, node_id TEXT NOT NULL, attempt INTEGER NOT NULL,
        verdict TEXT NOT NULL, diagnostics_json TEXT NOT NULL, change_digest TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS assembly_attempts(
        id TEXT PRIMARY KEY, build_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL,
        evidence_digest TEXT, diagnostics_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(build_id) REFERENCES builds(id)
      );
      CREATE TABLE IF NOT EXISTS leases(
        id TEXT PRIMARY KEY, build_id TEXT NOT NULL, node_id TEXT NOT NULL,
        client_id TEXT NOT NULL, expires_at TEXT NOT NULL, base_digest TEXT,
        tenant_id TEXT NOT NULL DEFAULT '', user_id TEXT NOT NULL DEFAULT '', context_id TEXT NOT NULL DEFAULT '', transport TEXT NOT NULL DEFAULT '',
        UNIQUE(build_id,node_id)
      );
      CREATE TABLE IF NOT EXISTS proposals(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, base_revision_id TEXT NOT NULL, target_node_id TEXT NOT NULL,
        owner_id TEXT NOT NULL, status TEXT NOT NULL, proposed_json TEXT NOT NULL,
        invalidation_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifact_records(
        digest TEXT PRIMARY KEY, media_type TEXT NOT NULL, size INTEGER NOT NULL, provenance_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS artifact_projects(
        digest TEXT NOT NULL, project_id TEXT NOT NULL,
        PRIMARY KEY(digest,project_id), FOREIGN KEY(project_id) REFERENCES projects(id)
      );
      CREATE TABLE IF NOT EXISTS confirmations(
        token TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision_id TEXT NOT NULL, prepared_digest TEXT NOT NULL,
        base_head TEXT, payload_json TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, kind TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operation_results(
        operation_id TEXT PRIMARY KEY, build_id TEXT NOT NULL, node_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL, client_id TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS infrastructure_failures(
        id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, build_id TEXT NOT NULL, node_id TEXT NOT NULL,
        component TEXT NOT NULL, attempt INTEGER NOT NULL, retryable INTEGER NOT NULL,
        diagnostic_code TEXT NOT NULL, details_json TEXT NOT NULL, retry_after_ms INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS verification_journal(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, build_id TEXT NOT NULL,
        node_id TEXT, phase TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mutation_reports(
        id TEXT PRIMARY KEY, build_id TEXT NOT NULL, node_id TEXT NOT NULL, mode TEXT NOT NULL,
        report_json TEXT NOT NULL, evidence_digest TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox(
        id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS compiled_product_plans(
        architecture_digest TEXT PRIMARY KEY, plan_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS architecture_scope_leases(
        id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, node_path TEXT NOT NULL,
        tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, client_id TEXT NOT NULL, context_id TEXT NOT NULL,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(draft_id) REFERENCES drafts(id)
      );
      CREATE TABLE IF NOT EXISTS product_work_items(
        work_id TEXT PRIMARY KEY, build_id TEXT NOT NULL, node_path TEXT NOT NULL,
        kind TEXT NOT NULL, actor TEXT NOT NULL, state TEXT NOT NULL, dependencies_json TEXT NOT NULL,
        updated_at TEXT NOT NULL, FOREIGN KEY(build_id) REFERENCES builds(id)
      );
      CREATE TABLE IF NOT EXISTS integration_attempts(
        id TEXT PRIMARY KEY, build_id TEXT NOT NULL, node_path TEXT NOT NULL, attempt INTEGER NOT NULL,
        status TEXT NOT NULL, evidence_digest TEXT, diagnostics_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(build_id) REFERENCES builds(id)
      );
      CREATE TABLE IF NOT EXISTS node_evidence(
        build_id TEXT NOT NULL, node_path TEXT NOT NULL, evidence_digest TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(build_id,node_path), FOREIGN KEY(build_id) REFERENCES builds(id)
      );
      CREATE TABLE IF NOT EXISTS product_implementation_evidence(
        build_id TEXT NOT NULL, work_id TEXT NOT NULL, evidence_digest TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(build_id,work_id), FOREIGN KEY(build_id) REFERENCES builds(id)
      );
      CREATE TABLE IF NOT EXISTS product_deliverables(
        build_id TEXT NOT NULL, deliverable_id TEXT NOT NULL, owner_path TEXT NOT NULL, required INTEGER NOT NULL,
        status TEXT NOT NULL, artifact_digest TEXT, evidence_digest TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(build_id,deliverable_id), FOREIGN KEY(build_id) REFERENCES builds(id)
      );
      INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
    `);
    const columns = this.db.prepare("PRAGMA table_info(schema_migrations)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "checksum")) this.db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
    const leaseColumns = new Set((this.db.prepare("PRAGMA table_info(leases)").all() as Array<{ name: string }>).map((column) => column.name));
    for (const column of ["tenant_id", "user_id", "context_id", "transport"]) if (!leaseColumns.has(column)) this.db.exec(`ALTER TABLE leases ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
    const known = new Map([[1, "foundry-bootstrap-v1"], [2, "trustworthy-delivery-journal-v2"], [3, "recursive-product-composition-v3"], [4, "recursive-product-evidence-v4"]]);
    this.transaction(() => {
      for (const [version, checksum] of known) {
        const row = this.db.prepare("SELECT checksum FROM schema_migrations WHERE version=?").get(version) as { checksum: string | null } | undefined;
        if (row?.checksum && row.checksum !== checksum) throw new Error(`SCHEMA_MIGRATION_CHECKSUM_MISMATCH:${version}`);
        if (row) this.db.prepare("UPDATE schema_migrations SET checksum=? WHERE version=?").run(checksum, version);
        else this.db.prepare("INSERT INTO schema_migrations(version,checksum) VALUES(?,?)").run(version, checksum);
      }
    });
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.db.exec("COMMIT"); return value; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  createProject(tenantId: string, name: string): Record<string, unknown> {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare("INSERT INTO projects(id,tenant_id,name,created_at) VALUES(?,?,?,?)").run(id, tenantId, name, now);
    return { id, tenantId, name, activeRevisionId: null, createdAt: now };
  }

  project(id: string): any {
    return this.db.prepare("SELECT id,tenant_id AS tenantId,name,active_revision_id AS activeRevisionId,created_at AS createdAt FROM projects WHERE id=?").get(id);
  }

  listProjects(tenantId: string): any[] {
    return this.db.prepare("SELECT id,tenant_id AS tenantId,name,active_revision_id AS activeRevisionId,created_at AS createdAt FROM projects WHERE tenant_id=? ORDER BY created_at").all(tenantId) as any[];
  }

  bindWorkspace(projectId: string, rootId: string, relativePath: string, internalPath: string): any {
    const existing = this.db.prepare("SELECT * FROM workspaces WHERE project_id=?").get(projectId) as any;
    if (existing) return { id: existing.id, projectId: existing.project_id, rootId: existing.root_id, relativePath: existing.relative_path, createdAt: existing.created_at };
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare("INSERT INTO workspaces VALUES(?,?,?,?,?,?)").run(id, projectId, rootId, relativePath, internalPath, now);
    return { id, projectId, rootId, relativePath, createdAt: now };
  }

  workspace(projectId: string): any { return this.db.prepare("SELECT * FROM workspaces WHERE project_id=?").get(projectId); }

  putSpec(projectId: string, body: string): any {
    const now = new Date().toISOString();
    const old = this.db.prepare("SELECT version FROM specs WHERE project_id=?").get(projectId) as { version: number } | undefined;
    const version = (old?.version ?? 0) + 1;
    this.db.prepare("INSERT INTO specs(project_id,version,body,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET version=excluded.version,body=excluded.body,updated_at=excluded.updated_at").run(projectId, version, body, now);
    return { projectId, version, body, updatedAt: now };
  }

  spec(projectId: string): any { return this.db.prepare("SELECT project_id AS projectId,version,body,updated_at AS updatedAt FROM specs WHERE project_id=?").get(projectId); }

  createDraft(projectId: string, baseRevisionId: string | null, mode: ArchitectMode, document: AnyFoundryArchitecture): any {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare("INSERT INTO drafts VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, projectId, baseRevisionId, 1, "open", mode, JSON.stringify(document), "[]", now, now);
    return this.draft(id);
  }

  draft(id: string): any {
    const row = this.db.prepare("SELECT * FROM drafts WHERE id=?").get(id) as any;
    return row ? { id: row.id, projectId: row.project_id, baseRevisionId: row.base_revision_id, version: row.version, status: row.status, mode: row.mode, councilRoles: (this.db.prepare("SELECT role FROM draft_council_roles WHERE draft_id=? ORDER BY role").all(id) as Array<{ role: string }>).map((entry) => entry.role), document: JSON.parse(row.document_json), warnings: JSON.parse(row.warnings_json), createdAt: row.created_at, updatedAt: row.updated_at } : undefined;
  }

  setCouncilRoles(draftId: string, roles: string[]): void { const insert = this.db.prepare("INSERT INTO draft_council_roles VALUES(?,?)"); for (const role of roles) insert.run(draftId, role); }

  updateDraft(id: string, expectedVersion: number, document: AnyFoundryArchitecture, warnings: unknown[]): any {
    const now = new Date().toISOString();
    const result = this.db.prepare("UPDATE drafts SET version=version+1,document_json=?,warnings_json=?,updated_at=? WHERE id=? AND version=? AND status='open'").run(JSON.stringify(document), JSON.stringify(warnings), now, id, expectedVersion);
    if (result.changes !== 1) throw new Error("DRAFT_CONFLICT");
    return this.draft(id);
  }

  commitRevision(projectId: string, parentId: string | null, document: AnyFoundryArchitecture, digest: string, manifestDigest: string | null, provenance: unknown): any {
    const id = randomUUID(), now = new Date().toISOString();
    this.db.prepare("INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?)").run(id, projectId, parentId, JSON.stringify(document), digest, manifestDigest, JSON.stringify(provenance), now);
    return this.revision(id);
  }

  revision(id: string): any {
    const row = this.db.prepare("SELECT * FROM revisions WHERE id=?").get(id) as any;
    return row ? { id: row.id, projectId: row.project_id, parentId: row.parent_id, document: JSON.parse(row.document_json), digest: row.digest, manifestDigest: row.manifest_digest, provenance: JSON.parse(row.provenance_json), createdAt: row.created_at } : undefined;
  }

  activate(projectId: string, expectedRevision: string | null, revisionId: string): void {
    const result = expectedRevision === null
      ? this.db.prepare("UPDATE projects SET active_revision_id=? WHERE id=? AND active_revision_id IS NULL").run(revisionId, projectId)
      : this.db.prepare("UPDATE projects SET active_revision_id=? WHERE id=? AND active_revision_id=?").run(revisionId, projectId, expectedRevision);
    if (result.changes !== 1) throw new Error("ACTIVE_REVISION_CONFLICT");
  }

  event(projectId: string, kind: string, payload: unknown): void {
    this.db.prepare("INSERT INTO events(project_id,kind,payload_json,created_at) VALUES(?,?,?,?)").run(projectId, kind, JSON.stringify(payload), new Date().toISOString());
  }
}
