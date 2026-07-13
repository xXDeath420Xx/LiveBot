// Fix Phase 18's DB gap: log_event_config column is log_channel_id, not channel_id.
// Rewire the 6 old log-channel IDs to their new regenerated counterparts.
import 'dotenv/config';
import mysql from 'mysql2/promise';

const GUILD = '1216126780767731722';
const remap = [
    ['1496410180240408606', '1496445462440443997'], // member-log
    ['1496410181620203662', '1496445465053495327'], // message-log
    ['1496410183604109383', '1496445466668175482'], // mod-log
    ['1496410184937898066', '1496445469285548032'], // voice-log
    ['1496410186074558474', '1496445471898603550'], // channel-log
    ['1496410187643228280', '1496445480178159688'], // role-log
];

const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

for (const [oldId, newId] of remap) {
    const [u] = await pool.execute(
        'UPDATE log_event_config SET log_channel_id = ? WHERE guild_id = ? AND log_channel_id = ?',
        [newId, GUILD, oldId]);
    if (u.affectedRows) console.log(`  ${oldId} → ${newId}: ${u.affectedRows} rows`);
}

// Also sweep logging_config for any remaining stale IDs we might've missed
const [cols] = await pool.execute(
    `SHOW COLUMNS FROM logging_config WHERE Field LIKE '%channel_id'`);
for (const c of cols) {
    for (const [oldId, newId] of remap) {
        const [u] = await pool.execute(
            `UPDATE logging_config SET \`${c.Field}\` = ? WHERE guild_id = ? AND \`${c.Field}\` = ?`,
            [newId, GUILD, oldId]);
        if (u.affectedRows) console.log(`  logging_config.${c.Field}: ${oldId} → ${newId}`);
    }
}

console.log('DONE');
await pool.end();
