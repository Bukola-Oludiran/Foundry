# Aegis architecture exercise

This fixture exercises Foundry's durable `architect-critic` workflow on a 16-node, three-language
software supply-chain control plane. It is intentionally an architecture and acceptance-mandate
exercise; the implementation has not been generated.

## Architecture

```text
aegis
├── inventory-domain
│   ├── manifest-discovery           Go
│   └── inventory-normalizer         Python
├── policy-domain
│   ├── policy-parser                TypeScript
│   └── policy-evaluator             Python
├── remediation-domain
│   ├── remediation-planner          Python
│   └── patch-verifier               Go
├── evidence-domain
│   ├── evidence-bundler             Go
│   └── audit-attestor               Go
└── operator-domain
    ├── control-api                  Go
    └── review-publisher             TypeScript
```

The five domain nodes and the root are TypeScript integrators. Cross-language leaves communicate
through versioned newline-delimited canonical JSON over stdio. External container, network, model,
credential, and Git-host effects remain behind replaceable boundaries.

## Durable review result

- Run: `01a003a9-c64a-7903-8b5f-f151183ede89`
- Author context: `codex`
- Critic context: `claude-code`
- Approved revision: `3`
- Candidate digest: `7ecdafbccc1481459f96bf153fcd1c32dfd378a834deef53f08e584a017fea70`
- Approval artifact: `01a003b4-8ea4-7853-a005-b55375708145`

Revision 1 exposed missing parent-level evidence verification, an unthreaded inventory dependency,
undefined cross-language types, unspecified IPC, and insufficient idempotency coverage. Revision 2
exposed two deeper type-algebra failures: Python leaves received opaque component arrays, and the
evidence verifier promised to recompute content hashes without receiving content bytes. Revision 3
closed those gaps and received independent approval.

The exercise demonstrates durable collaborative architecture, compiler validation, independent
review, revision CAS, and immutable evidence. It does not demonstrate successful implementation,
sandbox execution, repair, rearchitecture, or draft-PR publication; those require building this IR.
