import { posix } from "node:path";
import type { Diagnostic, FoundryArchitecture, FoundryNode, FoundryTarget, FoundryTypedValue } from "./types.ts";

export const MAX_NODE_TARGETS = 16;
export const MAX_CHANGESET_BYTES = 2 * 1024 * 1024;

export function targetsFor(node: FoundryNode): FoundryTarget[] {
  if (node.implementation.targets?.length) return node.implementation.targets;
  if (!node.implementation.write_target) return [];
  return [{
    targetId: node.id,
    path: node.implementation.write_target,
    mediaType: "text/plain",
    role: node.implementation.entrypoint ? "entrypoint" : "source",
  }];
}

export function primaryTarget(node: FoundryNode): FoundryTarget {
  const targets = targetsFor(node);
  return targets.find((target) => target.targetId === node.implementation.primaryTargetId) ?? targets[0]!;
}

export function deliveryDiagnostics(ir: FoundryArchitecture): Diagnostic[] {
  const out: Diagnostic[] = [];
  const paths = new Map<string, string>();
  const targetIds = new Map<string, string>();
  for (const [nodeIndex, node] of ir.nodes.entries()) {
    const targets = targetsFor(node);
    if (!targets.length) out.push({ code: "TARGET_REQUIRED", severity: "error", message: `${node.id} has no compiler target`, path: `/nodes/${nodeIndex}/implementation` });
    if (targets.length > MAX_NODE_TARGETS) out.push({ code: "TOO_MANY_TARGETS", severity: "error", message: `${node.id} exceeds ${MAX_NODE_TARGETS} targets`, path: `/nodes/${nodeIndex}/implementation/targets` });
    if ((node.acceptance.perf?.time_ms ?? 0) > 10_000 || (node.acceptance.perf?.mem_mb ?? 0) > 256) out.push({ code: "RESOURCE_CEILING_EXCEEDED", severity: "error", message: `${node.id} exceeds the 10s/256MB node-verification ceiling`, path: `/nodes/${nodeIndex}/acceptance/perf` });
    for (const [targetIndex, target] of targets.entries()) {
      const path = posix.normalize(target.path);
      if (!target.targetId || !target.path || path !== target.path || path.startsWith("../") || path.startsWith("/") || path === ".") out.push({ code: "INVALID_TARGET", severity: "error", message: `${node.id}/${target.targetId} has an unsafe repository path`, path: `/nodes/${nodeIndex}/implementation/targets/${targetIndex}` });
      const priorPath = paths.get(path); if (priorPath) out.push({ code: "DUPLICATE_TARGET_PATH", severity: "error", message: `${path} is owned by ${priorPath} and ${node.id}` }); else paths.set(path, node.id);
      const priorId = targetIds.get(target.targetId); if (priorId) out.push({ code: "DUPLICATE_TARGET_ID", severity: "error", message: `${target.targetId} is owned by ${priorId} and ${node.id}` }); else targetIds.set(target.targetId, node.id);
    }
  }
  if ((ir.version ?? 2) >= 3) {
    const delivery = ir.delivery;
    const root = ir.nodes.find((node) => node.id === ir.root);
    if (!delivery) out.push({ code: "DELIVERY_PROFILE_REQUIRED", severity: "error", message: "IR v3 requires a delivery profile" });
    else {
      if (!root || root.kind !== "integrator" || delivery.integrationNode !== ir.root) out.push({ code: "INVALID_INTEGRATION_NODE", severity: "error", message: "delivery.integrationNode must identify the root integrator" });
      if (delivery.runtime.language !== "python" || !["python-library", "python-service"].includes(delivery.profile)) out.push({ code: "UNSUPPORTED_DELIVERY_PROFILE", severity: "error", message: "Supported delivery profiles are python-library and python-service" });
      if (delivery.profile === "python-library" && delivery.dependencyPolicy !== "none") out.push({ code: "INVALID_DEPENDENCY_POLICY", severity: "error", message: "python-library currently requires dependencyPolicy none" });
      if (delivery.profile === "python-service") {
        if (delivery.dependencyPolicy !== "locked") out.push({ code: "INVALID_DEPENDENCY_POLICY", severity: "error", message: "python-service requires hash-locked dependencies" });
        if (!delivery.healthRoute.startsWith("/") || delivery.healthRoute.includes("..")) out.push({ code: "INVALID_HEALTH_ROUTE", severity: "error", message: "Service healthRoute must be an absolute application path" });
        if (!delivery.entrypoint.module || !delivery.entrypoint.symbol || delivery.persistence.engine !== "sqlite" || delivery.persistence.schemaVersion < 1) out.push({ code: "INVALID_SERVICE_CONTRACT", severity: "error", message: "Service entrypoint and SQLite schema contract are required" });
        for (const [field, id] of [["lockfileTargetId", delivery.lockfileTargetId], ["serviceEntrypointTargetId", delivery.serviceEntrypointTargetId]] as const) if (!targetIds.has(id)) out.push({ code: "DELIVERY_TARGET_MISSING", severity: "error", message: `${field} references unknown target ${id}` });
        const rootOperations = new Set(root?.provides.operations.map((operation) => operation.name)); for (const operation of [delivery.migrationOperationId, delivery.readinessOperationId]) if (!rootOperations.has(operation)) out.push({ code: "SERVICE_OPERATION_MISSING", severity: "error", message: `Service operation ${operation} is not exposed by the root interface` });
      }
      for (const [field, id] of [["metadataTargetId", delivery.metadataTargetId], ["readmeTargetId", delivery.readmeTargetId]] as const) if (!targetIds.has(id)) out.push({ code: "DELIVERY_TARGET_MISSING", severity: "error", message: `${field} references unknown target ${id}` });
    }
    const must = new Set((ir.requirements ?? []).filter((r) => r.priority === "must").map((r) => r.id));
    const covered = new Set(ir.nodes.flatMap((node) => ir.version === 4 ? (node.acceptance.scenarios ?? []).flatMap((scenario) => scenario.covers) : node.acceptance.cases.flatMap((test) => test.covers ?? [])));
    for (const id of must) if (!covered.has(id)) out.push({ code: "MUST_REQUIREMENT_UNCOVERED", severity: "error", message: `Must requirement ${id} has no acceptance case reference` });
  }
  if (ir.version === 4) out.push(...typedAcceptanceDiagnostics(ir));
  return out;
}

