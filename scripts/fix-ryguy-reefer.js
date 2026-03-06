import dotenv from 'dotenv';
dotenv.config();
import pool from '../utils/db.js';

const GUILD_ID = '985116833193553930';

try {
    // Fix ryguy2kr: clear the explicit channel override so it uses the team channel
    const [result] = await pool.execute(
        `UPDATE subscriptions s
         JOIN streamers st ON s.streamer_id = st.streamer_id
         SET s.announcement_channel_id = NULL
         WHERE s.guild_id = ? AND st.username = 'ryguy2kr'`,
        [GUILD_ID]
    );
    console.log('Updated ryguy2kr:', result.affectedRows, 'row(s)');

    // Also link discord_user_id if not set
    await pool.execute(
        "UPDATE streamers SET discord_user_id = ? WHERE username = 'ryguy2kr' AND (discord_user_id IS NULL OR discord_user_id != ?)",
        ['881593846599925790', '881593846599925790']
    );

    // Verify
    const [verify] = await pool.execute(
        `SELECT s.subscription_id, s.announcement_channel_id, s.team_subscription_id, st.username, st.discord_user_id
         FROM subscriptions s
         JOIN streamers st ON s.streamer_id = st.streamer_id
         WHERE s.guild_id = ? AND st.username = 'ryguy2kr'`,
        [GUILD_ID]
    );
    console.log('\nVerified:');
    for (const v of verify) {
        console.log('  ' + v.username + ' -> channel: ' + (v.announcement_channel_id || 'NULL (will use team channel 1415373602068496545)'));
        console.log('  discord_user_id:', v.discord_user_id);
        console.log('  team_subscription_id:', v.team_subscription_id);
    }
} catch(e) { console.error('ERR:', e.message); }
await pool.end();
process.exit(0);
