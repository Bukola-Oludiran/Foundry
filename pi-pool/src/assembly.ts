import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { AssemblyRequest } from "./contract.ts";
import { resolvePistonVersion, satisfies, type TesterConfig } from "./tester.ts";

const SENTINEL = "__FOUNDRY_ASSEMBLY__";

function runner(req: AssemblyRequest): string {
  const delivery: any = req.architecture.delivery;
  const root: any = req.architecture.nodes.find((node: any) => node.id === delivery.integrationNode);
  const targets = req.architecture.nodes.flatMap((node: any) => (node.implementation.targets?.length ? node.implementation.targets : [{ targetId: node.id, path: node.implementation.write_target, mediaType: "text/plain", role: "source" }]));
  const metadata = targets.find((target: any) => target.targetId === delivery.metadataTargetId)?.path;
  const readme = targets.find((target: any) => target.targetId === delivery.readmeTargetId)?.path;
  const lockfile = delivery.profile === "python-service" ? targets.find((target: any) => target.targetId === delivery.lockfileTargetId)?.path : undefined;
  const payload = Buffer.from(JSON.stringify({ profile: delivery.profile, metadata, readme, lockfile, publicModule: delivery.publicModule, operations: root.provides.operations.map((op: any) => op.name), entrypoint: delivery.entrypoint, distributionName: delivery.distributionName, versionRange: delivery.runtime.versionRange, dependencyPolicy: delivery.dependencyPolicy })).toString("base64");
  return [
    "import base64, compileall, hashlib, importlib, json, os, pathlib, shutil, subprocess, sys, tempfile, time, venv, zipfile",
    `start=time.time(); cfg=json.loads(base64.b64decode("${payload}")); root=pathlib.Path.cwd(); checks=[]; tooling={}`,
    "def check(name, ok, detail=''):",
    " checks.append({'name':name,'passed':bool(ok),'detail':detail})",
    "try:",
    " metadata_path=root/cfg['metadata'] if cfg.get('metadata') else None",
    " readme_path=root/cfg['readme'] if cfg.get('readme') else None",
    " check('metadata', bool(metadata_path and metadata_path.is_file()), str(cfg.get('metadata')))",
    " check('readme', bool(readme_path and readme_path.is_file()), str(cfg.get('readme')))",
    " lock_path=root/cfg['lockfile'] if cfg.get('lockfile') else None",
    " if cfg['profile']=='python-service':",
    "  check('lockfile', bool(lock_path and lock_path.is_file()), str(cfg.get('lockfile')))",
    "  lock_lines=[line.strip() for line in lock_path.read_text().splitlines() if line.strip() and not line.lstrip().startswith('#')] if lock_path and lock_path.is_file() else []",
    "  check('hash-locked-dependencies', all('==' in line and '--hash=sha256:' in line for line in lock_lines), '; '.join(lock_lines))",
    " if metadata_path and metadata_path.is_file():",
    "  import tomllib",
    "  project=tomllib.loads(metadata_path.read_text()).get('project', {})",
    "  normalize=lambda value: str(value).lower().replace('_','-').replace('.','-')",
    "  check('distribution-name', normalize(project.get('name',''))==normalize(cfg['distributionName']), str(project.get('name')))",
    "  check('python-requires', project.get('requires-python')==cfg['versionRange'], str(project.get('requires-python')))",
    " check('compile', compileall.compile_dir(root, quiet=1))",
    " pip_version=subprocess.run([sys.executable,'-m','pip','--version'],capture_output=True,text=True,timeout=30)",
    " tooling['pip']=pip_version.stdout.strip()",
    " out=root/'.foundry-dist'; out.mkdir(exist_ok=True)",
    " wheel=subprocess.run([sys.executable,'-m','pip','wheel','.','--no-deps','--no-build-isolation','-w',str(out)],capture_output=True,text=True,timeout=120)",
    " check('wheel', wheel.returncode==0, (wheel.stdout+wheel.stderr)[-2000:])",
    " wheels=list(out.glob('*.whl')); check('wheel-artifact', len(wheels)==1, str([p.name for p in wheels]))",
    " wheel_digest=None; package_digest=None",
    " if wheels:",
    "  wheel_digest='sha256:'+hashlib.sha256(wheels[0].read_bytes()).hexdigest()",
    "  with zipfile.ZipFile(wheels[0]) as archive:",
    "   normalized=hashlib.sha256()",
    "   for member in sorted(archive.namelist()): normalized.update(member.encode()+b'\\0'+archive.read(member)+b'\\0')",
    "   package_digest='sha256:'+normalized.hexdigest()",
    "   metadata_names=[name for name in archive.namelist() if name.endswith('.dist-info/METADATA')]",
    "   check('wheel-metadata', len(metadata_names)==1, str(metadata_names))",
    "   wheel_metadata=archive.read(metadata_names[0]).decode('utf8','replace') if metadata_names else ''",
    "   requires=[line for line in wheel_metadata.splitlines() if line.lower().startswith('requires-dist:')]",
    "   check('dependency-policy-none', cfg['dependencyPolicy']!='none' or not requires, '; '.join(requires))",
    "   if cfg['dependencyPolicy']=='locked':",
    "    normalize_dep=lambda value: value.strip().lower().replace('_','-')",
    "    locked={normalize_dep(line.split('==',1)[0]) for line in lock_lines}",
    "    declared={normalize_dep(line.split(':',1)[1].strip().split(';',1)[0].split(' ',1)[0].split('(',1)[0]) for line in requires}",
    "    check('locked-metadata-parity',locked==declared,f'lock={sorted(locked)} metadata={sorted(declared)}')",
    "  env=root/'.foundry-venv'; venv.EnvBuilder(with_pip=True).create(env); py=env/('Scripts/python.exe' if os.name=='nt' else 'bin/python')",
    "  if cfg['profile']=='python-service' and lock_path and lock_lines:",
    "   dependencies=subprocess.run([str(py),'-m','pip','install','--no-index','--require-hashes','--find-links','/opt/foundry/wheelhouse','-r',str(lock_path)],capture_output=True,text=True,timeout=120); check('locked-dependencies',dependencies.returncode==0,(dependencies.stdout+dependencies.stderr)[-2000:])",
    "  install=subprocess.run([str(py),'-m','pip','install','--no-deps',str(wheels[0])],capture_output=True,text=True,timeout=120); check('install',install.returncode==0,(install.stdout+install.stderr)[-2000:])",
    "  smoke=('import importlib; m=importlib.import_module('+repr(cfg['entrypoint']['module'])+'); raise SystemExit(0 if hasattr(m,'+repr(cfg['entrypoint']['symbol'])+') else 1)') if cfg['profile']=='python-service' else ('import importlib; m=importlib.import_module('+repr(cfg['publicModule'])+'); missing=[n for n in '+repr(cfg['operations'])+ ' if not hasattr(m,n)]; raise SystemExit(\"missing:\"+\",\".join(missing) if missing else 0)')",
    "  outside=pathlib.Path(tempfile.mkdtemp()); imported=subprocess.run([str(py),'-c',smoke],cwd=outside,capture_output=True,text=True,timeout=30); check('public-import',imported.returncode==0,(imported.stdout+imported.stderr)[-2000:])",
    "  outside_test=outside/'test_acceptance.py'; shutil.copy2(root/'__foundry_conformance.py', outside_test)",
    "  conformance=subprocess.run([str(py),str(outside_test)],cwd=outside,capture_output=True,text=True,timeout=60); check('conformance',conformance.returncode==0,(conformance.stdout+conformance.stderr)[-4000:])",
    "except Exception as exc: check('execution',False,repr(exc))",
    `failed=[c for c in checks if not c['passed']]; print("${SENTINEL}"+json.dumps({'checks':checks,'passed':len(checks)-len(failed),'failed':len(failed),'durationMs':round((time.time()-start)*1000),'python':sys.version.split()[0],'tooling':tooling,'wheelDigest':locals().get('wheel_digest'),'packageDigest':locals().get('package_digest')})); raise SystemExit(1 if failed else 0)`,
    "",
  ].join("\n");
}