function visitRefs(value: FoundryTypedValue, visit: (ref: string) => void): void {
  if (Array.isArray(value)) { for (const item of value) visitRefs(item, visit); return; }
  if (!value || typeof value !== "object") return;
  if ("$ref" in value && typeof value.$ref === "string") { visit(value.$ref); return; }
  if ("$type" in value) return;
  for (const nested of Object.values(value)) visitRefs(nested, visit);
}

export function typedAcceptanceDiagnostics(ir: FoundryArchitecture): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [nodeIndex, node] of ir.nodes.entries()) {
    const scenarios = node.acceptance.scenarios ?? [];
    if (node.acceptance.cases.length > 0) out.push({ code: "V4_EXECUTABLE_CASE_FORBIDDEN", severity: "error", message: `${node.id} uses legacy executable cases`, path: `/nodes/${nodeIndex}/acceptance/cases` });
    if (!scenarios.length) out.push({ code: "V4_SCENARIO_REQUIRED", severity: "error", message: `${node.id} requires typed acceptance scenarios`, path: `/nodes/${nodeIndex}/acceptance/scenarios` });
    const operations = new Map(node.provides.operations.map((operation) => [operation.name, operation])); const scenarioIds = new Set<string>();
    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      if (scenarioIds.has(scenario.id)) out.push({ code: "DUPLICATE_ACCEPTANCE_SCENARIO", severity: "error", message: `${node.id} repeats scenario ${scenario.id}` }); else scenarioIds.add(scenario.id);
      const handles = new Set<string>(); const stepIds = new Set<string>();
      for (const [stepIndex, step] of scenario.steps.entries()) {
        const path = `/nodes/${nodeIndex}/acceptance/scenarios/${scenarioIndex}/steps/${stepIndex}`;
        if (stepIds.has(step.id)) out.push({ code: "DUPLICATE_ACCEPTANCE_STEP", severity: "error", message: `${scenario.id} repeats step ${step.id}`, path }); else stepIds.add(step.id);
        const operation = operations.get(step.operation);
        if (!operation) out.push({ code: "UNKNOWN_ACCEPTANCE_OPERATION", severity: "error", message: `${scenario.id}/${step.id} references unknown operation ${step.operation}`, path });
        else if (operation.parameters && operation.parameters.length !== step.arguments.length + (step.receiver ? 1 : 0)) out.push({ code: "ACCEPTANCE_ARGUMENT_MISMATCH", severity: "error", message: `${scenario.id}/${step.id} does not match ${step.operation} parameters`, path });
        if (step.receiver && !handles.has(step.receiver)) out.push({ code: "UNKNOWN_ACCEPTANCE_HANDLE", severity: "error", message: `${scenario.id}/${step.id} references unknown receiver ${step.receiver}`, path });
        for (const argument of step.arguments) visitRefs(argument, (ref) => { if (!handles.has(ref)) out.push({ code: "UNKNOWN_ACCEPTANCE_HANDLE", severity: "error", message: `${scenario.id}/${step.id} references unknown handle ${ref}`, path }); });
        if (step.bind) { if (handles.has(step.bind)) out.push({ code: "DUPLICATE_ACCEPTANCE_HANDLE", severity: "error", message: `${scenario.id}/${step.id} rebinds ${step.bind}`, path }); else handles.add(step.bind); }
      }
    }
  }
  return out;
}

