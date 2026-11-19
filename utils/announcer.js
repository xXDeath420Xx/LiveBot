import { EmbedBuilder, WebhookClient, DiscordAPIError, MessageFlags } from 'discord.js';
import pool from './db.js';
import logger from './logger.js';
import { renderStreamCard } from './stream-card.js';
import { resolveStyle, sizePreviewUrl } from '../core/stream-render-style.js';
import { mayCreate as mayCreateWebhook, register as registerWebhook } from '../core/webhook-registry.js';
import { buildStreamAlertV2Container } from './stream-alert-v2.js';
import crypto from 'crypto';
import { createEditGovernor, parseUnexpected429 } from './announcement-edit-governor.js';

// Webhook client cache to reduce Discord API calls (5 minute TTL)
const webhookCache = new Map();
const WEBHOOK_CACHE_TTL = 5 * 60 * 1000;
const MAX_WEBHOOK_CACHE = 500;

// ── Streamer avatar attachments ──────────────────────────────────────────────
//
// Discord re-hosts embed images through its own proxy, and that proxy cannot fetch
// Twitch's CDN — hotlinked previews AND avatars both come back unresolved (0x0) and
// render as broken images. Uploading the picture as a real attachment sidesteps the
// proxy entirely: Discord stores the bytes itself, so it always renders.
//
// The same streamer is announced in many guilds, so the bytes are cached in-process
// and each avatar is downloaded roughly once a day rather than once per announcement.
const avatarCache = new Map(); // url -> { buffer, name, fetchedAt }
const AVATAR_CACHE_TTL = 24 * 60 * 60 * 1000;
const MAX_AVATAR_CACHE = 300;
const MAX_AVATAR_BYTES = 8 * 1024 * 1024; // Discord's non-boosted upload ceiling

/**
 * Download a streamer avatar for attaching to an embed.
 * @returns {Promise<{attachment: Buffer, name: string}|null>} null if it can't be fetched —
 *          callers fall back to hotlinking, which is no worse than before.
 */
async function fetchAvatarAttachment(url) {
    if (!url || typeof url !== 'string' || !/^https:\/\//i.test(url)) return null;

    const cached = avatarCache.get(url);
    if (cached && Date.now() - cached.fetchedAt < AVATAR_CACHE_TTL) {
        return { attachment: cached.buffer, name: cached.name };
    }

    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) {
            logger.warn(`[Announcer] Avatar fetch ${res.status} for ${url}`, { category: 'announcer' });
            return null;
        }

        const type = res.headers.get('content-type') || '';
        if (!type.startsWith('image/')) {
            logger.warn(`[Announcer] Avatar not an image (${type}) for ${url}`, { category: 'announcer' });
            return null;
        }

        const buffer = Buffer.from(await res.arrayBuffer());
        if (!buffer.length || buffer.length > MAX_AVATAR_BYTES) {
            logger.warn(`[Announcer] Avatar size rejected (${buffer.length} bytes) for ${url}`, { category: 'announcer' });
            return null;
        }

        // The filename must match the attachment:// reference in the embed
        const ext = type.includes('png') ? 'png' : type.includes('gif') ? 'gif' : type.includes('webp') ? 'webp' : 'jpg';
        const name = `avatar.${ext}`;

        if (avatarCache.size >= MAX_AVATAR_CACHE && !avatarCache.has(url)) {
            avatarCache.delete(avatarCache.keys().next().value);
        }
        avatarCache.set(url, { buffer, name, fetchedAt: Date.now() });
        return { attachment: buffer, name };
    } catch (error) {
        logger.warn(`[Announcer] Could not download avatar ${url}: ${error.message}`, { category: 'announcer' });
        return null;
    }
}

/**
 * Get cached webhook client or null if expired/missing
 */
function getCachedWebhook(channelId) {
    const cached = webhookCache.get(channelId);
    if (cached && Date.now() - cached.timestamp < WEBHOOK_CACHE_TTL) {
        return cached.client;
    }
    if (cached) {
        webhookCache.delete(channelId);
    }
    return null;
}

/**
 * Cache a webhook client
 */
function cacheWebhook(channelId, webhookClient) {
    // Enforce max size
    if (webhookCache.size >= MAX_WEBHOOK_CACHE && !webhookCache.has(channelId)) {
        const oldestKey = webhookCache.keys().next().value;
        webhookCache.delete(oldestKey);
    }
    webhookCache.set(channelId, {
        client: webhookClient,
        timestamp: Date.now()
    });
}

/**
 * Clear cached webhook for a channel (call when webhook is deleted/changed)
 */
function invalidateWebhookCache(channelId) {
    webhookCache.delete(channelId);
}

// Platform color definitions
// The server-wide message from the dashboard's Announcement defaults, used when a subscription has
// no message of its own. The dashboard used to pre-fill this exact text into the box, so it was
// saved by every server that only meant to pick a channel; it counts as "not set" so those servers'
// alerts do not suddenly gain a text line.
const PREFILLED_DEFAULT_MESSAGE = '{streamer} is now live on {platform}! {url}';
function serverDefaultMessage(message) {
    const text = typeof message === 'string' ? message.trim() : '';
    return text && text !== PREFILLED_DEFAULT_MESSAGE ? text : null;
}

const platformColors = {
    twitch: '#9146FF',
    youtube: '#FF0000',
    kick: '#52E252',
    tiktok: '#00f2ea',
    default: '#36393f'
};

const WEBHOOK_NAME_PREFIX = 'CertiFried MultiTool';

/**
 * Retrieves or creates a webhook client for a given channel (with caching)
 */
