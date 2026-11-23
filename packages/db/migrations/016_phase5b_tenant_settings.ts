import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE core.tenants
      ADD COLUMN allow_self_approval boolean NOT NULL DEFAULT false,
      ADD COLUMN time_zone text NOT NULL DEFAULT 'Asia/Kolkata'
        CHECK(time_zone ~ '^[A-Za-z_+-]+(/[A-Za-z0-9_+-]+)*$');
    ALTER TABLE registry.governed_events DROP CONSTRAINT governed_events_event_type_check;
    ALTER TABLE registry.governed_events ADD CONSTRAINT governed_events_event_type_check
      CHECK(event_type IN ('draft_created','version_approved','self_approved'));
    ALTER TABLE reports.schedules
      ADD COLUMN cadence text NOT NULL DEFAULT 'daily' CHECK(cadence IN ('daily','weekly')),
      ADD COLUMN tenant_time_zone text NOT NULL DEFAULT 'Asia/Kolkata',
      ADD COLUMN local_weekday smallint CHECK(local_weekday BETWEEN 1 AND 7);
    ALTER TABLE reports.schedules ADD CONSTRAINT reports_weekly_weekday_required
      CHECK((cadence='daily' AND local_weekday IS NULL) OR (cadence='weekly' AND local_weekday IS NOT NULL));`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE reports.schedules DROP CONSTRAINT reports_weekly_weekday_required,
      DROP COLUMN local_weekday, DROP COLUMN tenant_time_zone, DROP COLUMN cadence;
    ALTER TABLE registry.governed_events DROP CONSTRAINT governed_events_event_type_check;
    ALTER TABLE registry.governed_events ADD CONSTRAINT governed_events_event_type_check
      CHECK(event_type IN ('draft_created','version_approved'));
    ALTER TABLE core.tenants DROP COLUMN time_zone, DROP COLUMN allow_self_approval;`);
}
