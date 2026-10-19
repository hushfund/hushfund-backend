# Dependency review

Snapshot: 2026-10-19, `npm audit --package-lock-only --json` against this
export's inherited package lock. This is a point-in-time dependency check,
not a security certification. No dependency upgrade or major SDK migration
was silently applied during the source split.

- critical: 0
- high: 0
- moderate: 0
- low: 0

Re-run npm audit after installation and before each release. Moderate and low
advisories remain maintenance work where reported; the repository does not
claim a clean vulnerability audit. Review dependency updates for compatibility,
especially wallet authentication, recovery and the circuit/prover toolchain.
