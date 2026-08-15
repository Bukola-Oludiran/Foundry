# ADR 0004: immutable architecture revisions

Status: accepted.

Architecture and rearchitecture produce proposed, versioned IR artifacts. A subtree proposal must
preserve its externally consumed interface and cannot change files or nodes outside its calculated
scope. Only a proposal whose affected test closure is green can replace the accepted revision.
