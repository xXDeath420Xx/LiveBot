// Apply two stream-pipeline fixes:
//   1) Lair #1457541374424387768 self-promo: whitelist Cubs + Twitch Streamer roles
//   2) Pac wolfzgangz live-announce: clear stream_ignored_roles (remove FemaleAlpha)
// Also runs migration 086 inline if the whitelisted_role_ids column is missing.
import 'dotenv/config';
import mysql from 'mysql2/promise';

const LAIR_GUILD         = '1216126780767731722';
const LAIR_SELFPROMO_CH  = '1457541374424387768';
const CUBS_ROLE          = '1496409522120560663';
const TWITCH_STREAMER    = '1414792796912746576';

const PAC_GUILD          = '1099732505243959407';

const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

// ── Issue 1: ensure column exists, then set whitelist ──
console.log('== Issue 1: Lair self-promo role whitelist ==');
const [cols] = await pool.execute(
    `SHOW COLUMNS FROM self_promo_config LIKE 'whitelisted_role_ids'`
);
if (cols.length === 0) {
    console.log('  Adding whitelisted_role_ids column (running migration 086 inline)...');
    await pool.execute(`
        ALTER TABLE self_promo_config
        ADD COLUMN whitelisted_role_ids LONGTEXT NULL
        COMMENT 'JSON array of role snowflakes allowed to post without deletion'
    `);
    console.log('  ✓ column added');
} else {
    console.log('  column already exists — skipping ALTER');
}

const [beforeLair] = await pool.execute(
    `SELECT guild_id, channel_id, whitelisted_role_ids FROM self_promo_config
     WHERE guild_id = ? AND channel_id = ?`,
    [LAIR_GUILD, LAIR_SELFPROMO_CH]
);
console.log('  before:', beforeLair[0] || '(no row for this guild+channel)');

const whitelistJson = JSON.stringify([CUBS_ROLE, TWITCH_STREAMER]);
const [res1] = await pool.execute(
    `UPDATE self_promo_config
     SET whitelisted_role_ids = ?
     WHERE guild_id = ? AND channel_id = ?`,
    [whitelistJson, LAIR_GUILD, LAIR_SELFPROMO_CH]
);
console.log(`  UPDATE affected ${res1.affectedRows} row(s)`);

const [afterLair] = await pool.execute(
    `SELECT guild_id, channel_id, whitelisted_role_ids FROM self_promo_config
     WHERE guild_id = ? AND channel_id = ?`,
    [LAIR_GUILD, LAIR_SELFPROMO_CH]
);
console.log('  after: ', afterLair[0]);

// ── Issue 2: clear Pac's stream_ignored_roles ──
console.log('\n== Issue 2: Pac stream_ignored_roles → [] ==');
const [beforePac] = await pool.execute(
    `SELECT guild_id, stream_ignored_roles FROM guilds WHERE guild_id = ?`,
    [PAC_GUILD]
);
console.log('  before:', beforePac[0]);

const [res2] = await pool.execute(
    `UPDATE guilds SET stream_ignored_roles = '[]' WHERE guild_id = ?`,
    [PAC_GUILD]
);
console.log(`  UPDATE affected ${res2.affectedRows} row(s)`);

const [afterPac] = await pool.execute(
    `SELECT guild_id, stream_ignored_roles FROM guilds WHERE guild_id = ?`,
    [PAC_GUILD]
);
console.log('  after: ', afterPac[0]);

console.log('\nDONE');
await pool.end();
