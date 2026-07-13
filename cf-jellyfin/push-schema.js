// One-off: push the current /jellyfin per-guild schema to every enabled guild.
// Uses the per-guild custom bot (looked up via guild_bot_mapping → custom_bots)
// when one is assigned; otherwise uses the default CertiFriedUtility token.
//
//   node push-schema.js
//
// Reads DISCORD_TOKEN + DISCORD_CLIENT_ID + BOT_ENCRYPTION_KEY from ../.env.

import { config } from 'dotenv';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '..', '.env') });

const DEFAULT_TOKEN = process.env.DISCORD_TOKEN;
const DEFAULT_APP_ID = process.env.DISCORD_CLIENT_ID || '1409904443125665875';
if (!DEFAULT_TOKEN) { console.error('DISCORD_TOKEN missing'); process.exit(1); }

const JELLYFIN_CMD = {
    name: 'jellyfin',
    description: 'CertiFried Movie Theatre',
    dm_permission: false,
    options: [
        { type: 1, name: 'link', description: 'Get a link to create or manage your Movie Theatre account' },
        { type: 1, name: 'status', description: 'Check the status of your Movie Theatre account' },
        { type: 1, name: 'reset-password', description: 'Generate a new password for your Movie Theatre account' },
        {
            type: 1, name: 'request', description: 'Request a movie or TV show for the Movie Theatre',
            options: [
                { type: 3, name: 'title', description: 'Title of the movie or show', required: true, min_length: 2, max_length: 200 },
                { type: 3, name: 'type', description: 'Movie or TV series', required: true, choices: [
                    { name: 'Movie', value: 'movie' }, { name: 'TV Series', value: 'tv' }
                ] },
                { type: 4, name: 'year', description: 'Release year (helps disambiguate)', min_value: 1900, max_value: 2100 },
                { type: 3, name: 'quality', description: 'Preferred quality (default 1080p)', choices: [
                    { name: '720p', value: '720p' }, { name: '1080p', value: '1080p' }, { name: '2160p (4K)', value: '2160p' }
                ] }
            ]
        },
        { type: 1, name: 'requests', description: 'Check the status of your recent Movie Theatre requests' },
        { type: 1, name: 'disable', description: '(Admin) Turn OFF Jellyfin features in this server' },
        {
            type: 1, name: 'config', description: '(Admin) Configure Jellyfin notification channels',
            options: [
                { type: 7, name: 'new-media',   description: 'Channel for new-media announcements', channel_types: [0, 5] },
                { type: 7, name: 'now-playing', description: 'Channel for now-playing posts',       channel_types: [0]    },
                { type: 7, name: 'audit',       description: 'Channel for audit logs',              channel_types: [0]    }
            ]
        }
    ]
};

const sdb = new Database(join(__dirname, 'guild-config.db'), { readonly: true });
const enabledGuilds = sdb.prepare('SELECT guild_id FROM guild_jellyfin_settings WHERE enabled = 1').all();
sdb.close();
console.log(`Pushing /jellyfin schema to ${enabledGuilds.length} enabled guild(s)\n`);

// Resolve which {token, appId, label} to use for each guild
async function resolveBotForGuild(guildId) {
    const [mapRows] = await pool.execute('SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ?', [guildId]);
    if (mapRows.length === 0) {
        return { token: DEFAULT_TOKEN, appId: DEFAULT_APP_ID, label: 'default' };
    }
    const customBotId = mapRows[0].bot_id;
    const [botRows] = await pool.execute(
        'SELECT bot_id, bot_name, bot_token, client_id, enabled, approved FROM custom_bots WHERE bot_id = ?',
        [customBotId]
    );
    if (botRows.length === 0) return { error: `custom bot ${customBotId} not found in custom_bots` };
    const b = botRows[0];
    if (!b.enabled || !b.approved) return { error: `custom bot ${b.bot_name} not enabled/approved` };
    let token;
    try { token = encryption.decrypt(JSON.parse(b.bot_token)); }
    catch (e) { return { error: `decrypt failed: ${e.message}` }; }
    return { token, appId: b.client_id || b.bot_id, label: b.bot_name };
}

async function upsertCommand({ token, appId }, guildId) {
    const headers = { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' };
    const existingResp = await fetch(`https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`, { headers });
    if (!existingResp.ok) return { ok: false, error: `fetch ${existingResp.status}` };
    const existing = await existingResp.json();
    const ours = existing.find(c => c.name === 'jellyfin');
    const url = ours
        ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands/${ours.id}`
        : `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`;
    const method = ours ? 'PATCH' : 'POST';
    const resp = await fetch(url, { method, headers, body: JSON.stringify(JELLYFIN_CMD) });
    if (!resp.ok) {
        const text = await resp.text();
        return { ok: false, error: `${method} ${resp.status}: ${text.substring(0, 200)}` };
    }
    return { ok: true, method };
}

(async () => {
    for (const { guild_id } of enabledGuilds) {
        const bot = await resolveBotForGuild(guild_id);
        if (bot.error) { console.log(`  ✗ ${guild_id}  resolve: ${bot.error}`); continue; }
        const r = await upsertCommand(bot, guild_id);
        if (r.ok) console.log(`  ✓ ${guild_id}  via ${bot.label}  (${r.method})`);
        else      console.log(`  ✗ ${guild_id}  via ${bot.label}  ${r.error}`);
    }
    await pool.end();
})();
