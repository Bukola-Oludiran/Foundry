# Aegis Software Supply-Chain Control Plane

Build a local-first control plane that continuously evaluates a source repository, produces a
reproducible security evidence package, proposes bounded remediations, and prepares—but never
merges—a human-reviewed draft pull request.

## Product outcome

Given an immutable repository revision plus repository metadata, dependency manifests, an optional
SBOM, provenance attestations, and an organization policy bundle, Aegis must produce one deterministic
assessment containing:

- a normalized component inventory;
- verified or rejected provenance claims;
- policy findings with stable identifiers and severities;
- an explicitly bounded remediation plan;
- validation evidence for every proposed file change;
- a tamper-evident audit chain and signed-content attestation payload;
- a human-readable review report; and
- a publication decision that permits only a draft pull request after all gates are green.

No component may merge, approve, force-push, modify the protected base revision, or claim that an
external side effect was rolled back.

## Required domains

### Repository inventory

Discover supported Python, TypeScript, and Go dependency manifests without following symlinks outside
the repository. Normalize packages to Package URLs (purl), deduplicate components by canonical purl,
preserve source evidence, and produce a stable lexicographically ordered inventory. Validate SLSA-style
provenance subjects against the immutable base commit and artifact digests. Missing provenance is a
finding; malformed or mismatched provenance is never treated as verified.

### Policy and risk

Parse a versioned, deny-by-default policy bundle. Evaluate license rules, forbidden packages,
provenance requirements, vulnerability severity thresholds, and expiry-bounded waivers. Finding IDs
must be deterministic from policy rule, component, and evidence—not timestamps or process order.
Expired, malformed, or scope-mismatched waivers do not suppress findings. Risk totals must be bounded,
explainable, and stable for the same normalized input.

### Remediation

Generate a plan only for findings marked automatically remediable by policy. Each operation declares
its exact repository-relative write path, expected preimage digest, intended postimage digest, and
finding IDs addressed. Reject traversal, absolute paths, symlink escapes, undeclared files, binary
changes, secrets, oversized files, lockfile/manifest inconsistency, and any patch whose preimage no
longer matches. Execute checks in an isolated network-denied sandbox. An ambiguous retry uses the same
job identity and must not apply a patch twice.

### Evidence and publication

Hash all inputs and outputs with SHA-256. Build a canonical evidence index, a hash-chained audit log,
an in-toto-compatible attestation payload, and a deterministic review report. Publication is allowed
only when inventory, policy, remediation validation, test closure, and evidence integrity are green.
Publication produces a draft-PR request object; a human remains responsible for review and merge.

### Operator console

Expose a typed control-plane API and a TypeScript review console for assessment status, findings,
component provenance, remediation diffs, evidence downloads, cancellation, and the final draft-only
publication decision. Mutations require an idempotency key. Cancellation is monotonic and retains all
previously committed evidence.

## Architecture constraints

- Use a recursive ownership tree with separate inventory, policy, remediation, evidence, and operator
  domains.
- Use TypeScript for operator-facing contracts and composition, Go for repository/sandbox/integrity
  boundaries, and Python for package normalization and explainable risk/remediation planning.
- Every node has a unique repository-relative write target and a parent-owned deterministic acceptance
  mandate.
- Interfaces must expose behavior and data contracts, not implementation internals.
- All deterministic outputs use canonical JSON with sorted keys where serialized.
- Core evaluation is independent of wall-clock time. Time-dependent waiver evaluation receives an
  explicit evaluation timestamp.
- Network access, credentials, model calls, GitHub mutation, and container execution must sit behind
  explicit replaceable interfaces. The fixture implementation uses deterministic in-memory adapters.

## Required acceptance scenario

Assess a mixed Python/TypeScript/Go fixture at immutable commit `abc123` containing one forbidden
package, one high-severity vulnerable package, one valid provenance statement, one mismatched
statement, one valid waiver, and one expired waiver. Aegis must produce stable findings, propose only
the permitted dependency update, reject a simulated stale-preimage retry, preserve evidence after
cancellation, and emit a draft-only publication request only after the repaired fixture and complete
affected test closure are green.
