# Contributing to Hushfund

1. Discuss substantial changes in a GitHub issue; report vulnerabilities privately.
2. Fork and create a focused branch. Explain the behavior change and rationale.
3. Install dependencies using the documented commands. Never copy production secrets.
4. Run the documented checks and include their results with your pull request.
5. Include regression coverage for changed behavior; preserve accessibility,
   responsive layouts, Mainnet chain checks and note custody boundaries.
6. Do not attach notes, wallet exports, user records, logs containing tokens,
   generated transaction signatures or RPC credentials.

Protocol or circuit changes need explicit compatibility analysis: commitments,
public inputs, verifier versions, notes, Merkle roots and existing deployments
must remain consistent. Do not imply that changed code is already deployed.

Contributions must be your own work or carry compatible licensing and attribution.
Submitting a contribution licenses it under this repository's applicable license.
