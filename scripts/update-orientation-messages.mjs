// Refresh every ALREADY-POSTED orientation message in place (REST PATCH only).
// NEVER posts a new message: if the stored message is gone (404) the row is skipped.
//
// Safe to run while PM2 is live — uses the stateless Discord REST API, so it opens
// no gateway session (no competing-session risk). Custom-bot guilds are edited with
// their own decrypted token, because a bot may only edit messages it authored.
//
//   node scripts/update-orientation-messages.mjs           # dry run (no writes)
//   node scripts/update-orientation-messages.mjs --apply   # actually edit messages

import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { buildOrientationEmbed } from '../core/orientation-manager.js';

const APPLY = process.argv.includes('--apply');

function avatarUrl(id, hash) {
    if (!hash) return 'https://cdn.discordapp.com/embed/avatars/0.png';
    const ext = hash.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}`;
}
function guildIconUrl(id, hash) {
    if (!hash) return null;
    const ext = hash.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/icons/${id}/${hash}.${ext}`;
}

// A discord.js-shaped stand-in: buildOrientationEmbed only reads client.user.* and
// client.guilds.cache.get(guildId).{name,iconURL}. Everything else comes from the DB.
function makeFakeClient(bot, guildInfo, guildId) {
    return {
        user: {
            displayName: bot.global_name || bot.username,
            username: bot.username,
            displayAvatarURL: () => bot.avatarUrl,
        },
        guilds: {
            cache: {
                get: (id) => (id === guildId
                    ? { name: guildInfo.name, iconURL: () => guildInfo.iconUrl }
                    : undefined),
            },
        },
    };
}

async function buildRestClient(token) {
    const rest = new REST({ version: '10' }).setToken(token);
    const me = await rest.get(Routes.user('@me')); // verifies the token + gets identity
    return {
        rest,
        id: me.id,
        username: me.username,
        global_name: me.global_name,
        avatarUrl: avatarUrl(me.id, me.avatar),
    };
}

const codeOf = (err) => err?.rawError?.code ?? err?.code;

async function main() {
    // 1. Orientation messages that actually exist in config
    const [rows] = await pool.execute(
        'SELECT guild_id, channel_id, message_id FROM orientation_config WHERE message_id IS NOT NULL'
    );
    console.log(`Found ${rows.length} orientation messages on record.\n`);

    // 2. guild -> [custom bot_ids]
    const [maps] = await pool.execute('SELECT guild_id, bot_id FROM guild_bot_mapping');
    const guildCustomBots = new Map();
    for (const m of maps) {
        if (!guildCustomBots.has(m.guild_id)) guildCustomBots.set(m.guild_id, []);
        guildCustomBots.get(m.guild_id).push(m.bot_id);
    }

    // 3. custom bot tokens (decrypted, lazily cached as REST clients)
    const [bots] = await pool.execute('SELECT bot_id, bot_token FROM custom_bots');
    const customTokenById = new Map();
    for (const b of bots) {
        try {
            customTokenById.set(b.bot_id, encryption.decrypt(JSON.parse(b.bot_token)));
        } catch (e) {
            console.warn(`  ! could not decrypt token for custom bot ${b.bot_id}: ${e.message}`);
        }
    }

    // REST client cache by token so /users/@me is fetched once per bot
    const clientCache = new Map();
    async function getClient(token, label) {
        if (clientCache.has(token)) return clientCache.get(token);
        try {
            const c = await buildRestClient(token);
            clientCache.set(token, c);
            return c;
        } catch (e) {
            console.warn(`  ! token invalid (${label}): ${codeOf(e) || e.message}`);
            clientCache.set(token, null);
            return null;
        }
    }

    const mainToken = process.env.DISCORD_TOKEN;
    const guildInfoCache = new Map();
    const stats = { updated: 0, deleted: 0, noToken: 0, noAccess: 0, error: 0 };

    for (const row of rows) {
        const { guild_id, channel_id, message_id } = row;

        // Candidate authoring bots: this guild's custom bots first, then the main bot.
        const candidates = [];
        for (const botId of (guildCustomBots.get(guild_id) || [])) {
            const tok = customTokenById.get(botId);
            if (tok) candidates.push({ token: tok, label: `custom ${botId}` });
        }
        if (mainToken) candidates.push({ token: mainToken, label: 'main' });

        let foundAuthorId = null;
        let deleted = false;
        let accessSeen = false;

        // Locate the message + its author via whichever candidate can read it.
        for (const cand of candidates) {
            const client = await getClient(cand.token, cand.label);
            if (!client) continue;
            try {
                const msg = await client.rest.get(Routes.channelMessage(channel_id, message_id));
                accessSeen = true;
                foundAuthorId = msg.author?.id;
                break;
            } catch (e) {
                const code = codeOf(e);
                if (code === 10008) { deleted = true; break; }            // Unknown Message
                if (code === 10003 || code === 50001 || code === 50013) {  // no access — try next bot
                    continue;
                }
                console.warn(`  ! ${guild_id}: fetch error (${cand.label}) code=${code || e.message}`);
            }
        }

        if (deleted) {
            console.log(`  – skip ${guild_id}: message deleted (will NOT repost)`);
            stats.deleted++;
            continue;
        }
        if (!foundAuthorId) {
            console.log(`  – skip ${guild_id}: no bot could access the message`);
            stats.noAccess++;
            continue;
        }

        // The editor must be the authoring bot.
        const editorToken = foundAuthorId === clientCache.get(mainToken)?.id
            ? mainToken
            : (guildCustomBots.get(guild_id) || [])
                .map((id) => customTokenById.get(id))
                .find((tok) => tok && clientCache.get(tok)?.id === foundAuthorId);

        const editor = editorToken ? clientCache.get(editorToken) : null;
        if (!editor) {
            console.log(`  – skip ${guild_id}: message authored by ${foundAuthorId}, no matching token`);
            stats.noToken++;
            continue;
        }

        // Guild name/icon (cached) for the embed.
        if (!guildInfoCache.has(guild_id)) {
            try {
                const g = await editor.rest.get(Routes.guild(guild_id));
                guildInfoCache.set(guild_id, { name: g.name, iconUrl: guildIconUrl(g.id, g.icon) });
            } catch {
                guildInfoCache.set(guild_id, { name: null, iconUrl: null });
            }
        }
        const guildInfo = guildInfoCache.get(guild_id);

        try {
            const fakeClient = makeFakeClient(editor, guildInfo, guild_id);
            const embed = await buildOrientationEmbed(fakeClient, guild_id);
            if (APPLY) {
                await editor.rest.patch(Routes.channelMessage(channel_id, message_id), {
                    body: { embeds: [embed.toJSON()] },
                });
                console.log(`  ✓ updated ${guild_id} (${guildInfo.name || '?'}) via ${editor.username}`);
            } else {
                embed.toJSON(); // validate it builds
                console.log(`  · would update ${guild_id} (${guildInfo.name || '?'}) via ${editor.username}`);
            }
            stats.updated++;
        } catch (e) {
            console.warn(`  ! ${guild_id}: build/patch failed: ${codeOf(e) || e.message}`);
            stats.error++;
        }
    }

    console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'} — ` +
        `updated:${stats.updated} deleted-skip:${stats.deleted} ` +
        `no-token:${stats.noToken} no-access:${stats.noAccess} errors:${stats.error}`);
    await pool.end();
    process.exit(0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
