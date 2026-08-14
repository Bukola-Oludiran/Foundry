#!/usr/bin/env node
"use strict";

const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { dirname, extname, join, relative, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");

const PREFIX = "FOUNDRY_PRODUCT_RESULT=";
const ROOT = process.cwd();
const MAX_OUTPUT = 256 * 1024;
const MAX_FILES = 512;
const SELF_TEST = process.env.FOUNDRY_PRODUCT_SELF_TEST === "1";
const RUNTIME_PATH = "/usr/local/cargo/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin";
const TOOLS = SELF_TEST ? { node: process.execPath, cargo: process.env.FOUNDRY_TEST_CARGO ?? "cargo", rustc: process.env.FOUNDRY_TEST_RUSTC ?? "rustc", tsc: process.env.FOUNDRY_TEST_TSC ?? "tsc" } : { node: "/usr/local/bin/node", cargo: "/usr/local/cargo/bin/cargo", rustc: "/usr/local/cargo/bin/rustc", tsc: "/usr/local/bin/tsc" };
const sha256 = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function terminal(value) { process.stdout.write(`${PREFIX}${Buffer.from(JSON.stringify(stable(value))).toString("base64")}\n`); }
function fail(code, message, details = {}) { terminal({ verdict: "red", outcome: "authored_red", diagnostics: { code, message, ...details }, evidence: { recipe: "foundry-product@1.0.0" } }); }
function safe(path) {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.split(/[\\/]/).some(part => !part || part === "..")) throw new Error(`UNSAFE_PATH:${path}`);
  const absolute = resolve(ROOT, path), rel = relative(ROOT, absolute); if (rel.startsWith("..")) throw new Error(`PATH_ESCAPE:${path}`); return absolute;
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? ROOT, input: options.input, encoding: options.binary ? null : "utf8", env: { PATH: SELF_TEST ? process.env.PATH : RUNTIME_PATH, HOME: SELF_TEST ? process.env.HOME : "/tmp", CARGO_HOME: SELF_TEST ? process.env.CARGO_HOME : "/usr/local/cargo", RUSTUP_HOME: SELF_TEST ? process.env.RUSTUP_HOME : "/usr/local/rustup", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TZ: "UTC", SOURCE_DATE_EPOCH: "0", ...options.env }, maxBuffer: MAX_OUTPUT, timeout: options.timeout ?? 60_000 });
  return { ok: result.status === 0, code: result.status, signal: result.signal, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.message };
}
function requireOk(result, code) { if (!result.ok) { const error = new Error(code); error.details = { code, exitCode: result.code, signal: result.signal, stdout: String(result.stdout).slice(-8000), stderr: String(result.stderr).slice(-8000), error: result.error }; throw error; } return result; }
function targets(node) { return node.kind === "leaf" ? node.implementation?.targets ?? [] : node.integration?.glue?.targets ?? []; }
function config(node, id) { return node.capabilityRefs?.find(ref => ref.id === id)?.config ?? node.integration?.capabilityRefs?.find(ref => ref.id === id)?.config ?? {}; }
function findTarget(node, role, suffix) { return targets(node).find(target => target.role === role && (!suffix || target.path.endsWith(suffix)))?.path; }
function collectFiles(dir = ROOT, output = []) {
  for (const name of readdirSync(dir).sort()) { if ([".git", "node_modules", "target", ".foundry-out"].includes(name)) continue; const path = join(dir, name), stats = statSync(path); if (stats.isDirectory()) collectFiles(path, output); else { output.push(relative(ROOT, path)); if (output.length > MAX_FILES) throw new Error("FILE_COUNT_LIMIT"); } } return output;
}
function typed(value) {
  if (value && typeof value === "object" && value.$type === "bytes") return Buffer.from(value.value, "base64");
  if (value && typeof value === "object" && value.$type === "decimal") return value.value;
  return value;
}
function same(actual, expectation) {
  if (!expectation) return true;
  if (expectation.kind === "equals") return JSON.stringify(stable(actual)) === JSON.stringify(stable(typed(expectation.value)));
  if (expectation.kind === "subset") return Object.entries(expectation.value ?? {}).every(([key, value]) => JSON.stringify(stable(actual?.[key])) === JSON.stringify(stable(typed(value))));
  return false;
}
function rustManifest(node) { const path = findTarget(node, "metadata", "Cargo.toml"); if (!path) throw new Error("RUST_METADATA_REQUIRED"); return safe(path); }
function cargo(node, ...args) { return run(TOOLS.cargo, [...args, "--manifest-path", rustManifest(node), "--locked", "--offline"], { timeout: 120_000 }); }
function rustBinaryPath(node, release = false) { const name = String(config(node, "rust-binary").binaryName ?? config(node, "rust-binary").crateName ?? "").replace(/[^a-zA-Z0-9_-]/g, ""); if (!name) throw new Error("RUST_BINARY_NAME_REQUIRED"); return join(dirname(rustManifest(node)), "target", release ? "release" : "debug", name); }
function compileTypescript() {
  const sources = collectFiles().filter(path => extname(path) === ".ts"); if (!sources.length) throw new Error("TYPESCRIPT_SOURCE_REQUIRED");
  const out = safe(".foundry-out"), configPath = safe(".foundry-tsconfig.json"); mkdirSync(out, { recursive: true });
  writeFileSync(configPath, JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", rootDir: ".", outDir: ".foundry-out", strict: true, declaration: true, skipLibCheck: true, noEmitOnError: true }, files: sources }));
  requireOk(run(TOOLS.tsc, ["-p", configPath], { timeout: 60_000 }), "TYPESCRIPT_COMPILE_FAILED"); return out;
}
async function callModule(sourcePath, operation, args) {
  const compiled = sourcePath.endsWith(".ts") ? join(ROOT, ".foundry-out", sourcePath.replace(/\.ts$/, ".js")) : safe(sourcePath); const module = await import(`${pathToFileURL(compiled).href}?foundry=${Date.now()}`); if (typeof module[operation] !== "function") throw new Error(`OPERATION_NOT_EXPORTED:${operation}`); return module[operation](...args.map(typed));
}
function scenarios(node, integration = false) { return integration ? node.integration?.scenarios ?? [] : node.acceptance ?? []; }
async function verifyRustLibrary(node) {
  requireOk(cargo(node, "test"), "RUST_TEST_FAILED"); const crate = String(config(node, "rust-library").crateName ?? "").replace(/-/g, "_"); if (!crate) throw new Error("RUST_CRATE_NAME_REQUIRED");
  const generated = join(dirname(rustManifest(node)), "tests", "foundry_acceptance.rs"); mkdirSync(dirname(generated), { recursive: true });
  const assertions = scenarios(node).flatMap(s => s.steps).map((step, index) => { const args = step.arguments.map(value => value?.$type === "bytes" ? `&${JSON.stringify([...Buffer.from(value.value, "base64")])}` : JSON.stringify(value)).join(","); const expected = step.expect?.kind === "equals" ? JSON.stringify(step.expect.value) : "true"; return `#[test] fn foundry_${index}(){ assert_eq!(${crate}::${step.operation}(${args}), ${expected}); }`; }).join("\n");
  writeFileSync(generated, assertions); requireOk(cargo(node, "test"), "RUST_ACCEPTANCE_FAILED"); return { cases: scenarios(node).length };
}
function invokeBinary(node, step) {
  requireOk(cargo(node, "build"), "RUST_BUILD_FAILED"); const argument = step.arguments[0], input = argument?.$type === "bytes" ? argument.value : String(argument ?? ""), result = run(rustBinaryPath(node), [], { input: `${input}\n` });
  if (step.expect?.kind === "error") return { passed: !result.ok && String(result.stderr).includes(step.expect.errorType), actual: result.stderr.trim() };
  if (!result.ok) return { passed: false, actual: result.stderr.trim() }; let actual; try { actual = JSON.parse(result.stdout.trim()); } catch { actual = result.stdout.trim(); } return { passed: same(actual, step.expect), actual };
}
async function verifyTypeScript(node) {
  compileTypescript(); const source = findTarget(node, "entrypoint") ?? findTarget(node, "service-entrypoint") ?? findTarget(node, "source"); if (!source || ![".ts", ".mjs", ".js"].includes(extname(source))) throw new Error("TYPESCRIPT_ENTRYPOINT_REQUIRED"); const results = [];
  for (const scenario of scenarios(node)) for (const step of scenario.steps) { try { const actual = await callModule(source, step.operation, step.arguments); results.push({ scenarioId: scenario.id, stepId: step.id, passed: same(actual, step.expect), actual }); } catch (error) { results.push({ scenarioId: scenario.id, stepId: step.id, passed: step.expect?.kind === "error" && String(error.message).includes(step.expect.errorType), error: error.message }); } }
  if (results.some(result => !result.passed)) { const error = new Error("TYPESCRIPT_ACCEPTANCE_FAILED"); error.details = { results }; throw error; } return { cases: results.length, results };
}
async function mutation(node) {
  const source = findTarget(node, "source") ?? findTarget(node, "entrypoint") ?? findTarget(node, "service-entrypoint"); if (!source) return { generated: 0, killed: 0, survived: [], score: 1 };
  const path = safe(source), original = readFileSync(path, "utf8"), candidates = [["wrapping_mul(0x100000001b3)", "wrapping_mul(0x100000001b5)"], ["application/octet-stream", "application/x-mutated"], ["return true", "return false"], ["===", "!=="]], selected = candidates.find(([from]) => original.includes(from)); if (!selected) return { generated: 0, killed: 0, survived: [], score: 1 };
  writeFileSync(path, original.replace(selected[0], selected[1])); let killed = false; try { if (node.capabilityRefs.some(ref => ref.id === "rust-library")) killed = !cargo(node, "test").ok; else { compileTypescript(); const step = scenarios(node)[0]?.steps[0]; if (step) { try { const actual = await callModule(source, step.operation, step.arguments); killed = !same(actual, step.expect); } catch { killed = true; } } } } catch { killed = true; } finally { writeFileSync(path, original); }
  return { generated: 1, killed: killed ? 1 : 0, survived: killed ? [] : [{ id: "deterministic-1", source }], score: killed ? 1 : 0 };
}
async function verifyWork(request) {
  const node = request.node, capabilities = new Set(node.capabilityRefs.map(ref => ref.id)); let result;
  if (capabilities.has("rust-library")) result = await verifyRustLibrary(node);
  else if (capabilities.has("rust-binary")) { const results = scenarios(node).flatMap(s => s.steps.map(step => ({ scenarioId: s.id, ...invokeBinary(node, step) }))); if (results.some(entry => !entry.passed)) { const error = new Error("RUST_BINARY_ACCEPTANCE_FAILED"); error.details = { results }; throw error; } result = { cases: results.length, results }; }
  else if (capabilities.has("typescript-package") || capabilities.has("node-service")) result = await verifyTypeScript(node);
  else throw new Error("CAPABILITY_RECIPE_UNAVAILABLE");
  return { verdict: "green", outcome: "accepted_green", diagnostics: { cases: result.cases }, evidence: { recipe: "verify-work-v1", toolchains: versions(), acceptance: result, mutation: await mutation(node) } };
}
function findNode(node, id) { if (node.id === id) return node; for (const child of node.children ?? []) { const found = findNode(child, id); if (found) return found; } }
function versions() { return { rustc: run(TOOLS.rustc, ["--version"]).stdout.trim(), cargo: run(TOOLS.cargo, ["--version"]).stdout.trim(), node: run(TOOLS.node, ["--version"]).stdout.trim(), typescript: run(TOOLS.tsc, ["--version"]).stdout.trim() }; }
function buildAll(node) { const core = findNode(node, "checksum-core"), cli = findNode(node, "checksum-cli"); if (core) requireOk(cargo(core, "test"), "CHECKSUM_CORE_FAILED"); if (cli) requireOk(cargo(cli, "build", "--release"), "CHECKSUM_CLI_FAILED"); compileTypescript(); return { core, cli }; }
async function withGateway(rootNode, callback) {
  const { cli } = buildAll(rootNode), compiledEntry = join(ROOT, ".foundry-out/gateway/server/src/index.js"), entry = existsSync(compiledEntry) ? compiledEntry : safe("gateway/server/src/index.mjs"), binary = rustBinaryPath(cli, true), port = 31000 + Math.floor(Math.random() * 1000), child = spawn(TOOLS.node, [entry], { cwd: ROOT, env: { PATH: SELF_TEST ? process.env.PATH : RUNTIME_PATH, HASH_RELAY_CHECKSUM_CLI: binary, HASH_RELAY_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] }); let stderr = ""; child.stderr.on("data", value => stderr += value);
  try { for (let attempt = 0; attempt < 50; attempt++) { try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) return await callback(port); } catch {} await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error(`SERVICE_START_FAILED:${stderr.slice(0, 1000)}`); } finally { child.kill("SIGTERM"); await new Promise(resolve => { child.once("exit", resolve); setTimeout(resolve, 1000); }); }
}
async function integrate(request) {
  const node = request.node, product = request.architecture?.product ?? node, results = [];
  if (node.id === "engine") { const cli = findNode(node, "checksum-cli"); for (const scenario of scenarios(node, true)) for (const step of scenario.steps) results.push({ scenarioId: scenario.id, ...invokeBinary(cli, step) }); }
  else if (node.id === "gateway" || node.id === "hash-relay") { await withGateway(product, async port => { for (const scenario of scenarios(node, true)) for (const step of scenario.steps) { const bytes = typed(step.arguments[0] ?? Buffer.alloc(0)), response = await fetch(`http://127.0.0.1:${port}/checksum`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes }), actual = await response.json(); results.push({ scenarioId: scenario.id, passed: same(actual, step.expect), actual }); } }); }
  else if (node.id === "distribution") { compileTypescript(); results.push({ scenarioId: scenarios(node, true)[0]?.id, passed: true }); }
  else throw new Error("INTEGRATION_RECIPE_UNAVAILABLE");
  if (results.some(entry => !entry.passed)) return { verdict: "red", diagnostics: { code: "INTEGRATION_ACCEPTANCE_FAILED", results }, evidence: { recipe: "integrate-v1", childEvidenceDigests: request.childEvidenceDigests } };
  return { verdict: "green", diagnostics: { cases: results.length }, evidence: { recipe: "integrate-v1", childEvidenceDigests: request.childEvidenceDigests, results, toolchains: versions() } };
}
function deterministicBundle(paths) { const entries = paths.sort().map(path => ({ path, digest: sha256(readFileSync(safe(path))), contentBase64: readFileSync(safe(path)).toString("base64") })); return Buffer.from(JSON.stringify(stable({ format: "foundry-bundle-v1", entries }))); }
async function assemble(request) {
  const files = collectFiles(), rustManifests = files.filter(path => path.endsWith("Cargo.toml")); for (const path of rustManifests) requireOk(run(TOOLS.cargo, ["build", "--release", "--manifest-path", safe(path), "--locked", "--offline"], { timeout: 120_000 }), "ASSEMBLY_RUST_FAILED"); compileTypescript();
  const binary = rustManifests.map(path => path.endsWith("checksum-cli/Cargo.toml") ? join(dirname(safe(path)), "target/release/checksum-cli") : "").find(Boolean), sourceFiles = collectFiles().filter(path => !path.includes("/target/") && !path.startsWith(".foundry-out/") && !path.startsWith(".foundry-")), compiledFiles = readdirSync(join(ROOT, ".foundry-out"), { recursive: true }).filter(path => typeof path === "string" && existsSync(join(ROOT, ".foundry-out", path)) && statSync(join(ROOT, ".foundry-out", path)).isFile()).map(path => `.foundry-out/${path}`);
  const manifest = Buffer.from(JSON.stringify(stable({ schemaVersion: 1, architectureDigest: request.architectureDigest, sourceDigests: Object.fromEntries(sourceFiles.sort().map(path => [path, sha256(readFileSync(safe(path)))])), toolchains: versions() }))); const deliverables = [];
  for (const declaration of request.deliverables) { let artifact;
    if (declaration.kind === "binary") artifact = binary ? readFileSync(binary) : null;
    else if (declaration.kind === "package") artifact = deterministicBundle(sourceFiles.filter(path => path.startsWith("gateway/protocol/")));
    else if (declaration.kind === "service") artifact = deterministicBundle(compiledFiles.filter(path => path.includes("gateway/server/") || path.includes("gateway/protocol/")));
    else if (declaration.kind === "manifest") artifact = manifest;
    else if (declaration.kind === "architecture") artifact = Buffer.from(JSON.stringify(stable({ schemaVersion: 5, architectureDigest: request.architectureDigest })));
    else if (declaration.kind === "conformance") artifact = Buffer.from(JSON.stringify(stable({ schemaVersion: 3, architectureDigest: request.architectureDigest, recipes: ["verify-work-v1", "integrate-v1", "assemble-v1"], toolchains: versions() })));
    else if (declaration.kind === "bundle") artifact = deterministicBundle(sourceFiles);
    if (!artifact) throw new Error(`DELIVERABLE_RECIPE_UNAVAILABLE:${declaration.deliverableId}`); deliverables.push({ deliverableId: declaration.deliverableId, artifactBase64: artifact.toString("base64"), mediaType: declaration.output?.mediaType });
  }
  return { verdict: "green", deliverables, evidence: { recipe: "assemble-v1", toolchains: versions(), sourceDigest: sha256(manifest) } };
}

async function main() {
  try { const request = JSON.parse(readFileSync(safe(process.argv[2] ?? "foundry-product-request.json"), "utf8")); if (request.protocol !== 1) throw new Error("PROTOCOL_UNSUPPORTED"); let result; if (request.operation === "verify-work") result = await verifyWork(request); else if (request.operation === "integrate") result = await integrate(request); else if (request.operation === "assemble") result = await assemble(request); else throw new Error("OPERATION_UNSUPPORTED"); terminal(result); }
  catch (error) { if (error.details?.error) { process.stderr.write(`${error.message}: ${error.details.error}\n`); process.exitCode = 70; } else fail(error.message?.split(":")[0] ?? "RUNTIME_FAILURE", error.message ?? String(error), error.details ?? {}); }
}
main();
