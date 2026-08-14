import { Server, inputRequired, inputResponse } from "@modelcontextprotocol/server";
import type { FoundryCommandService } from "../core/commands.ts";
import type { FoundryAuthorizationContext } from "../core/types.ts";
import { FoundryCommandError } from "../core/types.ts";
import { randomUUID } from "node:crypto";
import { FOUNDRY_SERVER_INSTRUCTIONS, FOUNDRY_WORKFLOWS, findFoundryWorkflow, renderFoundryWorkflow, workflowResourceUri } from "./workflows.ts";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const id = { type: "string", minLength: 1, maxLength: 200 };
const longId = { type: "string", minLength: 1, maxLength: 2200 };
const nodePath = { type: "string", minLength: 1, maxLength: 2000, pattern: "^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$" };
const architecture = { type: "object", description: "A legacy Foundry Architecture IR v2-v4 document. IR v5 is authored incrementally." };
const versionedDraft = { draftId: id, expectedVersion: { type: "integer", minimum: 1 }, scopeLeaseId: id };

const TOOLS = [
  { name: "foundry_list_projects", description: "List projects visible to the caller.", schema: object({}), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_create_project", description: "Create a tenant-owned Foundry project.", schema: object({ name: { type: "string", minLength: 1, maxLength: 200 } }, ["name"]) },
  { name: "foundry_get_project", description: "Read a Foundry project and its active revision.", schema: object({ projectId: id }, ["projectId"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_bind_workspace", description: "Bind a project to an administrator-configured workspace root using an opaque root id.", schema: object({ projectId: id, rootId: id, relativePath: { type: "string", maxLength: 500 } }, ["projectId", "rootId"]) },
  { name: "foundry_submit_spec", description: "Create a new immutable specification version for a project.", schema: object({ projectId: id, spec: { type: "string", minLength: 1, maxLength: 200000 } }, ["projectId", "spec"]) },
  { name: "foundry_begin_architecture", description: "Open an architecture draft. Adaptive critique is the default; council mode requires two to four explicit roles.", schema: object({ projectId: id, mode: { enum: ["solo", "adaptive", "architect-critic", "council"] }, specialistRoles: { type: "array", minItems: 2, maxItems: 4, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 100 } } }, ["projectId"]) },
  { name: "foundry_begin_product_architecture", description: "Open a canonical recursive IR v5 product draft.", schema: object({ projectId: id, productId: id, mode: { enum: ["solo", "adaptive", "architect-critic", "council"] } }, ["projectId"]) },
  { name: "foundry_get_product_tree", description: "Read a v5 nested product tree and its derived compiled plan.", schema: object({ draftId: id }, ["draftId"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_acquire_architecture_scope", description: "Optionally lease one architecture subtree for concurrent authoring.", schema: object({ draftId: id, nodePath: nodePath, ttlMs: { type: "integer", minimum: 1000, maximum: 3600000 } }, ["draftId", "nodePath"]) },
  { name: "foundry_add_product_node", description: "Add one nested leaf or composite to an IR v5 draft.", schema: object({ ...versionedDraft, parentPath: nodePath, node: { type: "object" } }, ["draftId", "expectedVersion", "parentPath", "node"]) },
  { name: "foundry_update_product_node", description: "Replace one v5 node while preserving its path identity and kind.", schema: object({ ...versionedDraft, nodePath: nodePath, node: { type: "object" } }, ["draftId", "expectedVersion", "nodePath", "node"]) },
  { name: "foundry_move_product_subtree", description: "Move a subtree, assign new hierarchical identities, and record supersedes lineage.", schema: object({ ...versionedDraft, nodePath: nodePath, newParentPath: nodePath, newId: id }, ["draftId", "expectedVersion", "nodePath", "newParentPath"]) },
  { name: "foundry_remove_product_subtree", description: "Remove a non-root product subtree from an open v5 draft.", schema: object({ ...versionedDraft, nodePath: nodePath }, ["draftId", "expectedVersion", "nodePath"]) },
  { name: "foundry_set_composite_dependencies", description: "Replace one composite's immediate-child dependency DAG.", schema: object({ ...versionedDraft, nodePath: nodePath, dependencies: { type: "array", maxItems: 1024, items: { type: "object" } } }, ["draftId", "expectedVersion", "nodePath", "dependencies"]) },
  { name: "foundry_declare_dependency_exception", description: "Declare a reviewed public-contract dependency crossing normal composite scope.", schema: object({ ...versionedDraft, nodePath: nodePath, exception: { type: "object" } }, ["draftId", "expectedVersion", "nodePath", "exception"]) },
  { name: "foundry_allocate_requirement", description: "Allocate one requirement through a composite to executable evidence.", schema: object({ ...versionedDraft, nodePath: nodePath, allocation: { type: "object" } }, ["draftId", "expectedVersion", "nodePath", "allocation"]) },
  { name: "foundry_set_node_acceptance", description: "Set typed public and optional composite-integration scenarios.", schema: object({ ...versionedDraft, nodePath: nodePath, acceptance: { type: "array", maxItems: 1024 }, integrationScenarios: { type: "array", maxItems: 1024 } }, ["draftId", "expectedVersion", "nodePath", "acceptance"]) },
  { name: "foundry_set_node_capabilities", description: "Set curated versioned capability references for a v5 node.", schema: object({ ...versionedDraft, nodePath: nodePath, capabilityRefs: { type: "array", maxItems: 32, items: { type: "object" } } }, ["draftId", "expectedVersion", "nodePath", "capabilityRefs"]) },
  { name: "foundry_set_node_deliverables", description: "Set compiler-governed deliverables owned by a v5 node.", schema: object({ ...versionedDraft, nodePath: nodePath, deliverables: { type: "array", maxItems: 128, items: { type: "object" } } }, ["draftId", "expectedVersion", "nodePath", "deliverables"]) },
  { name: "foundry_list_capabilities", description: "List curated capability definitions available to v5 architectures.", schema: object({}), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_get_architecture_draft", description: "Read a canonical architecture draft and CAS version.", schema: object({ draftId: id }, ["draftId"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_update_architecture", description: "CAS-replace the typed architecture IR in an open draft.", schema: object({ draftId: id, expectedVersion: { type: "integer", minimum: 1 }, architecture }, ["draftId", "expectedVersion", "architecture"]) },
  { name: "foundry_set_scenarios", description: "CAS-update structured critical scenarios used for sequence projections.", schema: object({ draftId: id, expectedVersion: { type: "integer", minimum: 1 }, scenarios: { type: "array", maxItems: 100 } }, ["draftId", "expectedVersion", "scenarios"]) },
  { name: "foundry_set_deployment", description: "CAS-update the structured deployment topology.", schema: object({ draftId: id, expectedVersion: { type: "integer", minimum: 1 }, deployment: { type: "object" } }, ["draftId", "expectedVersion", "deployment"]) },
  { name: "foundry_set_view_layout", description: "CAS-update renderer-neutral positions for existing semantic elements.", schema: object({ draftId: id, expectedVersion: { type: "integer", minimum: 1 }, viewId: id, positions: { type: "object", additionalProperties: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 } }, required: ["x", "y"], additionalProperties: false } } }, ["draftId", "expectedVersion", "viewId", "positions"]) },
  { name: "foundry_import_diagram_layout", description: "Import layout coordinates from Excalidraw; semantic additions are rejected.", schema: object({ draftId: id, expectedVersion: { type: "integer", minimum: 1 }, viewId: id, excalidraw: { type: "object" } }, ["draftId", "expectedVersion", "viewId", "excalidraw"]) },
  { name: "foundry_validate_architecture", description: "Run semantic and Rust compiler validation without mutating a draft.", schema: object({ draftId: id }, ["draftId"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_render_architecture", description: "Render deterministic UML, SVG, PNG, and editable Excalidraw projections.", schema: object({ draftId: id }, ["draftId"]), annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_validate_product_architecture", description: "Validate a recursive IR v5 product draft and its compiled scoped execution plan.", schema: object({ draftId: id }, ["draftId"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_render_product_architecture", description: "Render recursive composition, per-composite DAG, contract, and lifecycle projections.", schema: object({ draftId: id }, ["draftId"]), annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_compare_architecture_revisions", description: "Compare immutable architecture revisions by semantic node identity.", schema: object({ projectId: id, fromRevisionId: id, toRevisionId: id }, ["projectId", "fromRevisionId", "toRevisionId"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_submit_architecture_review", description: "Submit an independent architecture critic verdict.", schema: object({ draftId: id, verdict: { enum: ["approve", "changes_requested"] }, body: { type: "string", minLength: 1, maxLength: 50000 }, kind: { type: "string", maxLength: 100 } }, ["draftId", "verdict", "body"]) },
  { name: "foundry_request_architecture_review", description: "Request one fresh-context critic through MCP sampling/input-required. Manual review remains available.", schema: object({ draftId: id, specialist: { type: "string", maxLength: 100 } }, ["draftId"]) },
  { name: "foundry_waive_architecture_review", description: "Record an authorized, scoped review waiver.", schema: object({ draftId: id, reason: { type: "string", minLength: 10, maxLength: 2000 } }, ["draftId", "reason"]) },
  { name: "foundry_activate_architecture", description: "Validate, immutably commit, project, and CAS-activate an architecture draft.", schema: object({ draftId: id, expectedActiveRevision: { type: ["string", "null"] } }, ["draftId", "expectedActiveRevision"]) },
  { name: "foundry_start_build", description: "Start a provider-free build against an immutable architecture revision.", schema: object({ projectId: id, revisionId: id }, ["projectId"]) },
  { name: "foundry_get_build", description: "Read a durable build and node states.", schema: object({ buildId: id }, ["buildId"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_inspect_node", description: "Read one node's fixed contract, graph scope, and prior attempts.", schema: object({ buildId: id, nodeId: longId }, ["buildId", "nodeId"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_get_node_attempts", description: "Read deterministic attempt evidence for one build node.", schema: object({ buildId: id, nodeId: longId }, ["buildId", "nodeId"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_get_ready_work", description: "Lease ready, non-overlapping node work to this MCP client.", schema: object({ buildId: id, limit: { type: "integer", minimum: 1, maximum: 16 } }, ["buildId"]) },
  { name: "foundry_submit_node_changes", description: "Atomically apply every compiler-issued target for a leased node and run its parent-owned tests.", schema: object({ buildId: id, changeSet: { type: "object", properties: { submissionId: id, leaseId: id, targetId: longId, baseDigest: { type: ["string", "null"] }, content: { type: "string", maxLength: 2000000 }, files: { type: "array", minItems: 1, maxItems: 256, items: { type: "object", properties: { targetId: id, baseDigest: { type: ["string", "null"] }, content: { type: "string", maxLength: 2000000 } }, required: ["targetId", "baseDigest", "content"], additionalProperties: false } }, summary: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["leaseId", "targetId", "baseDigest", "summary"], additionalProperties: false } }, ["buildId", "changeSet"]) },
  { name: "foundry_get_assembly_evidence", description: "Read the latest immutable repository assembly verdict and evidence.", schema: object({ buildId: id }, ["buildId"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_get_conformance", description: "Read the immutable conformance manifest and generated-test resource for a build.", schema: object({ buildId: id }, ["buildId"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_get_reproducibility_evidence", description: "Read the two-clean-build normalized replay comparison for a build.", schema: object({ buildId: id }, ["buildId"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_get_mutation_report", description: "Read deterministic mutation-strength reports for a build or node.", schema: object({ buildId: id, nodeId: id }, ["buildId"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_get_system_health", description: "Read administrator-only readiness, queue, verifier, failure, and storage health.", schema: object({}), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_retry_assembly", description: "Retry a red assembly gate while all authored nodes remain green.", schema: object({ buildId: id }, ["buildId"]) },
  { name: "foundry_cancel_build", description: "Cancel a build and all uncommitted work leases.", schema: object({ buildId: id }, ["buildId"]), annotations: { destructiveHint: true } },
  { name: "foundry_retry_node", description: "Return a red node to ready state while its bounded retry budget remains.", schema: object({ buildId: id, nodeId: longId }, ["buildId", "nodeId"]) },
  { name: "foundry_retry_infrastructure", description: "Resume infrastructure-blocked node verification without consuming an authored retry.", schema: object({ buildId: id, nodeId: longId }, ["buildId", "nodeId"]) },
  { name: "foundry_get_invalidation_set", description: "Compute the deterministic transitive consumer blast radius for a node.", schema: object({ projectId: id, revisionId: id, nodeId: nodePath }, ["projectId", "nodeId"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_begin_rearchitecture", description: "Open an immutable-authority subtree proposal.", schema: object({ projectId: id, targetNodeId: nodePath }, ["projectId", "targetNodeId"]) },
  { name: "foundry_submit_subtree_proposal", description: "Submit replacement subtree nodes while preserving M4 authority boundaries.", schema: object({ proposalId: id, nodes: { type: "array", minItems: 1 } }, ["proposalId", "nodes"]) },
  { name: "foundry_validate_proposal", description: "Compile a subtree proposal and enforce authority boundaries.", schema: object({ proposalId: id }, ["proposalId"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_build_proposal", description: "Start an isolated build for a validated subtree proposal.", schema: object({ proposalId: id }, ["proposalId"]) },
  { name: "foundry_prepare_activation", description: "Prepare an all-green proposal activation and issue a confirmation token.", schema: object({ proposalId: id }, ["proposalId"]), annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false } },
  { name: "foundry_activate_proposal", description: "CAS-activate exactly the prepared immutable subtree proposal.", schema: object({ proposalId: id, preparedDigest: id, confirmationToken: id }, ["proposalId", "preparedDigest", "confirmationToken"]) },
  { name: "foundry_prepare_repository_update", description: "Prepare an exact architecture and optional all-green build diff, then issue a short-lived confirmation token.", schema: object({ projectId: id, revisionId: id, buildId: id }, ["projectId"]), annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true } },
  { name: "foundry_apply_repository_update", description: "Apply and commit exactly a prepared, digest-bound repository update.", schema: object({ projectId: id, revisionId: id, preparedDigest: id, confirmationToken: id }, ["projectId", "revisionId", "preparedDigest", "confirmationToken"]), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
] as const;

function text(value: Record<string, unknown>) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value }; }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

export async function normalizeCommandResult(value: unknown): Promise<Record<string, unknown>> {
  const resolved = await Promise.resolve(value);
  if (!isRecord(resolved) || typeof resolved.accepted !== "boolean" || !Array.isArray(resolved.diagnostics) || !isRecord(resolved.provenance) || typeof resolved.provenance.operationId !== "string" || typeof resolved.provenance.clientId !== "string" || typeof resolved.provenance.at !== "string") {
    throw new Error("Command returned an invalid transport-neutral result");
  }
  return resolved;
}

export function createFoundryMcpServer(service: FoundryCommandService, auth: FoundryAuthorizationContext): Server {
  const server = new Server({ name: "foundry", version: "0.1.0" }, { capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false }, logging: {} }, instructions: FOUNDRY_SERVER_INSTRUCTIONS });
  server.setRequestHandler("tools/list", async () => ({ tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.schema as any, annotations: "annotations" in tool ? tool.annotations : { readOnlyHint: false, idempotentHint: false, openWorldHint: false } })) }));
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const a = (request.params.arguments ?? {}) as any;
    try {
      let result: unknown;
      switch (request.params.name) {
        case "foundry_list_projects": result = service.listProjects(auth); break;
        case "foundry_create_project": result = service.createProject(auth, a); break;
        case "foundry_get_project": result = service.getProject(auth, a.projectId); break;
        case "foundry_bind_workspace": result = service.bindWorkspace(auth, a); break;
        case "foundry_submit_spec": result = service.submitSpec(auth, a); break;
        case "foundry_begin_architecture": result = service.beginArchitecture(auth, a); break;
        case "foundry_begin_product_architecture": result = service.beginProductArchitecture(auth, a); break;
        case "foundry_get_product_tree": result = service.getProductTree(auth, a.draftId); break;
        case "foundry_acquire_architecture_scope": result = service.acquireArchitectureScope(auth, a); break;
        case "foundry_add_product_node": result = service.addProductNode(auth, a); break;
        case "foundry_update_product_node": result = service.updateProductNode(auth, a); break;
        case "foundry_move_product_subtree": result = service.moveProductSubtree(auth, a); break;
        case "foundry_remove_product_subtree": result = service.removeProductSubtree(auth, a); break;
        case "foundry_set_composite_dependencies": result = service.setCompositeDependencies(auth, a); break;
        case "foundry_declare_dependency_exception": result = service.declareDependencyException(auth, a); break;
        case "foundry_allocate_requirement": result = service.allocateRequirement(auth, a); break;
        case "foundry_set_node_acceptance": result = service.setNodeAcceptance(auth, a); break;
        case "foundry_set_node_capabilities": result = service.setNodeCapabilities(auth, a); break;
        case "foundry_set_node_deliverables": result = service.setNodeDeliverables(auth, a); break;
        case "foundry_list_capabilities": result = service.listCapabilities(auth); break;
        case "foundry_get_architecture_draft": result = service.getDraft(auth, a.draftId); break;
        case "foundry_update_architecture": result = service.updateArchitecture(auth, a); break;
        case "foundry_set_scenarios": result = service.setScenarios(auth, a); break;
        case "foundry_set_deployment": result = service.setDeployment(auth, a); break;
        case "foundry_set_view_layout": result = service.setViewLayout(auth, a); break;
        case "foundry_import_diagram_layout": result = service.importLayout(auth, a); break;
        case "foundry_validate_architecture": result = await service.validateArchitecture(auth, a.draftId); break;
        case "foundry_render_architecture": result = service.renderDraft(auth, a.draftId); break;
        case "foundry_validate_product_architecture": result = await service.validateArchitecture(auth, a.draftId); break;
        case "foundry_render_product_architecture": result = service.renderDraft(auth, a.draftId); break;
        case "foundry_compare_architecture_revisions": result = service.compareRevisions(auth, a); break;
        case "foundry_submit_architecture_review": result = service.submitReview(auth, a); break;
        case "foundry_request_architecture_review": {
          const response = inputResponse(ctx.mcpReq.inputResponses, "critic");
          if (response.kind === "missing") {
            const draft = service.getDraft(auth, a.draftId).state;
            return inputRequired({ inputRequests: { critic: inputRequired.createMessage({
              messages: [{ role: "user", content: { type: "text", text: `Act as an independent ${a.specialist ?? "architecture"} critic. Review this canonical Foundry IR without rewriting it. Check ownership separately from dependencies, public contracts, acceptance ownership, critical scenarios, deployment/security boundaries, and failure recovery. Return strict JSON: {"verdict":"approve|changes_requested","body":"evidence-backed review"}.\n\n${JSON.stringify(draft.document)}` } }],
              maxTokens: 2400,
            }) } });
          }
          if (response.kind !== "sampling") throw new FoundryCommandError("SAMPLING_UNAVAILABLE", "The client did not return a sampling result; use foundry_submit_architecture_review manually");
          const content = response.result.content as any; const raw = Array.isArray(content) ? content.find((part: any) => part.type === "text")?.text : content?.type === "text" ? content.text : undefined;
          if (typeof raw !== "string") throw new FoundryCommandError("MALFORMED_CRITIC", "Critic sampling result did not contain text");
          let review: any; try { review = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw); } catch { throw new FoundryCommandError("MALFORMED_CRITIC", "Critic must return the requested JSON object"); }
          if (!["approve", "changes_requested"].includes(review.verdict) || typeof review.body !== "string") throw new FoundryCommandError("MALFORMED_CRITIC", "Critic verdict or body is invalid");
          result = service.submitReview(auth, { draftId: a.draftId, verdict: review.verdict, body: review.body, kind: a.specialist ?? "sampled-critic", reviewerContextId: `sampling:${randomUUID()}` }); break;
        }
        case "foundry_waive_architecture_review": result = service.waiveReview(auth, a); break;
        case "foundry_activate_architecture": result = await service.activateArchitecture(auth, a); break;
        case "foundry_start_build": result = await service.startBuild(auth, a); break;
        case "foundry_get_build": result = await service.getBuild(auth, a.buildId); break;
        case "foundry_inspect_node": result = await service.getNodeContext(auth, a); break;
        case "foundry_get_node_attempts": result = service.getNodeAttempts(auth, a); break;
        case "foundry_get_ready_work": result = await service.getReadyWork(auth, a); break;
        case "foundry_submit_node_changes": result = await service.submitNodeChanges(auth, a); break;
        case "foundry_get_assembly_evidence": result = service.getAssemblyEvidence(auth, a.buildId); break;
        case "foundry_get_conformance": result = service.getConformance(auth, a.buildId); break;
        case "foundry_get_reproducibility_evidence": result = service.getReproducibilityEvidence(auth, a.buildId); break;
        case "foundry_get_mutation_report": result = service.getMutationReport(auth, a); break;
        case "foundry_get_system_health": result = await service.getSystemHealth(auth); break;
        case "foundry_retry_assembly": result = await service.retryAssembly(auth, a.buildId); break;
        case "foundry_cancel_build": result = await service.cancelBuild(auth, a.buildId); break;
        case "foundry_retry_node": result = await service.retryNode(auth, a); break;
        case "foundry_retry_infrastructure": result = await service.retryInfrastructure(auth, a); break;
        case "foundry_get_invalidation_set": result = await service.getInvalidationSet(auth, a); break;
        case "foundry_begin_rearchitecture": result = await service.beginRearchitecture(auth, a); break;
        case "foundry_submit_subtree_proposal": result = service.submitSubtreeProposal(auth, a); break;
        case "foundry_validate_proposal": result = await service.validateProposal(auth, a.proposalId); break;
        case "foundry_build_proposal": result = await service.buildProposal(auth, a.proposalId); break;
        case "foundry_prepare_activation": result = service.prepareActivation(auth, a.proposalId); break;
        case "foundry_activate_proposal": result = service.activateProposal(auth, a); break;
        case "foundry_prepare_repository_update": result = service.prepareRepositoryUpdate(auth, a); break;
        case "foundry_apply_repository_update": result = service.applyRepositoryUpdate(auth, a); break;
        default: throw new FoundryCommandError("TOOL_NOT_FOUND", `Unknown tool ${request.params.name}`);
      }
      return text(await normalizeCommandResult(result));
    } catch (error) {
      const known = error instanceof FoundryCommandError; const payload = { accepted: false, error: { code: known ? error.code : "INTERNAL_ERROR", message: (error as Error).message, ...(known && error.details !== undefined ? { details: error.details } : {}) } };
      return { ...text(payload), isError: true };
    }
  });
  server.setRequestHandler("resources/list", async (request) => {
    const offset = request.params?.cursor ? Number(Buffer.from(request.params.cursor, "base64url").toString("utf8")) : 0;
    const workflows = FOUNDRY_WORKFLOWS.map((workflow) => ({ uri: workflowResourceUri(workflow.id), name: workflow.description, mimeType: "text/markdown" }));
    const projects = service.store.listProjects(auth.tenantId).map((project) => ({ uri: `foundry://projects/${project.id}`, name: project.name, mimeType: "application/json" }));
    const all = [...workflows, ...projects], page = all.slice(offset, offset + 50);
    return { resources: page, ...(offset + page.length < all.length ? { nextCursor: Buffer.from(String(offset + page.length)).toString("base64url") } : {}) };
  });
  server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: [
    { uriTemplate: "foundry://workflows/{workflowId}", name: "Foundry workflow", mimeType: "text/markdown" },
    { uriTemplate: "foundry://projects/{projectId}", name: "project", mimeType: "application/json" },
    { uriTemplate: "foundry://projects/{projectId}/spec", name: "spec", mimeType: "text/markdown" },
    { uriTemplate: "foundry://projects/{projectId}/architecture/active", name: "active architecture", mimeType: "application/json" },
    { uriTemplate: "foundry://projects/{projectId}/architecture/revisions/{revisionId}", name: "architecture revision", mimeType: "application/json" },
    { uriTemplate: "foundry://projects/{projectId}/architecture/revisions/{revisionId}/diagrams", name: "architecture diagram package", mimeType: "application/json" },
    { uriTemplate: "foundry://projects/{projectId}/architecture/drafts/{draftId}/tree", name: "recursive product draft tree", mimeType: "application/json" },
    { uriTemplate: "foundry://projects/{projectId}/architecture/revisions/{revisionId}/nodes/{nodePath}", name: "recursive product node", mimeType: "application/json" },
    { uriTemplate: "foundry://projects/{projectId}/architecture/revisions/{revisionId}/composites/{nodePath}/dag", name: "composite-scoped dependency DAG", mimeType: "application/json" },
    { uriTemplate: "foundry://builds/{buildId}", name: "build", mimeType: "application/json" },
    { uriTemplate: "foundry://builds/{buildId}/events", name: "build event stream", mimeType: "application/json" },
    { uriTemplate: "foundry://builds/{buildId}/assembly", name: "assembly evidence", mimeType: "application/json" },
    { uriTemplate: "foundry://builds/{buildId}/conformance", name: "generated conformance test", mimeType: "text/x-python" },
    { uriTemplate: "foundry://builds/{buildId}/conformance/manifest", name: "conformance manifest v2", mimeType: "application/json" },
    { uriTemplate: "foundry://builds/{buildId}/reproducibility", name: "reproducibility replay evidence", mimeType: "application/json" },
    { uriTemplate: "foundry://builds/{buildId}/mutation", name: "mutation-strength reports", mimeType: "application/json" },
    { uriTemplate: "foundry://builds/{buildId}/nodes/{nodeId}/context", name: "build node context", mimeType: "application/json" },
    { uriTemplate: "foundry://builds/{buildId}/nodes/{nodeId}/attempts", name: "build node attempts", mimeType: "application/json" },
    { uriTemplate: "foundry://builds/{buildId}/work/{workId}", name: "recursive product work item", mimeType: "application/json" },
    { uriTemplate: "foundry://builds/{buildId}/nodes/{nodePath}/evidence", name: "hierarchical node evidence", mimeType: "application/json" },
    { uriTemplate: "foundry://builds/{buildId}/deliverables", name: "product deliverables", mimeType: "application/json" },
    { uriTemplate: "foundry://capabilities/{capabilityId}/versions/{version}", name: "curated capability definition", mimeType: "application/json" },
    { uriTemplate: "foundry://proposals/{proposalId}", name: "subtree rearchitecture proposal", mimeType: "application/json" },
    { uriTemplate: "foundry://artifacts/{digest}", name: "content-addressed artifact", mimeType: "application/octet-stream" },
  ] }));
  server.setRequestHandler("resources/read", async (request) => {
    const uri = request.params.uri; let content: string | Buffer | undefined, mimeType = "application/json";
    let match = uri.match(/^foundry:\/\/workflows\/([^/]+)$/); if (match) { const workflow = findFoundryWorkflow(match[1]!); if (workflow) { content = renderFoundryWorkflow(workflow); mimeType = "text/markdown"; } }
    match = uri.match(/^foundry:\/\/projects\/([^/]+)$/); if (match) content = JSON.stringify(service.getProject(auth, match[1]!).state, null, 2);
    match = uri.match(/^foundry:\/\/projects\/([^/]+)\/spec$/); if (match) { const project = service.getProject(auth, match[1]!).state; content = service.store.spec(project.id)?.body; mimeType = "text/markdown"; }
    match = uri.match(/^foundry:\/\/projects\/([^/]+)\/architecture\/active$/); if (match) { const project = service.getProject(auth, match[1]!).state; content = JSON.stringify(project.activeRevisionId ? service.store.revision(project.activeRevisionId) : null, null, 2); }
    match = uri.match(/^foundry:\/\/projects\/([^/]+)\/architecture\/revisions\/([^/]+)$/); if (match) content = JSON.stringify(service.getRevision(auth, match[1]!, match[2]!).state, null, 2);
    match = uri.match(/^foundry:\/\/projects\/([^/]+)\/architecture\/revisions\/([^/]+)\/diagrams$/); if (match) content = JSON.stringify(service.getRevisionDiagrams(auth, match[1]!, match[2]!).state, null, 2);
    match = uri.match(/^foundry:\/\/projects\/([^/]+)\/architecture\/drafts\/([^/]+)\/tree$/); if (match) { const tree = service.getProductTree(auth, match[2]!).state; if (tree.projectId !== match[1]) throw new FoundryCommandError("DRAFT_NOT_FOUND", "Product draft was not found"); content = JSON.stringify(tree, null, 2); }
    match = uri.match(/^foundry:\/\/projects\/([^/]+)\/architecture\/revisions\/([^/]+)\/nodes\/(.+)$/); if (match) content = JSON.stringify(service.getProductRevisionNode(auth, match[1]!, match[2]!, decodeURIComponent(match[3]!)).state, null, 2);
    match = uri.match(/^foundry:\/\/projects\/([^/]+)\/architecture\/revisions\/([^/]+)\/composites\/(.+)\/dag$/); if (match) content = JSON.stringify(service.getProductCompositeDag(auth, match[1]!, match[2]!, decodeURIComponent(match[3]!)).state, null, 2);
    match = uri.match(/^foundry:\/\/builds\/([^/]+)$/); if (match) content = JSON.stringify((await service.getBuild(auth, match[1]!)).state, null, 2);
    match = uri.match(/^foundry:\/\/builds\/([^/]+)\/events$/); if (match) content = JSON.stringify(service.getBuildEvents(auth, match[1]!).state, null, 2);
    match = uri.match(/^foundry:\/\/builds\/([^/]+)\/assembly$/); if (match) content = JSON.stringify((await service.getAssemblyEvidence(auth, match[1]!)).state, null, 2);
    match = uri.match(/^foundry:\/\/builds\/([^/]+)\/conformance$/); if (match) { const evidence = (await service.getAssemblyEvidence(auth, match[1]!)).state; if (evidence.evidenceDigest) { const body = JSON.parse(service.readArtifact(auth, evidence.evidenceDigest).toString("utf8")); content = service.readArtifact(auth, body.conformanceDigest); mimeType = "text/x-python"; } }
    match = uri.match(/^foundry:\/\/builds\/([^/]+)\/conformance\/manifest$/); if (match) content = JSON.stringify((await service.getConformance(auth, match[1]!)).state, null, 2);
    match = uri.match(/^foundry:\/\/builds\/([^/]+)\/reproducibility$/); if (match) content = JSON.stringify((await service.getReproducibilityEvidence(auth, match[1]!)).state, null, 2);
    match = uri.match(/^foundry:\/\/builds\/([^/]+)\/mutation$/); if (match) content = JSON.stringify(service.getMutationReport(auth, { buildId: match[1]! }).state, null, 2);
    match = uri.match(/^foundry:\/\/builds\/([^/]+)\/nodes\/([^/]+)\/context$/); if (match) content = JSON.stringify((await service.getNodeContext(auth, { buildId: match[1]!, nodeId: match[2]! })).state, null, 2);
    match = uri.match(/^foundry:\/\/builds\/([^/]+)\/nodes\/([^/]+)\/attempts$/); if (match) content = JSON.stringify(service.getNodeAttempts(auth, { buildId: match[1]!, nodeId: match[2]! }).state, null, 2);
    match = uri.match(/^foundry:\/\/builds\/([^/]+)\/work\/(.+)$/); if (match) content = JSON.stringify(service.getProductWork(auth, match[1]!, decodeURIComponent(match[2]!)).state, null, 2);
    match = uri.match(/^foundry:\/\/builds\/([^/]+)\/nodes\/(.+)\/evidence$/); if (match) content = JSON.stringify(service.getProductNodeEvidence(auth, match[1]!, decodeURIComponent(match[2]!)).state, null, 2);
    match = uri.match(/^foundry:\/\/builds\/([^/]+)\/deliverables$/); if (match) content = JSON.stringify(service.getProductDeliverables(auth, match[1]!).state, null, 2);
    match = uri.match(/^foundry:\/\/capabilities\/([^/]+)\/versions\/([^/]+)$/); if (match) content = JSON.stringify(service.getCapability(auth, match[1]!, match[2]!).state, null, 2);
    match = uri.match(/^foundry:\/\/proposals\/([^/]+)$/); if (match) content = JSON.stringify(service.getProposal(auth, match[1]!).state, null, 2);
    match = uri.match(/^foundry:\/\/artifacts\/(sha256:[a-f0-9]{64})$/); if (match) { content = service.readArtifact(auth, match[1]!); mimeType = "application/octet-stream"; }
    if (content === undefined) throw new Error("resource not found");
    return { contents: [Buffer.isBuffer(content) ? { uri, mimeType, blob: content.toString("base64") } : { uri, mimeType, text: content }] };
  });
  server.setRequestHandler("prompts/list", async () => ({ prompts: FOUNDRY_WORKFLOWS.map((workflow) => ({ name: workflow.id, description: workflow.description, arguments: [{ name: "resourceUri", description: "Foundry resource to operate on", required: false }] })) }));
  server.setRequestHandler("prompts/get", async (request) => {
    const workflow = findFoundryWorkflow(request.params.name); if (!workflow) throw new Error("prompt not found"); const resource = request.params.arguments?.resourceUri;
    return { description: workflow.description, messages: [{ role: "user", content: { type: "text", text: renderFoundryWorkflow(workflow, resource) } }] };
  });
  return server;
}
