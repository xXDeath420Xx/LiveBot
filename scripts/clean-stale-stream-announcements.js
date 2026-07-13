/**
 * Clean stale stream announcements from ALL guilds across ALL bots.
 *
 * For each orphaned LIVE embed (not tracked in live_announcements):
 *   - edit_on_end=1 guilds → edit to "Stream has ended" (grey embed, VOD link if Twitch)
 *   - delete_on_end=1 & edit_on_end=0 guilds → delete the message
 *   - both 0 → skip (message should stay)
 *
 * Uses Discord REST API only (no gateway session = safe to run alongside PM2 bot).
 *
 * Usage:
 *   DRY_RUN=1 node scripts/clean-stale-stream-announcements.js   # preview only
 *   node scripts/clean-stale-stream-announcements.js              # execute
 */
import dotenv from 'dotenv';
dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import { getLatestVod } from '../utils/platforms/twitch.js';

const DRY_RUN = process.env.DRY_RUN === '1';
const API_BASE = 'https://discord.com/api/v10';
const RATE_LIMIT_MS = 500;

if (DRY_RUN) console.log('=== DRY RUN MODE — no changes will be made ===\n');

// ─── Helpers ─────────────────────────────────────────────

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function discordFetch(path, token, options = {}) {
    const url = `${API_BASE}${path}`;
    const res = await fetch(url, {
        ...options,
        headers: {
            'Authorization': `Bot ${token}`,
            'Content-Type': 'application/json',
            ...options.headers,
        },
    });
    if (res.status === 429) {
        const retry = res.headers.get('Retry-After');
        const waitMs = retry ? parseFloat(retry) * 1000 : 5000;
        console.log(`  Rate limited, waiting ${Math.ceil(waitMs)}ms...`);
        await sleep(waitMs);
        return discordFetch(path, token, options);
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Discord API ${res.status}: ${body}`);
    }
    if (res.status === 204) return null;
    return res.json();
}

async function fetchMessages(channelId, token) {
    return discordFetch(`/channels/${channelId}/messages?limit=100`, token);
}

async function deleteMessage(channelId, messageId, token) {
    await discordFetch(`/channels/${channelId}/messages/${messageId}`, token, { method: 'DELETE' });
}

async function editMessage(channelId, messageId, token, embed) {
    await discordFetch(`/channels/${channelId}/messages/${messageId}`, token, {
        method: 'PATCH',
        body: JSON.stringify({ embeds: [embed] }),
    });
}

async function fetchChannelWebhooks(channelId, token) {
    return discordFetch(`/channels/${channelId}/webhooks`, token);
}

async function editWebhookMessage(webhookId, webhookToken, messageId, embed) {
    // Webhook message edits use the webhook token, not the bot token
    const url = `${API_BASE}/webhooks/${webhookId}/${webhookToken}/messages/${messageId}`;
    const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
    });
    if (res.status === 429) {
        const retry = res.headers.get('Retry-After');
        await sleep(retry ? parseFloat(retry) * 1000 : 5000);
        return editWebhookMessage(webhookId, webhookToken, messageId, embed);
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Webhook edit ${res.status}: ${body}`);
    }
}

function buildStreamEndedEmbed(username, platform, existingEmbed, vod) {
    const platformName = platform.charAt(0).toUpperCase() + platform.slice(1);
    const channelUrl = existingEmbed?.url || undefined;

    const embed = {
        color: 0x808080,
        author: {
            name: `${username} was LIVE on ${platformName}`,
            url: channelUrl,
        },
        title: 'Stream has ended',
        timestamp: new Date().toISOString(),
    };

    if (channelUrl) embed.url = channelUrl;

    if (vod) {
        embed.description = `**[Watch the VOD](${vod.url})**\n${vod.title}`;
    } else {
        embed.description = 'This streamer does not have VODs enabled — sorry you missed the stream!';
    }

    return embed;
}

