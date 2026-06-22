// Create an "About CertiFried" category + channel in both Mama Bear's Lair
// (1216126780767731722) and The Pac (1099732505243959407), positioned directly
// below each guild's support section. Posts a banner + info embed, pins both.
// Idempotent: re-running updates missing pins but won't duplicate category/channel.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

const BANNER_LOCAL  = '/home/death/CertiFriedUtility/dashboard/public/images/certifried-banner.png';
const BANNER_URL    = 'https://certifriedmultitool.com/images/certifried-banner.png';
const THUMB_URL     = 'https://certifriedmultitool.com/images/CertiFried.png';
const SITE_URL      = 'https://certifriedmultitool.com';
const INVITE_URL    = 'https://discord.com/api/oauth2/authorize?client_id=1409904443125665875&permissions=8&scope=bot+applications.commands';
const DASHBOARD_URL = 'https://certifriedmultitool.com/dashboard';

const GUILDS = [
    {
        name: 'Mama Bear\'s Lair',
        guildId: '1216126780767731722',
        supportCategoryId: '1219862861514543151', // "Lair Bear Care" category
        botId: '1496406792417185802',              // CertiFried Bear (custom)
    },
    {
        name: 'The Pac',
        guildId: '1099732505243959407',
        supportCategoryId: '1412158772868022372', // "Pacs Party" (holds pacSupport channel)
        botId: '1496352090950467595',              // Twatwaffle Patrol (custom, assigned via guild_bot_mapping)
    },
];

const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});
const enc = (await import('/home/death/CertiFriedUtility/utils/encryption.js')).default;

async function tokenFor(botId) {
    if (botId === '1409904443125665875') return process.env.DISCORD_TOKEN;
    const [r] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [botId]);
    if (!r[0]) throw new Error(`no custom_bots row for ${botId}`);
    return enc.decrypt(JSON.parse(r[0].bot_token));
}

async function rest(token, method, url, body, { raw = false } = {}) {
    for (let i = 0; i < 6; i++) {
        const headers = { Authorization: 'Bot ' + token };
        if (body && !raw) headers['Content-Type'] = 'application/json';
        const init = { method, headers };
        if (body) init.body = raw ? body : JSON.stringify(body);
        const r = await fetch(url, init);
        if (r.status === 429) {
            const b = await r.json().catch(() => ({ retry_after: 1 }));
            await new Promise(res => setTimeout(res, Math.ceil((b.retry_after || 1) * 1000) + 150));
            continue;
        }
        if (r.status === 404) return { __notfound: true };
        if (!r.ok) {
            const t = await r.text().catch(() => '');
            console.log(`    ${method} ${url.slice(-70)}: ${r.status} ${t.slice(0, 200)}`);
            return null;
        }
        return r.status === 204 ? { __ok: true } : r.json();
    }
    return null;
}

function buildInfoEmbed() {
    return {
        title: 'About CertiFried',
        color: 0xF0A500,
        thumbnail: { url: THUMB_URL },
        description:
            'CertiFried is an all-in-one Discord utility suite — go-live stream alerts, moderation, ' +
            'leveling, music, giveaways, tickets, economy, a full D&D 5e RPG, games, and 50+ more ' +
            'features in a single bot backed by a full web dashboard.',
        fields: [
            {
                name: '🛡️ Moderation & Protection',
                value: 'Anti-nuke • phishing shield with image/OCR scam detection • global ban network • automod • raid & self-bot detection • full audit logging',
            },
            {
                name: '📢 Go-Live Stream Alerts',
                value: 'Twitch • Kick • YouTube • Trovo • TikTok • Facebook — auto-tracked streamer roles, cancel-aware Twitch schedule images, per-guild live roster & auto-shoutouts',
            },
            {
                name: '📰 Social Feeds',
                value: 'New-post alerts from Reddit • YouTube • Twitter/X • Bluesky • Facebook, plus TikTok VOD notifications',
            },
            {
                name: '🎫 Community Tools',
                value: 'Leveling + rank cards • reaction roles • ticketing • suggestions • starboard • welcome/goodbye cards • group greeting cards • birthdays • confessions • QOTD',
            },
            {
                name: '🎮 Games & Engagement',
                value: 'Full D&D 5e RPG (`/rpg`) • Cards Against Humanity (`/cah`) • word games (`/wordgame`) • Pokémon • trivia, hangman, music quiz, counting, LFG • economy, pets & gambling • giveaways & polls',
            },
            {
                name: '🎵 Music & Voice',
                value: 'Full music player + AI DJ (YouTube + local files) • VC sound drops • text-to-speech',
            },
            {
                name: '🧰 Utility',
                value: 'Notes, reminders, weather, crypto, recipes, translation, color & QR tools, NASA APOD, strain lookup — plus a `/setup` guided walkthrough and a `/help` explorer',
            },
            {
                name: '🤝 Creator Integrations',
                value: 'Buy Me a Coffee supporter alerts • Throne wishlists • Fourthwall shop • Steam game watcher • Against_The_Tide Stream Team signups',
            },
            {
                name: '🌐 Dashboard',
                value: `Full web UI at ${SITE_URL} — per-guild configs, stream rosters, log routing, ticket analytics, and more.`,
            },
            {
                name: '🤖 Option 1 — Invite the default CertiFried bot',
                value: `Easiest route. Hit the link, pick your server, done.\n→ [add CertiFried to your server](${INVITE_URL})`,
            },
            {
                name: '🎨 Option 2 — Run your OWN branded bot on our backend',
                value:
                    `Same features, your custom name / avatar / presence. Steps:\n\n` +
                    `**1.** Create a bot at [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → **Bot** → **Reset Token** (copy it, you won't see it again).\n` +
                    `**2.** In the Bot tab, enable all three **Privileged Gateway Intents**: Server Members, Message Content, Presence.\n` +
                    `**3.** Invite your bot: **OAuth2 → URL Generator** → scopes \`bot\` + \`applications.commands\` → permission **Administrator** → open the URL → add to your server.\n` +
                    `**4.** Sign in at ${DASHBOARD_URL} and open your server.\n` +
                    `**5.** Click **Appearance** in the sidebar (or visit \`/manage/{your-guild-id}?page=appearance\`).\n` +
                    `**6.** Paste your bot's **Application/Client ID** and **Bot Token** into the form → **Set Up Custom Bot**.\n\n` +
                    `That's it. Your bot boots on our backend with every CertiFried feature, encrypted token storage, and per-guild slash-command deploys.`,
            },
        ],
        footer: { text: 'certifriedmultitool.com  •  made by CertiFried' },
    };
}

