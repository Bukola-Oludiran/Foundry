import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import ts from "typescript-legacy";
import type {
  AcceptanceCaseResultV1,
  ContractSymbolMappingV1,
  EvidenceSymbolV1,
  NodeImplementationEvidenceV1,
  TestRequest,
  TestRequestV2,
} from "./contract.ts";
import type { LanguageBackend } from "./language-backend.ts";

const MAX_SYMBOLS = 500;
const MAX_DIAGNOSTICS = 50;
const MAX_TEXT = 512;

const bounded = (value: string): string => value.trim().slice(0, MAX_TEXT);

function safeRelative(workspace: string, target: string): string {
  const root = resolve(workspace);
  const absolute = resolve(root, target);
  const path = relative(root, absolute);
  if (
    !path ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path)
  ) {
    throw new Error("write target is outside the workspace");
  }
  return normalize(path).split(sep).join("/");
}

export function typeScriptSymbols(
  path: string,
  _absolutePath: string,
  content: string,
): EvidenceSymbolV1[] {
  const source = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
  );
  const symbols: EvidenceSymbolV1[] = [];
  const exported = (node: ts.Node): boolean =>
    (ts.getCombinedModifierFlags(node as ts.Declaration) &
      ts.ModifierFlags.Export) !==
    0;
  const add = (
    node: ts.Node,
    name: string,
    kind: EvidenceSymbolV1["kind"],
    signature: string | null,
    visibility: "public" | "internal" = exported(node) ? "public" : "internal",
  ): void => {
    if (!name || symbols.length >= MAX_SYMBOLS) return;
    symbols.push({
      name: bounded(name),
      kind,
      signature: signature ? bounded(signature) : null,
      visibility,
      path,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      add(
        statement,
        statement.name.text,
        "function",
        statement.getText(source).split("{")[0] ?? null,
      );
      continue;
    }
    if (
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name)
        add(statement, statement.name.text, "type", statement.name.text);
      if (ts.isClassDeclaration(statement)) {
        for (const member of statement.members) {
          const name = member.name?.getText(source);
          const visibility = exported(statement) ? "public" : "internal";
          if (name && ts.isMethodDeclaration(member)) {
            add(
              member,
              name,
              "method",
              member.getText(source).split("{")[0] ?? null,
              visibility,
            );
          } else if (name && ts.isPropertyDeclaration(member)) {
            add(
              member,
              name,
              "state",
              member.type?.getText(source) ?? null,
              visibility,
            );
          }
        }
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        add(
          statement,
          declaration.name.getText(source),
          (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
            ? "constant"
            : "state",
          declaration.type?.getText(source) ?? null,
        );
      }
    }
  }
  return symbols;
}

const PYTHON_PARSER = String.raw`
import ast,json,sys
p=sys.argv[1]; t=ast.parse(sys.stdin.read(), filename=p); out=[]
def add(n,name,kind,sig=None,public=None):
 out.append({'name':name,'kind':kind,'signature':sig,'visibility':'public' if (public if public is not None else not name.startswith('_')) else 'internal','path':p,'line':getattr(n,'lineno',1)})
for n in t.body:
 if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)):
  add(n,n.name,'function',n.name+'('+','.join(a.arg for a in n.args.args)+')')
 elif isinstance(n,ast.ClassDef):
  add(n,n.name,'type',n.name)
  for m in n.body:
   if isinstance(m,(ast.FunctionDef,ast.AsyncFunctionDef)): add(m,m.name,'method',m.name+'('+','.join(a.arg for a in m.args.args)+')',not n.name.startswith('_') and not m.name.startswith('_'))
   elif isinstance(m,(ast.Assign,ast.AnnAssign)):
    targets=m.targets if isinstance(m,ast.Assign) else [m.target]
    for x in targets:
     if isinstance(x,ast.Name): add(m,x.id,'state',None,not n.name.startswith('_') and not x.id.startswith('_'))
 elif isinstance(n,(ast.Assign,ast.AnnAssign)):
  targets=n.targets if isinstance(n,ast.Assign) else [n.target]
  for x in targets:
   if isinstance(x,ast.Name): add(n,x.id,'constant' if x.id.isupper() else 'state')
print(json.dumps(out))
`;

export function pythonSymbols(
  path: string,
  _absolutePath: string,
  content: string,
): EvidenceSymbolV1[] {
  const result = spawnSync("python3", ["-c", PYTHON_PARSER, path], {
    input: content,
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 256 * 1024,
  });
  if (result.status !== 0) throw new Error("Python source could not be parsed");
  return (JSON.parse(result.stdout) as EvidenceSymbolV1[]).slice(
    0,
    MAX_SYMBOLS,
  );
}

