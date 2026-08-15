import { Server } from "@modelcontextprotocol/server";
import type { FoundryHostClient, FoundryResult } from "../core/host-client.ts";
import { HostCommandError } from "../core/host-client.ts";
import { WorkspaceError } from "../core/workspaces.ts";
import { FOUNDRY_SERVER_INSTRUCTIONS, FOUNDRY_WORKFLOWS, findFoundryWorkflow, renderFoundryWorkflow, workflowResourceUri } from "./workflows.ts";

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = { type: "string", minLength: 1, maxLength: 4096 };
const relativePath = { type: "string", minLength: 1, maxLength: 1024, description: "Path relative to the configured workspace root." };
const common = { workspaceId: { type: "string", minLength: 1, maxLength: 100 } };

const TOOLS = [
  { name: "foundry_validate", description: "Validate and compile an IR without changing repository state.", schema: object({ ...common, ir: relativePath }, ["workspaceId", "ir"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_architect", description: "Generate a validated IR and rationale through the configured architecture worker.", schema: object({ ...common, spec: relativePath, output: relativePath, base: text, languages: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: ["python", "typescript", "go"] } } }, ["workspaceId", "spec", "output"]) },
  { name: "foundry_build", description: "Start or resume a GraphReact durable build using local persistence.", schema: object({ ...common, ir: relativePath, durabilityDir: relativePath, base: text, dryRun: { type: "boolean" } }, ["workspaceId", "ir", "durabilityDir"]) },
  { name: "foundry_status", description: "Read the terminal or active status of a durable run.", schema: object({ ...common, runId: text, durabilityDir: relativePath }, ["workspaceId", "runId", "durabilityDir"]), annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_cancel", description: "Durably request monotonic cancellation for a run.", schema: object({ ...common, runId: text, durabilityDir: relativePath }, ["workspaceId", "runId", "durabilityDir"]), annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "foundry_rearchitect", description: "Validate an interface-preserving subtree proposal and write its structural diff.", schema: object({ ...common, ir: relativePath, proposal: relativePath, node: text, reason: { type: "string", minLength: 1, maxLength: 2000 }, output: relativePath }, ["workspaceId", "ir", "proposal", "node", "reason", "output"]) },
  { name: "foundry_publish", description: "Publish a successful durable run as a draft pull request only.", schema: object({ ...common, runId: text, durabilityDir: relativePath, ir: relativePath, base: text, summary: relativePath, draftPr: { const: true } }, ["workspaceId", "runId", "durabilityDir", "ir", "draftPr"]), annotations: { openWorldHint: true } },
] as const;

function response(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function validResult(value: FoundryResult): FoundryResult {
  if (typeof value.accepted !== "boolean" || !Array.isArray(value.diagnostics) || typeof value.provenance?.operationId !== "string" || typeof value.provenance?.at !== "string") throw new Error("Host adapter returned an invalid result");
  return value;
}

function rejectUnknown(input: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new HostCommandError("INVALID_ARGUMENT", `Unknown argument${unexpected.length === 1 ? "" : "s"}: ${unexpected.join(", ")}`);
}

function stringArgument(input: Record<string, unknown>, name: string, maximum = 4096): string {
  const value = input[name];
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) throw new HostCommandError("INVALID_ARGUMENT", `${name} must be a non-empty string of at most ${maximum} characters`);
  return value;
}

function optionalString(input: Record<string, unknown>, name: string, maximum = 4096): string | undefined {
  return input[name] === undefined ? undefined : stringArgument(input, name, maximum);
}

function workspace(input: Record<string, unknown>): string {
  return stringArgument(input, "workspaceId", 100);
}

export function createFoundryMcpServer(client: FoundryHostClient): Server {
  const server = new Server({ name: "foundry", version: "0.1.0" }, { capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: { listChanged: false } }, instructions: FOUNDRY_SERVER_INSTRUCTIONS });

  server.setRequestHandler("tools/list", async () => ({ tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.schema as never, annotations: "annotations" in tool ? tool.annotations : { readOnlyHint: false, idempotentHint: false, openWorldHint: false } })) }));
  server.setRequestHandler("tools/call", async (request) => {
    const input = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      let result: FoundryResult;
      switch (request.params.name) {
        case "foundry_validate": {
          rejectUnknown(input, ["workspaceId", "ir"]);
          result = await client.validate({ workspaceId: workspace(input), ir: stringArgument(input, "ir", 1024) });
          break;
        }
        case "foundry_architect": {
          rejectUnknown(input, ["workspaceId", "spec", "output", "base", "languages"]);
          const languages = input.languages;
          if (languages !== undefined && (!Array.isArray(languages) || languages.length === 0 || languages.length > 3 || new Set(languages).size !== languages.length || languages.some((language) => !["python", "typescript", "go"].includes(String(language))))) throw new HostCommandError("INVALID_ARGUMENT", "languages must contain unique supported language names");
          result = await client.architect({ workspaceId: workspace(input), spec: stringArgument(input, "spec", 1024), output: stringArgument(input, "output", 1024), base: optionalString(input, "base"), languages: languages?.map(String) });
          break;
        }
        case "foundry_build": {
          rejectUnknown(input, ["workspaceId", "ir", "durabilityDir", "base", "dryRun"]);
          if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") throw new HostCommandError("INVALID_ARGUMENT", "dryRun must be a boolean");
          result = await client.build({ workspaceId: workspace(input), ir: stringArgument(input, "ir", 1024), durabilityDir: stringArgument(input, "durabilityDir", 1024), base: optionalString(input, "base"), dryRun: input.dryRun as boolean | undefined });
          break;
        }
        case "foundry_status":
        case "foundry_cancel": {
          rejectUnknown(input, ["workspaceId", "runId", "durabilityDir"]);
          const parsed = { workspaceId: workspace(input), runId: stringArgument(input, "runId", 200), durabilityDir: stringArgument(input, "durabilityDir", 1024) };
          result = request.params.name === "foundry_status" ? await client.status(parsed) : await client.cancel(parsed);
          break;
        }
        case "foundry_rearchitect": {
          rejectUnknown(input, ["workspaceId", "ir", "proposal", "node", "reason", "output"]);
          result = await client.rearchitect({ workspaceId: workspace(input), ir: stringArgument(input, "ir", 1024), proposal: stringArgument(input, "proposal", 1024), node: stringArgument(input, "node", 200), reason: stringArgument(input, "reason", 2000), output: stringArgument(input, "output", 1024) });
          break;
        }
        case "foundry_publish": {
          rejectUnknown(input, ["workspaceId", "runId", "durabilityDir", "ir", "base", "summary", "draftPr"]);
          if (input.draftPr !== true) throw new HostCommandError("INVALID_ARGUMENT", "draftPr must be true; Foundry cannot publish a non-draft pull request");
          result = await client.publish({ workspaceId: workspace(input), runId: stringArgument(input, "runId", 200), durabilityDir: stringArgument(input, "durabilityDir", 1024), ir: stringArgument(input, "ir", 1024), base: optionalString(input, "base"), summary: optionalString(input, "summary", 1024), draftPr: true });
          break;
        }
        default: throw new HostCommandError("TOOL_NOT_FOUND", `Unknown tool ${request.params.name}`);
      }
      return response(validResult(result) as unknown as Record<string, unknown>);
    } catch (error) {
      const known = error instanceof HostCommandError || error instanceof WorkspaceError;
      const payload = { accepted: false, error: { code: known ? error.code : "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error), ...(error instanceof HostCommandError && error.details !== undefined ? { details: error.details } : {}) } };
      return { ...response(payload), isError: true };
    }
  });

  server.setRequestHandler("resources/list", async () => ({ resources: [
    ...FOUNDRY_WORKFLOWS.map((workflow) => ({ uri: workflowResourceUri(workflow.id), name: workflow.description, mimeType: "text/markdown" })),
    ...client.workspaces.ids().map((id) => ({ uri: `foundry://workspaces/${id}`, name: `Configured workspace ${id}`, mimeType: "application/json" })),
  ] }));
  server.setRequestHandler("resources/templates/list", async () => ({ resourceTemplates: [
    { uriTemplate: "foundry://workflows/{workflowId}", name: "Foundry workflow", mimeType: "text/markdown" },
    { uriTemplate: "foundry://workspaces/{workspaceId}", name: "Configured Foundry workspace", mimeType: "application/json" },
  ] }));
  server.setRequestHandler("resources/read", async (request) => {
    const workflowMatch = request.params.uri.match(/^foundry:\/\/workflows\/([^/]+)$/);
    if (workflowMatch) {
      const workflow = findFoundryWorkflow(workflowMatch[1]!);
      if (!workflow) throw new Error("workflow not found");
      return { contents: [{ uri: request.params.uri, mimeType: "text/markdown", text: renderFoundryWorkflow(workflow) }] };
    }
    const workspaceMatch = request.params.uri.match(/^foundry:\/\/workspaces\/([^/]+)$/);
    if (workspaceMatch && client.workspaces.ids().includes(workspaceMatch[1]!)) return { contents: [{ uri: request.params.uri, mimeType: "application/json", text: JSON.stringify({ id: workspaceMatch[1], configured: true }, null, 2) }] };
    throw new Error("resource not found");
  });
  server.setRequestHandler("prompts/list", async () => ({ prompts: FOUNDRY_WORKFLOWS.map((workflow) => ({ name: workflow.id, description: workflow.description, arguments: [{ name: "resourceUri", description: "Foundry resource to operate on", required: false }] })) }));
  server.setRequestHandler("prompts/get", async (request) => {
    const workflow = findFoundryWorkflow(request.params.name);
    if (!workflow) throw new Error("prompt not found");
    return { description: workflow.description, messages: [{ role: "user", content: { type: "text", text: renderFoundryWorkflow(workflow, request.params.arguments?.resourceUri) } }] };
  });
  return server;
}
