// Rebuild 📜┃rules (1496351042017824859) as ONE panel + the verify button.
// REST-only: safe to run while PM2 is up.
import dotenv from 'dotenv';
dotenv.config();
import mysql from 'mysql2/promise';
// dynamic: utils/encryption reads BOT_ENCRYPTION_KEY at import time, after dotenv has run
const { resolveBotForGuild } = await import('../../utils/bot-resolver.js');

const GUILD_ID = '1099732505243959407';
const CHANNEL_ID = '1496351042017824859';
// The acting bot comes from guild_bot_mapping — never pinned here.
const KEEP_MSG = '1496387925120778291'; // verify_config.gate_message_id — must survive
const DROP_MSG = '1496387924000899072'; // old 7-embed wall
const COLOR = 13485055;
const ADD_REACTIONS = 1n << 6n;

const LEVELS = '1496362125776388096';
const STREAM_SIGNUP = '1496351044567961620';

const DESCRIPTION = `# 🐺 WELCOME TO THE PAC

### **Where Family Fuels the Grind**

Keep it simple. Keep it kind. Keep it **Pac**.

The Pac is built on **Love • Respect • Kindness**. This is a community where streamers, gamers, and supporters come together to connect, grow, and lift each other up.

XP resets every 6 months to keep things fair, fresh & encourage ongoing activity.

We encourage authentic friendships & support. Real conversations > Fake engagement.

If you're only here to self-promote, *this probably isn't the server for you.*

## 📜 Server Rules

🐺 **Be Cool, Be Kind, Be Respectful**
Everyone deserves to feel welcome. This is a safe space for all.

🔞 **18+ Community**
Mature conversations are allowed, but keep it classy. No X-rated content or piracy.

🚫 **No Hate or Drama**
No racism, sexism, homophobia, transphobia, harassment, politics, or religious debates.

📢 **No Spam or Link Dumping**
No random @everyone tags, spam, or self-promo outside the correct channels.

NO Price lists, "DM me for pricing" posts, or DMing Pac members with offers. Automatically BANNED.

🔒 **Respect Privacy & Boundaries**
Do not share personal information, screenshots, or DMs without permission. If someone asks you to stop, respect it.

🐺 **Use Common Sense**
Keep profiles and conversations appropriate. Mods may step in to keep The Pac safe and fun.

## 💬 How The Pac Works

We are a **chat-first community**, not a drop-your-link-and-leave server.

We want to know **you**, not just your stream.

🌟 **Engagement = Access**
Hang out, join conversations, support others, and earn XP by being part of the community.

🏆 Check your rank here: <#${LEVELS}>

Once you reach **Level 3**, you unlock access to post your stream info in the proper channels. Sign up in <#${STREAM_SIGNUP}>. When you reach Level 3 your links will automatically drop.

## 🐺 Final Word

Show up. Support each other. Be genuine.

The Pac grows because we grow **together**.

**Welcome to the family. 💜**`;

const EMBED = {
    description: DESCRIPTION,
    color: COLOR,
    footer: { text: 'Click "I accept the rules" below to unlock the server · You have 7 days after joining to verify.' },
};

const BUTTON_ROW = {
    type: 1,
    components: [{ type: 2, custom_id: 'verify_accept', style: 3, label: 'I accept the rules', emoji: { name: '✅' } }],
};

async function api(token, path, method = 'GET', body) {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
        method,
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
    return json;
}

const dry = process.argv.includes('--dry');
console.log(`description length: ${DESCRIPTION.length}/4096`);
if (DESCRIPTION.length > 4096) throw new Error('embed description too long');

const db = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const bot = await resolveBotForGuild(GUILD_ID, { db });
const [[gate]] = await db.execute('SELECT gate_message_id FROM verify_config WHERE guild_id = ?', [GUILD_ID]);
await db.end();
const token = bot.token;

if (gate.gate_message_id !== KEEP_MSG) throw new Error(`gate_message_id moved: ${gate.gate_message_id}`);

if (dry) {
    console.log(JSON.stringify({ embeds: [EMBED], components: [BUTTON_ROW] }, null, 2));
    process.exit(0);
}

// 1. Merge everything into the gate message (id preserved -> verify_config stays valid)
await api(token, `/channels/${CHANNEL_ID}/messages/${KEEP_MSG}`, 'PATCH', {
    content: '', embeds: [EMBED], components: [BUTTON_ROW],
});
console.log('edited gate message into the single panel');

// 2. Strip the pile-on reactions (joining an existing reaction does NOT need ADD_REACTIONS)
await api(token, `/channels/${CHANNEL_ID}/messages/${KEEP_MSG}/reactions`, 'DELETE');
console.log('cleared reactions');

// 3. Drop the old multi-embed wall
await api(token, `/channels/${CHANNEL_ID}/messages/${DROP_MSG}`, 'DELETE');
console.log('deleted old rules wall');

// 4. Deny ADD_REACTIONS on every overwrite in the channel
const channel = await api(token, `/channels/${CHANNEL_ID}`);
for (const ow of channel.permission_overwrites) {
    const allow = BigInt(ow.allow) & ~ADD_REACTIONS;
    const deny = BigInt(ow.deny) | ADD_REACTIONS;
    if (allow === BigInt(ow.allow) && deny === BigInt(ow.deny)) {
        console.log(`overwrite ${ow.id}: already denies ADD_REACTIONS`);
        continue;
    }
    await api(token, `/channels/${CHANNEL_ID}/permissions/${ow.id}`, 'PUT', {
        type: ow.type, allow: allow.toString(), deny: deny.toString(),
    });
    console.log(`overwrite ${ow.id}: ADD_REACTIONS denied`);
}

// 5. Pin the panel
await api(token, `/channels/${CHANNEL_ID}/pins/${KEEP_MSG}`, 'PUT').catch(e => console.log('pin skipped:', e.message));
console.log('done');

