import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolvePistonVersion, type TesterConfig } from "./tester.ts";

const SENTINEL = "__FOUNDRY_MUTATION__";

export interface MutationRequest { workspace: string; sourcePath: string; repositoryFiles: string[]; conformance: string; maxMutants?: number; }

function script(sourcePath: string, maxMutants: number): string {
  const cfg = Buffer.from(JSON.stringify({ sourcePath, maxMutants })).toString("base64");
  return `import ast,base64,copy,json,os,pathlib,subprocess,sys
cfg=json.loads(base64.b64decode("${cfg}")); root=pathlib.Path.cwd(); source=root/cfg["sourcePath"]; original=source.read_text(); tree=ast.parse(original)
candidates=[]
for node in ast.walk(tree):
 if isinstance(node,ast.Compare) and len(node.ops)==1 and type(node.ops[0]) in (ast.Eq,ast.NotEq,ast.Lt,ast.LtE,ast.Gt,ast.GtE): candidates.append((node.lineno,node.col_offset,"compare"))
 elif isinstance(node,ast.BoolOp): candidates.append((node.lineno,node.col_offset,"boolop"))
 elif isinstance(node,ast.BinOp) and type(node.op) in (ast.Add,ast.Sub,ast.Mult,ast.Div,ast.FloorDiv): candidates.append((node.lineno,node.col_offset,"binop"))
 elif isinstance(node,ast.Constant) and isinstance(node.value,bool): candidates.append((node.lineno,node.col_offset,"boolean"))
 elif isinstance(node,ast.If): candidates.append((node.lineno,node.col_offset,"condition"))
 elif isinstance(node,ast.Expr) and isinstance(node.value,ast.Call) and isinstance(node.value.func,ast.Attribute) and node.value.func.attr in ("commit","rollback"): candidates.append((node.lineno,node.col_offset,"transaction-call"))
 elif isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id=="round" and node.args: candidates.append((node.lineno,node.col_offset,"rounding"))
 elif isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=="__all__" for target in node.targets): candidates.append((node.lineno,node.col_offset,"public-export"))
 elif isinstance(node,ast.Tuple) and len(node.elts)>1: candidates.append((node.lineno,node.col_offset,"tuple-element"))
candidates=sorted(set(candidates))[:cfg["maxMutants"]]; results=[]
class Mutate(ast.NodeTransformer):
 def __init__(self,target): self.target=target
 def generic_visit(self,node):
  node=super().generic_visit(node); key=(getattr(node,"lineno",-1),getattr(node,"col_offset",-1),self.target[2])
  if key!=self.target:return node
  if self.target[2]=="compare" and isinstance(node,ast.Compare): node.ops[0]={ast.Eq:ast.NotEq(),ast.NotEq:ast.Eq(),ast.Lt:ast.GtE(),ast.LtE:ast.Gt(),ast.Gt:ast.LtE(),ast.GtE:ast.Lt()}[type(node.ops[0])]
  elif self.target[2]=="boolop" and isinstance(node,ast.BoolOp): node.op=ast.Or() if isinstance(node.op,ast.And) else ast.And()
  elif self.target[2]=="binop" and isinstance(node,ast.BinOp): node.op=ast.Sub() if isinstance(node.op,ast.Add) else ast.Add()
  elif self.target[2]=="boolean" and isinstance(node,ast.Constant): node.value=not node.value
  elif self.target[2]=="condition" and isinstance(node,ast.If): node.test=ast.Constant(False)
  elif self.target[2]=="transaction-call" and isinstance(node,ast.Expr): return ast.copy_location(ast.Pass(),node)
  elif self.target[2]=="rounding" and isinstance(node,ast.Call): return ast.copy_location(node.args[0],node)
  elif self.target[2]=="public-export" and isinstance(node,ast.Assign): node.value=ast.List(elts=[],ctx=ast.Load())
  elif self.target[2]=="tuple-element" and isinstance(node,ast.Tuple): node.elts=node.elts[1:]
  return node
try:
 for target in candidates:
  mutant=Mutate(target).visit(copy.deepcopy(tree)); ast.fix_missing_locations(mutant); source.write_text(ast.unparse(mutant)+"\\n")
  env={**os.environ,"PYTHONHASHSEED":"0","TZ":"UTC","LC_ALL":"C"}; run=subprocess.run([sys.executable,"__foundry_mutation_test.py"],cwd=root,capture_output=True,text=True,timeout=10,env=env)
  results.append({"mutantId":f"{target[2]}:{target[0]}:{target[1]}","operation":target[2],"location":f"{cfg['sourcePath']}:{target[0]}","killed":run.returncode!=0})
finally: source.write_text(original)
killed=sum(1 for result in results if result["killed"]); print("${SENTINEL}"+json.dumps({"generated":len(results),"killed":killed,"mutants":results,"survived":[result for result in results if not result["killed"]],"score":killed/len(results) if results else 1.0}))
`;
}

function files(req: MutationRequest): Array<{ name: string; content: string }> {
  const repository = req.repositoryFiles.flatMap((name) => { const path = join(req.workspace, name); return existsSync(path) ? [{ name, content: readFileSync(path, "utf8") }] : []; });
  return [{ name: "__foundry_mutation.py", content: script(req.sourcePath, Math.min(req.maxMutants ?? 64, 64)) }, { name: "__foundry_mutation_test.py", content: req.conformance }, ...repository];
}

function parse(stdout: string): any { const line = stdout.split("\n").find((value) => value.startsWith(SENTINEL)); if (!line) throw new Error("mutation runner returned no structured report"); return JSON.parse(line.slice(SENTINEL.length)); }

export async function executeMutation(req: MutationRequest, cfg: TesterConfig): Promise<any> {
  const payload = files(req);
  if (cfg.mode === "piston") { const url = cfg.pistonUrl ?? "http://127.0.0.1:2000", version = await resolvePistonVersion(url, "python", ">=3.11"); const response = await fetch(`${url}/api/v2/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ language: "python", version, files: payload, run_timeout: 180_000, run_memory_limit: 512_000_000 }) }); const data: any = await response.json(); if (!data.run || data.run.code !== 0) throw new Error(data.message ?? data.run?.stderr ?? "mutation runner failed"); return parse(data.run.stdout ?? ""); }
  const root = mkdtempSync(join(tmpdir(), "foundry-mutation-")); try { for (const file of payload) { const path = join(root, file.name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, file.content); } const run = spawnSync("python3", ["__foundry_mutation.py"], { cwd: root, encoding: "utf8", timeout: 190_000 }); if (run.status !== 0) throw new Error(run.stderr || "mutation runner failed"); return parse(run.stdout); } finally { rmSync(root, { recursive: true, force: true }); }
}
