# Vendor connection prerequisites

No vendor service was installed, created, or contacted for this phase.

## SQL Server

To exercise the real connector, provide access to a SQL Server instance that can be reached from this development machine. The account must be read-only and limited to the synthetic test database/schema. Provide a host/port, database name, TLS requirements, and a local-only username/password through `.env` or a local secret manager. Do not send credentials in chat or commit them.

## Snowflake

To exercise the real connector, provide a Snowflake account. A free Snowflake trial is sufficient. Create or provide a synthetic-only database/schema and a least-privilege read-only role/user, plus the account identifier, warehouse, database, schema, and authentication method. Put secrets in local environment configuration only; do not send them in chat or commit them.

Tableau and Power BI remain fixture-based until real metadata exports are available. Their live connectors are not part of this Phase 5b test.
