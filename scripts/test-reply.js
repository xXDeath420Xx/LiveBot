import 'dotenv/config';
import { resolveBotForGuild } from '../utils/bot-resolver.js';
import pool from '../utils/db.js';

const GUILD_ID = '902393911958470717';
const CHANNEL_ID = '1318141825009319936';
const MESSAGE_ID = '1493172452677652541';

// The acting bot comes from guild_bot_mapping — never pinned here.
const bot = await resolveBotForGuild(GUILD_ID, { db: pool });
const token = bot.token;
const auth = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };

const body = {
    embeds: [{
        color: 0x00D166,
        description: '💚 Support tracked for <@569998001477517313>!\n\n**rc_jev** (Affiliate) +3pts\n\n**Total: +3 points**\n\n📊 [View your ranking here](https://certifriedmultitool.com/supporters/902393911958470717)',
        footer: { text: 'Community Support Tracker (recovered)' },
        timestamp: new Date().toISOString()
    }],
    message_reference: {
        message_id: MESSAGE_ID,
        channel_id: CHANNEL_ID,
        guild_id: GUILD_ID,
        fail_if_not_exists: false
    },
    allowed_mentions: { replied_user: false }
};

const res = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
    method: 'POST', headers: auth, body: JSON.stringify(body)
});
console.log(`Reply status: ${res.status} ${res.statusText}`);
if (!res.ok) console.log('Body:', await res.text());
else { const r = await res.json(); console.log(`Reply ID: ${r.id}`); }
process.exit(0);
