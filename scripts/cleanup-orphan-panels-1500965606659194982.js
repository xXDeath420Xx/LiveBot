/**
 * One-shot: remove reaction_role_panels rows for guild 1500965606659194982 that
 * have no mappings (left over from the first failed setup run).
 */
import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';

const GUILD = '1500965606659194982';
const [orphans] = await pool.execute(
    `SELECT p.id, p.panel_name, p.message_id
     FROM reaction_role_panels p
     LEFT JOIN reaction_role_mappings m ON m.panel_id = p.id
     WHERE p.guild_id = ?
     GROUP BY p.id
     HAVING COUNT(m.id) = 0`,
    [GUILD]
);
console.log(`Found ${orphans.length} orphan panel rows`);
for (const o of orphans) console.log(`  - id=${o.id} name=${o.panel_name} msg=${o.message_id}`);
if (orphans.length) {
    const ids = orphans.map(o => o.id);
    await pool.execute(`DELETE FROM reaction_role_panels WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    console.log(`Deleted ${orphans.length} orphan rows`);
}
const [[{ n }]] = await pool.execute(
    'SELECT COUNT(*) AS n FROM reaction_role_panels WHERE guild_id = ?',
    [GUILD]
);
console.log(`Remaining panel rows: ${n}`);
await pool.end();
