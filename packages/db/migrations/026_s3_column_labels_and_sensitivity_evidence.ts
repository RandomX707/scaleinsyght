import type { MigrationBuilder } from 'node-pg-migrate';

// S3: keep a column's original text (for example the workbook header "Patient ID") beside its SQL identifier,
// and record why each sensitivity tag applies: declared by the source or inferred by the detector (decision 41).
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE profiler.field_profiles
    ADD COLUMN display_name text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 512),
    ADD COLUMN sensitivity_evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sensitivity_evidence) = 'array');`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('ALTER TABLE profiler.field_profiles DROP COLUMN sensitivity_evidence, DROP COLUMN display_name;');
}
