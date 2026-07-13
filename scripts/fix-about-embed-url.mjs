// Patch the live "About CertiFried" info embed in Lair + Pac to replace
// the invalid /bots URL with /bot-management. Uses PATCH /messages/{id}.
import 'dotenv/config';
import mysql from 'mysql2/promise';

const TARGETS = [
    { name: 'Lair', channelId: '1496641274151698673', msgId: '1496641284218163452', botId: '1496406792417185802' },
    { name: 'Pac',  channelId: '1496641417173532683', msgId: '1496641422562955384', botId: '1496352090950467595' },
];

const INVITE_URL     = 'https://discord.com/api/oauth2/authorize?client_id=1409904443125665875&permissions=8&scope=bot+applications.commands';
const DASHBOARD_URL  = 'https://certifriedmultitool.com/dashboard';
const SITE_URL       = 'https://certifriedmultitool.com';
const THUMB_URL      = 'https://certifriedmultitool.com/images/CertiFried.png';

const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const enc = (await import('/home/death/CertiFriedUtility/utils/encryption.js')).default;

async function tokenFor(botId) {
    if (botId === '1409904443125665875') return process.env.DISCORD_TOKEN;
    const [r] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [botId]);
    return enc.decrypt(JSON.parse(r[0].bot_token));
}

function buildInfoEmbed() {
    return {
        title: 'About CertiFried',
        color: 0xF0A500,
        thumbnail: { url: THUMB_URL },
        description:
            'CertiFried is an all-in-one Discord utility suite — streaming announcements, moderation, leveling, music, giveaways, tickets, economy, games, and 40+ more features in a single bot backed by a full web dashboard.',
        fields: [
            { name: '🛡️ Moderation & Protection',
              value: 'Anti-nuke • phishing shield • global ban network • automod • raid detection • full audit logging' },
            { name: '📢 Streaming & Social',
              value: 'Twitch / Kick / YouTube / TikTok / Twitter / Bluesky / Instagram alerts • cancel-aware Twitch schedule images • self-promo tracking • community support points • auto-shoutouts' },
            { name: '🎫 Community Tools',
              value: 'Leveling + rank cards • reaction roles • ticketing • suggestions • starboard • welcome/goodbye cards • birthdays • confessions • QOTD' },
            { name: '🎮 Engagement',
              value: 'Music panel (YouTube + local files) • VC sound drops • trivia, hangman, music quiz, counting, LFG • Pokémon, RPG, economy, giveaways, polls' },
            { name: '🧰 Utility',
              value: 'Notes, reminders, weather, crypto, recipes, translation, TTS, color lookup, QR, NASA APOD, strain lookup — plus a `/help` explorer' },
            { name: '🌐 Dashboard',
              value: `Full web UI at ${SITE_URL} — per-guild configs, stream rosters, log routing, ticket analytics, and more.` },
            { name: '🤖 Option 1 — Invite the default CertiFried bot',
              value: `Easiest route. Hit the link, pick your server, done.\n→ [add CertiFried to your server](${INVITE_URL})` },
            { name: '🎨 Option 2 — Run your OWN branded bot on our backend',
              value:
                `Same features, your custom name / avatar / presence. Steps:\n\n` +
                `**1.** Create a bot at [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → **Bot** → **Reset Token** (copy it, you won't see it again).\n` +
                `**2.** In the Bot tab, enable all three **Privileged Gateway Intents**: Server Members, Message Content, Presence.\n` +
                `**3.** Invite your bot: **OAuth2 → URL Generator** → scopes \`bot\` + \`applications.commands\` → permission **Administrator** → open the URL → add to your server.\n` +
                `**4.** Sign in at ${DASHBOARD_URL} and open your server.\n` +
                `**5.** Click **Appearance** in the sidebar (or visit \`/manage/{your-guild-id}?page=appearance\`).\n` +
                `**6.** Paste your bot's **Application/Client ID** and **Bot Token** into the form → **Set Up Custom Bot**.\n\n` +
                `That's it. Your bot boots on our backend with every CertiFried feature, encrypted token storage, and per-guild slash-command deploys.` },
        ],
        footer: { text: 'certifriedmultitool.com  •  made by CertiFried' },
    };
}

for (const t of TARGETS) {
    const token = await tokenFor(t.botId);
    const r = await fetch(
        `https://discord.com/api/v10/channels/${t.channelId}/messages/${t.msgId}`,
        {
            method: 'PATCH',
            headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [buildInfoEmbed()] }),
        });
    console.log(`${t.name}: PATCH ${t.msgId} → ${r.status}`);
}

await pool.end();