const GO_PARSER =
  String.raw`
package main
import("encoding/json";"go/ast";"go/parser";"go/token";"os")
type Symbol struct{Name string ` +
  '`json:"name"`' +
  `;Kind string ` +
  '`json:"kind"`' +
  `;Signature *string ` +
  '`json:"signature"`' +
  `;Visibility string ` +
  '`json:"visibility"`' +
  `;Path string ` +
  '`json:"path"`' +
  `;Line int ` +
  '`json:"line"`' +
  `}
func main(){p:=os.Args[len(os.Args)-1];src,e:=os.ReadFile(p);if e!=nil{os.Exit(2)};f:=token.NewFileSet();n,e:=parser.ParseFile(f,p,src,0);if e!=nil{os.Exit(2)};out:=[]Symbol{};add:=func(x ast.Node,name,kind string){v:="internal";if ast.IsExported(name){v="public"};out=append(out,Symbol{name,kind,nil,v,p,f.Position(x.Pos()).Line})};for _,d:=range n.Decls{switch x:=d.(type){case *ast.FuncDecl:k:="function";if x.Recv!=nil{k="method"};add(x,x.Name.Name,k);case *ast.GenDecl:for _,sp:=range x.Specs{switch y:=sp.(type){case *ast.TypeSpec:add(y,y.Name.Name,"type");if st,ok:=y.Type.(*ast.StructType);ok{for _,fld:=range st.Fields.List{for _,nm:=range fld.Names{add(fld,nm.Name,"state")}}};case *ast.ValueSpec:for _,nm:=range y.Names{k:="state";if x.Tok==token.CONST{k="constant"};add(y,nm.Name,k)}}}}};json.NewEncoder(os.Stdout).Encode(out)}
`;

export function goSymbols(
  path: string,
  absolutePath: string,
  _content: string,
): EvidenceSymbolV1[] {
  const directory = mkdtempSync(join(tmpdir(), "foundry-go-evidence-"));
  try {
    const helper = join(directory, "main.go");
    writeFileSync(helper, GO_PARSER);
    const result = spawnSync("go", ["run", helper, "--", absolutePath], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      env: { ...process.env, GO111MODULE: "off" },
    });
    if (result.status !== 0) throw new Error("Go source could not be parsed");
    return (JSON.parse(result.stdout) as EvidenceSymbolV1[])
      .map((symbol) => ({ ...symbol, path }))
      .slice(0, MAX_SYMBOLS);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function mappings(
  req: TestRequest | TestRequestV2,
  symbols: EvidenceSymbolV1[],
): ContractSymbolMappingV1[] {
  return req.provides.operations.map((operation) => {
    const matches = symbols.filter(
      (symbol) =>
        symbol.name.toLocaleLowerCase() ===
          operation.name.toLocaleLowerCase() &&
        (symbol.kind === "function" || symbol.kind === "method"),
    );
    return {
      operation: operation.name,
      status:
        matches.length === 0
          ? "missing"
          : matches.length === 1
            ? "matched"
            : "ambiguous",
      symbols: matches.map(
        (symbol) => `${symbol.path}:${symbol.line}:${symbol.name}`,
      ),
    };
  });
}

export function extractImplementationEvidence(
  req: TestRequest | TestRequestV2,
  caseResults: AcceptanceCaseResultV1[],
  backend: LanguageBackend,
  measurements: { duration_ms: number; memory_mb: number | null },
): NodeImplementationEvidenceV1 {
  const path = safeRelative(req.workspace, req.write_target);
  const absolutePath = resolve(req.workspace, path);
  const content = readFileSync(absolutePath, "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const diagnostics: string[] = [];
  let symbols: EvidenceSymbolV1[] = [];
  try {
    symbols = backend.extractSymbols(path, absolutePath, content);
    if (symbols.length === 0)
      diagnostics.push(
        "No supported declarations were discovered in the node source.",
      );
  } catch {
    diagnostics.push(
      `The ${req.language} source could not be parsed; implementation evidence is partial.`,
    );
  }
  const contractMappings = mappings(req, symbols);
  for (const mapping of contractMappings) {
    if (mapping.status !== "matched")
      diagnostics.push(
        `Declared operation '${mapping.operation}' is ${mapping.status} in source evidence.`,
      );
  }
  return {
    evidence_version: 1,
    node_id: req.node_id,
    build_run_id: req.run_id,
    proposal_id: req.proposal_id ?? null,
    revision_id: req.revision_id ?? null,
    semantic_digest: req.semantic_digest ?? req.ir_digest,
    base_commit: req.base_commit,
    attempt: req.attempt ?? 1,
    language: req.language,
    source_snapshot_digest: sha256,
    source_files: [{ path, sha256 }],
    symbols,
    contract_mappings: contractMappings,
    case_results: caseResults,
    measurements,
    completeness: diagnostics.length === 0 ? "complete" : "partial",
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
    created_at_ms: Date.now(),
  };
}
