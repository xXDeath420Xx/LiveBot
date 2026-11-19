import logger from '../utils/logger.js';
import db from '../utils/db.js';
import { EmbedBuilder, WebhookClient, MessageFlags } from 'discord.js';
import { safeJsonArray } from '../utils/safeJson.js';
import configCache from '../utils/configCache.js';
import { getMessageById, markMessagesDeleted } from '../utils/message-cache.js';
import { themeColor } from './guild-theme.js';
import { recordBotMessage } from './bot-messages.js';
import { optInAllowed } from './log-actions.js';
import { isMessageLoggingOptedOut } from './privacy-settings.js';
import { preserveDeletedAttachments, describeAttachments, getEvidenceConfig } from './evidence-capture.js';
import { embedToContainer } from '../utils/log-v2-wrap.js';

/**
 * Resolve whether a guild wants its modlog rendered as Components V2.
 * Soft-fails to the default (legacy embeds) if the column is missing — the
 * migration adding it is 359 and this cache stops a hot modlog path hitting
 * the DB on every log send.
 */
const _modlogV2Cache = new Map();  // guildId -> { on: boolean, expiresAt: number }
async function usesModlogV2(guildId) {
    if (!guildId) return false;
    const cached = _modlogV2Cache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) return cached.on;
    let on = false;
    try {
        const [rows] = await db.execute(
            'SELECT modlog_components_v2 FROM guild_config WHERE guild_id = ? LIMIT 1',
            [guildId]
        );
        on = !!rows?.[0]?.modlog_components_v2;
    } catch { /* column/table missing — fall through as off */ }
    _modlogV2Cache.set(guildId, { on, expiresAt: Date.now() + 60_000 });
    if (_modlogV2Cache.size > 2000) _modlogV2Cache.clear();  // crude bound
    return on;
}
export function _invalidateModlogV2Cache(guildId) { _modlogV2Cache.delete(guildId); }
import {
    fetchJoinSource, bypassedApplication, requiresApplication, findApprovalForJoin, claimForPosting,
    decidedByText, answerFields,
} from './join-request-tracker.js';
import { riskFieldForJoin } from './member-insight.js';

// ===========================
// HELPER FUNCTIONS
// ===========================

/**
 * Get webhook client for a channel, checking for custom webhook URL first
 */
async function getLogWebhookClient(client, channelId) {
    try {
        // Check for custom webhook URL from channel_settings
        const [rows] = await db.execute(
            'SELECT webhook_url FROM channel_settings WHERE channel_id = ?',
            [channelId]
        );

        if (rows && rows.length > 0 && rows[0].webhook_url) {
            logger.info(`[Log Webhook] Using custom webhook for channel ${channelId}`);
            return new WebhookClient({ url: rows[0].webhook_url });
        }

        // Fallback: return null to use regular channel.send()
        return null;
    } catch (error) {
        logger.error('[Log Webhook] Error fetching webhook', { channelId, error: error.message });
        return null;
    }
}

/**
 * Send a log embed to the configured Discord channel
 */
/**
 * Where (and whether) a log event of this type goes for a guild: logging_config (master switch,
 * enabled_events, default channel) then log_event_config (per-event switch, channel override).
 * Returns null when the event is not logged.
 *
 * log_event_config.embed_color (legacy, one colour per category) is deliberately NOT read: applying it
 * painted every action in a category the same (voice join/leave/move all yellow). Colours are per action
 * now — log_action_colors, applied in sendLogEmbed.
 * @returns {Promise<null | { channelId: string }>}
 */
async function resolveLogTarget(guildId, eventType) {
    // Get logging configuration for this guild
    const [configRows] = await db.execute(
        'SELECT log_channel_id, enabled_events, enabled, events_saved_at FROM logging_config WHERE guild_id = ?',
        [guildId]
    );

    if (!configRows || configRows.length === 0) {
        logger.debug(`[sendLogEmbed] No logging config found for guild ${guildId}`);
        return null;
    }

    const config = configRows[0];

    // Check if logging is globally disabled for this guild
    if (config.enabled === 0) {
        logger.debug(`[sendLogEmbed] Logging disabled for guild ${guildId}`);
        return null;
    }

    const enabledEvents = safeJsonArray(config.enabled_events, 'logging enabled_events');

    // Check if this event type is enabled (null/empty = all events allowed, defer to log_event_config)
    if (enabledEvents.length > 0 && !enabledEvents.includes(eventType)) {
        logger.debug(`[sendLogEmbed] Event type '${eventType}' not enabled for guild ${guildId}. Enabled: ${enabledEvents.join(', ')}`);
        return null;
    }

    // Categories wired on 2026-10-06 need an explicit tick saved since then (core/log-actions.js OPT_IN_CATEGORIES).
    if (!optInAllowed(eventType, enabledEvents, config.events_saved_at)) {
        logger.debug(`[sendLogEmbed] Opt-in event '${eventType}' not switched on since it was wired, guild ${guildId}`);
        return null;
    }

    logger.debug(`[sendLogEmbed] Event type '${eventType}' is enabled for guild ${guildId}`);

    // Check for category-specific channel override
    const [eventConfigRows] = await db.execute(
        'SELECT log_channel_id, enabled FROM log_event_config WHERE guild_id = ? AND event_type = ?',
        [guildId, eventType]
    );

    let targetChannelId = config.log_channel_id;

    if (eventConfigRows && eventConfigRows.length > 0) {
        const eventConfig = eventConfigRows[0];

        // If event is explicitly disabled in log_event_config, don't log
        if (eventConfig.enabled === 0) {
            logger.debug(`[sendLogEmbed] Event '${eventType}' explicitly disabled in log_event_config for guild ${guildId}`);
            return null;
        }

        // Use category override channel if set
        if (eventConfig.log_channel_id) {
            targetChannelId = eventConfig.log_channel_id;
            logger.debug(`[sendLogEmbed] Using override channel ${targetChannelId} for event ${eventType}`);
        }
    }

    if (!targetChannelId) {
        logger.debug(`[sendLogEmbed] No target channel configured for guild ${guildId}, event ${eventType}`);
        return null;
    }

    return { channelId: targetChannelId };
}

// Colours a server picked per log action on the Logging page (core/log-actions.js), cached briefly per guild.
// The dashboard runs in this process and drops a guild's entry when it saves.
const ACTION_COLOR_TTL_MS = 60_000;
// The same cache holds the actions the server switched off (log_action_disabled, migration 413).
const actionColorCache = new Map(); // guildId -> { at, colors: Map<action, '#RRGGBB'>, disabled: Set<action> }

async function actionSettings(guildId) {
    let entry = actionColorCache.get(guildId);
    if (!entry || Date.now() - entry.at > ACTION_COLOR_TTL_MS) {
        let colors = new Map();
        let disabled = new Set();
        try {
            const [rows] = await db.execute('SELECT action, color FROM log_action_colors WHERE guild_id = ?', [guildId]);
            colors = new Map(rows.map(r => [r.action, r.color]));
        } catch (error) {
            logger.debug(`[sendLogEmbed] Log action colours unavailable for guild ${guildId}: ${error.message}`);
        }
        try {
            const [rows] = await db.execute('SELECT action FROM log_action_disabled WHERE guild_id = ?', [guildId]);
            disabled = new Set(rows.map(r => r.action));
        } catch (error) {
            logger.debug(`[sendLogEmbed] Switched-off log actions unavailable for guild ${guildId}: ${error.message}`);
        }
        entry = { at: Date.now(), colors, disabled };
        actionColorCache.set(guildId, entry);
    }
    return entry;
}

async function customActionColor(guildId, action) {
    return (await actionSettings(guildId)).colors.get(action) || null;
}

async function isLogActionDisabled(guildId, action) {
    return (await actionSettings(guildId)).disabled.has(action);
}

function invalidateLogActionColors(guildId) {
    actionColorCache.delete(guildId);
}

/**
 * The Logging page's ignore lists (logging_config.ignored_channels / ignored_roles / ignore_bots,
 * migration 420). They apply only to what members do in channels — the categories below — and only
 * when the caller names the subject (sendLogEmbed's 5th argument). Moderation, security and server
 * logs are never hidden by them: ignoring a channel must not hide a ban.
 */
const IGNORABLE_LOG_EVENTS = new Set([
    'messageDelete', 'messageUpdate', 'channelPinsUpdate',
    'reactionAdd', 'reactionRemove', 'reactionRemoveAll', 'reactionRemoveEmoji',
    'pollVoteAdd', 'pollVoteRemove',
    'memberUpdate',
    'voiceUpdate', 'voiceStream', 'voiceVideo', 'voiceSelfMute',
    'commandUsage',
]);

const NO_LOG_IGNORES = Object.freeze({ channels: new Set(), roles: new Set(), bots: false, any: false });

/** A guild's ignore lists, cached through utils/configCache.js (dropped when the dashboard saves). */
async function logIgnoreFilters(guildId) {
    try {
        return await configCache.get('logging_ignores', guildId, async () => {
            const [rows] = await db.execute(
                'SELECT ignored_channels, ignored_roles, ignore_bots FROM logging_config WHERE guild_id = ?', [guildId]);
            const row = rows?.[0];
            if (!row) return NO_LOG_IGNORES;
            const channels = new Set(safeJsonArray(row.ignored_channels, 'logging ignored_channels').map(String));
            const roles = new Set(safeJsonArray(row.ignored_roles, 'logging ignored_roles').map(String));
            const bots = !!row.ignore_bots;
            return { channels, roles, bots, any: bots || channels.size > 0 || roles.size > 0 };
        });
    } catch (error) {
        // Columns missing (migration 420 not applied) or the DB is unreachable: log as before.
        logger.debug(`[sendLogEmbed] Log ignore lists unavailable for guild ${guildId}: ${error.message}`);
        return NO_LOG_IGNORES;
    }
}

/**
 * Whether a log about this subject is hidden by the guild's ignore lists.
 * @param {import('discord.js').Guild} guild
 * @param {string} eventType  the log category
 * @param {{ channel?: any, channelId?: string, channels?: Array<any>, member?: any, user?: any, userId?: string, bot?: boolean }} subject
 *        channel(s): where it happened (a thread or channel also matches through its parent channel and category);
 *        member / user / userId: who did it.
 */
