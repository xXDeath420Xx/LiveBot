// Repair already-posted free-game announcement embeds whose Epic link is the broken
// internal GUID slug (/p/<32-hex>), replacing it with the valid store slug — in place.
//
// EDITS ONLY (REST PATCH); never posts new messages. Safe alongside PM2 (stateless REST).
// Custom-bot guilds are edited with their own decrypted token (only the authoring bot
// may edit its message). Message IDs aren't stored, so it scans each subscription
// channel's recent messages for the bot's own free-game embeds.
//
//   node scripts/fix-epic-game-links.mjs           # dry run
//   node scripts/fix-epic-game-links.mjs --apply    # actually edit

import 'dotenv/config';
import { REST, Routes, EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const APPLY = process.argv.includes('--apply');
const SCAN_LIMIT = 60; // recent messages per channel to inspect
const HIGHLIGHT = '1517182387581227078'; // the message the user pointed at

const codeOf = (err) => err?.rawError?.code ?? err?.code;

async function buildRestClient(token) {
    const rest = new REST({ version: '10' }).setToken(token);
    const me = await rest.get(Routes.user('@me'));
    return { rest, id: me.id, username: me.username };
}

async function main() {
    // GUID -> correct slug for the currently-free Epic games (DB already fixed; this
    // map repairs the GUIDs baked into already-posted message embeds).
    const guidToSlug = {
        da528841e0eb43d8b93fd243c6767b0c: 'citizen-sleeper-944858',
        '4ee365fd76704f37ae3dc13676f1ac61': 'robobeat-5f084b',
    };
    const guids = Object.keys(guidToSlug);
    console.log(`Repairing ${guids.length} broken Epic slug(s): ${guids.join(', ')}\n`);

    // Subscriptions = the channels announcements were posted to.
    const [subs] = await pool.execute(
        'SELECT guild_id, discord_channel_id FROM free_games_subscriptions WHERE is_enabled = 1'
    );
    console.log(`Scanning ${subs.length} subscription channel(s).\n`);

    // guild -> custom bot ids
    const [maps] = await pool.execute('SELECT guild_id, bot_id FROM guild_bot_mapping');
    const guildCustomBots = new Map();
    for (const m of maps) {
        if (!guildCustomBots.has(m.guild_id)) guildCustomBots.set(m.guild_id, []);
        guildCustomBots.get(m.guild_id).push(m.bot_id);
    }
    const [bots] = await pool.execute('SELECT bot_id, bot_token FROM custom_bots');
    const customTokenById = new Map();
    for (const b of bots) {
        try { customTokenById.set(b.bot_id, encryption.decrypt(JSON.parse(b.bot_token))); }
        catch (e) { console.warn(`  ! decrypt failed for ${b.bot_id}: ${e.message}`); }
    }
    const mainToken = process.env.DISCORD_TOKEN;

    const clientCache = new Map();
    async function getClient(token, label) {
        if (clientCache.has(token)) return clientCache.get(token);
        try { const c = await buildRestClient(token); clientCache.set(token, c); return c; }
        catch (e) { console.warn(`  ! token invalid (${label}): ${codeOf(e) || e.message}`); clientCache.set(token, null); return null; }
    }

    // Replace any broken GUID with its slug throughout an embed; return clean JSON or null.
    function repairEmbed(rawEmbed) {
        let json;
        try { json = EmbedBuilder.from(rawEmbed).toJSON(); } catch { return null; }
        let str = JSON.stringify(json);
        let changed = false;
        for (const guid of guids) {
            if (str.includes(guid)) { str = str.split(guid).join(guidToSlug[guid]); changed = true; }
        }
        return changed ? JSON.parse(str) : null;
    }

    const stats = { scanned: 0, fixed: 0, channelsNoAccess: 0 };

    for (const sub of subs) {
        const candidates = [];
        for (const id of (guildCustomBots.get(sub.guild_id) || [])) {
            const tok = customTokenById.get(id);
            if (tok) candidates.push({ token: tok, label: `custom ${id}` });
        }
        if (mainToken) candidates.push({ token: mainToken, label: 'main' });

        // Find a client that can read the channel + which bot authored messages here.
        let reader = null, messages = null;
        for (const cand of candidates) {
            const client = await getClient(cand.token, cand.label);
            if (!client) continue;
            try {
                messages = await client.rest.get(Routes.channelMessages(sub.discord_channel_id), {
                    query: new URLSearchParams({ limit: String(SCAN_LIMIT) }),
                });
                reader = client;
                break;
            } catch (e) {
                const c = codeOf(e);
                if (c === 10003 || c === 50001 || c === 50013) continue; // try next bot
                console.warn(`  ! ${sub.guild_id}/${sub.discord_channel_id} read error (${cand.label}): ${c || e.message}`);
            }
        }
        if (!messages) { stats.channelsNoAccess++; continue; }

        // The editor must be the bot that authored each message. The reader is in the
        // guild; build a quick id->client map for all candidate bots in this guild.
        const editorById = new Map();
        for (const cand of candidates) {
            const cl = clientCache.get(cand.token);
            if (cl) editorById.set(cl.id, cl);
        }

        for (const msg of messages) {
            if (!msg.embeds || msg.embeds.length === 0) continue;
            const editor = editorById.get(msg.author?.id);
            if (!editor) continue; // not our bot's message
            stats.scanned++;

            let touched = false;
            const newEmbeds = msg.embeds.map((e) => {
                const repaired = repairEmbed(e);
                if (repaired) { touched = true; return repaired; }
                return EmbedBuilder.from(e).toJSON();
            });
            if (!touched) continue;

            const tag = msg.id === HIGHLIGHT ? '  << the message you referenced' : '';
            const title = msg.embeds[0]?.title || '(no title)';
            if (APPLY) {
                try {
                    await editor.rest.patch(Routes.channelMessage(sub.discord_channel_id, msg.id), {
                        body: { embeds: newEmbeds },
                    });
                    console.log(`  ✓ fixed ${msg.id} "${title}" in ${sub.guild_id} via ${editor.username}${tag}`);
                    stats.fixed++;
                } catch (e) {
                    console.warn(`  ! patch failed ${msg.id} (${sub.guild_id}): ${codeOf(e) || e.message}`);
                }
            } else {
                console.log(`  · would fix ${msg.id} "${title}" in ${sub.guild_id} via ${editor.username}${tag}`);
                stats.fixed++;
            }
        }
    }

    console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'} — ` +
        `our-embeds-scanned:${stats.scanned} fixed:${stats.fixed} channels-no-access:${stats.channelsNoAccess}`);
    await pool.end();
    process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
