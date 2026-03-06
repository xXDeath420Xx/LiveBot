import dotenv from 'dotenv';
dotenv.config();
import pool from '../utils/db.js';

const V = '902393911958470717';
const BDAY_CHANNEL = '1339623180087595089';

await pool.execute(
    `INSERT INTO birthday_config (guild_id, announcement_channel_id, enabled)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE
        announcement_channel_id = VALUES(announcement_channel_id),
        enabled = 1`,
    [V, BDAY_CHANNEL]
);
console.log('birthday_config: created for VognarFam');
console.log('  Channel: ' + BDAY_CHANNEL);

// Clean up duplicate automod rule if any
const [dupes] = await pool.execute('SELECT id FROM automod_rules WHERE guild_id = ? AND filter_type = ?', [V, 'anti_spam']);
if (dupes.length > 1) {
    for (let i = 1; i < dupes.length; i++) {
        await pool.execute('DELETE FROM automod_rules WHERE id = ?', [dupes[i].id]);
    }
    console.log('Cleaned up ' + (dupes.length - 1) + ' duplicate automod rule(s)');
}

const [verify] = await pool.execute('SELECT * FROM birthday_config WHERE guild_id = ?', [V]);
console.log('Verified:', JSON.stringify(verify[0]));

await pool.end();
process.exit(0);
