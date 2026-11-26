import type { MigrationBuilder } from 'node-pg-migrate';

// Decision 61: a large table's identifier column is fingerprinted through a consistent sample (a fixed rule on the value
// itself keeps about 1 in 16, the same values in every source). id_fields records whether a field was sampled; each
// fingerprint records whether its value passes the rule (computed when the value is read, never stored), so a whole
// field and a sampled one are compared on the same values. Fingerprints stored before this are NULL until re-profiled.
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    ALTER TABLE graph.id_fields ADD COLUMN sampled boolean NOT NULL DEFAULT false;
    ALTER TABLE graph.id_fingerprints ADD COLUMN in_sample boolean;
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE graph.id_fingerprints DROP COLUMN in_sample; ALTER TABLE graph.id_fields DROP COLUMN sampled;');
}
