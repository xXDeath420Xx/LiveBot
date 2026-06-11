// Regenerates migrations/125_dnd_rpg.js from the LIVE dnd_* schema (ground truth),
// so a fresh-DB rebuild matches exactly what the managers query. Idempotent.
import db from '../utils/db.js';
import { writeFileSync } from 'node:fs';

const [tbls] = await db.execute(
  "SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name LIKE 'dnd\\_%' ORDER BY table_name"
);
const names = tbls.map(r => r.TABLE_NAME || r.table_name);
const ddls = [];
for (const t of names) {
  const [[row]] = await db.execute('SHOW CREATE TABLE `' + t + '`');
  let ddl = row['Create Table'];
  ddl = ddl.replace(/^CREATE TABLE `/, 'CREATE TABLE IF NOT EXISTS `');
  ddl = ddl.replace(/\sAUTO_INCREMENT=\d+/g, '');
  ddls.push(ddl);
}

const body = `// AUTO-GENERATED from the live dnd_* schema (SHOW CREATE TABLE) — the ground truth
// the RPG managers were reconciled to. Regenerate via scripts/gen-dnd-migration.mjs.
// FK checks are disabled during create/drop so the ${names.length} inter-referencing
// tables don't need topological ordering. Idempotent (CREATE TABLE IF NOT EXISTS).

const TABLES = [
${ddls.map(d => '  `' + d.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`').join(',\n')}
];

const NAMES = ${JSON.stringify(names)};

export async function up(db) {
  await db.execute('SET FOREIGN_KEY_CHECKS=0');
  try {
    for (const ddl of TABLES) await db.execute(ddl);
    // An abandoned earlier migration created dnd_session_messages.message_type as a
    // restrictive ENUM; widen it so any action type (player_examine/roll/system…) inserts.
    await db.execute('ALTER TABLE dnd_session_messages MODIFY COLUMN message_type VARCHAR(32) NOT NULL').catch(() => {});
  } finally {
    await db.execute('SET FOREIGN_KEY_CHECKS=1');
  }
}

export async function down(db) {
  await db.execute('SET FOREIGN_KEY_CHECKS=0');
  try {
    for (const name of [...NAMES].reverse()) await db.execute('DROP TABLE IF EXISTS \`' + name + '\`');
  } finally {
    await db.execute('SET FOREIGN_KEY_CHECKS=1');
  }
}
`;
writeFileSync('migrations/125_dnd_rpg.js', body);
console.log('wrote migrations/125_dnd_rpg.js with', names.length, 'tables');
process.exit(0);
