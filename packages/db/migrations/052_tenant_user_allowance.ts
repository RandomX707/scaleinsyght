import type { MigrationBuilder } from 'node-pg-migrate';

// Decision 71: the plan's user allowance, shown on Usage beside active users. Null means the plan sets none.
// Display only in Release 1; nothing is refused when it is reached.
export function up(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE core.tenants ADD COLUMN user_allowance integer CHECK (user_allowance IS NULL OR user_allowance >= 0)');
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE core.tenants DROP COLUMN user_allowance');
}
