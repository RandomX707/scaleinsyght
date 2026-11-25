import type { MigrationBuilder } from 'node-pg-migrate';

// Daily model budgets are USD caps per tenant and per user. Record who each model call was made for, so a
// person's own daily spend can be capped and shown on the Usage screen.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE core.model_usage ADD COLUMN principal_id uuid;
    ALTER TABLE core.model_budget_reservations ADD COLUMN principal_id uuid;
    CREATE INDEX model_usage_by_principal_day ON core.model_usage(tenant_id, principal_id, created_at);
    CREATE INDEX model_budget_reservations_by_principal_day ON core.model_budget_reservations(tenant_id, principal_id, created_at);`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP INDEX core.model_budget_reservations_by_principal_day; DROP INDEX core.model_usage_by_principal_day;
    ALTER TABLE core.model_budget_reservations DROP COLUMN principal_id; ALTER TABLE core.model_usage DROP COLUMN principal_id;`);
}
