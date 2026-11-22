# Phase 2 report — Analytic mode, personal agents and governed agents

**Status:** built; approved by agent, pending review.

## Assumptions (pending Yashaswi)

- **Decision 28:** analytic plans and results use a deterministic local provider with the synthetic golden question set; no hosted model calls or model credentials.
- **Decision 29:** a governed definition version must be approved by a same-tenant member other than its owner. Approval binds to that immutable version.
- **Decision 30:** activating a connector grants only its activating member read-only analytic access to that connection. Access can be revoked and does not grant access to other sources or members.

## What was built

- Typed analytic plans, deterministic golden results for 30 questions per connector, two-source collation, evidence references, trust metadata and durable PostgreSQL runs.
- Session-scoped source selection and authorization rechecks; native runner work is claimed by `si_worker`. Run URLs restore persisted plans, answers and event progress after refresh.
- Personal vocabulary and answer-style preferences, owner-scoped feedback and safe evaluation references.
- Versioned governed drafts, second-member approval, immutable version pins on runs and deterministic reruns. Source groups can be moved by creating a new version.
- Home, Agents and Approval Matrix views, including keyboard reachable run, feedback, memory, group and governed controls.

## Demo

Start the native services with `pnpm dev`, then sign in at `http://127.0.0.1:5173` using the synthetic `analyst@north.example` account and password `golden-local-only`. Activate the Meridian Keystone synthetic source, ask the listed-count question from the Home screen, then refresh the run URL to see the saved answer and event progress. In Agents, change the answer style and save a governed draft. Sign out, sign in as synthetic `approver@north.example` with the same golden password, and approve the exact version in Approval Matrix. Sign back in as the owner and run the approved version from Agents. All demo data comes from `tests/golden`.

## Verification

- `pnpm typecheck` — passed.
- `pnpm lint` — passed.
- `pnpm test` — 8 files, 27 unit tests passed, including the 30-case-per-connector corpus check.
- `pnpm test:integration` — 1 file, 1 PostgreSQL integration test passed.
- `pnpm test:contracts` — 19 files, 42 PostgreSQL contract tests passed.
- `pnpm test:e2e` — 4 golden browser tests passed, including the analytic answer, refresh, feedback, second-member approval and owner rerun.

The tests reset only `si_test`. No real source data, hosted model, external credential or INSYGHT system was used.
