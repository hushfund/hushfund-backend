# Public source versus private operations

## Included

Application logic, API/relayer validation, protocol implementation, local tests,
public chain configuration, deployed contract addresses, public proof artifacts,
documentation and placeholder-only configuration examples.

## Deliberately excluded

- Git history from the working deployment, hosting-provider configuration and agent history.
- Live environment files, credentials, key stores, private RPC URLs and database URLs.
- Relayer/deployer keys, Openfort secrets and Shield encryption shares.
- Recovery notes, witnesses, user data, database exports, logs and session material.
- Deployment broadcasts, funded acceptance-run scripts, receipts and incident records.
- Dependency installations, build output and local caches.

Public source code necessarily reveals how the system works. Contract addresses,
ABI, verification keys and circuit bytecode are public protocol information, not
secrets. Runtime credentials and data must remain private; security must not
depend on hiding source code. Infrastructure topology and private runbooks are
not required to build this distribution.

Use separate development credentials with least privilege. Browser settings are
public; never put a server credential behind a VITE_ name. A new operator must
configure their own services, review gas budgets and use their own domains.
