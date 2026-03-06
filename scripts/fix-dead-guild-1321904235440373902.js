/**
 * One-time fix: Disable global bans for dead guild 1321904235440373902
 * and insert its name into guilds table for the record.
 *
 * Usage: node scripts/fix-dead-guild-1321904235440373902.js
 */
import pool from '../utils/db.js';

const GUILD_ID = '1321904235440373902';
const GUILD_NAME = 'CannaFriend | Twitch Companion';

async function run() {
  try {
    // Disable global bans for this guild
    const [result] = await pool.execute(
      'UPDATE global_ban_config SET enabled = 0 WHERE guild_id = ?',
      [GUILD_ID]
    );
    console.log(`global_ban_config: ${result.affectedRows} row(s) updated`);

    // Insert/update guild name for the record
    await pool.execute(`
      INSERT INTO guilds (guild_id, guild_name, last_seen)
      VALUES (?, ?, NOW())
      ON DUPLICATE KEY UPDATE
        guild_name = VALUES(guild_name)
    `, [GUILD_ID, GUILD_NAME]);
    console.log(`guilds: inserted/updated name for ${GUILD_ID} → "${GUILD_NAME}"`);

    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

run();
