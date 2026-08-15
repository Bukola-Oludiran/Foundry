# Incident Triage Core

Build a pure TypeScript library that turns an incident report into a deterministic triage result.

Input fields:

- `title`: arbitrary text; trim surrounding whitespace and use `Untitled incident` when empty.
- `customerImpact`: number truncated toward zero and then clamped to the inclusive range 0–5.
- `serviceDown`: boolean.
- `securitySignal`: boolean.

Risk score is `customerImpact * 2`, plus 4 when the service is down, plus 5 when a security signal
exists, capped at 10. Severity is low for scores 0–2, medium for 3–5, high for 6–8, and critical for
9–10. The summary is `SEVERITY: title (risk score/10)` with the severity uppercased.

The architecture must separate input normalization from scoring and compose both behind one public
`triageIncident` operation. It must define deterministic, parent-owned acceptance cases for boundary
scores, malformed input normalization, and combined outage/security conditions. No network,
database, clock, randomness, or mutable global state is allowed.
