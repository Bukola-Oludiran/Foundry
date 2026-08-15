# ADR 0002: ownership drives supervision

Status: accepted.

The IR ownership tree maps to GraphReact supervisors: an integrator supervises its direct children.
Dependency edges still control build order and invalidation and do not imply ownership. Exhausted
repair produces an explicit manager decision rather than an imperative retry hidden in a worker.
