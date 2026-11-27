import { applySchema, resetSchemaReadyForTests } from '../../src/server/db/schema';

const TABLES = [
  'journeys',
  'media',
  'admin_settings',
  'admin_trash',
  'vault_files',
  'vault_uploads',
  'vault_shares',
  'vault_tickets',
  'security_settings',
  'security_sessions',
  'security_visitors',
  'security_events',
  'security_blocks',
  'security_limits',
  'usage_limits',
];

export async function resetTestDatabase(db: D1Database): Promise<void> {
  resetSchemaReadyForTests();
  await applySchema(db);
  await db.batch(TABLES.map((table) => db.prepare(`DELETE FROM ${table}`)));
}
