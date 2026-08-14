import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { executeAssembly } from "../src/assembly.ts";
import { satisfies } from "../src/tester.ts";
import { generatePythonConformance } from "../../src/core/delivery.ts";
import type { FoundryArchitecture } from "../../src/core/types.ts";

const root = resolve("fixtures", "python-pricing-engine");
const architecture = JSON.parse(readFileSync(resolve(root, "foundry-v3.ir.json"), "utf8")) as FoundryArchitecture;
const pistonUrl = process.env.PISTON_URL ?? "http://127.0.0.1:2000";

try {
  const result = await executeAssembly({ workspace: resolve(root, "fixed"), buildId: "live-piston-assembly", revisionId: "fixture-v3", architecture, conformance: generatePythonConformance(architecture) }, { mode: "piston", pistonUrl });
  assert.equal(result.verdict, "green", JSON.stringify(result.evidence));
  assert.equal(satisfies(result.evidence.runtime.resolved, architecture.delivery!.runtime.versionRange), true);
  console.log("✅ live Piston python-library assembly validated (wheel → clean install → external import → conformance)");
} catch (error) {
  if ((error as Error).message.startsWith("RUNTIME_UNAVAILABLE")) {
    const runtimes = await fetch(`${pistonUrl}/api/v2/runtimes`).then((response) => response.json());
    throw new Error(`Live Piston cannot certify python-library assembly: ${(error as Error).message}; installed runtimes=${JSON.stringify(runtimes)}`);
  }
  throw error;
}