export function pythonModuleFor(ir: FoundryArchitecture, node: FoundryNode): string {
  const target = primaryTarget(node).path;
  const sourceRoot = ir.delivery?.sourceRoot?.replace(/^\.\/?|\/$/g, "") ?? "";
  let relative = sourceRoot && target.startsWith(`${sourceRoot}/`) ? target.slice(sourceRoot.length + 1) : target;
  relative = relative.replace(/\.py$/, "").replace(/\/__init__$/, "");
  return relative.split("/").filter(Boolean).join(".");
}

export function generatePythonConformance(ir: FoundryArchitecture): string {
  if (!ir.delivery || !["python-library", "python-service"].includes(ir.delivery.profile)) throw new Error("DELIVERY_PROFILE_REQUIRED");
  if (ir.version === 4 && ir.delivery.profile === "python-service") return generatePythonServiceConformance(ir);
  if (ir.version === 4) return generatePythonTypedConformance(ir);
  const root = ir.nodes.find((node) => node.id === ir.delivery!.integrationNode)!;
  const operations = root.provides.operations.map((op) => op.name);
  const cases = Buffer.from(JSON.stringify(root.acceptance.cases.map(({ name, call, expect, covers }) => ({ name, call, expect, covers: covers ?? [] })))).toString("base64");
  return `# Generated by Foundry. Source of truth: architecture/foundry.ir.json\nimport base64, json, unittest\nfrom ${ir.delivery.publicModule} import ${operations.join(", ")}\n_CASES = json.loads(base64.b64decode("${cases}"))\nclass FoundryAcceptance(unittest.TestCase):\n    def test_contract(self):\n        for case in _CASES:\n            with self.subTest(case=case["name"]):\n                self.assertEqual(eval(case["call"], globals()), case.get("expect"))\nif __name__ == "__main__": unittest.main()\n`;
}