function files(req: AssemblyRequest): Array<{ name: string; content: string }> {
  const entries = req.architecture.nodes.flatMap((node: any) => (node.implementation.targets?.length ? node.implementation.targets : [{ path: node.implementation.write_target }])).flatMap((target: any) => { const path = join(req.workspace, target.path); return existsSync(path) ? [{ name: target.path, content: readFileSync(path, "utf8") }] : []; });
  return [{ name: "__assembly.py", content: runner(req) }, { name: "__foundry_conformance.py", content: req.conformance }, ...entries];
}

function evidence(req: AssemblyRequest, stdout: string, stderr: string, code: number, resolved: string, started: number, mode: "piston" | "local-control") {
  const line = stdout.split("\n").find((value) => value.startsWith(SENTINEL)); const parsed = line ? JSON.parse(line.slice(SENTINEL.length)) : { passed: 0, failed: 1, checks: [{ name: "execution", passed: false, detail: stderr || `exit ${code}` }], durationMs: Date.now() - started };
  const targetDigests = Object.fromEntries(req.architecture.nodes.flatMap((node: any) => (node.implementation.targets?.length ? node.implementation.targets : [{ targetId: node.id, path: node.implementation.write_target }])).map((target: any) => { const path = join(req.workspace, target.path); return [target.targetId, existsSync(path) ? `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}` : null]; }));
  const base = { schemaVersion: req.architecture.version === 4 ? 2 : 1, buildId: req.buildId, revisionId: req.revisionId, profile: req.architecture.delivery?.profile, runtime: { requested: req.architecture.delivery?.runtime.versionRange, resolved }, tooling: parsed.tooling ?? {}, wheelDigest: parsed.wheelDigest ?? null, packageDigest: parsed.packageDigest ?? null, targetDigests, passed: parsed.passed, failed: parsed.failed, diagnostics: { checks: parsed.checks, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000), exitCode: code }, durationMs: parsed.durationMs };
  if (req.architecture.version !== 4) return base;
  const conformancePassed = parsed.checks?.find((check: any) => check.name === "conformance")?.passed === true;
  const acceptance = req.architecture.nodes.flatMap((node: any) => (node.acceptance.scenarios ?? []).map((scenario: any) => ({ nodeId: node.id, scenarioId: scenario.id, covers: scenario.covers ?? [], passed: conformancePassed, steps: scenario.steps.map((step: any) => ({ stepId: step.id, operation: step.operation, expectation: step.expect ?? null, passed: conformancePassed })) })));
  const nodes = req.architecture.nodes.map((node: any) => ({ nodeId: node.id, mandateOwner: node.acceptance.mandate_owner, properties: node.acceptance.properties ?? [], scenarios: acceptance.filter((entry: any) => entry.nodeId === node.id) }));
  return { ...base, environment: { worker: "pi-pool", sandbox: mode, oracle: `${mode}:python:${resolved}` }, requirements: (req.architecture.requirements ?? []).map((requirement: any) => ({ requirementId: requirement.id, priority: requirement.priority ?? null, scenarioIds: acceptance.filter((entry: any) => entry.covers.includes(requirement.id)).map((entry: any) => `${entry.nodeId}/${entry.scenarioId}`) })), nodes, acceptance };
}

