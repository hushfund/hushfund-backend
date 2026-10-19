<img src="brand/hushfund-logo.svg" alt="Hushfund" width="64" />

# hushfund-backend

**Hushfund — Your money, hushed.**

Hushfund API and gas-sponsoring relayer with persistent transaction state and Openfort integration.

## Layout and setup

The `backend/`, `config/` and `deployments/` siblings deliberately preserve
the runtime's existing relative-path contract. **Run commands from `backend/`.**
Requires Node.js 22.18+, npm, PostgreSQL and an Ethereum Mainnet RPC.

```sh
cd backend
npm ci
cp .env.example .env
# Fill your own RPC and PostgreSQL credentials privately before startup.
npm run db:init
npm run typecheck
npm test
npm run build
npm start
```

The default standalone port is 3007. Use `GET /api/health` for health status
and `GET /api/public-env` for allowlisted browser settings. See route definitions
in `backend/src/routes.ts` for request validation and supported endpoints.

### Configuration

- `config/mainnet.json` contains public protocol parameters.
- `deployments/mainnet.json` contains public Mainnet addresses and deployment block.
- `backend/.env.example` is a blank credential template, not a configured service.
- `RPC_URL` must support Ethereum Mainnet reads and logs.
- `DATABASE_URL` is private and required for persistent relay state.
- `npm run db:init` explicitly creates the public schema in your own database,
  without deleting existing records. It is a fresh-database bootstrap, not a
  schema-drift migration tool; review existing installations separately.
- Openfort/Shield credentials must be provisioned in the operator's secret manager.
- Enable signing only with an explicitly authorized, separately funded relayer.
  A missing relayer key must not be replaced with a default key.
- Review sponsorship quotas and gas estimates before enabling funded requests.
- Set explicit `CORS_ORIGINS` for your frontend; do not turn CORS into a
  wildcard authorization policy.

Deployer credentials are not required to run the API. Leave deployment fields
empty. Set `SERVE_FRONTEND=false` for this standalone layout and route `/api/*`
through the frontend reverse proxy. The production service's actual credentials,
database, user records and infrastructure settings are not distributed.
GitHub CI provisions an isolated, empty PostgreSQL database, initializes this
schema and runs persistence tests without production credentials or funds.


## Scope and safety

Ethereum Mainnet (chain ID 1) only. Supported fixed deposits: 10, 50, 100 and
1,000 USDC; arbitrary/custom amounts are not supported. Yield is variable.
Gas sponsorship depends on service availability and limits. Zero-knowledge
proofs do not eliminate public timing, amount, network or recipient metadata.
No claim of guaranteed anonymity, guaranteed returns or independent security
certification is made.

This is a source distribution, not a production environment or permission to
spend funds. Local tests may use mocks; those are fixtures, not deployed
protocols. Never use production keys or real user notes in tests.

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md),
[OPERATIONS.md](OPERATIONS.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
Hushfund-authored code is MIT licensed unless a file states otherwise.
Existing third-party copyright and license notices remain authoritative.
Hushfund names, logos and domains identify the original project; the code
license does not grant endorsement or trademark rights. Forks must identify
themselves and must not impersonate the official service.


## Official links

- Website: https://hushfund.eth.limo
- Application: https://hushfund.app
- App documentation: https://hushfund.app/docs
- Mechanism: https://hushfund.eth.limo/mechanism.html
- Privacy limits: https://hushfund.eth.limo/privacy.html
- Risks: https://hushfund.eth.limo/risks.html
- X: https://x.com/Hushfund_
- GitHub: https://github.com/hushfund
- Contact: hello@husfund.app

## Repository family

- [hushfund-contracts](https://github.com/hushfund/hushfund-contracts) — Ethereum Mainnet USDC vault contracts, Noir circuits, verifiers and protocol tests.
- [hushfund-app](https://github.com/hushfund/hushfund-app) — Hushfund web app for private USDC notes, yield, withdrawals, borrowing and repayment.
- [hushfund-backend](https://github.com/hushfund/hushfund-backend) — Hushfund API and gas-sponsoring relayer with persistent transaction state and Openfort integration.
- [hushfund-landing](https://github.com/hushfund/hushfund-landing) — Hushfund marketing website and mechanism, privacy and risk pages for ENS/IPFS hosting.