function generatePythonServiceConformance(ir: FoundryArchitecture): string {
  const delivery = ir.delivery!; if (delivery.profile !== "python-service") throw new Error("PYTHON_SERVICE_REQUIRED"); const root = ir.nodes.find((node) => node.id === delivery.integrationNode)!;
  const config = Buffer.from(JSON.stringify({ entrypoint: delivery.entrypoint, healthRoute: delivery.healthRoute, schemaVersion: delivery.persistence.schemaVersion, operations: root.provides.operations.map((operation) => ({ name: operation.name, parameters: operation.parameters ?? [], http: operation.http })), scenarios: root.acceptance.scenarios ?? [] })).toString("base64");
  return `# Generated by Foundry from typed IR v4 service acceptance. No authored code is evaluated.
import asyncio, base64, concurrent.futures, importlib, json, os, pathlib, socket, sqlite3, subprocess, sys, tempfile, time, unittest, urllib.error, urllib.parse, urllib.request
from datetime import datetime
from decimal import Decimal
_CFG=json.loads(base64.b64decode("${config}"))
def _value(value, handles):
    if isinstance(value,list): return [_value(item,handles) for item in value]
    if not isinstance(value,dict): return value
    if set(value)=={"$ref"}: return handles[value["$ref"]]
    if set(value)=={"$type","value"}:
        if value["$type"]=="datetime": return datetime.fromisoformat(value["value"].replace("Z","+00:00"))
        if value["$type"]=="decimal": return Decimal(value["value"])
        if value["$type"]=="bytes": return base64.b64decode(value["value"])
    return {key:_value(item,handles) for key,item in value.items()}
def _subset(expected,actual):
    if isinstance(expected,dict): return isinstance(actual,dict) and all(key in actual and _subset(value,actual[key]) for key,value in expected.items())
    if isinstance(expected,list): return isinstance(actual,list) and len(expected)==len(actual) and all(_subset(a,b) for a,b in zip(expected,actual))
    return expected==actual
class FoundryServiceAcceptance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sock=socket.socket(); sock.bind(("127.0.0.1",0)); cls.port=sock.getsockname()[1]; sock.close(); cls.temp=tempfile.TemporaryDirectory(); cls.database=str(pathlib.Path(cls.temp.name)/"service.sqlite")
        cls.launch="import asyncio,importlib,inspect,sys; m=importlib.import_module(sys.argv[1]); f=getattr(m,sys.argv[2]); r=f(host='127.0.0.1',port=int(sys.argv[3]),database_path=sys.argv[4]); asyncio.run(r) if inspect.isawaitable(r) else None"
        cls._start()
    @classmethod
    def _start(cls):
        cls.process=subprocess.Popen([sys.executable,"-c",cls.launch,_CFG["entrypoint"]["module"],_CFG["entrypoint"]["symbol"],str(cls.port),cls.database],cwd=cls.temp.name,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        deadline=time.time()+10
        while time.time()<deadline:
            if cls.process.poll() is not None: raise RuntimeError("service exited during startup: "+cls.process.stderr.read()[-2000:])
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{cls.port}"+_CFG["healthRoute"],timeout=.5) as response:
                    if 200<=response.status<300: break
            except Exception: time.sleep(.1)
        else: raise RuntimeError("service health route did not become ready")
    def test_zz_concurrent_readiness(self):
        def health(_):
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}"+_CFG["healthRoute"],timeout=2) as response: return response.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool: self.assertEqual(list(pool.map(health,range(16))),[200]*16)
    def test_zz_restart_recovery(self):
        operation=next((operation for operation in _CFG["operations"] if operation["name"]=="create_subscription"),None)
        if operation:
            body=json.dumps({"tenant":"restart-tenant","id":"restart-sub","amount_cents":777,"idempotency_key":"restart-key"}).encode(); request=urllib.request.Request(f"http://127.0.0.1:{self.port}"+operation["http"]["path"],data=body,method="POST",headers={"content-type":"application/json"}); urllib.request.urlopen(request,timeout=3).read()
        self.process.terminate(); self.process.wait(timeout=5); self._start()
        if operation:
            read=next(candidate for candidate in _CFG["operations"] if candidate["name"]=="get_subscription"); path=read["http"]["path"].replace("{tenant}","restart-tenant").replace("{id}","restart-sub")
            with urllib.request.urlopen(f"http://127.0.0.1:{self.port}"+path,timeout=3) as response: self.assertEqual(json.loads(response.read())["amount_cents"],777)
    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        try: cls.process.wait(timeout=5)
        except subprocess.TimeoutExpired: cls.process.kill(); cls.process.wait(timeout=2)
        if pathlib.Path(cls.database).exists():
            with sqlite3.connect(cls.database) as database: assert database.execute("PRAGMA user_version").fetchone()[0]==_CFG["schemaVersion"]
        cls.temp.cleanup()
def _test(scenario):
    def run(self):
        handles={}; operations={operation["name"]:operation for operation in _CFG["operations"]}
        for step in scenario["steps"]:
            operation=operations[step["operation"]]; http=operation.get("http"); self.assertIsNotNone(http,"service operations require typed HTTP mappings"); arguments=[_value(value,handles) for value in step["arguments"]]; names=[parameter["name"] for parameter in operation["parameters"]]; values=dict(zip(names,arguments)); path=http["path"]
            for key,value in list(values.items()):
                marker="{"+key+"}"
                if marker in path: path=path.replace(marker,urllib.parse.quote(str(value),safe="")); values.pop(key)
            data=None
            if http["method"]=="GET" and values: path += ("&" if "?" in path else "?")+urllib.parse.urlencode(values)
            elif values: data=json.dumps(values,default=str,separators=(",",":")).encode()
            request=urllib.request.Request(f"http://127.0.0.1:{self.port}"+path,data=data,method=http["method"],headers={"content-type":"application/json"})
            expectation=step.get("expect")
            try:
                with urllib.request.urlopen(request,timeout=5) as response: raw=response.read(); actual=json.loads(raw) if raw else None
                if expectation and expectation["kind"]=="error": self.fail("expected typed HTTP error")
            except urllib.error.HTTPError as error:
                raw=error.read(); body=json.loads(raw) if raw else {}; actual=body
                if not expectation or expectation["kind"]!="error": raise
                self.assertEqual(str(body.get("error",body.get("type",error.code))),expectation["errorType"])
                if expectation.get("messageIncludes"): self.assertIn(expectation["messageIncludes"],str(body))
                continue
            if step.get("bind"): handles[step["bind"]]=actual
            if expectation:
                expected=_value(expectation["value"],handles)
                if expectation["kind"]=="equals": self.assertEqual(actual,expected)
                else: self.assertTrue(_subset(expected,actual))
    return run
for _scenario in _CFG["scenarios"]: setattr(FoundryServiceAcceptance,"test_"+_scenario["id"].replace("-","_"),_test(_scenario))
if __name__=="__main__": unittest.main(verbosity=2)
`;
}

