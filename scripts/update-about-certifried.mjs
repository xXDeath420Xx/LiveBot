// Refresh EVERY already-posted "About CertiFried" info embed in place to the current,
// accurate feature set. Scans the main bot + all enabled custom bots: for each bot,
// lists its guilds, finds #about-certifried channel(s), and PATCHes any message whose
// embed title is "About CertiFried" that THAT bot authored (only the author may edit).
//
// EDITS ONLY — never posts a new message. REST-only (no gateway session), safe with PM2.
//
//   node scripts/update-about-certifried.mjs           # dry run
//   node scripts/update-about-certifried.mjs --apply    # actually edit
//   node scripts/update-about-certifried.mjs --apply 1505428320458899576   # also assert this id was hit

import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const APPLY = process.argv.includes('--apply');
const ASSERT_ID = process.argv.find(a => /^\d{17,20}$/.test(a)) || null;

const SITE_URL      = 'https://certifriedmultitool.com';
const THUMB_URL     = 'https://certifriedmultitool.com/images/CertiFried.png';
const INVITE_URL    = 'https://discord.com/api/oauth2/authorize?client_id=1409904443125665875&permissions=8&scope=bot+applications.commands';
const DASHBOARD_URL = 'https://certifriedmultitool.com/dashboard';

// ── The accurate, current embed ─────────────────────────────────────────────
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

// Discord embed limits sanity-check (fail fast before any network write).
function assertEmbedValid(embed) {
    let total = (embed.title || '').length + (embed.description || '').length + (embed.footer?.text || '').length;
    for (const f of embed.fields) {
        if (f.name.length > 256) throw new Error(`field name too long: ${f.name}`);
        if (f.value.length > 1024) throw new Error(`field value too long (${f.value.length}): ${f.name}`);
        total += f.name.length + f.value.length;
    }
    if (embed.fields.length > 25) throw new Error('too many fields');
    if (total > 6000) throw new Error(`embed total too long: ${total}`);
    return total;
}

async function rest(token, method, url, body) {
    for (let i = 0; i < 6; i++) {
        const headers = { Authorization: 'Bot ' + token };
        if (body) headers['Content-Type'] = 'application/json';
        const init = { method, headers };
        if (body) init.body = JSON.stringify(body);
        const r = await fetch(url, init);
        if (r.status === 429) {
            const b = await r.json().catch(() => ({ retry_after: 1 }));
            await new Promise(res => setTimeout(res, Math.ceil((b.retry_after || 1) * 1000) + 200));
            continue;
        }
        if (r.status === 404) return { __notfound: true };
        if (r.status === 403) return { __forbidden: true };
        if (!r.ok) { return { __error: r.status, body: (await r.text().catch(() => '')).slice(0, 160) }; }
        return r.status === 204 ? { __ok: true } : r.json();
    }
    return { __error: 'retries' };
}

async function main() {
    const newEmbed = buildInfoEmbed();
    const total = assertEmbedValid(newEmbed);
    console.log(`Embed validated: ${newEmbed.fields.length} fields, ${total}/6000 chars.\n`);

    // Build bot roster: main + enabled custom bots.
    const roster = [{ label: 'CertiFried Utility (main)', token: process.env.DISCORD_TOKEN, id: '1409904443125665875' }];
    const [bots] = await pool.execute('SELECT bot_id, bot_name, bot_token FROM custom_bots WHERE enabled = 1');
    for (const b of bots) {
        try { roster.push({ label: b.bot_name || b.bot_id, token: encryption.decrypt(JSON.parse(b.bot_token)), id: b.bot_id }); }
        catch (e) { console.warn(`  ! decrypt failed for ${b.bot_id}: ${e.message}`); }
    }
    console.log(`Scanning ${roster.length} bot(s) for #about-certifried embeds…\n`);

    const stats = { patched: 0, alreadyCurrent: 0, channels: 0, errors: 0 };
    let assertHit = false;

    for (const bot of roster) {
        // Resolve real bot id (custom rows may be stale); also validates the token.
        const me = await rest(bot.token, 'GET', 'https://discord.com/api/v10/users/@me');
        if (!me || me.__error || me.__forbidden) { console.warn(`  ! ${bot.label}: token invalid`); continue; }
        const botId = me.id;

        const guilds = await rest(bot.token, 'GET', 'https://discord.com/api/v10/users/@me/guilds');
        if (!Array.isArray(guilds)) continue;

        for (const g of guilds) {
            const channels = await rest(bot.token, 'GET', `https://discord.com/api/v10/guilds/${g.id}/channels`);
            if (!Array.isArray(channels)) continue;

            const aboutChannels = channels.filter(c => c.type === 0 && /about.?certifried/i.test(c.name || ''));
            for (const ch of aboutChannels) {
                const msgs = await rest(bot.token, 'GET', `https://discord.com/api/v10/channels/${ch.id}/messages?limit=50`);
                if (!Array.isArray(msgs)) continue;
                stats.channels++;

                for (const m of msgs) {
                    const isAbout = (m.embeds || []).some(e => e.title === 'About CertiFried');
                    if (!isAbout) continue;
                    if (m.author?.id !== botId) continue; // only the author can edit

                    if (m.id === ASSERT_ID) assertHit = true;
                    const tag = m.id === ASSERT_ID ? '  << the message you referenced' : '';

                    if (APPLY) {
                        const res = await rest(bot.token, 'PATCH',
                            `https://discord.com/api/v10/channels/${ch.id}/messages/${m.id}`,
                            { embeds: [newEmbed] });
                        if (res && !res.__error && !res.__forbidden && !res.__notfound) {
                            console.log(`  ✓ ${g.name} / #${ch.name} — ${m.id} via ${bot.label}${tag}`);
                            stats.patched++;
                        } else {
                            console.warn(`  ! ${g.name} / #${ch.name} — ${m.id}: ${res?.__error || res?.__forbidden ? 'forbidden' : 'failed'} ${res?.body || ''}`);
                            stats.errors++;
                        }
                    } else {
                        console.log(`  · would update ${g.name} / #${ch.name} — ${m.id} via ${bot.label}${tag}`);
                        stats.patched++;
                    }
                }
            }
        }
    }

    console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'} — ${APPLY ? 'updated' : 'would update'}:${stats.patched} ` +
        `about-channels-seen:${stats.channels} errors:${stats.errors}`);
    if (ASSERT_ID) console.log(`Referenced message ${ASSERT_ID}: ${assertHit ? 'FOUND & handled ✓' : 'NOT found ✗'}`);
    await pool.end();
    process.exit(0);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