async function isLogSubjectIgnored(guild, eventType, subject) {
    if (!guild?.id || !subject || !IGNORABLE_LOG_EVENTS.has(eventType)) return false;
    const filters = await logIgnoreFilters(guild.id);
    if (!filters.any) return false;

    if (filters.channels.size) {
        const places = [subject.channel, subject.channelId, ...(Array.isArray(subject.channels) ? subject.channels : [])];
        for (const place of places) {
            if (!place) continue;
            const channel = typeof place === 'string' ? guild.channels?.cache?.get(place) : place;
            const ids = [typeof place === 'string' ? place : place.id, channel?.parentId, channel?.parent?.parentId];
            if (ids.some(id => id && filters.channels.has(String(id)))) return true;
        }
    }

    const userId = subject.userId ?? subject.member?.id ?? subject.user?.id ?? null;
    const member = subject.member?.roles?.cache ? subject.member : (userId ? guild.members?.cache?.get(userId) : null);
    const user = subject.user ?? member?.user ?? (userId ? guild.client?.users?.cache?.get(userId) : null);
    if (filters.bots && (subject.bot === true || user?.bot)) return true;
    if (filters.roles.size && member?.roles?.cache?.some(role => filters.roles.has(role.id))) return true;
    return false;
}

/**
 * @param action  the log's action key in core/log-actions.js. A category with one action uses the category
 *                key (the default); one with several (voiceUpdate: join / leave / move) passes its own.
 * @param subject where it happened and who did it, for the Logging page's ignore lists (isLogSubjectIgnored).
 *                Omit it for logs those lists must never hide.
 */
async function sendLogEmbed(guild, eventType, embed, action = eventType, subject = null) {
    try {
        // Never log emoji / sticker / soundboard changes — the owner does not
        // want these categories logged in any guild.
        if (/^(emoji|sticker|soundboard)/i.test(eventType || '')) return;

        // The Logging page's ignored channels, roles and bots (see isLogSubjectIgnored).
        if (subject && await isLogSubjectIgnored(guild, eventType, subject)) {
            logger.debug(`[sendLogEmbed] '${eventType}' skipped by the ignore lists for guild ${guild.id}`);
            return;
        }

        // This one action switched off on the Logging page (its category can still be on).
        if (await isLogActionDisabled(guild.id, action)) {
            logger.debug(`[sendLogEmbed] Action '${action}' switched off for guild ${guild.id}`);
            return;
        }

        const target = await resolveLogTarget(guild.id, eventType);
        if (!target) return;
        const targetChannelId = target.channelId;

        // A colour the server chose for this action; otherwise the embed keeps the colour its action gave it.
        const customColor = await customActionColor(guild.id, action);
        if (customColor) embed.setColor(customColor);

        logger.debug(`[sendLogEmbed] Attempting to send ${eventType} log to channel ${targetChannelId} for guild ${guild.id}`);

        // Build the payload once. Guilds opted into Components V2 receive the
        // container form; everyone else gets the legacy embed. Both payload
        // shapes are accepted by both webhook.send and channel.send.
        const v2 = await usesModlogV2(guild.id);
        const payload = v2
            ? { components: [embedToContainer(embed)], flags: MessageFlags.IsComponentsV2 }
            : { embeds: [embed] };

        // Try to use webhook first (respects custom webhooks from dashboard)
        const webhookClient = await getLogWebhookClient(guild.client, targetChannelId);

        if (webhookClient) {
            try {
                const posted = await webhookClient.send(payload);
                recordBotMessage({
                    guildId: guild.id, channelId: targetChannelId,
                    messageId: posted?.id || null, templateKey: action, feature: 'log',
                });
                logger.debug(`[sendLogEmbed] Sent via webhook to channel ${targetChannelId}`);
                return;
            } catch (webhookError) {
                logger.warn('[sendLogEmbed] Webhook send failed, falling back to channel.send()', {
                    error: webhookError.message
                });
            }
        }

        // Fallback: Send via regular channel
        const logChannel = await guild.channels.fetch(targetChannelId).catch((err) => {
            logger.warn(`[sendLogEmbed] Failed to fetch channel ${targetChannelId}:`, err.message);
            return null;
        });

        if (!logChannel || !logChannel.isTextBased()) {
            logger.warn(`[sendLogEmbed] Channel ${targetChannelId} not found or not text-based for guild ${guild.id}`);
            return;
        }

        const sent = await logChannel.send(payload);
        recordBotMessage({
            guildId: guild.id, channelId: targetChannelId,
            messageId: sent?.id || null, templateKey: action, feature: 'log',
        });
        logger.debug(`[sendLogEmbed] Successfully sent via channel.send() to channel ${targetChannelId}`);
    } catch (error) {
        logger.error('[sendLogEmbed] Error sending log embed', {
            guildId: guild.id,
            eventType,
            error: error.message
        });
    }
}

async function saveAuditLog(
    guildId,
    eventType,
    userId,
    targetId,
    moderatorId,
    channelId,
    action,
    reason,
    oldValue,
    newValue,
    metadata = {}
) {
    try {
        await db.execute(
            `INSERT INTO audit_logs (guild_id, event_type, user_id, target_id, moderator_id, channel_id, action, reason, old_value, new_value, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [guildId, eventType, userId || null, targetId || null, moderatorId || null, channelId || null,
             action, reason || null, oldValue || null, newValue || null, JSON.stringify(metadata)]
        );
    } catch (error) {
        logger.error(`[AUDIT LOG] Failed to save audit log: ${error.message}`, { guildId, eventType, error: error.message });
    }
}

// ===========================
// EXISTING LOG FUNCTIONS
// ===========================

async function logMessageDelete(message) {
    if (!message.guild) return;

    // Skip bot messages if we have author info
    if (message.author && message.author.bot) return;

    const guildId = message.guild.id;
    const channelId = message.channel.id;
    const messageId = message.id;

    let content;
    let authorInfo;
    let authorDisplay;
    let authorId = message.author?.id ?? null;
    let authorTag = message.author?.tag ?? null;
    let cached = null;

    if (message.author) {
        // Discord.js in-memory cache hit — message was seen by this session
        content = message.content ?? 'No text content';
        authorInfo = `${message.author.tag} (${message.author.id})`;
        authorDisplay = message.author;
    } else {
        // Partial message — Discord.js didn't have it cached (bot restarted since it was sent)
        // Fall back to our DB message cache
        cached = await getMessageById(messageId);
        if (cached) {
            // Skip bot messages from DB cache too
            if (cached.author_id === message.client.user?.id) return;

            content = cached.content ?? 'No text content';
            authorInfo = `${cached.author_tag} (${cached.author_id})`;
            authorDisplay = cached.author_tag;
            authorId = cached.author_id;
            authorTag = cached.author_tag;
        } else {
            content = 'Content unavailable (sent before bot restart)';
            authorInfo = 'Unknown (sent before bot restart)';
            authorDisplay = 'Unknown';
        }
    }

    // /privacy opt-out message-logging: the bot keeps no copy of this member's messages (so the
    // DB fallback above never has one) and writes no content to its own log files or evidence
    // channel. The server's log embed still shows what discord.js held in memory.
    const optedOut = authorId ? await isMessageLoggingOptedOut(authorId) : false;

    const botIdentifier = message.client.isDefaultBot
        ? 'Default Bot'
        : `Custom Bot ${message.client.botId}`;

    const loggedContent = optedOut ? '[withheld: author opted out of message logging]' : content;
    logger.info(`[${botIdentifier}] Message deleted in #${message.channel?.name || channelId}${message.author ? ` by ${message.author.tag}` : ''}: ${loggedContent}`, {
        guildId,
        channelId,
        userId: authorId,
        messageId,
        content: loggedContent,
        botId: message.client.botId || 'default',
        category: 'messageDelete'
    });

    // Attachments: what discord.js held, else the URLs we cached. With deleted-image evidence on,
    // images are re-hosted so the links below keep working after Discord removes the originals.
    const liveAttachments = message.attachments?.size ? message.attachments : null;
    const logSubject = { channel: message.channel, member: message.member, userId: authorId };
    const ignored = await isLogSubjectIgnored(message.guild, 'messageDelete', logSubject);
    let evidence = null;
    if (!optedOut && !ignored && (await getEvidenceConfig(guildId)).enabled) {
        const target = await resolveLogTarget(guildId, 'messageDelete').catch((error) => {
            logger.error('[logMessageDelete] Could not resolve the delete-log channel', { guildId, error: error.message });
            return null;
        });
        evidence = await preserveDeletedAttachments({
            guild: message.guild,
            sourceChannelId: channelId,
            messageId,
            authorId,
            authorTag,
            liveAttachments,
            logRow: cached,
            fallbackChannelId: target?.channelId || null,
        }).catch((error) => {
            logger.error('[logMessageDelete] Evidence capture failed', { guildId, messageId, error: error.message });
            return null;
        });
    }
    const fallbackAttachments = liveAttachments
        ? [...liveAttachments.values()].map(a => ({ name: a.name, url: a.url }))
        : (optedOut ? [] : cachedAttachmentList(cached));

    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'danger'))
        .setTitle('💬 Message Deleted')
        .setDescription(`Message${message.author ? ` by ${authorDisplay}` : ''} was deleted in ${message.channel}`)
        .addFields(
            { name: 'Author', value: authorInfo, inline: true },
            { name: 'Channel', value: `${message.channel.name}`, inline: true },
            { name: 'Message ID', value: messageId, inline: true },
            { name: 'Content', value: (content || 'No text content').substring(0, 1024), inline: false }
        )
        .setTimestamp();

    const attachmentText = describeAttachments(evidence, fallbackAttachments);
    if (attachmentText) {
        embed.addFields({ name: 'Attachments', value: attachmentText, inline: false });
    }
    const firstImage = evidence?.items?.find(i => i.status === 'rehosted' && i.storedUrl);
    if (firstImage) embed.setImage(firstImage.storedUrl);
    if (optedOut) embed.setFooter({ text: 'Author has opted out of message logging — nothing from this message was stored by the bot.' });

    if (!ignored) await sendLogEmbed(message.guild, 'messageDelete', embed, 'messageDelete', logSubject);

    // The cached copy (if any) is now evidence of a deleted message rather than plain cache.
    await markMessagesDeleted([messageId], 'DELETE');
}