function generatePythonTypedConformance(ir: FoundryArchitecture): string {
  const suites = ir.nodes.map((node) => ({ nodeId: node.id, module: node.id === ir.delivery!.integrationNode ? ir.delivery!.publicModule : pythonModuleFor(ir, node), scenarios: node.acceptance.scenarios ?? [] }));
  const encoded = Buffer.from(JSON.stringify(suites)).toString("base64");
  return `# Generated by Foundry from typed IR v4 acceptance. No authored code is evaluated.
import base64, importlib, json, unittest
from datetime import datetime
from decimal import Decimal
_SUITES = json.loads(base64.b64decode("${encoded}"))
def _value(value, handles):
    if isinstance(value, list): return [_value(item, handles) for item in value]
    if not isinstance(value, dict): return value
    if set(value) == {"$ref"}: return handles[value["$ref"]]
    if set(value) == {"$type", "value"}:
        if value["$type"] == "datetime": return datetime.fromisoformat(value["value"].replace("Z", "+00:00"))
        if value["$type"] == "decimal": return Decimal(value["value"])
        if value["$type"] == "bytes": return base64.b64decode(value["value"])
        raise ValueError("unsupported typed value")
    return {key: _value(item, handles) for key, item in value.items()}
def _subset(expected, actual):
    if isinstance(expected, dict): return isinstance(actual, dict) and all(key in actual and _subset(value, actual[key]) for key, value in expected.items())
    if isinstance(expected, list): return isinstance(actual, list) and len(expected) == len(actual) and all(_subset(a, b) for a, b in zip(expected, actual))
    return expected == actual
class FoundryAcceptance(unittest.TestCase): pass
def _test(suite, scenario):
    def run(self):
        module = importlib.import_module(suite["module"]); handles = {}
        for step in scenario["steps"]:
            operation = getattr(module, step["operation"]); arguments = [_value(value, handles) for value in step["arguments"]]
            if step.get("receiver"): arguments.insert(0, handles[step["receiver"]])
            expectation = step.get("expect")
            if expectation and expectation["kind"] == "error":
                with self.assertRaisesRegex(Exception, expectation.get("messageIncludes", ".*")) as caught: operation(*arguments)
                self.assertEqual(type(caught.exception).__name__, expectation["errorType"]); continue
            actual = operation(*arguments)
            if step.get("bind"): handles[step["bind"]] = actual
            if expectation:
                expected = _value(expectation["value"], handles)
                if expectation["kind"] == "equals": self.assertEqual(actual, expected)
                else: self.assertTrue(_subset(expected, actual), f"{expected!r} is not a subset of {actual!r}")
    return run
for _suite in _SUITES:
    for _scenario in _suite["scenarios"]: setattr(FoundryAcceptance, "test_" + _suite["nodeId"].replace("-", "_") + "__" + _scenario["id"].replace("-", "_"), _test(_suite, _scenario))
if __name__ == "__main__": unittest.main(verbosity=2)
`;
}
