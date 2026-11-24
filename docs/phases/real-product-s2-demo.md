# S2 SQL Server demo

This local demo uses SQL Server 2022 in Colima as a source. The Scale Insyght API, worker, web app, and product database run natively. All source rows are fictional.

## Start the sources and application

From the repository root:

```sh
pnpm testbed:up
pnpm db:migrate
pnpm dev
```

Use an existing admin-provisioned tenant, or create one with `pnpm tenant:create`. Open the URL printed by Vite and sign in. On Connectors, select **Add connector → SQL Server**.

## Connector form

After `pnpm testbed:up`, use the local values written to the ignored `.env` as `SQLSERVER_TESTBED_HOST`, `SQLSERVER_TESTBED_PORT`, `SQLSERVER_TESTBED_DATABASE`, `SQLSERVER_TESTBED_USERNAME`, and `SQLSERVER_TESTBED_PASSWORD`. Never copy them into a tracked file. The source login is SELECT-only. The local testbed uses a self-signed certificate, so select **Trust server certificate (local test source only)**. For remote sources, leave that option off so certificate validation remains enabled.

Test the connection, start profiling, and then open Profile, ER, Dictionary, and Home. The catalog contains five tables, two views, and two stored procedures. The encounters-to-patients edge is inferred because the source declares no foreign key for it. Ask:

> How many patients are in SQL Server hospital?

The answer is 500. Its evidence includes the SQL query, source name, and returned row count.

## Reproduce the acceptance run

```sh
pnpm test:testbed
```

This recreates only the local PostgreSQL and SQL Server test sources plus `si_test`, computes `testbed/truth.json` from SQL, runs source contracts, then runs both empty-tenant browser walkthroughs. SQL Server-specific screenshots and the video are in `docs/acceptance/s2/`.

## Assumptions

- The connector defaults to encrypted SQL Server transport with certificate validation. The explicit certificate trust override is accepted only for loopback hosts and is intended for the local self-signed testbed.
- SQL Server Developer Edition is used only as a local test source under Colima/Rosetta. It is not part of the application runtime.
