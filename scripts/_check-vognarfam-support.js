import 'dotenv/config';
import pool from '../utils/db.js';
import { resolveBotForGuild } from '../utils/bot-resolver.js';

// The acting bot comes from guild_bot_mapping — never pinned here.
const GUILD_ID = '902393911958470717';
const CHANNEL_ID = '1476147991122284711';

try {
    const [config] = await pool.execute('SELECT * FROM community_support_config WHERE guild_id = ?', [GUILD_ID]);
    console.log('=== Community Support Config ===');
    console.log(JSON.stringify(config[0] || 'NOT FOUND', null, 2));

    // Delete the wrong embed I just posted
    const bot = await resolveBotForGuild(GUILD_ID, { db: pool });
    const token = bot.token;

    // Delete the wrong message and unpin
    const wrongMsgId = '1481931304290488320';

    // Unpin first
    await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/pins/${wrongMsgId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bot ${token}` }
    });

    // Delete the message
    const delRes = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${wrongMsgId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bot ${token}` }
    });
    console.log('\nDeleted wrong embed:', delRes.ok ? 'YES' : 'NO');

    // Also check shoutout entries
    const [shoutouts] = await pool.execute(
        'SELECT * FROM community_support_shoutouts WHERE guild_id = ? ORDER BY month_key DESC LIMIT 10', [GUILD_ID]);
    console.log('\n=== Recent Shoutouts ===');
    for (const s of shoutouts) {
        console.log(`  [${s.month_key}] rank:${s.rank_position} user:${s.user_id} twitch:${s.twitch_username} points:${s.total_points}`);
    }
} catch (err) {
    console.error('Error:', err.message);
}
process.exit(0);