// ─── DB Queries ──────────────────────────────────────────

console.log('Querying announcement channels...');

// 1. Gather announcement channels from all sources (separate queries to avoid slow JOINs)
const [subChannels] = await pool.execute(
    'SELECT DISTINCT guild_id, announcement_channel_id FROM subscriptions WHERE announcement_channel_id IS NOT NULL'
);
const [guildChannels] = await pool.execute(
    'SELECT guild_id, announcement_channel_id FROM guilds WHERE announcement_channel_id IS NOT NULL'
);
const [gcChannels] = await pool.execute(
    'SELECT guild_id, announcement_channel_id FROM guild_config WHERE announcement_channel_id IS NOT NULL'
);
const [teamChannels] = await pool.execute(
    'SELECT NULL AS guild_id, announcement_channel_id FROM twitch_teams WHERE announcement_channel_id IS NOT NULL'
);

// Build guild_id → fallback announcement_channel_id maps
const guildFallback = Object.fromEntries(guildChannels.map(r => [r.guild_id, r.announcement_channel_id]));
const gcFallback = Object.fromEntries(gcChannels.map(r => [r.guild_id, r.announcement_channel_id]));

// Merge: subscription-level channel > guild_config > guilds table
const channelSet = new Set();
const channels = [];

function addChannel(guild_id, channel_id) {
    const key = `${guild_id}:${channel_id}`;
    if (!channelSet.has(key)) {
        channelSet.add(key);
        channels.push({ guild_id, channel_id: channel_id });
    }
}

// Subscription-level (with fallback to guild-level)
for (const row of subChannels) {
    addChannel(row.guild_id, row.announcement_channel_id);
}
// Guilds without per-sub overrides
for (const row of guildChannels) {
    addChannel(row.guild_id, row.announcement_channel_id);
}
// guild_config fallbacks
for (const row of gcChannels) {
    addChannel(row.guild_id, row.announcement_channel_id);
}
// Twitch teams
for (const row of teamChannels) {
    addChannel(row.guild_id, row.announcement_channel_id);
}

// Also add guild fallbacks for subscriptions that had no per-sub channel
const [subNoChannel] = await pool.execute(
    'SELECT DISTINCT guild_id FROM subscriptions WHERE announcement_channel_id IS NULL'
);
for (const row of subNoChannel) {
    const fallback = gcFallback[row.guild_id] || guildFallback[row.guild_id];
    if (fallback) addChannel(row.guild_id, fallback);
}

console.log(`Found ${channels.length} unique guild/channel pairs`);

// 2. Currently tracked live announcements (preserve these)
const [liveMessages] = await pool.execute('SELECT message_id FROM live_announcements');
const liveMessageIds = new Set(liveMessages.map(r => r.message_id));
console.log(`Preserving ${liveMessageIds.size} currently-live announcement messages`);

console.log('Querying subscription settings...');
// 3. Per-guild majority setting for edit_on_end / delete_on_end
const [subSettings] = await pool.execute(`
    SELECT guild_id,
           SUM(edit_on_end = 1) AS edit_count,
           SUM(delete_on_end = 1 AND edit_on_end = 0) AS delete_count,
           COUNT(*) AS total
    FROM subscriptions
    GROUP BY guild_id
`);
const guildBehavior = {};
for (const row of subSettings) {
    const editMajority = row.edit_count > row.total / 2;
    const deleteMajority = row.delete_count > row.total / 2;
    guildBehavior[row.guild_id] = {
        action: editMajority ? 'edit' : deleteMajority ? 'delete' : 'skip',
        editCount: Number(row.edit_count),
        deleteCount: Number(row.delete_count),
        total: Number(row.total),
    };
}

console.log(`Guild behaviors: ${Object.entries(guildBehavior).map(([g, b]) => `${g}=${b.action}`).join(', ')}`);

