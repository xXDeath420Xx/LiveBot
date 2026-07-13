import 'dotenv/config';
import pool from '../utils/db.js';

try {
    const [bot] = await pool.execute('SELECT bot_id, bot_name FROM custom_bots WHERE bot_id = ?', ['1476040458680406214']);
    console.log('=== Custom Bot ===');
    console.log(bot[0] || 'NOT FOUND');

    const [mapping] = await pool.execute('SELECT * FROM guild_bot_mapping WHERE guild_id = ?', ['902393911958470717']);
    console.log('\n=== Guild Bot Mapping ===');
    console.log(mapping);

    const [subs] = await pool.execute(
        `SELECT sub.subscription_id, sub.guild_id,
                COALESCE(sub.announcement_channel_id, gc.announcement_channel_id) AS channel_id,
                sub.delete_on_end, sub.edit_on_end,
                s.username, s.platform
         FROM subscriptions sub
         JOIN streamers s ON sub.streamer_id = s.streamer_id
         LEFT JOIN guild_config gc ON CAST(sub.guild_id AS CHAR) = CAST(gc.guild_id AS CHAR)
         WHERE sub.guild_id = ? ORDER BY s.username`, ['902393911958470717']);
    console.log('\n=== Stream Subscriptions (' + subs.length + ') ===');
    for (const s of subs) {
        console.log('  ' + s.platform + '/' + s.username + ' -> #' + s.channel_id + ' enabled:' + s.is_enabled);
    }

    const [live] = await pool.execute('SELECT * FROM live_announcements WHERE guild_id = ?', ['902393911958470717']);
    console.log('\n=== Live Announcements (' + live.length + ') ===');
    for (const l of live) {
        console.log('  ' + l.platform + '/' + l.username + ' msg:' + l.message_id + ' offline:' + l.offline_check_count);
    }

    const [guild] = await pool.execute('SELECT guild_id, announcement_channel_id, live_role_id, use_webhook_persona FROM guilds WHERE guild_id = ?', ['902393911958470717']);
    console.log('\n=== Guild Config ===');
    console.log(guild[0] || 'NOT FOUND');
} catch (err) {
    console.error('Error:', err.message);
}
process.exit(0);
