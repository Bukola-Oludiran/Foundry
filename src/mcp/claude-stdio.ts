import { realpathSync } from "node:fs";
import { join } from "node:path";

const projectRoot = realpathSync(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
process.env.FOUNDRY_WORKSPACE_ROOTS ??= `foundry=${projectRoot}`;
process.env.FOUNDRY_HOST_BIN ??= join(projectRoot, "gr-host", "target", "debug", "foundry-host");
process.env.FOUNDRY_MCP_CONTEXT_ID ??= "claude-code";

await import("./stdio.ts");