// 4. Per-guild webhook persona setting
const [guildRows] = await pool.execute('SELECT guild_id, use_webhook_persona FROM guilds');
const guildWebhookMode = Object.fromEntries(guildRows.map(r => [r.guild_id, r.use_webhook_persona === 1]));

// 5. Map guilds to their custom bot
const [mappings] = await pool.execute('SELECT guild_id, bot_id FROM guild_bot_mapping');
const guildBotMap = Object.fromEntries(mappings.map(r => [r.guild_id, r.bot_id]));

// 6. Group channels by bot_id
const botChannels = {};
for (const { guild_id, channel_id } of channels) {
    const botId = guildBotMap[guild_id] || 'main';
    if (!botChannels[botId]) botChannels[botId] = [];
    botChannels[botId].push({ guild_id, channel_id });
}

// 7. Get custom bot tokens and bot user IDs
const botIds = Object.keys(botChannels).filter(id => id !== 'main');
const botTokens = {};
const botUserIds = {};

if (botIds.length) {
    const [bots] = await pool.execute(
        `SELECT bot_id, bot_token FROM custom_bots WHERE bot_id IN (${botIds.map(() => '?').join(',')})`,
        botIds
    );
    for (const bot of bots) {
        botTokens[bot.bot_id] = encryption.decrypt(JSON.parse(bot.bot_token));
    }
}

if (botChannels['main']) {
    botTokens['main'] = process.env.DISCORD_TOKEN;
}

console.log(`Bot tokens loaded: ${Object.keys(botTokens).join(', ')}`);

// Resolve bot user IDs via /users/@me (needed to identify bot messages)
for (const [botId, token] of Object.entries(botTokens)) {
    try {
        const me = await discordFetch('/users/@me', token);
        botUserIds[botId] = me.id;
        console.log(`Bot ${botId}: ${me.username}#${me.discriminator} (${me.id})`);
    } catch (e) {
        console.log(`Bot ${botId}: failed to identify — ${e.message}`);
    }
}

// ─── Process Channels ────────────────────────────────────

let totalEdited = 0;
let totalDeleted = 0;
let totalSkipped = 0;
const vodCache = new Map();