/** Attachment names/URLs from a message_logs row (JSON array of URLs). */
function cachedAttachmentList(row) {
    if (!row?.attachment_urls) return [];
    try {
        const urls = JSON.parse(row.attachment_urls);
        if (!Array.isArray(urls)) return [];
        return urls.filter(u => typeof u === 'string').map(url => {
            let name = 'attachment';
            try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || name); } catch { /* keep default */ }
            return { name, url };
        });
    } catch {
        return [];
    }
}

/**
 * Log an automatic moderation action (spam filter, pattern match, heat threshold).
 *
 * The automod paths used to punish silently — they deleted messages and applied
 * timeouts but only ever wrote to Winston, so a guild watching its log channels saw
 * nothing while members were being muted. Routed through sendLogEmbed so the guild's
 * normal logging_config / log_event_config wiring applies.
 *
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').User} user - the member acted on
 * @param {string} action - 'Delete' | 'Warn' | 'Mute' | 'Kick' | 'Ban'
 * @param {string} reason - human-readable trigger description
 * @param {Object} [details] - optional extra fields
 * @param {number} [details.durationMinutes] - timeout length, if any
 * @param {string} [details.source] - which subsystem acted, e.g. 'Anti-Spam Filter'
 * @param {import('discord.js').GuildChannel} [details.channel] - where it happened
 */
async function logAutomodAction(guild, user, action, reason, details = {}) {
    if (!guild || !user) return;

    const severity = (action === 'Kick' || action === 'Ban') ? 'danger'
        : (action === 'Mute') ? 'warning'
        : 'primary';

    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, severity))
        .setTitle(`🤖 Automod: ${action}`)
        .addFields(
            { name: 'User', value: `${user.tag ?? user.username} (${user.id})`, inline: true },
            { name: 'Action', value: action, inline: true }
        )
        .setTimestamp();

    if (details.source) embed.addFields({ name: 'Triggered By', value: details.source, inline: true });
    if (details.channel) embed.addFields({ name: 'Channel', value: `${details.channel}`, inline: true });
    if (details.durationMinutes) {
        embed.addFields({ name: 'Duration', value: `${details.durationMinutes} minute(s)`, inline: true });
    }
    embed.addFields({ name: 'Reason', value: String(reason || 'No reason provided').substring(0, 1024) });

    // The Logging page's toggle for this is "automodAction"; only a couple of older configs
    // carry "automod". Posting under "automod" alone dropped every bot automod action — mutes
    // included — for guilds that had ticked the toggle, leaving a bare "Member Timed Out" with no why.
    if (await resolveLogTarget(guild.id, 'automod').catch(() => null)) {
        await sendLogEmbed(guild, 'automod', embed,
            severity === 'danger' ? 'automod.removed' : severity === 'warning' ? 'automod.muted' : 'automod.other');
    } else {
        await sendLogEmbed(guild, 'automodAction', embed,
            severity === 'danger' ? 'automod.removed' : severity === 'warning' ? 'automod.muted' : 'automod.other');
    }
}

// A real edit's gateway event lands within milliseconds. Anything claiming to be
// older than this is Discord replaying a long-settled state, not a live edit.
const EDIT_FRESHNESS_MS = 5 * 60 * 1000;

