import type { MigrationBuilder } from 'node-pg-migrate';

// Average text length of an untagged column, measured by the profiler. With the distinct count and null rate it lets
// code choose a related table's display label (decision 45). Tagged columns keep it null (contract 7).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('ALTER TABLE profiler.field_profiles ADD COLUMN average_length double precision');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('ALTER TABLE profiler.field_profiles DROP COLUMN average_length');
}