for (const [botId, channelList] of Object.entries(botChannels)) {
    const token = botTokens[botId];
    const botUserId = botUserIds[botId];
    if (!token || !botUserId) {
        console.log(`\nSkipping bot ${botId} — no token or user ID`);
        continue;
    }

    // Deduplicate channels for this bot
    const seen = new Set();
    const uniqueChannels = channelList.filter(c => {
        if (seen.has(c.channel_id)) return false;
        seen.add(c.channel_id);
        return true;
    });

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Bot ${botId} (${botUserId}): processing ${uniqueChannels.length} channels`);

    // Pre-fetch webhook info per channel (for webhook-mode guilds)
    const channelWebhooks = {};

    for (const { guild_id, channel_id } of uniqueChannels) {
        const behavior = guildBehavior[guild_id] || { action: 'delete' }; // default delete_on_end=1 per migration 056
        const usesWebhook = guildWebhookMode[guild_id] || false;

        try {
            const messages = await fetchMessages(channel_id, token);
            if (!messages || !messages.length) {
                console.log(`  [${guild_id}] Channel ${channel_id}: empty`);
                continue;
            }

            let edited = 0, deleted = 0, skipped = 0;

            // If this guild uses webhooks and behavior is 'edit', we need webhook info
            let webhook = null;
            if (usesWebhook && behavior.action === 'edit') {
                if (!channelWebhooks[channel_id]) {
                    try {
                        const whs = await fetchChannelWebhooks(channel_id, token);
                        // Find our bot's webhook
                        channelWebhooks[channel_id] = whs.find(
                            wh => wh.user?.id === botUserId && wh.name?.startsWith('CertiFried MultiTool')
                        ) || null;
                    } catch (e) {
                        console.log(`  [${guild_id}] Could not fetch webhooks for ${channel_id}: ${e.message}`);
                        channelWebhooks[channel_id] = null;
                    }
                }
                webhook = channelWebhooks[channel_id];
            }

            for (const msg of messages) {
                const isFromBot = msg.author?.id === botUserId;
                const isWebhook = !!msg.webhook_id;
                if (!isFromBot && !isWebhook) continue;

                // Check embeds for LIVE announcement pattern
                const authorName = msg.embeds?.[0]?.author?.name || '';
                if (!authorName.includes('is LIVE on')) continue;

                // Skip "was LIVE on" (already ended)
                if (authorName.includes('was LIVE on')) continue;

                // Preserve currently-tracked live messages
                if (liveMessageIds.has(msg.id)) continue;

                // Extract username and platform from author name: "username is LIVE on Platform"
                const match = authorName.match(/^(.+?) is LIVE on (\w+)/);
                const username = match?.[1] || 'Unknown';
                const platform = match?.[2]?.toLowerCase() || 'unknown';

                if (behavior.action === 'edit') {
                    // Fetch VOD for Twitch (cached)
                    let vod = null;
                    if (platform === 'twitch') {
                        if (!vodCache.has(username)) {
                            try {
                                vodCache.set(username, await getLatestVod(username));
                            } catch {
                                vodCache.set(username, null);
                            }
                        }
                        vod = vodCache.get(username);
                    }

                    const embed = buildStreamEndedEmbed(username, platform, msg.embeds[0], vod);

                    if (DRY_RUN) {
                        console.log(`  [${guild_id}] WOULD EDIT ${msg.id}: ${username} on ${platform}${vod ? ' (with VOD)' : ''}`);
                    } else {
                        try {
                            if (isWebhook && webhook?.token) {
                                await editWebhookMessage(webhook.id, webhook.token, msg.id, embed);
                            } else {
                                await editMessage(channel_id, msg.id, token, embed);
                            }
                            console.log(`  [${guild_id}] EDITED ${msg.id}: ${username} on ${platform}${vod ? ' (with VOD)' : ''}`);
                        } catch (e) {
                            console.log(`  [${guild_id}] Failed to edit ${msg.id}: ${e.message}`);
                        }
                        await sleep(RATE_LIMIT_MS);
                    }
                    edited++;
                } else if (behavior.action === 'delete') {
                    if (DRY_RUN) {
                        console.log(`  [${guild_id}] WOULD DELETE ${msg.id}: ${username} on ${platform}`);
                    } else {
                        try {
                            await deleteMessage(channel_id, msg.id, token);
                            console.log(`  [${guild_id}] DELETED ${msg.id}: ${username} on ${platform}`);
                        } catch (e) {
                            console.log(`  [${guild_id}] Failed to delete ${msg.id}: ${e.message}`);
                        }
                        await sleep(RATE_LIMIT_MS);
                    }
                    deleted++;
                } else {
                    skipped++;
                }
            }

            const action = DRY_RUN ? 'would' : '';
            console.log(`  [${guild_id}] Channel ${channel_id}: ${action} edited=${edited} deleted=${deleted} skipped=${skipped} (behavior=${behavior.action})`);
            totalEdited += edited;
            totalDeleted += deleted;
            totalSkipped += skipped;
        } catch (e) {
            console.log(`  [${guild_id}] Channel ${channel_id} error: ${e.message}`);
        }
    }
}

// ─── Summary ─────────────────────────────────────────────

console.log(`\n${'═'.repeat(60)}`);
console.log(`${DRY_RUN ? 'DRY RUN' : 'DONE'}`);
console.log(`  Edited:  ${totalEdited}`);
console.log(`  Deleted: ${totalDeleted}`);
console.log(`  Skipped: ${totalSkipped}`);
console.log(`  Live announcements preserved: ${liveMessageIds.size}`);
console.log(`${'═'.repeat(60)}`);

await pool.end();
