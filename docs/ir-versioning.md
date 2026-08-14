# Version-controlling the IR

> Status: **design, not implemented.** Companion to [mutation-testing.md](./mutation-testing.md).

## The claim

The IR — not a document — is the architecture role's product. Once that is true, the IR should live
in git as the authored, reviewable, diffable artifact, and the human-readable architecture document
should be *rendered from it*.

This deletes a large amount of machinery rather than porting it.

## What it deletes, and why

Hephaestus accumulated a Decisions Ledger, canonical `RKD-N` ids, a ledger store, an adoption
verifier with heading-level regex enforcement, retirement records, and a structural-completeness
check. Each was a correct response to a *measured* failure — v4 produced zero ratifications; v7
demoted seven ratified decisions to prose and regressed 6→5→6.

But every one of those failures is downstream of a single choice: **the deliverable was an 82 KB
markdown document.** They are format-induced, not intrinsic.

| Mechanism | Exists because | Replacement |
|---|---|---|
| `DecisionsLedger` + `KeyDecision` | prose can't be diffed | node files under `tree/` |
| `ledger-store.ts` | needed somewhere to persist commitments | git |
| canonical `RKD-N` ids | prose has no stable identity | node `id` (already `^[a-z0-9][a-z0-9-]*$`) |
| `verifyLedgerAdoption` heading regex | prose can be *demoted* | `git diff` + review |
| retirement records | prose deletions are invisible | the commit that removes the node |
| structural-completeness check | prose truncates *silently* | JSON parse + `foundry-ir` validate |
| `submit_synthesis` / `submit_plan` | prose must be *extracted* | one `submit_architecture(ir)` |
| LLM Wiki (for architecture decisions) | prose forgets *why* | `changes/archive/` |

A node either exists with a given contract or it does not. There is no heading level to decay to,
nothing to regex out, and a truncated IR fails to parse.

**The inversion:** render the document from the IR; stop extracting the IR from the document.

## Layout — the directory IS the ownership tree

Today `ir/examples/string-utils.ir.json` is one file holding `{spec, root, nodes[]}` — a flat array
carrying two overlaid graphs. Any nontrivial re-architecture produces an unreviewable diff.

Proposed authored form:

```
ir/
  spec.json                          { name, description, language }
  tree/
    string-utils/
      node.json                      root integrator (owner derived: none)
      lowercase/node.json
      trim/node.json
      hyphenate/node.json
  changes/                           proposed, not yet canonical (see below)
  build-state.json                   content-addressed green results (gitignored)
```

Two fields become **redundant with the filesystem** and are dropped from the authored form:

- `owner` — derived from the parent directory.
- `implementation.children` (integrators) — derived from the subdirectories.

That is two fewer things to state inconsistently, and two fewer sources of spurious diff noise. The
compiler derives them and cross-checks nothing, because there is nothing to disagree with.

`requires` **stays explicit in the node file.** It cannot be derived from the tree, and that is the
point: the ownership tree and the dependency DAG are different graphs. A shared node has one owner
(its path) and many consumers (references by id from anywhere in the tree). Path expresses ownership
only — never dependency.

### Authored vs. compiled

The versioned tree is the **authored** form. The existing flat `{spec, root, nodes[]}` shape remains
the **compiled** form, and `foundry-ir` keeps consuming exactly what it consumes today.

```
ir/tree/**  ──(loader)──▶  {spec, root, nodes[]}  ──(existing compiler)──▶  DAG
   authored                     compiled                                    build plan
```

This is what makes the change stageable: it adds a loader, it does not rewrite the compiler, the
schema's `$defs`, or the wire types.

### Diff discipline

A canonical formatter (`foundry-ir fmt`, with `--check` for CI) enforces:

- keys emitted in **schema-declaration order**, not alphabetical — declaration order reads correctly
  and is just as stable
- 2-space indent, LF, trailing newline, no trailing whitespace
- **each test case on a single line** — the current example already does this, and it is the single
  highest-value formatting rule here: one case is one diff line, so adding, deleting, or changing an
  acceptance case is legible at a glance
- string arrays (`properties`) one element per line

Without a formatter this whole design degrades back to unreviewable blobs the first time an agent
emits differently-ordered JSON.

## Change proposals

Re-architecture becomes a scoped overlay, which fits Foundry exactly — `invalidation_set` already
makes the subtree the unit of change.

