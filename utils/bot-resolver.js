// Resolve which bot owns a guild, and get its credentials — from the database,
// never from a constant pinned in a script.
//
// Why this exists: scripts used to open with `const BOT_ID = '14099...'` next to a
// `GUILD_ID`. When a guild is handed to a different custom bot, `guild_bot_mapping`
// moves but the constant doesn't, and the script silently talks to Discord with a
// token that isn't in that guild — 403, or an unhandled rejection that hangs a
// top-level-await ESM script instead of erroring. Ask the database instead.
//
// Works in two worlds:
//   - inside the running bot: pass the shared pool as `db`
//   - in a one-off script:    pass nothing; a dedicated connection is opened and
//                             closed per call (the shared pool hangs in scripts)
//
//   import { resolveBotForGuild } from '../utils/bot-resolver.js';
//   const bot = await resolveBotForGuild(GUILD_ID);
//   const res = await bot.rest(`/guilds/${GUILD_ID}/channels`);
//
// Run scripts/audit-hardcoded-bot-ids.mjs to find pinned ids that have gone stale.

import mysql from 'mysql2/promise';

// encryption.js reads BOT_ENCRYPTION_KEY in its constructor and throws when it is
// missing. ESM hoists every import above the importing script's `dotenv.config()`,
// so importing it at the top here would blow up any script that loads its env in
// the module body — which is most of them. Load it on first use instead.
let encryptionPromise = null;
function getEncryption() {
    encryptionPromise ??= import('./encryption.js').then(m => m.default);
    return encryptionPromise;
}

/** The main CertiFried bot's application id, from the environment. */
export function getMainBotId() {
    return process.env.DISCORD_CLIENT_ID || null;
}

/** The main bot's token, from the environment. */
export function getMainBotToken() {
    return process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || null;
}

async function withDb(db, fn) {
    if (db) return fn(db);
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT || 3306,
    });
    try {
        return await fn(conn);
    } finally {
        await conn.end().catch(() => {});
    }
}

/**
 * The bot id mapped to a guild, or the main bot id when the guild has no custom
 * bot. Returns null only when there is no mapping AND no DISCORD_CLIENT_ID.
 */
export async function resolveBotIdForGuild(guildId, { db } = {}) {
    if (!guildId) throw new Error('resolveBotIdForGuild: guildId is required');
    return withDb(db, async (conn) => {
        const [[row]] = await conn.execute(
            'SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ?', [guildId]
        );
        return row?.bot_id || getMainBotId();
    });
}

/** Decrypted token for a bot id. Falls back to the main bot's env token. */
export async function getBotToken(botId, { db } = {}) {
    if (!botId) throw new Error('getBotToken: botId is required');
    if (botId === getMainBotId()) {
        const token = getMainBotToken();
        if (!token) throw new Error('getBotToken: main bot selected but DISCORD_TOKEN is not set');
        return token;
    }
    return withDb(db, async (conn) => {
        const [[row]] = await conn.execute(
            'SELECT bot_token FROM custom_bots WHERE bot_id = ?', [botId]
        );
        if (!row) throw new Error(`getBotToken: no custom_bots row for bot ${botId}`);
        const encryption = await getEncryption();
        return encryption.decrypt(JSON.parse(row.bot_token));
    });
}

/**
 * Everything a script needs to act in a guild as the bot that actually owns it:
 *   { guildId, botId, botName, isMain, token, auth, rest(path, init) }
 *
 * `rest()` calls the Discord API with the right token and throws a readable error
 * on a non-2xx, so a wrong-bot mistake surfaces immediately instead of hanging.
 */
export async function resolveBotForGuild(guildId, { db } = {}) {
    return withDb(db, async (conn) => {
        const botId = await resolveBotIdForGuild(guildId, { db: conn });
        if (!botId) {
            throw new Error(
                `resolveBotForGuild: guild ${guildId} has no guild_bot_mapping row and DISCORD_CLIENT_ID is unset`
            );
        }

        const [[row]] = await conn.execute(
            'SELECT bot_name FROM custom_bots WHERE bot_id = ?', [botId]
        );
        const isMain = botId === getMainBotId();
        const botName = row?.bot_name || (isMain ? 'CertiFried (main)' : botId);
        const token = await getBotToken(botId, { db: conn });
        const auth = `Bot ${token}`;

        async function rest(path, init = {}) {
            const res = await fetch(`https://discord.com/api/v10${path}`, {
                ...init,
                headers: {
                    Authorization: auth,
                    'Content-Type': 'application/json',
                    ...(init.headers || {}),
                },
            });
            if (!res.ok) {
                const body = await res.text().catch(() => '');
                throw new Error(`Discord ${init.method || 'GET'} ${path} -> ${res.status} ${body.slice(0, 400)}`);
            }
            return res.status === 204 ? null : res.json();
        }

        return { guildId, botId, botName, isMain, token, auth, rest };
    });
}

/**
 * Same, but fails loudly when the guild has no custom bot of its own. Use in
 * scripts that must not fall back to the main bot (which is usually not a member
 * of a custom-bot guild, and whose commands are hidden there anyway).
 */
export async function requireCustomBotForGuild(guildId, { db } = {}) {
    const bot = await resolveBotForGuild(guildId, { db });
    if (bot.isMain) {
        throw new Error(
            `requireCustomBotForGuild: guild ${guildId} has no custom bot in guild_bot_mapping — refusing to act as the main bot`
        );
    }
    return bot;
}

export default {
    getMainBotId,
    getMainBotToken,
    resolveBotIdForGuild,
    getBotToken,
    resolveBotForGuild,
    requireCustomBotForGuild,
};
