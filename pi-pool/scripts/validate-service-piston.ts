import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { executeAssembly } from "../src/assembly.ts";
import { executeMutation } from "../src/mutation.ts";
import { generatePythonConformance } from "../../src/core/delivery.ts";
import type { FoundryArchitecture } from "../../src/core/types.ts";

const workspace = resolve("fixtures", "python-subscription-service"), architecture = JSON.parse(readFileSync(resolve(workspace, "foundry-v4.ir.json"), "utf8")) as FoundryArchitecture;
const result = await executeAssembly({ workspace, buildId: "service-piston-control", revisionId: "service-v4", architecture, conformance: generatePythonConformance(architecture) }, { mode: "piston", pistonUrl: process.env.PISTON_URL ?? "http://127.0.0.1:2000" });
assert.equal(result.verdict, "green", JSON.stringify(result.evidence.diagnostics)); assert.equal(result.evidence.environment.sandbox, "piston"); assert.ok(result.evidence.diagnostics.checks.some((check: any) => check.name === "conformance" && check.passed));
const mutation = await executeMutation({ workspace, sourcePath: "subscription_service/service.py", repositoryFiles: architecture.nodes.flatMap((node) => node.implementation.targets!.map((target) => target.path)), conformance: generatePythonConformance(architecture), maxMutants: 24 }, { mode: "piston", pistonUrl: process.env.PISTON_URL ?? "http://127.0.0.1:2000" }); assert.equal(mutation.score, 1); assert.equal(mutation.survived.length, 0);
console.log("✅ live Piston python-service assembly + mutation validated (locked install → HTTP/SQLite/restart → 24/24 mutants killed)");