async function getWebhookClient(client, channelId, desiredName, desiredAvatarURL) {
    // Helper to safely get guild ID from cached channel
    const getCachedGuildId = (chId) => {
        const ch = client.channels.cache.get(chId);
        if (ch && 'guild' in ch) {
            return ch.guild?.id;
        }
        return undefined;
    };

    // Check cache first to avoid API calls
    const cachedClient = getCachedWebhook(channelId);
    if (cachedClient) {
        logger.debug(`[Webhook Manager] Using cached webhook for channel ${channelId}.`, {
            guildId: getCachedGuildId(channelId),
            category: 'announcer'
        });
        return cachedClient;
    }

    logger.debug(`[Webhook Manager] Processing channel ${channelId}.`, {
        guildId: getCachedGuildId(channelId),
        category: 'announcer'
    });

    try {
        // Priority 1: Check for custom webhook URL from channel_settings
        const [rows] = await pool.execute(
            'SELECT webhook_url FROM channel_settings WHERE channel_id = ?',
            [channelId]
        );
        const channelSettings = rows[0];

        if (channelSettings && channelSettings.webhook_url) {
            logger.info(`[Webhook Manager] Using custom webhook URL for channel ${channelId}.`, {
                guildId: getCachedGuildId(channelId),
                channelId,
                category: 'announcer'
            });
            const webhookClient = new WebhookClient({ url: channelSettings.webhook_url });
            cacheWebhook(channelId, webhookClient);
            return webhookClient;
        }

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            logger.warn(`[Webhook Manager] Channel ${channelId} not found, not in a guild, or not a text channel.`, {
                category: 'announcer'
            });
            return null;
        }

        // Type guard for text channels with guild
        if (!('guild' in channel) || !channel.guild) {
            logger.warn(`[Webhook Manager] Channel ${channelId} not found, not in a guild, or not a text channel.`, {
                category: 'announcer'
            });
            return null;
        }

        const textChannel = channel;

        const botMember = await textChannel.guild.members.fetch(client.user.id).catch(() => null);
        if (!botMember) {
            logger.error(`[Webhook Manager] Could not fetch bot's own member object in guild ${textChannel.guild.id}.`, {
                guildId: textChannel.guild.id,
                category: 'announcer'
            });
            return null;
        }

        const permissions = textChannel.permissionsFor(botMember);
        if (!permissions || !permissions.has(['ManageWebhooks', 'SendMessages'])) {
            logger.warn(`[Webhook Manager] Missing ManageWebhooks or SendMessages permission in channel ${channelId}.`, {
                guildId: textChannel.guild.id,
                category: 'announcer'
            });
            return null;
        }

        const webhooks = await textChannel.fetchWebhooks();
        let webhook = webhooks.find(wh => wh.owner?.id === client.user.id && wh.name.startsWith(WEBHOOK_NAME_PREFIX));

        if (webhook) {
            // Reuse existing webhook
            logger.info(`[Webhook Manager] Reusing existing webhook ${webhook.id} in channel ${channelId}.`, {
                guildId: textChannel.guild.id,
                channelId,
                webhookId: webhook.id,
                category: 'announcer'
            });
            const webhookClient = new WebhookClient({ id: webhook.id, token: webhook.token });
            cacheWebhook(channelId, webhookClient);
            // Record on reuse too, not just creation — most guilds already have this webhook
            // from before the registry existed, and would otherwise never appear in the list.
            registerWebhook({
                guildId: textChannel.guild.id, channelId, webhook, name: webhook.name,
            }).catch(() => {});
            return webhookClient;
        }

        // If no existing webhook, check limit before creating
        if (webhooks.size >= 15) {
            logger.error(`[Webhook Manager] Maximum number of webhooks (15) reached in channel ${channelId}. Cannot create new webhook.`, {
                guildId: textChannel.guild.id,
                channelId,
                category: 'announcer'
            });
            return null;
        }

        // A server can refuse webhook creation — announcements then fall back to being posted
        // as the bot itself rather than with the streamer's name and avatar.
        if (!(await mayCreateWebhook(textChannel.guild.id))) {
            logger.info(`[Webhook Manager] Webhook creation is disabled for guild ${textChannel.guild.id}; posting as the bot instead.`, {
                guildId: textChannel.guild.id,
                channelId,
                category: 'announcer'
            });
            return null;
        }

        // Create new webhook with generic name
        logger.info(`[Webhook Manager] Creating new webhook in channel ${channelId}.`, {
            guildId: textChannel.guild.id,
            channelId,
            category: 'announcer'
        });
        const newWebhook = await textChannel.createWebhook({
            name: WEBHOOK_NAME_PREFIX,
            avatar: client.user.displayAvatarURL(),
            reason: 'For stream announcements - username/avatar set per message'
        });
        const webhookClient = new WebhookClient({ id: newWebhook.id, token: newWebhook.token });
        cacheWebhook(channelId, webhookClient);
        registerWebhook({
            guildId: textChannel.guild.id, channelId, webhook: newWebhook, name: WEBHOOK_NAME_PREFIX,
        }).catch(() => {});
        return webhookClient;

    } catch (e) {
        logger.error(`[Webhook Manager] Failed to get or update webhook.`, {
            guildId: getCachedGuildId(channelId) || 'N/A',
            channelId: channelId,
            errorMessage: e.message,
            errorStack: e.stack,
            category: 'announcer'
        });
        return null;
    }
}

/**
 * Detach a subscription from an announcement channel Discord says no longer exists.
 *
 * Guarded on an exact match against the subscription's own column: `targetChannelId`
 * may have been resolved from a live-routing rule or the guild default, and clearing
 * the subscription in that case would be wrong. Any stale live_announcements rows for
 * the dead channel go too — they hold a UNIQUE (guild, platform, username, channel)
 * slot that reserveAnnouncementSlot could otherwise never reclaim.
 */
async function clearDeadAnnouncementChannel(subContext, targetChannelId) {
    if (!subContext?.guild_id || !subContext?.streamer_id || !targetChannelId) return;

    try {
        const [result] = await pool.execute(
            `UPDATE subscriptions SET announcement_channel_id = NULL
             WHERE guild_id = ? AND streamer_id = ? AND announcement_channel_id = ?`,
            [subContext.guild_id, subContext.streamer_id, targetChannelId]
        );
        if (result.affectedRows > 0) {
            logger.warn(`[Announcer] Cleared deleted announcement channel ${targetChannelId} from subscription`, {
                guildId: subContext.guild_id, streamerId: subContext.streamer_id, category: 'announcer'
            });
        }

        await pool.execute(
            'DELETE FROM live_announcements WHERE guild_id = ? AND channel_id = ?',
            [subContext.guild_id, targetChannelId]
        );
    } catch (error) {
        logger.error('[Announcer] Failed to clear deleted announcement channel', {
            guildId: subContext.guild_id, channelId: targetChannelId, error: error.message, category: 'announcer'
        });
    }
}

