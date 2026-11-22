# Scale Insyght Release 1

Phase 0 runs as native processes on Node.js 22, pnpm via Corepack, and PostgreSQL 16. Docker is not needed for development or tests.

## Local setup

```sh
corepack enable
pnpm install
pnpm db:setup
pnpm db:migrate
pnpm db:seed:golden
```

`pnpm db:setup` creates the dedicated `scale_insyght` and `si_test` databases and the `si_migrate`, `si_app`, and `si_worker` roles. It does not modify any existing application database. Local URLs and generated secrets live in ignored `.env`; see `.env.example` for the names.

On macOS, start the native PostgreSQL service with:

```sh
brew services start postgresql@16
```

## Demo

Run the API, worker and web app in native processes:

```sh
pnpm dev
```

In another terminal, create two synthetic two-step runs:

```sh
pnpm demo:phase0
```

Open <http://127.0.0.1:5173/login>. The local-only golden accounts are `analyst@north.example` and `analyst@south.example`; their synthetic demo password is `golden-local-only`. The scripted worker stores only the golden result references.

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:contracts
pnpm test:e2e
```

Integration, contract and E2E tests use the real PostgreSQL 16 server and reset only `si_test`. If PostgreSQL cannot be reached, the suites fail and identify `DATABASE_URL`; they never fall back to a mock database.