async function postBannerMessage(token, channelId) {
    const buf = fs.readFileSync(BANNER_LOCAL);
    const fd = new FormData();
    // Attachment-only — Discord auto-renders attached images at full width.
    // Adding an embed with image.url here would duplicate the banner.
    fd.append('payload_json', JSON.stringify({}));
    fd.append('files[0]', new Blob([buf], { type: 'image/png' }), 'certifried-banner.png');
    const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { Authorization: 'Bot ' + token },
        body: fd,
    });
    if (!r.ok) {
        console.log(`    banner post failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
        return null;
    }
    return r.json();
}

async function pin(token, channelId, messageId) {
    const r = await rest(token, 'PUT',
        `https://discord.com/api/v10/channels/${channelId}/pins/${messageId}`);
    return !!(r?.__ok || r === null ? false : true) || r?.__ok;
}

async function setupGuild({ name, guildId, supportCategoryId, botId }) {
    console.log(`\n== ${name} (${guildId}) ==`);
    const token = await tokenFor(botId);

    // Fetch all channels
    const channels = await rest(token, 'GET',
        `https://discord.com/api/v10/guilds/${guildId}/channels`);
    if (!channels) throw new Error('could not list channels');

    // Find support anchor
    const anchor = channels.find(c => c.id === supportCategoryId);
    if (!anchor) throw new Error(`support anchor category ${supportCategoryId} not found`);
    console.log(`  support anchor: ${anchor.name} (pos=${anchor.position})`);

    // Idempotency: existing "About CertiFried" category?
    let aboutCat = channels.find(c => c.type === 4
        && /about\s*certifried/i.test(c.name));
    if (aboutCat) {
        console.log(`  existing About category: ${aboutCat.name} (${aboutCat.id})`);
    } else {
        aboutCat = await rest(token, 'POST',
            `https://discord.com/api/v10/guilds/${guildId}/channels`, {
                name: 'About CertiFried',
                type: 4,
                permission_overwrites: [
                    {
                        id: guildId,           // @everyone
                        type: 0,
                        deny: '2048',           // SendMessages
                    },
                ],
            });
        if (!aboutCat?.id) throw new Error('failed to create category');
        console.log(`  created category: ${aboutCat.id}`);
    }

    // Position: anchor.position + 1
    const targetPos = anchor.position + 1;
    if (aboutCat.position !== targetPos) {
        await rest(token, 'PATCH',
            `https://discord.com/api/v10/channels/${aboutCat.id}`, { position: targetPos });
        console.log(`  positioned to ${targetPos}`);
    }

    // Find / create inside channel
    let aboutCh = channels.find(c => c.type === 0
        && c.parent_id === aboutCat.id
        && /about.?certifried/i.test(c.name));
    if (aboutCh) {
        console.log(`  existing channel: ${aboutCh.name} (${aboutCh.id})`);
    } else {
        aboutCh = await rest(token, 'POST',
            `https://discord.com/api/v10/guilds/${guildId}/channels`, {
                name: 'about-certifried',
                type: 0,
                parent_id: aboutCat.id,
            });
        if (!aboutCh?.id) throw new Error('failed to create channel');
        console.log(`  created channel: ${aboutCh.id}`);
    }

    // Check for existing pins to avoid re-posting
    const existingPins = await rest(token, 'GET',
        `https://discord.com/api/v10/channels/${aboutCh.id}/pins`);
    const pinnedArr = Array.isArray(existingPins) ? existingPins : [];
    const hasBanner = pinnedArr.some(m =>
        (m.attachments || []).some(a => a.filename === 'certifried-banner.png')
        || (m.embeds || []).some(e => e.image?.url === BANNER_URL));
    const hasEmbed = pinnedArr.some(m =>
        (m.embeds || []).some(e => e.title === 'About CertiFried'));

    if (!hasBanner) {
        const posted = await postBannerMessage(token, aboutCh.id);
        if (posted?.id) {
            await pin(token, aboutCh.id, posted.id);
            console.log(`  banner posted + pinned (${posted.id})`);
        }
    } else {
        console.log('  banner already pinned — skipping');
    }

    if (!hasEmbed) {
        const posted = await rest(token, 'POST',
            `https://discord.com/api/v10/channels/${aboutCh.id}/messages`,
            { embeds: [buildInfoEmbed()] });
        if (posted?.id) {
            await pin(token, aboutCh.id, posted.id);
            console.log(`  info embed posted + pinned (${posted.id})`);
        }
    } else {
        console.log('  info embed already pinned — skipping');
    }

    console.log(`  done: category=${aboutCat.id}, channel=${aboutCh.id}`);
}

for (const g of GUILDS) {
    try {
        await setupGuild(g);
    } catch (e) {
        console.log(`  ERROR in ${g.name}: ${e.message}`);
    }
}

console.log('\nDONE');
await pool.end();