/**
 * True while live_announcements still points at this exact message. Used before re-posting a
 * message Discord says is gone (10008): when the stream checker has already ended the stream it
 * deletes both the message and the row, so a missing row means "ended on purpose", not "lost".
 * Without this, an edit that stalled behind a slow Discord queue (the announcement updater's 60 s
 * timeout does not cancel the request) finished minutes later with stale live data and re-posted
 * announcements for streams that had already ended - 2026-11-18, guild 901599353389596712.
 * Fails open (true) on a DB error so a genuinely lost message still gets replaced.
 */
async function stillTrackedForResend(subContext, liveData, targetChannelId, messageId) {
    try {
        const [rows] = await pool.query(
            `SELECT 1 FROM live_announcements
              WHERE guild_id = ? AND channel_id = ? AND platform = ? AND username = ? AND message_id = ?
              LIMIT 1`,
            [subContext.guild_id, targetChannelId, liveData.platform, liveData.username, String(messageId)]
        );
        if (rows.length) return true;
        logger.warn(`[Announcer] Not re-posting ${liveData.username}: message ${messageId} is gone and no longer tracked (stream already ended or replaced)`, {
            guildId: subContext.guild_id, channelId: targetChannelId, messageId, category: 'announcer'
        });
        return false;
    } catch (err) {
        logger.warn('[Announcer] Resend tracking check failed - re-posting anyway', { error: err.message, category: 'announcer' });
        return true;
    }
}

/**
 * Live-post edits go through one governor (utils/announcement-edit-governor.js, H-311). The stream
 * checker and the announcement updater both edit live posts, and their timeouts only stop waiting:
 * the Discord request keeps going. On 2026-11-17 22:02 KumaCaste Utility's requests for its
 * announcement channel started queueing for minutes; each pass queued more edits behind the stuck
 * ones (twitch-preview posts were edited by both jobs on every pass, changed or not), and the
 * backlog never drained until a restart (374 timeouts overnight). Now an edit is skipped when the
 * rendered post is unchanged, when only viewers / the preview frame moved within the last 4 minutes,
 * while another edit in the same channel is running, while Discord has the channel rate limited
 * (both the 'rateLimited' event and unexpected 429s), and past 6 edits per channel per minute.
 * New posts are never held back.
 */
const editGovernor = createEditGovernor();
const watchedRest = new WeakSet();

/** Feed Discord's rate-limit signals for a REST client into the governor (once per client). */
function watchRestLimits(rest, botKey, fixedChannelId = null) {
    if (!rest || typeof rest.on !== 'function' || watchedRest.has(rest)) return;
    watchedRest.add(rest);
    const channelOf = (route, major) => fixedChannelId || (String(route || '').startsWith('/channels/') ? major : null);
    rest.on('rateLimited', (info) => {
        const retryAfterMs = info.retryAfter ?? info.timeToReset;
        if (info.global) editGovernor.noteRateLimit({ botKey, global: true, retryAfterMs });
        else {
            const channelId = channelOf(info.route, info.majorParameter);
            if (channelId) editGovernor.noteRateLimit({ botKey, channelId, retryAfterMs });
        }
    });
    // Unexpected 429s (shared and sub-limits) make discord.js sleep without a 'rateLimited' event;
    // they are only visible in its debug stream.
    rest.on('restDebug', (message) => {
        const hit = parseUnexpected429(message);
        if (!hit) return;
        const retryAfterMs = Math.max(hit.retryAfterMs, hit.sublimitMs);
        if (hit.global) editGovernor.noteRateLimit({ botKey, global: true, retryAfterMs });
        else {
            const channelId = channelOf(hit.route, hit.majorParameter);
            if (channelId) editGovernor.noteRateLimit({ botKey, channelId, retryAfterMs });
        }
    });
}

/** What the post will show: `major` = what people read, `minor` = what drifts (viewers, frame). */
function renderFingerprint({ renderStyle, liveData, content, subContext, guildSettings, teamSettings, embed, v2Container, avatarFile }) {
    const sha1 = (v) => crypto.createHash('sha1').update(v).digest('hex');
    let image = null;
    try {
        image = v2Container ? JSON.stringify(v2Container.toJSON ? v2Container.toJSON() : null) : (embed.toJSON().image?.url || null);
    } catch { image = null; }
    const major = sha1(JSON.stringify([
        renderStyle, liveData.platform, liveData.username, liveData.title || null, liveData.game || null,
        liveData.url || null, liveData.profileImageUrl || null, content || null,
        subContext?.post_as_streamer ?? null, guildSettings?.use_webhook_persona ?? null,
        subContext?.override_nickname || null, subContext?.override_avatar_url || null,
        teamSettings?.webhook_avatar_url || null,
    ]));
    const minor = sha1(JSON.stringify([
        liveData.viewerCount ?? null, liveData.startedAt ? String(liveData.startedAt) : null, image,
        avatarFile?.attachment ? sha1(avatarFile.attachment) : null,
    ]));
    return { major, minor };
}

