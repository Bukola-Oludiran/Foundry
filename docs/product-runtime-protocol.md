# Foundry product Piston runtime protocol

Status: v1 boundary implemented and locally certified with HashRelay on 2026-08-13.

IR v5 work never executes through Foundry's host or local-control tester. The worker selects the
pinned `foundry-product` Piston language, sends `foundry-product-request.json` as the main file, and
adds only compiler-declared repository targets. A fresh Piston execution handles each request.

The request has `protocol: 1` and one operation:

- `verify-work` compiles and tests one leaf or bounded composite-glue target set and may return a
  deterministic mutation report;
- `integrate` executes one composite's typed scenarios against child public contracts and declared
  artifacts, using immutable child-evidence digests as inputs;
- `assemble` produces only the declared deliverable IDs and reruns in a second clean execution for
  reproducibility.

The runtime writes exactly one terminal line:

```text
FOUNDRY_PRODUCT_RESULT=<base64-encoded canonical JSON>
```

Verification JSON contains `verdict`, `outcome`, `diagnostics`, optional evidence, and optional
mutation evidence. Assembly JSON contains `verdict`, evidence, and `deliverables`; each deliverable
uses `{ deliverableId, artifactBase64, mediaType }`.

The worker rejects unknown verdicts, malformed output, undeclared deliverable IDs, media-type
mismatches, symlink or workspace escapes, payloads over 4 MB, target files over 4 MB, and artifacts
over their compiler-owned caps. It records only output digests and capped diagnostics. Runtime
absence, Piston transport failure, malformed runtime output, or a runtime crash is infrastructure
failure—not authored red—and cannot consume the implementation retry budget.

The runtime implementation must not accept commands, scripts, URLs, paths, target IDs, resource
limits, or permissions from capability configuration. Recipes and toolchain locations are owned by
the versioned runtime image. Network access is disabled during execution; dependency inputs must be
lockfile-bound and available in the pinned offline caches.

## Local certification evidence

The pinned `foundry-product/1.0.0` runtime was built in the isolated `foundry-runtime` Colima profile and advertised alongside Python 3.11.2. The live Piston gate verified all HashRelay Rust and TypeScript leaves, recursively integrated `engine`, `gateway`, `distribution`, and the product root, emitted all six declared deliverables, and reproduced the result in a clean replay. The legacy live Python library and service Piston suites also passed.

This proves the local runtime boundary and executable HashRelay fixture. It does not replace the remaining requirement for two independent MCP-client runs, hosted identity/security certification, or failure-injection certification.
