import type { MigrationBuilder } from 'node-pg-migrate';

// Decision 64: a function's returned columns are kept apart from its input parameters. PostgreSQL lists RETURNS TABLE
// columns and a function's OUT arguments among its arguments, so a function with 3 inputs returning 13 columns showed
// "Parameters 16". Existing rows keep '[]' until their routine is captured again (the next profile or nightly run):
// the capture hash includes the split, so every PostgreSQL routine with returned columns gets a new version then.
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    ALTER TABLE graph.definitions ADD COLUMN returned_columns jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(returned_columns)='array');
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE graph.definitions DROP COLUMN returned_columns;');
}