async function logMessageUpdate(oldMessage, newMessage) {
    if (!newMessage.guild) return;

    if (newMessage.author && newMessage.author.bot) return;

    // Skip if we don't have author information (partial message)
    if (!newMessage.author) return;

    // Discord fires MESSAGE_UPDATE for plenty of things a human never touched:
    // link embeds finishing their unfurl, pins, flag changes, and — the big one —
    // re-signing attachment CDN URLs on old posts, which our own message-cache seed
    // provokes every startup by fetching message history. None of those are edits,
    // and only a genuine user edit sets edited_timestamp.
    if (!newMessage.editedTimestamp) return;

    // An edited_timestamp from months ago rode in on one of those re-broadcasts —
    // the message was edited once, long ago, and Discord is just restating it.
    if (Date.now() - newMessage.editedTimestamp > EDIT_FRESHNESS_MS) return;

    const guildId = newMessage.guild.id;
    const channelId = newMessage.channel.id;
    const userId = newMessage.author.id;
    const messageId = newMessage.id;
    const newContent = newMessage.content;

    // oldMessage is a clone of whatever discord.js had cached. For a message posted
    // before this process started there is no cached copy, so its content is null —
    // which is not the same as "the message was empty". Fall back to our own
    // message_logs copy (messageUpdate.js only overwrites it after we run).
    const optedOut = await isMessageLoggingOptedOut(userId);

    let oldContent = oldMessage && !oldMessage.partial ? oldMessage.content : null;
    if ((oldContent === null || oldContent === undefined) && !optedOut) {
        const cached = await getMessageById(messageId);
        oldContent = cached ? cached.content : null;
    }

    // Content genuinely unchanged — an attachment or embed changed, not the text.
    if (oldContent !== null && oldContent === newContent) return;

    const botIdentifier = newMessage.client.isDefaultBot
        ? 'Default Bot'
        : `Custom Bot ${newMessage.client.botId}`;

    // Opted-out authors' text stays out of the bot's own log files.
    const withheld = '[withheld: author opted out of message logging]';
    const loggedOld = optedOut ? withheld : oldContent;
    const loggedNew = optedOut ? withheld : newContent;
    logger.info(`[${botIdentifier}] Message edited in #${newMessage.channel.toString()} by ${newMessage.author.tag}. Old: "${loggedOld}" New: "${loggedNew}"`, {
        guildId,
        channelId,
        userId,
        messageId,
        oldContent: loggedOld,
        newContent: loggedNew,
        botId: newMessage.client.botId || 'default',
        category: 'messageUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('✏️ Message Edited')
        .setDescription(`Message by ${newMessage.author} was edited in ${newMessage.channel}`)
        .addFields(
            { name: 'Author', value: `${newMessage.author.tag} (${newMessage.author.id})`, inline: true },
            { name: 'Channel', value: `${newMessage.channel.name}`, inline: true },
            { name: 'Before', value: oldContent === null ? (optedOut ? '*Not stored — author opted out of message logging*' : '*Not cached*') : (oldContent ? oldContent.substring(0, 1024) : 'No content'), inline: false },
            { name: 'After', value: newContent ? newContent.substring(0, 1024) : 'No content', inline: false }
        )
        .setTimestamp();

    await sendLogEmbed(newMessage.guild, 'messageUpdate', embed, 'messageUpdate',
        { channel: newMessage.channel, member: newMessage.member, user: newMessage.author });
}

async function logMemberUpdate(oldMember, newMember) {
    if (oldMember.partial || newMember.partial) return;

    const guildId = newMember.guild.id;
    const userId = newMember.id;

    if (oldMember.nickname !== newMember.nickname) {
        logger.info(`Member ${newMember.user.tag} nickname changed from "${oldMember.nickname || 'None'}" to "${newMember.nickname || 'None'}".`, {
            guildId,
            userId,
            oldNickname: oldMember.nickname,
            newNickname: newMember.nickname,
            category: 'memberUpdate'
        });

        const embed = new EmbedBuilder()
            .setColor(themeColor(guildId, 'primary'))
            .setTitle('👤 Nickname Changed')
            .setDescription(`${newMember} updated their nickname`)
            .addFields(
                { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: false },
                { name: 'Before', value: oldMember.nickname || 'None', inline: true },
                { name: 'After', value: newMember.nickname || 'None', inline: true }
            )
            .setTimestamp();

        await sendLogEmbed(newMember.guild, 'memberUpdate', embed, 'memberUpdate.nickname', { member: newMember });
    }

    const oldRoles = oldMember.roles.cache.map(r => r.id);
    const newRoles = newMember.roles.cache.map(r => r.id);

    const addedRoles = newRoles.filter(roleId => !oldRoles.includes(roleId));
    const removedRoles = oldRoles.filter(roleId => !newRoles.includes(roleId));

    if (addedRoles.length > 0) {
        const roleNames = addedRoles.map(id => newMember.guild.roles.cache.get(id)?.name || id).join(', ');
        logger.info(`Roles added to ${newMember.user.tag}: ${roleNames}.`, {
            guildId,
            userId,
            addedRoles,
            category: 'memberUpdate'
        });

        const embed = new EmbedBuilder()
            .setColor(themeColor(guildId, 'success'))
            .setTitle('🎭 Roles Added')
            .setDescription(`${newMember} received new roles`)
            .addFields(
                { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: false },
                { name: 'Roles Added', value: roleNames, inline: false }
            )
            .setTimestamp();

        await sendLogEmbed(newMember.guild, 'memberUpdate', embed, 'memberUpdate.rolesAdded', { member: newMember });
    }

    if (removedRoles.length > 0) {
        const roleNames = removedRoles.map(id => newMember.guild.roles.cache.get(id)?.name || id).join(', ');
        logger.info(`Roles removed from ${newMember.user.tag}: ${roleNames}.`, {
            guildId,
            userId,
            removedRoles,
            category: 'memberUpdate'
        });

        const embed = new EmbedBuilder()
            .setColor(themeColor(guildId, 'danger'))
            .setTitle('🎭 Roles Removed')
            .setDescription(`${newMember} lost roles`)
            .addFields(
                { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: false },
                { name: 'Roles Removed', value: roleNames, inline: false }
            )
            .setTimestamp();

        await sendLogEmbed(newMember.guild, 'memberUpdate', embed, 'memberUpdate.rolesRemoved', { member: newMember });
    }
}

async function logVoiceStateUpdate(oldState, newState) {
    // FIX: Add null checks for member and guild
    if (!newState.member || !newState.guild) return;

    const guildId = newState.guild.id;
    const userId = newState.member.id;

    // FIX: Add null checks for oldState.channel and newState.channel
    const oldChannelName = oldState.channel ? `#${oldState.channel.name}` : 'Unknown Channel';
    const newChannelName = newState.channel ? `#${newState.channel.name}` : 'Unknown Channel';

    if (!oldState.channelId && newState.channelId) {
        logger.info(`Member ${newState.member.user.tag} joined voice channel ${newChannelName}.`, {
            guildId,
            userId,
            channelId: newState.channelId,
            category: 'voiceUpdate'
        });
    }
    else if (oldState.channelId && !newState.channelId) {
        logger.info(`Member ${newState.member.user.tag} left voice channel ${oldChannelName}.`, {
            guildId,
            userId,
            channelId: oldState.channelId,
            category: 'voiceUpdate'
        });
    }
    else if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
        logger.info(`Member ${newState.member.user.tag} switched voice channel from ${oldChannelName} to ${newChannelName}.`, {
            guildId,
            userId,
            oldChannelId: oldState.channelId,
            newChannelId: newState.channelId,
            category: 'voiceUpdate'
        });
    }
}

// ===========================
// MEMBER EVENT HANDLERS
// ===========================

async function logMemberJoin(member) {
    if (!member.guild) return;

    // Discord's own record of how they got in — exact, unlike the invite-use diff below,
    // which stays as the fallback (and keeps invite_tracking counts current).
    const joinSource = await fetchJoinSource(member.guild, member.id);
    const application = requiresApplication(member.guild) && !member.user.bot
        && (!joinSource || joinSource.type === 7)
        ? await findApprovalForJoin(member.guild, member.id).catch(() => null)
        : null;
    // The join log announces the approval itself; the sync job skips a claimed row.
    if (application && !application.posted_at) await claimForPosting(application.request_id).catch(() => {});
    const bypassed = bypassedApplication(member.guild, joinSource, member);

    // Try to determine who invited this member
    let inviteInfo = null;
    try {
        // Get current invites
        const currentInvites = await member.guild.invites.fetch();

        // Check our tracked invites in database
        const [trackedInvites] = await db.execute(
            'SELECT invite_code, inviter_id, uses FROM invite_tracking WHERE guild_id = ?',
            [member.guild.id]
        );

        // Find which invite was used (uses increased by 1)
        for (const [code, invite] of currentInvites) {
            const tracked = trackedInvites.find(t => t.invite_code === code);
            if (tracked && invite.uses > tracked.uses) {
                // This invite was used!
                inviteInfo = {
                    code: code,
                    inviterId: invite.inviter?.id || tracked.inviter_id,
                    inviterTag: invite.inviter?.tag || 'Unknown'
                };

                // Update the uses count
                await db.execute(
                    'UPDATE invite_tracking SET uses = ? WHERE guild_id = ? AND invite_code = ?',
                    [invite.uses, member.guild.id, code]
                );
                break;
            }
        }

        // Discord's answer beats the guess whenever it has one.
        if (joinSource?.inviteCode) {
            const live = currentInvites.get(joinSource.inviteCode);
            inviteInfo = {
                code: joinSource.inviteCode,
                inviterId: joinSource.inviterId || live?.inviter?.id || inviteInfo?.inviterId,
                inviterTag: live?.inviter?.tag || (inviteInfo?.code === joinSource.inviteCode ? inviteInfo.inviterTag : 'Unknown')
            };
        }

        // Log who used which invite
        if (inviteInfo) {
            await db.execute(
                `INSERT INTO invite_tracker_logs (guild_id, user_id, inviter_id, invite_code, event_type)
                 VALUES (?, ?, ?, ?, 'join')`,
                [member.guild.id, member.id, inviteInfo.inviterId, inviteInfo.code]
            );
        }

        // Check for vanity URL
        if (!inviteInfo && member.guild.vanityURLCode) {
            try {
                const vanity = await member.guild.fetchVanityData();
                // Can't track vanity invites per-user, but note if it was likely used
            } catch (e) {
                // No vanity or no access
            }
        }
    } catch (error) {
        logger.debug(`[MemberJoin] Could not determine invite source: ${error.message}`);
    }

    logger.info(`[JOIN] ${member.user.tag} joined the server${inviteInfo ? ` (invited by ${inviteInfo.inviterTag} via ${inviteInfo.code})` : ''}`, {
        guildId: member.guild.id,
        userId: member.id,
        inviteCode: inviteInfo?.code,
        inviterId: inviteInfo?.inviterId,
        category: 'memberJoin'
    });

    const joinedTimestamp = Math.floor(member.joinedTimestamp / 1000);
    const embed = new EmbedBuilder()
        .setColor(themeColor(member.guild?.id, 'success'))
        .setTitle('👋 Member Joined')
        .setDescription(`${member} joined the server`)
        .addFields(
            { name: 'User', value: `${member.user.tag} (${member.id})`, inline: true },
            { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
            { name: 'Joined At', value: `<t:${joinedTimestamp}:f>`, inline: true }
        )
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .setTimestamp(member.joinedAt);

    // Add invite info if available
    if (inviteInfo) {
        embed.addFields(
            { name: 'Invited By', value: `<@${inviteInfo.inviterId}> (${inviteInfo.inviterTag})`, inline: true },
            { name: 'Invite Code', value: `\`${inviteInfo.code}\``, inline: true }
        );
    }

    if (joinSource) {
        embed.addFields({ name: 'Join Method', value: joinSource.label, inline: true });
    }

    // Risk insight (core/member-insight.js): account age against the server's threshold, default avatar,
    // Discord's spammer flag, the global ban network, rejoins, earlier protection hits, badges, and a
    // low / medium / high verdict. Per server on/off on the Logging page; never blocks the log.
    const insight = member.user.bot ? null : await riskFieldForJoin(member);
    if (insight) {
        embed.addFields({ name: insight.field.name, value: insight.field.value, inline: false });
    }
    if (application) {
        embed.addFields(
            { name: 'Application Approved By', value: decidedByText(application), inline: false },
            ...answerFields(application)
        );
    }
    if (bypassed) {
        embed.setColor(themeColor(member.guild?.id, 'danger'))
            .setTitle('⚠️ Member Joined Without an Application')
            .addFields({
                name: 'Bypassed Apply-to-Join',
                value: `This server requires an approved application, but Discord records this join as **${joinSource.label}**.`
                    + (joinSource.type === 2 ? ' Check the server\'s linked integrations (Server Settings → Integrations).' : '')
            });
    }

    await sendLogEmbed(member.guild, 'memberJoin', embed, bypassed ? 'memberJoin.noApplication' : 'memberJoin.joined');

    await saveAuditLog(
        member.guild.id,
        'GUILD_MEMBER_JOIN',
        member.id,
        member.id,
        inviteInfo?.inviterId || null,
        null,
        'Member joined',
        null,
        null,
        null,
        {
            username: member.user.tag,
            createdAt: member.user.createdAt.toISOString(),
            inviteCode: inviteInfo?.code,
            invitedBy: inviteInfo?.inviterTag,
            ...(insight ? { risk: insight.risk.level, riskScore: insight.risk.score } : {})
        }
    );
}

async function logMemberLeave(member) {
    // This is an alias for logGuildMemberRemove for consistency with event naming
    return logGuildMemberRemove(member);
}

async function logMemberNicknameUpdate(oldMember, newMember) {
    if (oldMember.partial || newMember.partial) return;
    if (oldMember.nickname === newMember.nickname) return;

    const guildId = newMember.guild.id;
    const userId = newMember.id;

    logger.info(`Member ${newMember.user.tag} nickname changed from "${oldMember.nickname || 'None'}" to "${newMember.nickname || 'None'}".`, {
        guildId,
        userId,
        oldNickname: oldMember.nickname,
        newNickname: newMember.nickname,
        category: 'memberUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'primary')) // Blurple
        .setTitle('✏️ Nickname Changed')
        .setDescription(`${newMember}'s nickname was changed`)
        .addFields(
            { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: false },
            { name: 'Old Nickname', value: oldMember.nickname || 'None', inline: true },
            { name: 'New Nickname', value: newMember.nickname || 'None', inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(newMember.guild, 'memberUpdate', embed, 'memberUpdate.nickname', { member: newMember });

    await saveAuditLog(
        guildId,
        'MEMBER_NICKNAME_UPDATE',
        userId,
        userId,
        null,
        null,
        'Nickname updated',
        null,
        oldMember.nickname || 'None',
        newMember.nickname || 'None',
        { username: newMember.user.tag }
    );
}

async function logMemberRoleUpdate(oldMember, newMember) {
    if (oldMember.partial || newMember.partial) return;

    const guildId = newMember.guild.id;
    const userId = newMember.id;

    const oldRoles = oldMember.roles.cache.map(r => r.id);
    const newRoles = newMember.roles.cache.map(r => r.id);

    const addedRoles = newRoles.filter(roleId => !oldRoles.includes(roleId));
    const removedRoles = oldRoles.filter(roleId => !newRoles.includes(roleId));

    if (addedRoles.length > 0) {
        const roleNames = addedRoles.map(id => newMember.guild.roles.cache.get(id)?.name || id).join(', ');
        logger.info(`Roles added to ${newMember.user.tag}: ${roleNames}.`, {
            guildId,
            userId,
            addedRoles,
            category: 'memberUpdate'
        });

        const embed = new EmbedBuilder()
            .setColor(themeColor(guildId, 'success'))
            .setTitle('🎭 Roles Added')
            .setDescription(`${newMember} received new roles`)
            .addFields(
                { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: false },
                { name: 'Roles Added', value: roleNames, inline: false }
            )
            .setTimestamp();

        await sendLogEmbed(newMember.guild, 'memberUpdate', embed, 'memberUpdate.rolesAdded', { member: newMember });

        await saveAuditLog(
            guildId,
            'MEMBER_ROLES_ADDED',
            userId,
            userId,
            null,
            null,
            'Roles added',
            null,
            null,
            roleNames,
            { username: newMember.user.tag, roleIds: addedRoles }
        );
    }

    if (removedRoles.length > 0) {
        const roleNames = removedRoles.map(id => newMember.guild.roles.cache.get(id)?.name || id).join(', ');
        logger.info(`Roles removed from ${newMember.user.tag}: ${roleNames}.`, {
            guildId,
            userId,
            removedRoles,
            category: 'memberUpdate'
        });

        const embed = new EmbedBuilder()
            .setColor(themeColor(guildId, 'danger'))
            .setTitle('🎭 Roles Removed')
            .setDescription(`${newMember} lost roles`)
            .addFields(
                { name: 'User', value: `${newMember.user.tag} (${newMember.id})`, inline: false },
                { name: 'Roles Removed', value: roleNames, inline: false }
            )
            .setTimestamp();

        await sendLogEmbed(newMember.guild, 'memberUpdate', embed, 'memberUpdate.rolesRemoved', { member: newMember });

        await saveAuditLog(
            guildId,
            'MEMBER_ROLES_REMOVED',
            userId,
            userId,
            null,
            null,
            'Roles removed',
            null,
            roleNames,
            null,
            { username: newMember.user.tag, roleIds: removedRoles }
        );
    }
}

async function logVoiceJoin(newState) {
    if (!newState.member || !newState.guild || !newState.channel) return;

    logger.info(`Member ${newState.member.user.tag} joined voice channel #${newState.channel.name}.`, {
        guildId: newState.guild.id,
        userId: newState.member.id,
        channelId: newState.channelId,
        category: 'voiceUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🔊 Voice Channel Join')
        .setDescription(`${newState.member} joined ${newState.channel}`)
        .addFields(
            { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: true },
            { name: 'Channel', value: newState.channel.name, inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(newState.guild, 'voiceUpdate', embed, 'voiceUpdate.join',
        { channel: newState.channel, member: newState.member });

    await saveAuditLog(
        newState.guild.id,
        'VOICE_JOIN',
        newState.member.id,
        newState.member.id,
        null,
        newState.channelId,
        'Joined voice channel',
        null,
        null,
        newState.channel.name,
        { username: newState.member.user.tag }
    );
}

async function logVoiceLeave(oldState) {
    // Only require guild and channelId - member might be partial
    if (!oldState.guild || !oldState.channelId) return;

    // Try to get member info, fallback to basic data
    const member = oldState.member || oldState.guild.members.cache.get(oldState.id);
    const channelName = oldState.channel?.name || `Unknown Channel (${oldState.channelId})`;
    const userName = member?.user?.tag || `Unknown User (${oldState.id})`;

    logger.info(`Member ${userName} left voice channel #${channelName}.`, {
        guildId: oldState.guild.id,
        userId: oldState.id,
        channelId: oldState.channelId,
        category: 'voiceUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(themeColor(oldState.guild.id, 'danger'))
        .setTitle('🔇 Voice Channel Leave')
        .setDescription(`${member || `<@${oldState.id}>`} left ${oldState.channel || channelName}`)
        .addFields(
            { name: 'User', value: `${userName} (${oldState.id})`, inline: true },
            { name: 'Channel', value: channelName, inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(oldState.guild, 'voiceUpdate', embed, 'voiceUpdate.leave',
        { channel: oldState.channel, channelId: oldState.channelId, member: oldState.member, userId: oldState.id });

    // oldState.channel is null when the channel no longer exists — handleTempChannels deletes an
    // emptied temp channel before this runs — and oldState.member can be uncached.
    await saveAuditLog(
        oldState.guild.id,
        'VOICE_LEAVE',
        oldState.id,
        oldState.id,
        null,
        oldState.channelId,
        'Left voice channel',
        null,
        channelName,
        null,
        { username: userName }
    );
}

async function logVoiceMove(oldState, newState) {
    if (!newState.member || !newState.guild || !oldState.channel || !newState.channel) return;

    logger.info(`Member ${newState.member.user.tag} switched voice channel from #${oldState.channel.name} to #${newState.channel.name}.`, {
        guildId: newState.guild.id,
        userId: newState.member.id,
        oldChannelId: oldState.channelId,
        newChannelId: newState.channelId,
        category: 'voiceUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🔀 Voice Channel Move')
        .setDescription(`${newState.member} moved voice channels`)
        .addFields(
            { name: 'User', value: `${newState.member.user.tag} (${newState.member.id})`, inline: false },
            { name: 'From', value: oldState.channel.name, inline: true },
            { name: 'To', value: newState.channel.name, inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(newState.guild, 'voiceUpdate', embed, 'voiceUpdate.move',
        { channels: [oldState.channel, newState.channel], member: newState.member });

    await saveAuditLog(
        newState.guild.id,
        'VOICE_MOVE',
        newState.member.id,
        newState.member.id,
        null,
        newState.channelId,
        'Switched voice channels',
        null,
        oldState.channel.name,
        newState.channel.name,
        { username: newState.member.user.tag }
    );
}

// ===========================
// CHANNEL EVENT HANDLERS
// ===========================

async function logChannelCreate(channel) {
    if (!channel.guild) return;

    logger.info(`[CHANNEL CREATE] #${channel.name} (${channel.type})`, {
        guildId: channel.guild.id,
        channelId: channel.id,
        category: 'channelCreate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('➕ Channel Created')
        .setDescription(`${channel} was created`)
        .addFields(
            { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: true },
            { name: 'Type', value: `${channel.type}`, inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(channel.guild, 'channelCreate', embed);

    await saveAuditLog(
        channel.guild.id,
        'CHANNEL_CREATE',
        null,
        channel.id,
        null,
        channel.id,
        'Channel created',
        null,
        null,
        channel.name,
        { type: channel.type }
    );
}

async function logChannelDelete(channel) {
    if (!channel.guild) return;

    logger.info(`[CHANNEL DELETE] #${channel.name} (${channel.type})`, {
        guildId: channel.guild.id,
        channelId: channel.id,
        category: 'channelDelete'
    });

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('➖ Channel Deleted')
        .setDescription(`#${channel.name} was deleted`)
        .addFields(
            { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: true },
            { name: 'Type', value: `${channel.type}`, inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(channel.guild, 'channelDelete', embed);

    await saveAuditLog(
        channel.guild.id,
        'CHANNEL_DELETE',
        null,
        channel.id,
        null,
        channel.id,
        'Channel deleted',
        null,
        channel.name,
        null,
        { type: channel.type }
    );
}

async function logChannelUpdate(oldChannel, newChannel) {
    if (!newChannel.guild) return;

    // Skip stat display channel renames (automated updates, not user actions)
    if (oldChannel.name !== newChannel.name) {
        const [statCh] = await db.execute(
            'SELECT 1 FROM stat_display_channels WHERE channel_id = ? LIMIT 1',
            [newChannel.id]
        );
        if (statCh.length > 0) return;
    }

    const changes = [];

    // Name change
    if (oldChannel.name !== newChannel.name) {
        changes.push(`**Name:** ${oldChannel.name} → ${newChannel.name}`);
    }

    // Topic change (text channels)
    if ('topic' in oldChannel && 'topic' in newChannel && oldChannel.topic !== newChannel.topic) {
        const oldTopic = oldChannel.topic || '(none)';
        const newTopic = newChannel.topic || '(none)';
        changes.push(`**Topic:** ${oldTopic.substring(0, 50)}${oldTopic.length > 50 ? '...' : ''} → ${newTopic.substring(0, 50)}${newTopic.length > 50 ? '...' : ''}`);
    }

    // NSFW toggle
    if ('nsfw' in oldChannel && 'nsfw' in newChannel && oldChannel.nsfw !== newChannel.nsfw) {
        changes.push(`**NSFW:** ${oldChannel.nsfw ? 'Yes' : 'No'} → ${newChannel.nsfw ? 'Yes' : 'No'}`);
    }

    // Slowmode change
    if ('rateLimitPerUser' in oldChannel && 'rateLimitPerUser' in newChannel && oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
        changes.push(`**Slowmode:** ${oldChannel.rateLimitPerUser}s → ${newChannel.rateLimitPerUser}s`);
    }

    // Hierarchy / placement changes intentionally skipped — moving channels between
    // categories or reordering fires cascading channelUpdate events for every affected
    // channel. Renames, topic, NSFW, slowmode, perms, etc. still log.
    // if (oldChannel.parentId !== newChannel.parentId) { ... }
    // if (oldChannel.position !== newChannel.position) { ... }

    // Voice channel specific
    if ('bitrate' in oldChannel && 'bitrate' in newChannel && oldChannel.bitrate !== newChannel.bitrate) {
        changes.push(`**Bitrate:** ${oldChannel.bitrate / 1000}kbps → ${newChannel.bitrate / 1000}kbps`);
    }
    if ('userLimit' in oldChannel && 'userLimit' in newChannel && oldChannel.userLimit !== newChannel.userLimit) {
        changes.push(`**User Limit:** ${oldChannel.userLimit || 'Unlimited'} → ${newChannel.userLimit || 'Unlimited'}`);
    }

    // Permission overwrites change
    const oldPerms = oldChannel.permissionOverwrites?.cache;
    const newPerms = newChannel.permissionOverwrites?.cache;
    if (oldPerms && newPerms) {
        const oldPermIds = new Set(oldPerms.keys());
        const newPermIds = new Set(newPerms.keys());

        // Check for added permissions
        for (const id of newPermIds) {
            if (!oldPermIds.has(id)) {
                const overwrite = newPerms.get(id);
                const targetType = overwrite.type === 0 ? 'role' : 'member';
                changes.push(`**Permissions Added:** ${targetType} override`);
                break; // Just note that permissions changed, don't spam
            }
        }

        // Check for removed permissions
        for (const id of oldPermIds) {
            if (!newPermIds.has(id)) {
                changes.push(`**Permissions Removed:** override removed`);
                break;
            }
        }

        // Check for modified permissions
        for (const id of oldPermIds) {
            if (newPermIds.has(id)) {
                const oldOverwrite = oldPerms.get(id);
                const newOverwrite = newPerms.get(id);
                if (oldOverwrite.allow.bitfield !== newOverwrite.allow.bitfield ||
                    oldOverwrite.deny.bitfield !== newOverwrite.deny.bitfield) {
                    changes.push(`**Permissions Modified:** override updated`);
                    break;
                }
            }
        }
    }

    // Default auto-archive duration (threads)
    if ('defaultAutoArchiveDuration' in oldChannel && 'defaultAutoArchiveDuration' in newChannel &&
        oldChannel.defaultAutoArchiveDuration !== newChannel.defaultAutoArchiveDuration) {
        changes.push(`**Auto-Archive:** ${oldChannel.defaultAutoArchiveDuration}min → ${newChannel.defaultAutoArchiveDuration}min`);
    }

    if (changes.length === 0) return;

    logger.info(`[CHANNEL UPDATE] #${newChannel.name}: ${changes.join(', ')}`, {
        guildId: newChannel.guild.id,
        channelId: newChannel.id,
        category: 'channelUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🔧 Channel Updated')
        .setDescription(`${newChannel} was updated`)
        .addFields(
            { name: 'Channel', value: `${newChannel.name} (${newChannel.id})`, inline: false },
            { name: 'Changes', value: changes.join('\n'), inline: false }
        )
        .setTimestamp();

    await sendLogEmbed(newChannel.guild, 'channelUpdate', embed);

    await saveAuditLog(
        newChannel.guild.id,
        'CHANNEL_UPDATE',
        null,
        newChannel.id,
        null,
        newChannel.id,
        'Channel updated',
        null,
        JSON.stringify({
            name: oldChannel.name,
            topic: 'topic' in oldChannel ? oldChannel.topic : null,
            nsfw: 'nsfw' in oldChannel ? oldChannel.nsfw : null,
            slowmode: 'rateLimitPerUser' in oldChannel ? oldChannel.rateLimitPerUser : null
        }),
        JSON.stringify({
            name: newChannel.name,
            topic: 'topic' in newChannel ? newChannel.topic : null,
            nsfw: 'nsfw' in newChannel ? newChannel.nsfw : null,
            slowmode: 'rateLimitPerUser' in newChannel ? newChannel.rateLimitPerUser : null
        }),
        { changes }
    );
}

// ===========================
// THREAD EVENT HANDLERS
// ===========================

async function logThreadCreate(thread) {
    if (!thread.guild) return;

    logger.info(`[THREAD CREATE] ${thread.name} in #${thread.parent?.name || 'Unknown'}`, {
        guildId: thread.guild.id,
        threadId: thread.id,
        category: 'threadCreate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🧵 Thread Created')
        .setDescription(`Thread **${thread.name}** was created`)
        .addFields(
            { name: 'Thread', value: `${thread.name} (${thread.id})`, inline: false },
            { name: 'Parent Channel', value: thread.parent ? `${thread.parent.name}` : 'Unknown', inline: true },
            { name: 'Owner', value: thread.ownerId ? `<@${thread.ownerId}>` : 'Unknown', inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(thread.guild, 'threadCreate', embed);

    await saveAuditLog(
        thread.guild.id,
        'THREAD_CREATE',
        thread.ownerId,
        thread.id,
        null,
        thread.parentId,
        'Thread created',
        null,
        null,
        thread.name,
        { parentChannel: thread.parent?.name }
    );
}

async function logThreadDelete(thread) {
    if (!thread.guild) return;

    logger.info(`[THREAD DELETE] ${thread.name} in #${thread.parent?.name || 'Unknown'}`, {
        guildId: thread.guild.id,
        threadId: thread.id,
        category: 'threadDelete'
    });

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('🗑️ Thread Deleted')
        .setDescription(`Thread **${thread.name}** was deleted`)
        .addFields(
            { name: 'Thread', value: `${thread.name} (${thread.id})`, inline: false },
            { name: 'Parent Channel', value: thread.parent ? `${thread.parent.name}` : 'Unknown', inline: true },
            { name: 'Owner', value: thread.ownerId ? `<@${thread.ownerId}>` : 'Unknown', inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(thread.guild, 'threadDelete', embed);

    await saveAuditLog(
        thread.guild.id,
        'THREAD_DELETE',
        thread.ownerId,
        thread.id,
        null,
        thread.parentId,
        'Thread deleted',
        null,
        thread.name,
        null,
        { parentChannel: thread.parent?.name }
    );
}

async function logThreadUpdate(oldThread, newThread) {
    if (!newThread.guild) return;

    const changes = [];
    if (oldThread.name !== newThread.name) changes.push(`name: ${oldThread.name} → ${newThread.name}`);
    if (oldThread.archived !== newThread.archived) changes.push(`archived: ${oldThread.archived} → ${newThread.archived}`);
    if (oldThread.locked !== newThread.locked) changes.push(`locked: ${oldThread.locked} → ${newThread.locked}`);

    if (changes.length === 0) return;

    logger.info(`[THREAD UPDATE] ${newThread.name}: ${changes.join(', ')}`, {
        guildId: newThread.guild.id,
        threadId: newThread.id,
        category: 'threadUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📝 Thread Updated')
        .setDescription(`Thread **${newThread.name}** was updated`)
        .addFields(
            { name: 'Thread', value: `${newThread.name} (${newThread.id})`, inline: false },
            { name: 'Changes', value: changes.join('\n'), inline: false }
        )
        .setTimestamp();

    await sendLogEmbed(newThread.guild, 'threadUpdate', embed);

    await saveAuditLog(
        newThread.guild.id,
        'THREAD_UPDATE',
        newThread.ownerId,
        newThread.id,
        null,
        newThread.parentId,
        'Thread updated',
        null,
        JSON.stringify({ name: oldThread.name, archived: oldThread.archived, locked: oldThread.locked }),
        JSON.stringify({ name: newThread.name, archived: newThread.archived, locked: newThread.locked }),
        { changes }
    );
}

// ===========================
// GUILD/SERVER EVENT HANDLERS
// ===========================

async function logGuildUpdate(oldGuild, newGuild) {
    const changes = [];
    if (oldGuild.name !== newGuild.name) changes.push(`name: ${oldGuild.name} → ${newGuild.name}`);
    if (oldGuild.iconURL() !== newGuild.iconURL()) changes.push(`icon changed`);
    if (oldGuild.verificationLevel !== newGuild.verificationLevel) changes.push(`verification: ${oldGuild.verificationLevel} → ${newGuild.verificationLevel}`);
    if (oldGuild.explicitContentFilter !== newGuild.explicitContentFilter) changes.push(`content filter changed`);

    if (changes.length === 0) return;

    logger.info(`[GUILD UPDATE] ${newGuild.name}: ${changes.join(', ')}`, {
        guildId: newGuild.id,
        category: 'guildUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🏛️ Server Updated')
        .setDescription(`Server settings were updated`)
        .addFields(
            { name: 'Server', value: `${newGuild.name} (${newGuild.id})`, inline: false },
            { name: 'Changes', value: changes.join('\n'), inline: false }
        )
        .setTimestamp();

    if (newGuild.iconURL()) {
        embed.setThumbnail(newGuild.iconURL({ dynamic: true }));
    }

    await sendLogEmbed(newGuild, 'guildUpdate', embed);

    await saveAuditLog(
        newGuild.id,
        'GUILD_UPDATE',
        null,
        newGuild.id,
        null,
        null,
        'Server updated',
        null,
        JSON.stringify({ name: oldGuild.name, verification: oldGuild.verificationLevel }),
        JSON.stringify({ name: newGuild.name, verification: newGuild.verificationLevel }),
        { changes }
    );
}

/**
 * @param opts.entry           the ban's audit-log entry when the caller already read it (events/guildBanAdd.js)
 * @param opts.classification  core/global-ban-manager.js ingestBan's verdict (who / which protection),
 *                             kept in the audit row's metadata for the dashboard ban log
 */
async function logGuildBanAdd(ban, { entry = undefined, classification = null } = {}) {
    if (!ban.guild) return;

    try {
        const banLog = entry !== undefined
            ? entry
            : (await ban.guild.fetchAuditLogs({ type: 22, limit: 1 })).entries.first();
        const moderator = banLog?.executor;

        // Get reason from audit log first (most reliable), fallback to ban object
        const reason = banLog?.reason || ban.reason || 'No reason provided';

        logger.info(`[BAN] ${ban.user.tag} banned by ${moderator?.tag || 'Unknown'}. Reason: ${reason}`, {
            guildId: ban.guild.id,
            userId: ban.user.id,
            moderatorId: moderator?.id,
            category: 'ban'
        });

        const embed = new EmbedBuilder()
            .setColor(0xED4245)
            .setTitle('🔨 Member Banned')
            .setDescription(`${ban.user.tag} was banned from the server`)
            .addFields(
                { name: 'User', value: `${ban.user.tag} (${ban.user.id})`, inline: true },
                { name: 'Moderator', value: moderator ? `${moderator.tag} (${moderator.id})` : 'Unknown', inline: true },
                { name: 'Reason', value: reason, inline: false }
            )
            .setThumbnail(ban.user.displayAvatarURL({ dynamic: true }))
            .setTimestamp();

        await sendLogEmbed(ban.guild, 'ban', embed);

        await saveAuditLog(
            ban.guild.id,
            'GUILD_BAN_ADD',
            ban.user.id,
            ban.user.id,
            moderator?.id || null,
            null,
            'Member banned',
            reason,
            null,
            null,
            {
                username: ban.user.tag,
                moderator: moderator?.tag,
                ...(moderator ? { moderatorBot: !!moderator.bot } : {}),
                ...(classification ? { source: classification.source, protection: classification.context || null } : {}),
            }
        );
    } catch (error) {
        logger.error(`[BAN] Failed to log ban: ${error.message}`);
    }
}

async function logGuildBanRemove(ban) {
    if (!ban.guild) return;

    try {
        const auditLogs = await ban.guild.fetchAuditLogs({ type: 23, limit: 1 });
        const unbanLog = auditLogs.entries.first();
        const moderator = unbanLog?.executor;

        logger.info(`[UNBAN] ${ban.user.tag} unbanned by ${moderator?.tag || 'Unknown'}`, {
            guildId: ban.guild.id,
            userId: ban.user.id,
            moderatorId: moderator?.id,
            category: 'unban'
        });

        const embed = new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle('🔓 Member Unbanned')
            .setDescription(`${ban.user.tag} was unbanned`)
            .addFields(
                { name: 'User', value: `${ban.user.tag} (${ban.user.id})`, inline: true },
                { name: 'Moderator', value: moderator ? `${moderator.tag} (${moderator.id})` : 'Unknown', inline: true }
            )
            .setThumbnail(ban.user.displayAvatarURL({ dynamic: true }))
            .setTimestamp();

        await sendLogEmbed(ban.guild, 'unban', embed);

        await saveAuditLog(
            ban.guild.id,
            'GUILD_BAN_REMOVE',
            ban.user.id,
            ban.user.id,
            moderator?.id || null,
            null,
            'Member unbanned',
            null,
            null,
            null,
            { username: ban.user.tag, moderator: moderator?.tag }
        );
    } catch (error) {
        logger.error(`[UNBAN] Failed to log unban: ${error.message}`);
    }
}

async function logGuildMemberRemove(member) {
    if (!member.guild) return;

    try {
        const auditLogs = await member.guild.fetchAuditLogs({ type: 20, limit: 1 });
        const kickLog = auditLogs.entries.first();

        const isKick = kickLog && kickLog.target && 'id' in kickLog.target && kickLog.target.id === member.id && (Date.now() - kickLog.createdTimestamp) < 5000;

        if (isKick) {
            const moderator = kickLog.executor;
            logger.info(`[KICK] ${member.user.tag} kicked by ${moderator?.tag || 'Unknown'}. Reason: ${kickLog.reason || 'None'}`, {
                guildId: member.guild.id,
                userId: member.id,
                moderatorId: moderator?.id,
                category: 'kick'
            });

            const embed = new EmbedBuilder()
                .setColor(themeColor(member.guild?.id, 'danger'))
                .setTitle('🚪 Member Kicked')
                .setDescription(`${member.user.tag} was kicked from the server`)
                .addFields(
                    { name: 'User', value: `${member.user.tag} (${member.id})`, inline: true },
                    { name: 'Moderator', value: moderator ? `${moderator.tag} (${moderator.id})` : 'Unknown', inline: true },
                    { name: 'Reason', value: kickLog.reason || 'No reason provided', inline: false }
                )
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                .setTimestamp();

            await sendLogEmbed(member.guild, 'memberKick', embed);

            await saveAuditLog(
                member.guild.id,
                'GUILD_MEMBER_KICK',
                member.id,
                member.id,
                moderator?.id || null,
                null,
                'Member kicked',
                kickLog.reason,
                null,
                null,
                { username: member.user.tag, moderator: moderator?.tag }
            );
        } else {
            logger.info(`[LEAVE] ${member.user.tag} left the server`, {
                guildId: member.guild.id,
                userId: member.id,
                category: 'memberLeave'
            });

            const embed = new EmbedBuilder()
                .setColor(0xFEE75C)
                .setTitle('👋 Member Left')
                .setDescription(`${member.user.tag} left the server`)
                .addFields(
                    { name: 'User', value: `${member.user.tag} (${member.id})`, inline: true },
                    { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true }
                )
                .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                .setTimestamp();

            await sendLogEmbed(member.guild, 'memberLeave', embed);

            await saveAuditLog(
                member.guild.id,
                'GUILD_MEMBER_LEAVE',
                member.id,
                member.id,
                null,
                null,
                'Member left',
                null,
                null,
                null,
                { username: member.user.tag }
            );
        }
    } catch (error) {
        logger.error(`[MEMBER REMOVE] Failed to log member removal: ${error.message}`);
    }
}

// ===========================
// ROLE EVENT HANDLERS
// ===========================

async function logRoleCreate(role) {
    if (!role.guild) return;

    logger.info(`[ROLE CREATE] ${role.name}`, {
        guildId: role.guild.id,
        roleId: role.id,
        category: 'roleCreate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🎭 Role Created')
        .setDescription(`Role **${role.name}** was created`)
        .addFields(
            { name: 'Role', value: `${role.name} (${role.id})`, inline: false },
            { name: 'Color', value: role.hexColor || 'Default', inline: true },
            { name: 'Position', value: `${role.position}`, inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(role.guild, 'roleCreate', embed);

    await saveAuditLog(
        role.guild.id,
        'ROLE_CREATE',
        null,
        role.id,
        null,
        null,
        'Role created',
        null,
        null,
        role.name,
        { color: role.hexColor, permissions: role.permissions.bitfield.toString() }
    );
}

async function logRoleDelete(role) {
    if (!role.guild) return;

    logger.info(`[ROLE DELETE] ${role.name}`, {
        guildId: role.guild.id,
        roleId: role.id,
        category: 'roleDelete'
    });

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('❌ Role Deleted')
        .setDescription(`Role **${role.name}** was deleted`)
        .addFields(
            { name: 'Role', value: `${role.name} (${role.id})`, inline: false },
            { name: 'Color', value: role.hexColor || 'Default', inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(role.guild, 'roleDelete', embed);

    await saveAuditLog(
        role.guild.id,
        'ROLE_DELETE',
        null,
        role.id,
        null,
        null,
        'Role deleted',
        null,
        role.name,
        null,
        { color: role.hexColor }
    );
}

async function logRoleUpdate(oldRole, newRole) {
    if (!newRole.guild) return;

    const changes = [];
    if (oldRole.name !== newRole.name) changes.push(`name: ${oldRole.name} → ${newRole.name}`);
    if (oldRole.hexColor !== newRole.hexColor) changes.push(`color: ${oldRole.hexColor} → ${newRole.hexColor}`);
    if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) changes.push(`permissions changed`);
    // Skip position-only changes — too noisy (reordering roles fires for every role in the hierarchy)
    // if (oldRole.position !== newRole.position) changes.push(`position: ${oldRole.position} → ${newRole.position}`);

    if (changes.length === 0) return;

    logger.info(`[ROLE UPDATE] ${newRole.name}: ${changes.join(', ')}`, {
        guildId: newRole.guild.id,
        roleId: newRole.id,
        category: 'roleUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎨 Role Updated')
        .setDescription(`Role **${newRole.name}** was updated`)
        .addFields(
            { name: 'Role', value: `${newRole.name} (${newRole.id})`, inline: false },
            { name: 'Changes', value: changes.join('\n'), inline: false }
        )
        .setTimestamp();

    await sendLogEmbed(newRole.guild, 'roleUpdate', embed);

    await saveAuditLog(
        newRole.guild.id,
        'ROLE_UPDATE',
        null,
        newRole.id,
        null,
        null,
        'Role updated',
        null,
        JSON.stringify({ name: oldRole.name, color: oldRole.hexColor, position: oldRole.position }),
        JSON.stringify({ name: newRole.name, color: newRole.hexColor, position: newRole.position }),
        { changes }
    );
}

// ===========================
// EMOJI EVENT HANDLERS
// ===========================

async function logEmojiCreate(emoji) {
    // These were switched off (2026-10) because the emoji cache was off (GuildEmojiManager: 0): with
    // nothing cached, discord.js treats every emoji in each GUILD_EMOJIS_UPDATE / GUILD_CREATE as new
    // and fired emojiCreate for all of them, a log storm, and never fired delete or update at all.
    // The cache is on again (core/bot-manager.js), so these events are real diffs. Belt and braces:
    // an emoji's id is minted when it is uploaded, so an "added" emoji older than ten minutes is a
    // cache artifact, not an upload.
    if (!emoji.guild) return;
    if (emoji.createdTimestamp && Date.now() - emoji.createdTimestamp > 10 * 60_000) return;

    logger.debug(`[EMOJI CREATE] :${emoji.name}: (${emoji.id})`, {
        guildId: emoji.guild.id,
        emojiId: emoji.id,
        category: 'emojiCreate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('😀 Emoji Added')
        .setDescription(`Emoji :${emoji.name}: was added`)
        .addFields(
            { name: 'Name', value: emoji.name || 'unknown', inline: true },
            { name: 'ID', value: emoji.id, inline: true },
            { name: 'Animated', value: emoji.animated ? 'Yes' : 'No', inline: true }
        )
        .setThumbnail(emoji.url)
        .setTimestamp();

    await sendLogEmbed(emoji.guild, 'emojiCreate', embed);

    await saveAuditLog(
        emoji.guild.id,
        'EMOJI_CREATE',
        null,
        emoji.id,
        null,
        null,
        'Emoji created',
        null,
        null,
        emoji.name || 'unknown',
        { animated: emoji.animated }
    );
}

async function logEmojiDelete(emoji) {
    if (!emoji.guild) return;

    logger.debug(`[EMOJI DELETE] :${emoji.name}: (${emoji.id})`, {
        guildId: emoji.guild.id,
        emojiId: emoji.id,
        category: 'emojiDelete'
    });

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('😢 Emoji Removed')
        .setDescription(`Emoji :${emoji.name}: was removed`)
        .addFields(
            { name: 'Name', value: emoji.name || 'unknown', inline: true },
            { name: 'ID', value: emoji.id, inline: true },
            { name: 'Animated', value: emoji.animated ? 'Yes' : 'No', inline: true }
        )
        .setThumbnail(emoji.url)
        .setTimestamp();

    await sendLogEmbed(emoji.guild, 'emojiDelete', embed);

    await saveAuditLog(
        emoji.guild.id,
        'EMOJI_DELETE',
        null,
        emoji.id,
        null,
        null,
        'Emoji deleted',
        null,
        emoji.name || 'unknown',
        null,
        { animated: emoji.animated }
    );
}

async function logEmojiUpdate(oldEmoji, newEmoji) {
    if (!newEmoji.guild) return;

    if (oldEmoji.name === newEmoji.name) return;

    logger.debug(`[EMOJI UPDATE] :${oldEmoji.name}: → :${newEmoji.name}:`, {
        guildId: newEmoji.guild.id,
        emojiId: newEmoji.id,
        category: 'emojiUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('😎 Emoji Updated')
        .setDescription(`Emoji was renamed`)
        .addFields(
            { name: 'Before', value: `:${oldEmoji.name}:`, inline: true },
            { name: 'After', value: `:${newEmoji.name}:`, inline: true },
            { name: 'ID', value: newEmoji.id, inline: true }
        )
        .setThumbnail(newEmoji.url)
        .setTimestamp();

    await sendLogEmbed(newEmoji.guild, 'emojiUpdate', embed);

    await saveAuditLog(
        newEmoji.guild.id,
        'EMOJI_UPDATE',
        null,
        newEmoji.id,
        null,
        null,
        'Emoji updated',
        null,
        oldEmoji.name || 'unknown',
        newEmoji.name || 'unknown',
        {}
    );
}

// ===========================
// STICKER EVENT HANDLERS
// ===========================

async function logStickerCreate(sticker) {
    if (!sticker.guild) return;

    logger.info(`[STICKER CREATE] ${sticker.name} (${sticker.id})`, {
        guildId: sticker.guild.id,
        stickerId: sticker.id,
        category: 'stickerCreate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🏷️ Sticker Added')
        .setDescription(`Sticker **${sticker.name}** was added`)
        .addFields(
            { name: 'Name', value: sticker.name, inline: true },
            { name: 'ID', value: sticker.id, inline: true },
            { name: 'Description', value: sticker.description || 'No description', inline: false }
        )
        .setThumbnail(sticker.url)
        .setTimestamp();

    await sendLogEmbed(sticker.guild, 'stickerCreate', embed);

    await saveAuditLog(
        sticker.guild.id,
        'STICKER_CREATE',
        sticker.user?.id || null,
        sticker.id,
        null,
        null,
        'Sticker created',
        null,
        null,
        sticker.name,
        { description: sticker.description }
    );
}

async function logStickerDelete(sticker) {
    if (!sticker.guild) return;

    logger.info(`[STICKER DELETE] ${sticker.name} (${sticker.id})`, {
        guildId: sticker.guild.id,
        stickerId: sticker.id,
        category: 'stickerDelete'
    });

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('🗑️ Sticker Removed')
        .setDescription(`Sticker **${sticker.name}** was removed`)
        .addFields(
            { name: 'Name', value: sticker.name, inline: true },
            { name: 'ID', value: sticker.id, inline: true }
        )
        .setThumbnail(sticker.url)
        .setTimestamp();

    await sendLogEmbed(sticker.guild, 'stickerDelete', embed);

    await saveAuditLog(
        sticker.guild.id,
        'STICKER_DELETE',
        null,
        sticker.id,
        null,
        null,
        'Sticker deleted',
        null,
        sticker.name,
        null,
        {}
    );
}

async function logStickerUpdate(oldSticker, newSticker) {
    if (!newSticker.guild) return;

    const changes = [];
    if (oldSticker.name !== newSticker.name) changes.push(`name: ${oldSticker.name} → ${newSticker.name}`);
    if (oldSticker.description !== newSticker.description) changes.push(`description changed`);

    if (changes.length === 0) return;

    logger.info(`[STICKER UPDATE] ${newSticker.name}: ${changes.join(', ')}`, {
        guildId: newSticker.guild.id,
        stickerId: newSticker.id,
        category: 'stickerUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('✨ Sticker Updated')
        .setDescription(`Sticker **${newSticker.name}** was updated`)
        .addFields(
            { name: 'Sticker', value: `${newSticker.name} (${newSticker.id})`, inline: false },
            { name: 'Changes', value: changes.join('\n'), inline: false }
        )
        .setThumbnail(newSticker.url)
        .setTimestamp();

    await sendLogEmbed(newSticker.guild, 'stickerUpdate', embed);

    await saveAuditLog(
        newSticker.guild.id,
        'STICKER_UPDATE',
        null,
        newSticker.id,
        null,
        null,
        'Sticker updated',
        null,
        JSON.stringify({ name: oldSticker.name, description: oldSticker.description }),
        JSON.stringify({ name: newSticker.name, description: newSticker.description }),
        { changes }
    );
}

// ===========================
// INVITE EVENT HANDLERS
// ===========================

async function logInviteCreate(invite) {
    if (!invite.guild) return;

    const inviter = invite.inviter;
    const channel = invite.channel;

    logger.info(`[INVITE CREATE] ${invite.code} by ${inviter?.tag || 'Unknown'}`, {
        guildId: invite.guild.id,
        inviteCode: invite.code,
        inviterId: inviter?.id,
        channelId: channel?.id,
        maxUses: invite.maxUses,
        maxAge: invite.maxAge,
        category: 'inviteCreate'
    });

    const expiresIn = invite.maxAge === 0 ? 'Never' : `${Math.round(invite.maxAge / 3600)}h`;
    const maxUses = invite.maxUses === 0 ? 'Unlimited' : invite.maxUses;

    const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🔗 Invite Created')
        .setDescription(`New invite link was created`)
        .addFields(
            { name: 'Code', value: `\`${invite.code}\``, inline: true },
            { name: 'Created By', value: inviter ? `${inviter.tag} (${inviter.id})` : 'Unknown', inline: true },
            { name: 'Channel', value: channel ? `${channel.name}` : 'Unknown', inline: true },
            { name: 'Max Uses', value: `${maxUses}`, inline: true },
            { name: 'Expires', value: expiresIn, inline: true },
            { name: 'Temporary', value: invite.temporary ? 'Yes' : 'No', inline: true }
        )
        .setTimestamp();

    if (inviter) {
        embed.setThumbnail(inviter.displayAvatarURL({ dynamic: true }));
    }

    await sendLogEmbed(invite.guild, 'inviteCreate', embed);

    await saveAuditLog(
        invite.guild.id,
        'INVITE_CREATE',
        inviter?.id || null,
        invite.code,
        null,
        channel?.id || null,
        'Invite created',
        null,
        null,
        invite.code,
        { maxUses: invite.maxUses, maxAge: invite.maxAge, temporary: invite.temporary }
    );
}

async function logInviteDelete(invite) {
    if (!invite.guild) return;

    logger.info(`[INVITE DELETE] ${invite.code}`, {
        guildId: invite.guild.id,
        inviteCode: invite.code,
        category: 'inviteDelete'
    });

    const embed = new EmbedBuilder()
        .setColor(0xED4245)
        .setTitle('🗑️ Invite Deleted')
        .setDescription(`Invite link was deleted or expired`)
        .addFields(
            { name: 'Code', value: `\`${invite.code}\``, inline: true },
            { name: 'Channel', value: invite.channel ? `${invite.channel.name}` : 'Unknown', inline: true },
            { name: 'Uses', value: `${invite.uses || 0}`, inline: true }
        )
        .setTimestamp();

    await sendLogEmbed(invite.guild, 'inviteDelete', embed);

    await saveAuditLog(
        invite.guild.id,
        'INVITE_DELETE',
        null,
        invite.code,
        null,
        invite.channel?.id || null,
        'Invite deleted',
        null,
        invite.code,
        null,
        { uses: invite.uses }
    );
}

// ===========================
// WEBHOOK/INTEGRATION HANDLERS
// ===========================

async function logWebhookUpdate(channel) {
    if (!channel.guild) return;

    logger.info(`[WEBHOOK UPDATE] Webhooks modified in #${channel.name}`, {
        guildId: channel.guild.id,
        channelId: channel.id,
        category: 'webhookUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('🔗 Webhook Modified')
        .setDescription(`Webhooks were modified in ${channel}`)
        .addFields(
            { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: false }
        )
        .setTimestamp();

    await sendLogEmbed(channel.guild, 'webhookUpdate', embed, 'webhookUpdate.modified');

    await saveAuditLog(
        channel.guild.id,
        'WEBHOOK_UPDATE',
        null,
        channel.id,
        null,
        channel.id,
        'Webhook updated',
        null,
        null,
        null,
        { channelName: channel.name }
    );
}

async function logIntegrationUpdate(guild) {
    logger.info(`[INTEGRATION UPDATE] Integrations modified in ${guild.name}`, {
        guildId: guild.id,
        category: 'integrationUpdate'
    });

    const embed = new EmbedBuilder()
        .setColor(0xFEE75C)
        .setTitle('🤖 Integration Updated')
        .setDescription(`Server integrations were modified`)
        .addFields(
            { name: 'Server', value: `${guild.name} (${guild.id})`, inline: false }
        )
        .setTimestamp();

    await sendLogEmbed(guild, 'integrationUpdate', embed);

    await saveAuditLog(
        guild.id,
        'INTEGRATION_UPDATE',
        null,
        guild.id,
        null,
        null,
        'Integration updated',
        null,
        null,
        null,
        {}
    );
}

export {
    // Helper functions
    sendLogEmbed,
    resolveLogTarget,
    isLogSubjectIgnored,
    invalidateLogActionColors,
    saveAuditLog,
    logAutomodAction,

    // Message events
    logMessageDelete,
    logMessageUpdate,

    // Member events (existing)
    logMemberUpdate,

    // Member events (new)
    logMemberJoin,
    logMemberLeave,
    logMemberNicknameUpdate,
    logMemberRoleUpdate,

    // Voice events (existing)
    logVoiceStateUpdate,

    // Voice events (new)
    logVoiceJoin,
    logVoiceLeave,
    logVoiceMove,

    // Channel events
    logChannelCreate,
    logChannelDelete,
    logChannelUpdate,

    // Thread events
    logThreadCreate,
    logThreadDelete,
    logThreadUpdate,

    // Guild/Server events
    logGuildUpdate,
    logGuildBanAdd,
    logGuildBanRemove,
    logGuildMemberRemove,

    // Role events
    logRoleCreate,
    logRoleDelete,
    logRoleUpdate,

    // Emoji events
    logEmojiCreate,
    logEmojiDelete,
    logEmojiUpdate,

    // Sticker events
    logStickerCreate,
    logStickerDelete,
    logStickerUpdate,

    // Invite events
    logInviteCreate,
    logInviteDelete,

    // Webhook/Integration events
    logWebhookUpdate,
    logIntegrationUpdate
};