const heldBackLogged = new Map(); // `${bot}:${channel}:${reason}` -> last logged
const HELD_BACK_REASONS = {
    'message-in-flight': 'the previous edit of this post is still running',
    'channel-busy': 'another edit in this channel is still running',
    'rate-limited': 'Discord has this channel rate limited',
    'channel-budget': 'this channel has had its 6 edits for the minute',
};
function noteHeldBack(verdict, ctx, liveData, subContext) {
    if (verdict.reason === 'unchanged' || verdict.reason === 'refreshed-recently') {
        logger.debug(`[Announcer] No edit for ${liveData?.username}: ${verdict.reason}`, { channelId: ctx.channelId, messageId: ctx.messageId, category: 'announcer' });
        return;
    }
    const key = `${ctx.botKey}:${ctx.channelId}:${verdict.reason}`;
    const t = Date.now();
    if (t - (heldBackLogged.get(key) || 0) < 10 * 60_000) return;
    if (heldBackLogged.size > 2000) heldBackLogged.clear();
    heldBackLogged.set(key, t);
    const wait = verdict.waitMs ? ` (${Math.round(verdict.waitMs / 1000)}s)` : '';
    logger.info(`[Announcer] Holding back live-post edits in channel ${ctx.channelId}: ${HELD_BACK_REASONS[verdict.reason] || verdict.reason}${wait}. The next pass updates them (logged once per 10 min per channel)`, {
        guildId: subContext?.guild_id, channelId: ctx.channelId, messageId: ctx.messageId, reason: verdict.reason, category: 'announcer'
    });
}

/** Plain-words state of a post's edits, for timeout log lines (jobs/announcement-updater.js). */
function describeAnnouncementEdit(client, channelId, messageId) {
    return editGovernor.describe({ botKey: client?.user?.id || 'bot', channelId: String(channelId), messageId: String(messageId) });
}

async function updateAnnouncement(client, subContext, liveData, existingAnnouncement, guildSettings, channelSettings, teamSettings, targetChannelId) {
    if (client?.rest) watchRestLimits(client.rest, client.user?.id || 'bot');
    const editCtx = {
        messageId: existingAnnouncement?.message_id ? String(existingAnnouncement.message_id) : null,
        channelId: targetChannelId ? String(targetChannelId) : null,
        botKey: client?.user?.id || 'bot',
        began: false,
    };
    try {
        return await updateAnnouncementNow(client, subContext, liveData, existingAnnouncement, guildSettings, channelSettings, teamSettings, targetChannelId, editCtx);
    } finally {
        if (editCtx.began) editGovernor.end(editCtx);
    }
}

/**
 * Updates or creates a stream announcement
 */
