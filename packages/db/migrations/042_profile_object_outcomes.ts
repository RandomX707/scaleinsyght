import type { MigrationBuilder } from 'node-pg-migrate';

// Bug 6: one slow or unreadable object no longer fails a whole profile. A job records how many objects were profiled
// without samples or statistics because the source ran out of time (limited), and how many could not be read at all
// (failed); those objects are kept in job_objects with their state. A job fails only when nothing could be profiled.
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    ALTER TABLE profiler.jobs
      ADD COLUMN limited_count integer NOT NULL DEFAULT 0 CHECK (limited_count >= 0),
      ADD COLUMN failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0);
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('ALTER TABLE profiler.jobs DROP COLUMN failed_count, DROP COLUMN limited_count;');
}
