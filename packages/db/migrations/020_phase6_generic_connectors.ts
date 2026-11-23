import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE registry.connections DROP CONSTRAINT connections_connector_type_check;
    ALTER TABLE registry.connections ADD CONSTRAINT connections_connector_type_check
      CHECK (connector_type IN ('sql_server','postgres','snowflake','excel','dbt','tableau','power_bi','lake','crm'));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE registry.connections DROP CONSTRAINT connections_connector_type_check;
    ALTER TABLE registry.connections ADD CONSTRAINT connections_connector_type_check
      CHECK (connector_type IN ('sql_server','postgres','snowflake','excel','dbt','tableau','power_bi'));
  `);
}
