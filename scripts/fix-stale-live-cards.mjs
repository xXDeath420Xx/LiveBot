/*
 * Strip stale "LIVE" card images from ended-stream announcements.
 *
 * Announcements posted before the offline-card change kept their uploaded card when the
 * message was edited to "Stream has ended" — the new embed no longer referenced
 * attachment://stream.png, so Discord left the file hanging under the message, still
 * showing the red LIVE badge.
 *
 * This sweeps every announcement channel, finds ended-stream messages that still carry an
 * attachment, and removes it. REST-only, safe while PM2 is running.
 *
 *   node scripts/fix-stale-live-cards.mjs --dry      preview, change nothing
 *   node scripts/fix-stale-live-cards.mjs            apply
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import encryption from '../utils/encryption.js';

const DRY = process.argv.includes('--dry');
const PAGES = 4; // 100 messages per page

const db = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME, port: process.env.DB_PORT || 3306,
});

const tokenCache = new Map();
async function tokenFor(guildId) {
    if (tokenCache.has(guildId)) return tokenCache.get(guildId);
    const [[map]] = await db.query('SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ?', [guildId]);
    let token = process.env.DISCORD_TOKEN;
    if (map) {
        const [[bot]] = await db.query('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [map.bot_id]);
        if (bot) token = encryption.decrypt(JSON.parse(bot.bot_token));
    }
    tokenCache.set(guildId, token);
    return token;
}

// Discord only lets a bot edit its OWN messages, and the guild's currently-mapped bot is not
// always the one that posted — announcements outlive mapping changes. Edit as the author.
const botTokenCache = new Map();
async function tokenForBot(botId) {
    if (botTokenCache.has(botId)) return botTokenCache.get(botId);
    let token = null;
    const [[bot]] = await db.query('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [botId]);
    if (bot) token = encryption.decrypt(JSON.parse(bot.bot_token));
    botTokenCache.set(botId, token);
    return token;
}

// Webhook-sent messages can only be edited through the webhook that created them
const webhookCache = new Map();
async function webhookFor(channelId, token, webhookId) {
    const key = `${channelId}:${webhookId}`;
    if (webhookCache.has(key)) return webhookCache.get(key);
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/webhooks`, { headers: { Authorization: `Bot ${token}` } });
    let hook = null;
    if (res.ok) hook = (await res.json()).find(w => w.id === webhookId && w.token) || null;
    webhookCache.set(key, hook);
    return hook;
}

try {
    const [rows] = await db.query(
        'SELECT DISTINCT announcement_channel_id AS channel_id, guild_id FROM subscriptions WHERE announcement_channel_id IS NOT NULL');
    console.log(`scanning ${rows.length} announcement channel(s)${DRY ? ' (dry run)' : ''}`);

    let found = 0, fixed = 0, failed = 0;

    for (const row of rows) {
        const token = await tokenFor(row.guild_id);
        let before = null;

        for (let page = 0; page < PAGES; page++) {
            const url = `https://discord.com/api/v10/channels/${row.channel_id}/messages?limit=100${before ? `&before=${before}` : ''}`;
            const res = await fetch(url, { headers: { Authorization: `Bot ${token}` } });
            if (!res.ok) break;
            const msgs = await res.json();
            if (!msgs.length) break;
            before = msgs[msgs.length - 1].id;

            for (const m of msgs) {
                const e = m.embeds?.[0];
                const ended = e?.title === 'Stream has ended' || /was LIVE on/i.test(e?.author?.name || '');
                // A stale card is an attachment the (already edited) embed no longer points at
                const stale = (m.attachments ?? []).filter(a => !e?.image?.url?.includes(a.filename) || !e?.image);
                if (!ended || !stale.length) continue;

                found++;
                const who = (e?.author?.name || '').split(' ')[0];
                if (DRY) { console.log(`  would strip ${stale.map(a => a.filename).join(',')} from ${who} (${m.id})`); continue; }

                let ok = false;
                if (m.webhook_id) {
                    const hook = await webhookFor(row.channel_id, token, m.webhook_id);
                    if (hook) {
                        const r = await fetch(`https://discord.com/api/v10/webhooks/${hook.id}/${hook.token}/messages/${m.id}`, {
                            method: 'PATCH',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ attachments: [] }),
                        });
                        ok = r.ok;
                    }
                } else {
                    // Must edit as whoever authored it, not as whichever bot the guild maps to now
                    const authorToken = (await tokenForBot(m.author?.id)) || token;
                    const r = await fetch(`https://discord.com/api/v10/channels/${row.channel_id}/messages/${m.id}`, {
                        method: 'PATCH',
                        headers: { Authorization: `Bot ${authorToken}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ attachments: [] }),
                    });
                    ok = r.ok;
                    if (!ok) console.log(`    (edit as ${m.author?.username} -> HTTP ${r.status})`);
                }

                if (ok) { fixed++; console.log(`  stripped stale LIVE card from ${who} (${m.id})`); }
                else { failed++; console.log(`  FAILED on ${who} (${m.id})`); }
                await new Promise(s => setTimeout(s, 350)); // stay well inside edit rate limits
            }
            await new Promise(s => setTimeout(s, 300));
        }
    }

    console.log(`\nended-stream messages with a stale card: ${found}   fixed: ${fixed}   failed: ${failed}`);
} catch (e) {
    console.error('ERR', e.message);
    process.exitCode = 1;
} finally {
    await db.end();
}
process.exit(process.exitCode ?? 0);