export async function executeAssembly(req: AssemblyRequest, cfg: TesterConfig): Promise<{ verdict: "green" | "red"; evidence: any }> {
  if (!req.architecture.delivery || !["python-library", "python-service"].includes(req.architecture.delivery.profile)) throw new Error("UNSUPPORTED_DELIVERY_PROFILE"); const started = Date.now(), assembled = files(req);
  if (cfg.mode === "piston") { const url = cfg.pistonUrl ?? "http://127.0.0.1:2000", version = await resolvePistonVersion(url, "python", req.architecture.delivery.runtime.versionRange), response = await fetch(`${url}/api/v2/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ language: "python", version, files: assembled, run_timeout: 180000, run_memory_limit: 512_000_000 }) }), data = await response.json() as any; if (!data.run) throw new Error(data.message ?? "Piston assembly failed"); const result = evidence(req, data.run.stdout ?? "", data.run.stderr ?? "", data.run.code ?? -1, version, started, "piston"); return { verdict: result.failed === 0 ? "green" : "red", evidence: result }; }
  const dir = mkdtempSync(join(tmpdir(), "foundry-assembly-")); try { const version = spawnSync("python3", ["--version"], { encoding: "utf8" }).stdout.trim().replace(/^Python\s+/, ""); if (!satisfies(version, req.architecture.delivery.runtime.versionRange)) return { verdict: "red", evidence: { schemaVersion: req.architecture.version === 4 ? 2 : 1, buildId: req.buildId, revisionId: req.revisionId, profile: req.architecture.delivery.profile, runtime: { requested: req.architecture.delivery.runtime.versionRange, resolved: version }, targetDigests: {}, passed: 0, failed: 1, diagnostics: { code: "RUNTIME_UNAVAILABLE" }, durationMs: Date.now() - started } }; for (const file of assembled) { const path = join(dir, file.name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, file.content); } const proc = spawnSync("python3", ["__assembly.py"], { cwd: dir, encoding: "utf8", timeout: 190000 }); const result = evidence(req, proc.stdout ?? "", proc.stderr ?? "", proc.status ?? -1, version, started, "local-control"); return { verdict: result.failed === 0 ? "green" : "red", evidence: result }; } finally { rmSync(dir, { recursive: true, force: true }); }
}
