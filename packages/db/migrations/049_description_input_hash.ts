import type { MigrationBuilder } from 'node-pg-migrate';

// Decision 66: a description drafted by the model gateway is stored as a draft with the hash of the metadata it was
// drafted from, so it is redrafted only when that input changes. Metadata only; the hash identifies no data values.
export function up(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE graph.description_reviews ADD COLUMN input_hash bytea;');
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE graph.description_reviews DROP COLUMN input_hash;');
}