async function updateAnnouncementNow(
    client,
    subContext,
    liveData,
    existingAnnouncement,
    guildSettings,
    channelSettings,
    teamSettings,
    targetChannelId,
    editCtx = null
) {
    if (!liveData || typeof liveData.platform !== 'string') {
        logger.error(`[Announcer] Invalid liveData for ${subContext.username}.`, {
            guildId: subContext.guild_id,
            category: 'announcer'
        });
        return null;
    }

    // Update profile image if changed
    if (liveData.profileImageUrl && liveData.profileImageUrl !== subContext.profile_image_url) {
        pool.execute(
            'UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?',
            [liveData.profileImageUrl, subContext.streamer_id]
        ).catch((dbError) => {
            logger.error(`[Announcer] Failed to update profile image.`, {
                error: dbError,
                guildId: subContext.guild_id,
                category: 'announcer'
            });
        });
    }

    if (!targetChannelId) return null;

    const platformName = liveData.platform.charAt(0).toUpperCase() + liveData.platform.slice(1);
    const platformColor = (platformColors[liveData.platform] || platformColors.default);

    const embed = new EmbedBuilder()
        .setColor(platformColor)
        .setAuthor({ name: `${liveData.username} is LIVE on ${platformName}!`, url: liveData.url })
        .setTitle(liveData.title || 'Untitled Stream')
        .setURL(liveData.url)
        .addFields({ name: 'Playing', value: liveData.game || 'N/A', inline: true })
        .setTimestamp();

    // How this announcement gets drawn is a per-streamer / per-channel / per-guild choice.
    //
    //   'twitch' (the default) hotlinks the platform's live preview as the embed image with the
    //   streamer's avatar as the thumbnail — the look the unified community channel has always
    //   had. Hotlinking was abandoned here once because Discord's proxy stopped resolving
    //   Twitch's preview CDN (previews came back 0x0 and rendered broken); that has since
    //   stopped being true, so it is the default again.
    //
    //   'card' uploads the card we render ourselves. Platform-independent and immune to any
    //   proxy trouble, at the cost of being our layout rather than Twitch's. It degrades in two
    //   steps — card → bare avatar attachment → hotlinked avatar — so a failure at any stage
    //   still shows something.
    const { style: renderStyle } = await resolveStyle({
        guildId: subContext.guild_id,
        channelId: targetChannelId,
        streamerId: subContext.streamer_id,
    });

    let avatarFile = null;
    // Components V2 branch — built once here, swapped for `embeds` in both send paths below.
    // The embed above is still constructed (as a legacy fallback) but will not be sent when
    // v2Container is non-null.
    let v2Container = null;

    if (renderStyle === 'v2') {
        const previewUrl = sizePreviewUrl(liveData.thumbnailUrl, {
            bucket: Math.floor(Date.now() / 300000),
        });
        v2Container = buildStreamAlertV2Container({
            liveData,
            platformName,
            platformColor,
            previewUrl: previewUrl || null,
        });
    } else if (renderStyle === 'card') {
        const avatar = liveData.profileImageUrl ? await fetchAvatarAttachment(liveData.profileImageUrl) : null;
        const cardPng = await renderStreamCard({
            username: liveData.username,
            title: liveData.title,
            game: liveData.game,
            viewers: liveData.viewerCount,
            startedAt: liveData.startedAt,
            platform: liveData.platform,
            avatarBuffer: avatar?.attachment,
        });

        if (cardPng) {
            // description= populates Discord's alt-text/aria-label for screen readers.
            avatarFile = {
                attachment: cardPng,
                name: 'stream.png',
                description: `Live preview card for ${liveData.username} on ${platformName}${liveData.game ? ` playing ${liveData.game}` : ''}`.slice(0, 1024),
            };
            embed.setImage('attachment://stream.png');
        } else if (avatar) {
            avatarFile = { ...avatar, description: `${liveData.username} avatar`.slice(0, 1024) };
            embed.setThumbnail(`attachment://${avatar.name}`);
        } else if (liveData.profileImageUrl) {
            embed.setThumbnail(liveData.profileImageUrl);
        }
    } else {
        // Bucket the cache-buster so an edited embed pulls a newer frame instead of the one
        // Discord proxied when the announcement first went out.
        const preview = sizePreviewUrl(liveData.thumbnailUrl, { bucket: Math.floor(Date.now() / 300000) });
        if (preview) embed.setImage(preview);
        if (liveData.profileImageUrl) embed.setThumbnail(liveData.profileImageUrl);
        if (liveData.viewerCount != null) {
            embed.addFields({ name: 'Viewers', value: Number(liveData.viewerCount).toLocaleString(), inline: true });
        }
    }

    // Escape Discord markdown characters in usernames to prevent formatting issues
    const safeUsername = liveData.username.replace(/([_*~`|\\])/g, '\\$1');

    const messageTemplate = subContext.custom_message || serverDefaultMessage(guildSettings?.announcement_message);
    let content = messageTemplate
        ? messageTemplate
            .replace(/{username}/g, safeUsername)
            .replace(/{streamer}/g, safeUsername)
            .replace(/{platform}/g, platformName)
            .replace(/{url}/g, liveData.url)
            .replace(/{title}/g, (liveData.title || 'Untitled Stream').replace(/([_*~`|\\])/g, '\\$1'))
            .replace(/{game}/g, (liveData.game || 'N/A').replace(/([_*~`|\\])/g, '\\$1'))
            .replace(/{everyone}/g, '@everyone')
        : null;
    // Discord rejects content over 2000 characters, which would lose the whole announcement.
    if (content && content.length > 2000) content = content.slice(0, 2000);

    // Build ping mention separately — sent as its own message so edits don't suppress the notification
    let pingMention = null;
    if (subContext.ping_role_id) {
        pingMention = subContext.ping_role_id === 'everyone' ? '@everyone' : `<@&${subContext.ping_role_id}>`;
    }

    // H-311: may this edit go out now? (New posts always go out.)
    const renderFp = renderFingerprint({ renderStyle, liveData, content, subContext, guildSettings, teamSettings, embed, v2Container, avatarFile });
    if (editCtx?.messageId && editCtx.channelId) {
        const verdict = editGovernor.check({ ...editCtx, ...renderFp });
        if (!verdict.ok) {
            noteHeldBack(verdict, editCtx, liveData, subContext);
            // Unchanged: the post already shows this, so callers may record it as current.
            // Anything else was not applied: null, so callers keep their old state and retry.
            return verdict.reason === 'unchanged'
                ? { id: editCtx.messageId, unchanged: true, pingMessageId: existingAnnouncement?.ping_message_id ?? existingAnnouncement?.pingMessageId ?? null }
                : null;
        }
        editGovernor.begin(editCtx);
        editCtx.began = true;
    }

    try {
        // Load guild appearance overrides (custom bot avatar from dashboard)
        let guildAppearance = null;
        try {
            const [appearanceRows] = await pool.execute(
                'SELECT bot_avatar_url, bot_nickname FROM guild_config WHERE guild_id = ?',
                [subContext.guild_id]
            );
            if (appearanceRows.length > 0) guildAppearance = appearanceRows[0];
        } catch { /* ignore */ }

        // Determine if this guild uses webhook persona (streamer name/avatar) or bot-direct mode
        // A subscription can override the server: 1 = post as the streamer, 0 = as the bot.
        const subPersona = subContext.post_as_streamer;
        const useWebhookPersona = subPersona === 1 || subPersona === 0
            ? subPersona === 1
            : guildSettings?.use_webhook_persona === 1;
        // If guild has a custom avatar configured, force webhook mode so the custom avatar appears
        const hasCustomAvatar = !!guildAppearance?.bot_avatar_url;

        // Always use platform username, not Discord username
        let finalNickname = liveData.username;
        // Start with custom guild avatar, team avatar, or default bot avatar
        let finalAvatarURL = guildAppearance?.bot_avatar_url || teamSettings?.webhook_avatar_url || client.user.displayAvatarURL();

        if (useWebhookPersona) {
            // If streamer has linked Discord account, use their Discord avatar
            if (subContext.discord_user_id) {
                try {
                    const discordUser = await client.users.fetch(subContext.discord_user_id);
                    if (discordUser) {
                        finalAvatarURL = discordUser.displayAvatarURL({ size: 256 });
                    }
                } catch (error) {
                    logger.warn(`[Announcer] Failed to fetch Discord user avatar for ${liveData.username}`, {
                        discordUserId: subContext.discord_user_id,
                        error,
                        category: 'announcer'
                    });
                    finalAvatarURL = liveData.profileImageUrl || finalAvatarURL;
                }
            } else {
                finalAvatarURL = liveData.profileImageUrl || finalAvatarURL;
            }

            // Allow channel/subscriber-specific overrides
            if (channelSettings?.override_avatar_url) finalAvatarURL = channelSettings.override_avatar_url;
            if (subContext.override_avatar_url) finalAvatarURL = subContext.override_avatar_url;
            if (subContext.override_nickname) finalNickname = subContext.override_nickname;
            else if (channelSettings?.override_nickname) finalNickname = channelSettings.override_nickname;
        }

        // If guild has a custom avatar but is in bot-direct mode, use the guild's
        // custom bot name for the webhook (not the streamer's name)
        if (!useWebhookPersona && hasCustomAvatar) {
            finalNickname = guildAppearance?.bot_nickname || client.user.username;
        }

        // ── Bot-direct mode: send as the bot via channel.send() ──
        // If guild has a custom avatar, use webhook instead so the avatar appears
        if (!useWebhookPersona && !hasCustomAvatar) {
            const channel = client.channels.cache.get(targetChannelId)
                || await client.channels.fetch(targetChannelId).catch(() => null);

            if (!channel) {
                logger.error(`[Announcer] Channel ${targetChannelId} not found for bot-direct send.`, {
                    guildId: subContext.guild_id, category: 'announcer'
                });
                // A deleted channel never comes back, so without this the same
                // subscription re-fails every cycle forever — one dead channel was
                // logging ~34 errors a day on its own. Detach the subscription from it
                // so the guild-level announcement channel takes over on the next check.
                //
                // Only clear the column when it still literally points at the channel we
                // just failed on: targetChannelId can also come from a live-routing rule
                // or the guild default, and neither of those is ours to rewrite here.
                await clearDeadAnnouncementChannel(subContext, targetChannelId);
                return null;
            }

            const botMessageOptions = v2Container
                ? {
                    // Components V2 replaces `embeds` entirely; must set flag or Discord rejects.
                    components: [v2Container],
                    flags: MessageFlags.IsComponentsV2,
                    ...(avatarFile ? { files: [avatarFile] } : {}),
                    // IMPORTANT: no `content` key — Components V2 is incompatible with top-level content.
                }
                : {
                    content: content || undefined,
                    embeds: [embed],
                    ...(avatarFile ? { files: [avatarFile] } : {})
                };

            let shouldSendNew = !existingAnnouncement?.message_id;

            if (existingAnnouncement?.message_id) {
                try {
                    const existingMsg = await channel.messages.fetch(existingAnnouncement.message_id);
                    // Only the message author can edit — if this was a webhook message, edit will fail
                    if (existingMsg.author.id === client.user.id) {
                        // attachments: [] ALWAYS — not just when re-uploading. It drops the previous
                        // upload so a re-rendered card replaces it instead of leaving a second,
                        // stale copy behind; and when this announcement has switched to the
                        // platform-preview style there is no new file at all, so without it the old
                        // card stays bolted to the message, still reading LIVE, under the preview.
                        const editedMessage = await existingMsg.edit({ ...botMessageOptions, attachments: [] });
                        if (editedMessage?.id) editGovernor.recordApplied(String(editedMessage.id), renderFp);
                        logger.debug(`[Announcer] Bot-direct message edited for ${liveData.username} - Message ID: ${editedMessage?.id || 'NO_ID'}`, {
                            username: liveData.username, channelId: targetChannelId, messageId: editedMessage?.id, category: 'announcer'
                        });
                        // Preserve the ping message id across edits so it isn't lost on save/cleanup
                        if (editedMessage) editedMessage.pingMessageId = existingAnnouncement?.ping_message_id ?? existingAnnouncement?.pingMessageId ?? null;
                        return editedMessage;
                    } else {
                        // Existing message was sent by webhook — leave it alone until stream ends
                        logger.info(`[Announcer] Existing announcement for ${liveData.username} is a webhook message — skipping edit, will use bot-direct on next stream`, {
                            username: liveData.username, channelId: targetChannelId, messageId: existingAnnouncement.message_id, category: 'announcer'
                        });
                        if (existingMsg) existingMsg.pingMessageId = existingAnnouncement?.ping_message_id ?? existingAnnouncement?.pingMessageId ?? null;
                        return existingMsg;
                    }
                } catch (e) {
                    if (e instanceof DiscordAPIError && e.code === 10008) {
                        if (!(await stillTrackedForResend(subContext, liveData, targetChannelId, existingAnnouncement.message_id))) return null;
                        logger.warn(`[Announcer] Old message not found (code 10008) - sending new bot-direct message for ${liveData.username}`, {
                            username: liveData.username, messageId: existingAnnouncement.message_id, channelId: targetChannelId, category: 'announcer'
                        });
                        shouldSendNew = true;
                    } else {
                        // Message exists but edit failed for other reason — don't spam a new one
                        logger.warn(`[Announcer] Failed to edit existing bot-direct announcement — keeping existing message - ${e.message}`, {
                            guildId: subContext.guild_id, messageId: existingAnnouncement.message_id, error: e.message, category: 'announcer'
                        });
                        return null;
                    }
                }
            }

            if (shouldSendNew) {
                // Send ping as separate message first (so it triggers a notification that survives embed edits)
                let pingMessageId = null;
                if (pingMention) {
                    try {
                        const pingMsg = await channel.send({ content: pingMention });
                        pingMessageId = pingMsg.id;
                    } catch (err) {
                        logger.warn(`[Announcer] Failed to send ping message for ${liveData.username}:`, { error: err.message, category: 'announcer' });
                    }
                }

                const sentMessage = await channel.send(botMessageOptions);
                if (sentMessage?.id) editGovernor.recordApplied(String(sentMessage.id), renderFp);
                logger.info(`[Announcer] Bot-direct message sent for ${liveData.username} - Message ID: ${sentMessage?.id || 'NO_ID'}`, {
                    username: liveData.username, channelId: targetChannelId, messageId: sentMessage?.id, pingMessageId, category: 'announcer'
                });
                pool.execute(
                    'INSERT INTO global_stats (id, total_announcements) VALUES (1, 1) ON DUPLICATE KEY UPDATE total_announcements = total_announcements + 1'
                );
                if (sentMessage) sentMessage.pingMessageId = pingMessageId;
                return sentMessage;
            }
            return null;
        }

        // ── Webhook persona mode: send as the streamer via webhook ──
        const webhookClient = await getWebhookClient(client, targetChannelId, finalNickname, finalAvatarURL);
        // A WebhookClient has its own REST queue; its limits apply to this channel.
        if (webhookClient?.rest) watchRestLimits(webhookClient.rest, editCtx?.botKey || client.user?.id || 'bot', String(targetChannelId));
        if (!webhookClient) {
            logger.error(`[Announcer] Webhook client is null for channel ${targetChannelId}. Cannot send/edit message.`, {
                guildId: subContext.guild_id,
                channelId: targetChannelId,
                category: 'announcer'
            });
            return null;
        }

        // Cache-bust the avatar URL so Discord doesn't serve a stale/failed cached version
        const cacheBustedAvatar = finalAvatarURL && !finalAvatarURL.includes('cdn.discordapp.com')
            ? `${finalAvatarURL}${finalAvatarURL.includes('?') ? '&' : '?'}v=${Math.floor(Date.now() / 3600000)}`
            : finalAvatarURL;

        const messageOptions = v2Container
            ? {
                username: finalNickname,
                avatarURL: cacheBustedAvatar,
                // Components V2 — no `content`/`embeds` keys; flag is required.
                components: [v2Container],
                flags: MessageFlags.IsComponentsV2,
                ...(avatarFile ? { files: [avatarFile] } : {}),
            }
            : {
                username: finalNickname,
                avatarURL: cacheBustedAvatar,
                content: content || undefined,
                embeds: [embed],
                ...(avatarFile ? { files: [avatarFile] } : {})
            };

        // Debug: Log embed structure for Kick
        if (liveData.platform === 'kick') {
            const embedData = embed.toJSON();
            logger.info(`[Announcer] Embed data for ${liveData.username}:`, {
                hasImage: !!embedData.image,
                imageUrl: embedData.image?.url,
                embedKeys: Object.keys(embedData),
                category: 'announcer'
            });
        }

        // Try to edit existing message if it exists
        let shouldSendNew = !existingAnnouncement?.message_id;

        if (existingAnnouncement?.message_id) {
            try {
                // attachments: [] ALWAYS — see the bot-direct edit above. Conditioning it on
                // avatarFile left the old card attached whenever the new render had no file,
                // which is every edit once an announcement uses the platform-preview style.
                const editedMessage = await webhookClient.editMessage(existingAnnouncement.message_id,
                    { ...messageOptions, attachments: [] });
                if (editedMessage?.id) editGovernor.recordApplied(String(editedMessage.id), renderFp);
                logger.debug(`[Announcer] Message edited for ${liveData.username} - Message ID: ${editedMessage?.id || 'NO_ID'}`, {
                    username: liveData.username,
                    channelId: targetChannelId,
                    messageId: editedMessage?.id,
                    category: 'announcer'
                });
                // Preserve the ping message id across edits so it isn't lost on save/cleanup
                if (editedMessage) editedMessage.pingMessageId = existingAnnouncement?.ping_message_id ?? existingAnnouncement?.pingMessageId ?? null;
                return editedMessage;
            } catch (e) {
                if (e instanceof DiscordAPIError && e.code === 10008) { // Unknown Message
                    if (!(await stillTrackedForResend(subContext, liveData, targetChannelId, existingAnnouncement.message_id))) return null;
                    logger.warn(`[Announcer] Old message not found (code 10008) - sending new message for ${liveData.username}`, {
                        username: liveData.username,
                        messageId: existingAnnouncement.message_id,
                        channelId: targetChannelId,
                        category: 'announcer'
                    });
                } else {
                    logger.warn(`[Announcer] Failed to edit existing announcement, will send new message - ${e.message}`, {
                        guildId: subContext.guild_id,
                        messageId: existingAnnouncement.message_id,
                        error: e.message,
                        category: 'announcer'
                    });
                }
                shouldSendNew = true;
            }
        }

        // Send new message if no existing message or if old message was deleted
        if (shouldSendNew) {
            // Send ping as separate bot-direct message first (not via webhook, so it triggers a real notification)
            let pingMessageId = null;
            if (pingMention) {
                try {
                    const channel = client.channels.cache.get(targetChannelId)
                        || await client.channels.fetch(targetChannelId).catch(() => null);
                    if (channel) {
                        const pingMsg = await channel.send({ content: pingMention });
                        pingMessageId = pingMsg.id;
                    }
                } catch (err) {
                    logger.warn(`[Announcer] Failed to send ping message for ${liveData.username}:`, { error: err.message, category: 'announcer' });
                }
            }

            const sentMessage = await webhookClient.send(messageOptions);
            if (sentMessage?.id) editGovernor.recordApplied(String(sentMessage.id), renderFp);
            logger.info(`[Announcer] Message sent for ${liveData.username} - Message ID: ${sentMessage?.id || 'NO_ID'}`, {
                username: liveData.username,
                channelId: targetChannelId,
                messageId: sentMessage?.id,
                hasId: !!sentMessage?.id,
                pingMessageId,
                category: 'announcer'
            });
            pool.execute(
                'INSERT INTO global_stats (id, total_announcements) VALUES (1, 1) ON DUPLICATE KEY UPDATE total_announcements = total_announcements + 1'
            );
            if (sentMessage) sentMessage.pingMessageId = pingMessageId;
            return sentMessage;
        }
    } catch (error) {
        logger.error(`[Announcer] CRITICAL Failure for ${liveData.username}.`, {
            error,
            guildId: subContext.guild_id,
            channelId: targetChannelId,
            category: 'announcer'
        });
        return null;
    }
}

/**
 * Deletes an announcement message
 */
// Discord says the message (10008 Unknown Message) or its whole channel (10003 Unknown Channel) no longer
// exists. For a delete that is the goal already reached, and for a stream-ended edit there is nothing left
// to edit: either way the tracking record can go. Anything else (missing access, network) stays a failure
// to retry. These used to be indistinguishable (`.catch(() => null)`), so a message someone deleted by
// hand was retried every cycle forever.
const GONE_CODES = new Set([10003, 10008]);
const isGone = (error) => GONE_CODES.has(error?.code);

async function deleteAnnouncement(client, channelId, messageId) {
    try {
        let channelError = null;
        const channel = await client.channels.fetch(channelId).catch(error => { channelError = error; return null; });
        if (!channel || !channel.isTextBased()) {
            if (isGone(channelError)) {
                logger.info(`[Announcer] Channel ${channelId} no longer exists; announcement ${messageId} went with it`, {
                    channelId, messageId, category: 'announcer'
                });
                return true;
            }
            logger.warn(`[Announcer] Channel ${channelId} not found or not text-based for message deletion.`, {
                category: 'announcer', code: channelError?.code
            });
            return false;
        }

        let fetchError = null;
        const message = await channel.messages.fetch(messageId).catch(error => { fetchError = error; return null; });
        if (!message && isGone(fetchError)) {
            logger.info(`[Announcer] Announcement ${messageId} was already deleted from channel ${channelId}`, {
                channelId, messageId, category: 'announcer'
            });
            return true;
        }
        if (message) {
            await message.delete();
            logger.info(`[Announcer] Deleted announcement message ${messageId} in channel ${channelId}`, {
                channelId,
                messageId,
                category: 'announcer'
            });
            return true;
        } else {
            logger.warn(`[Announcer] Message ${messageId} not found in channel ${channelId}`, {
                channelId,
                messageId,
                code: fetchError?.code,
                category: 'announcer'
            });
            return false;
        }
    } catch (error) {
        if (isGone(error)) return true; // deleted between the fetch and the delete
        logger.error(`[Announcer] Failed to delete announcement message ${messageId}:`, {
            error,
            channelId,
            messageId,
            category: 'announcer'
        });
        return false;
    }
}

/**
 * Edits an announcement to show "stream has ended" with optional VOD link.
 * Used instead of deleting for specific guild/channel combos.
 *
 * @param {import('discord.js').Client} client - Discord client
 * @param {string} channelId - Channel containing the message
 * @param {string} messageId - Message to edit
 * @param {string} username - Streamer username
 * @param {string} platform - Platform name
 * @param {{ url: string, title: string } | null} vod - VOD info or null
 * @returns {Promise<boolean>} true if edited successfully
 */
async function editAnnouncementStreamEnded(client, channelId, messageId, username, platform, vod) {
    try {
        let channelError = null;
        const channel = await client.channels.fetch(channelId).catch(error => { channelError = error; return null; });
        if (!channel || !channel.isTextBased()) {
            if (isGone(channelError)) return true; // the channel is gone: nothing left to edit
            logger.warn(`[Announcer] Channel ${channelId} not found for stream-ended edit`, { category: 'announcer', code: channelError?.code });
            return false;
        }

        let fetchError = null;
        const message = await channel.messages.fetch(messageId).catch(error => { fetchError = error; return null; });
        if (!message) {
            if (isGone(fetchError)) return true; // someone deleted it: nothing left to edit
            logger.warn(`[Announcer] Message ${messageId} not found for stream-ended edit`, { category: 'announcer', code: fetchError?.code });
            return false;
        }

        const platformName = platform.charAt(0).toUpperCase() + platform.slice(1);
        const existingEmbed = message.embeds[0];

        const embed = new EmbedBuilder()
            .setColor('#808080')
            .setAuthor({ name: `${username} was LIVE on ${platformName}`, url: existingEmbed?.url || undefined })
            .setTitle('Stream has ended')
            .setTimestamp();

        if (existingEmbed?.url) embed.setURL(existingEmbed.url);

        if (vod) {
            embed.setDescription(`**[Watch the VOD](${vod.url})**\n${vod.title}`);
        } else {
            embed.setDescription('This streamer does not have VODs enabled — sorry you missed the stream!');
        }

        // The live card has "LIVE" painted into the image, so it must not survive the stream.
        // Replace it with a greyed-out OFFLINE card; if that can't be rendered, drop the image
        // altogether rather than leave a card still claiming the stream is live.
        //
        // Either way the edit must pass `attachments: []` — without it Discord keeps the old
        // upload, and because the new embed no longer references attachment://stream.png it
        // would hang below the message as a bare image still reading LIVE.
        // In 'twitch' style there is no card to replace — the live preview is a hotlink, and
        // Twitch keeps serving that URL (stale frame or offline placeholder) after the stream
        // ends. Dropping the image is the honest end state; the avatar thumbnail stays.
        let offlineFile = null;
        try {
            const [[streamer]] = await pool.execute(
                'SELECT streamer_id, profile_image_url FROM streamers WHERE username = ? AND platform = ? LIMIT 1',
                [username, platform]
            );
            const { style: endedStyle } = await resolveStyle({
                guildId: channel.guild?.id,
                channelId,
                streamerId: streamer?.streamer_id,
            });

            if (endedStyle === 'card') {
                const avatar = streamer?.profile_image_url ? await fetchAvatarAttachment(streamer.profile_image_url) : null;
                const png = await renderStreamCard({
                    username,
                    title: 'Stream has ended',
                    game: existingEmbed?.fields?.find(f => f.name === 'Playing')?.value || null,
                    platform,
                    avatarBuffer: avatar?.attachment,
                    offline: true,
                });
                if (png) {
                    offlineFile = { attachment: png, name: 'stream.png' };
                    embed.setImage('attachment://stream.png');
                }
            } else if (streamer?.profile_image_url) {
                embed.setThumbnail(streamer.profile_image_url);
            }
        } catch (error) {
            logger.warn(`[Announcer] Could not build offline card for ${username}: ${error.message}`, { category: 'announcer' });
        }

        // Webhook messages can only be edited via the webhook client, not message.edit().
        // Pass empty content explicitly so any @everyone/role mention left in the original
        // message body clears on edit (Discord preserves prior `content` if you don't supply it).
        if (message.webhookId) {
            const webhookClient = await getWebhookClient(client, channelId);
            if (!webhookClient) {
                logger.error(`[Announcer] Cannot get webhook client to edit stream-ended for ${username} in channel ${channelId}`, { category: 'announcer' });
                return false;
            }
            await webhookClient.editMessage(messageId, {
                content: '', embeds: [embed], attachments: [], ...(offlineFile ? { files: [offlineFile] } : {})
            });
        } else {
            await message.edit({
                content: '', embeds: [embed], attachments: [], ...(offlineFile ? { files: [offlineFile] } : {})
            });
        }

        logger.info(`[Announcer] Edited announcement to stream-ended for ${username}`, {
            channelId, messageId, hasVod: !!vod, isWebhook: !!message.webhookId, category: 'announcer'
        });
        return true;
    } catch (error) {
        logger.error(`[Announcer] Failed to edit announcement for stream-ended: ${error.message}`, {
            channelId, messageId, username, error: error.message, category: 'announcer'
        });
        return false;
    }
}

export { updateAnnouncement, getWebhookClient, deleteAnnouncement, editAnnouncementStreamEnded, invalidateWebhookCache, describeAnnouncementEdit };
export default { updateAnnouncement, getWebhookClient, deleteAnnouncement, editAnnouncementStreamEnded, invalidateWebhookCache, describeAnnouncementEdit };