```
ir/changes/2026-08-07-hyphenate-unicode/
  proposal.md                        why — human-facing prose, NEVER parsed
  tree/
    string-utils/hyphenate/node.json  the scoped override
```

Lifecycle: propose → `foundry-ir apply` overlays onto `tree/` in a scratch copy → validate → build
the invalidation set → run → on all-green, merge into `tree/` and move the proposal to
`changes/archive/`.

`proposal.md` is prose and is **never machine-read**. That discipline is the whole lesson from
Phase 11.1: prose is for humans, structure carries the decisions. The moment anything regexes
`proposal.md`, the failure modes come back.

`changes/archive/` is the record of *why* — the job the LLM Wiki was doing for architecture
decisions, done by the history instead.

## Incremental builds

Version control supplies the identity function `invalidation_set` is reaching for.

```
build_key(n) = H(n.provides, n.requires, n.implementation,
                 [dep.provides for dep in n.requires],   # contracts only
                 doer_version)

test_key(n)  = H(build_key(n), n.acceptance, tester_version)
```

A node whose `test_key` matches a recorded green result in `build-state.json` is skipped.

The load-bearing subtlety: **a dependency's implementation changing does not invalidate its
consumers** — only its *provided interface* does. That is sound here precisely because acceptance is
black-box and every node was independently verified against a parent-owned contract. Ordinary build
systems cannot make this claim and must invalidate transitively; Foundry can, because the oracle
already established that each node satisfies its interface. The verification regime is what licenses
the aggressive cache.

`build-state.json` is a cache, not a source of truth — gitignored, safe to delete.

## Review at the right altitude

Nobody reviews 82 KB of markdown. Everybody can review this:

```diff
   "acceptance": {
     "mandate_owner": "string-utils",
     "cases": [
       { "name": "spaces", "call": "hyphenate('hello world')", "expect": "hello-world" },
-      { "name": "collapse", "call": "hyphenate('a   b')", "expect": "a-b" }
+      { "name": "collapse", "call": "hyphenate('a   b')", "expect": "a-b" },
+      { "name": "unicode-dash", "call": "hyphenate('a—b')", "expect": "a-b" }
     ]
   }
```

This is also the same artifact [mutation testing](./mutation-testing.md) grades. A diff shows *what
changed* in the contract; the mutation score says *whether the new cases have teeth*. Human judgment
and machine evidence land on the same lines — which is the cheapest place in the whole system to put
a person.

## Rendering

`foundry-ir render` emits the human-readable architecture document deterministically from `tree/`.
It is a build output: gitignored, regenerated on demand, never edited. If it is ever committed, it
carries a `DO NOT EDIT — generated from ir/tree/` header.

## Build sequence

1. **`foundry-ir fmt`** — canonical formatter + `--check`. Do this first; nothing else is stable
   without it.
2. **Loader** — `ir/tree/**` → the flat compiled form (derive `owner` from path, `children` from
   subdirs).
3. **Migrate the example** — convert `string-utils.ir.json` to `tree/` and assert the loader's
   compiled output is **byte-identical** to today's flat file. That makes the migration provably
   behavior-preserving for the compiler and every downstream consumer.
4. **Content-addressed keys** + `build-state.json`; wire the skip into the host's build plan.
5. **`changes/` overlay** + `foundry-ir apply`, and route `--rearchitect` to emit a proposal instead
   of mutating `tree/` directly.
6. **`foundry-ir render`.**

Steps 1–3 are worth doing on their own even if 4–6 never land.

## Limits — stated honestly

**Renames are expensive.** Node `id` is load-bearing across the dependency DAG: renaming a node
rewrites every `requires` entry that references it, and moves its directory. `git mv` keeps history
readable, but a rename is never a one-line diff. Ids should be chosen with that in mind — they are
closer to public API than to variable names.

**Path is ownership, not dependency.** This will be misread. A consumer three subtrees away
references a node by id with no path relationship to it. Anyone reading the tree as a dependency
layout will draw the wrong conclusions; the loader should reject any attempt to infer `requires`
from location.

**Concurrent overlapping proposals conflict.** Two change proposals touching the same subtree merge-
conflict like any other source change. Scoped by construction, but not free.

**A green build is not a good architecture.** Incremental builds and clean diffs make iteration
cheap; they say nothing about whether the decomposition is right. Nothing executable does — that is
the one question a review pass still owns, and the reason to keep a thin critique step over the IR
diff rather than deleting architecture review outright.
