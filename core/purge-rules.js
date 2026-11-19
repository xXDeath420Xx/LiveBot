/**
 * Content-aware purge rules — matching logic and time/snowflake helpers.
 *
 * Deliberately pure and Discord-free below `evaluateMessage`: everything it
 * needs is lifted off the message into a plain object first, so the matcher can
 * be reasoned about (and tested) without a gateway.
 *
 * The destructive half lives in jobs/purge-rule-sweeper.js.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import configCache from '../utils/configCache.js';

export const DISCORD_EPOCH = 1420070400000;

/** Lowest snowflake that could have been created at `ms`. */
export function snowflakeForTimestamp(ms) {
    const delta = Math.max(0, Math.floor(ms) - DISCORD_EPOCH);
    // BigInt because (delta << 22) overflows a double well inside Discord's range.
    return (BigInt(delta) << 22n).toString();
}

/** Creation time encoded in a snowflake. */
export function timestampForSnowflake(id) {
    return Number((BigInt(id) >> 22n)) + DISCORD_EPOCH;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|avif|heic)(\?|#|$)/i;
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v)(\?|#|$)/i;
const URL_RE = /https?:\/\/[^\s<>]+/gi;

function parseJson(value, fallback, label) {
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'object') return value;
    try {
        return JSON.parse(value);
    } catch {
        logger.warn(`[PurgeRules] Malformed ${label} JSON — ignoring`);
        return fallback;
    }
}

function parseArray(value, label) {
    const parsed = parseJson(value, [], label);
    return Array.isArray(parsed) ? parsed.map(String) : [];
}

/**
 * Normalise a DB row into the shape the matcher and sweeper want, so neither
 * has to know that TEXT columns hold JSON or that TINYINT holds booleans.
 */
export function normaliseRule(row) {
    const filters = parseJson(row.filters, {}, 'filters');
    return {
        id: row.id,
        guildId: row.guild_id,
        channelId: row.channel_id,
        name: row.name || 'Untitled rule',
        enabled: !!row.enabled,
        dryRun: !!row.dry_run,
        ttlSeconds: Number(row.delete_after_seconds) || 0,
        target: row.target === 'non_matching' ? 'non_matching' : 'matching',
        matchMode: row.match_mode === 'all' ? 'all' : 'any',
        filters: filters && typeof filters === 'object' ? filters : {},
        exemptPinned: !!row.exempt_pinned,
        exemptBots: !!row.exempt_bots,
        exemptRoleIds: parseArray(row.exempt_role_ids, 'exempt_role_ids'),
        exemptUserIds: parseArray(row.exempt_user_ids, 'exempt_user_ids'),
        logChannelId: row.log_channel_id || null,
        scanCursor: row.scan_cursor || null,
        scanComplete: !!row.scan_complete,
        lastRunAt: row.last_run_at,
        totalDeleted: Number(row.total_deleted) || 0,
    };
}

/**
 * Flatten a discord.js Message into the primitives the matcher reads.
 * `roleIds` may be empty when the member could not be resolved — the caller
 * decides whether that is safe (see sweeper: it skips role-exempt rules rather
 * than deleting a message it could not check).
 */
export function describeMessage(message, roleIds = []) {
    const attachments = [...message.attachments.values()];
    const content = message.content || '';
    const urls = content.match(URL_RE) || [];

    const hasImage =
        attachments.some(a => a.contentType?.startsWith('image/') || IMAGE_EXT.test(a.name || a.url || '')) ||
        urls.some(u => IMAGE_EXT.test(u));
    const hasVideo =
        attachments.some(a => a.contentType?.startsWith('video/') || VIDEO_EXT.test(a.name || a.url || '')) ||
        urls.some(u => VIDEO_EXT.test(u));

    return {
        id: message.id,
        createdTimestamp: message.createdTimestamp,
        content,
        authorId: message.author?.id || null,
        isBot: !!message.author?.bot,
        isWebhook: !!message.webhookId,
        pinned: !!message.pinned,
        hasAttachment: attachments.length > 0,
        hasImage,
        hasVideo,
        // Stickers and non-image/video uploads both count as "file" for the
        // "uploads" filter people mean when they say "delete uploads".
        hasFile: attachments.some(a => !a.contentType?.startsWith('image/') && !a.contentType?.startsWith('video/')),
        hasLink: urls.length > 0,
        hasEmbed: (message.embeds?.length || 0) > 0,
        hasSticker: (message.stickers?.size || 0) > 0,
        hasMention: (message.mentions?.users?.size || 0) > 0 || (message.mentions?.roles?.size || 0) > 0,
        length: content.length,
        roleIds: roleIds.map(String),
    };
}

/**
 * Build the list of active criteria for a rule. A criterion is a predicate plus
 * a label for logging. Inactive keys are simply absent, which is what makes
 * "no filters at all" mean "every message" instead of "no message".
 */
function activeCriteria(filters) {
    const c = [];
    const add = (label, fn) => c.push({ label, fn });

    if (filters.has_attachment) add('has an upload', m => m.hasAttachment);
    if (filters.has_image) add('has an image', m => m.hasImage);
    if (filters.has_video) add('has a video', m => m.hasVideo);
    if (filters.has_file) add('has a non-media file', m => m.hasFile);
    if (filters.has_link) add('has a link', m => m.hasLink);
    if (filters.has_embed) add('has an embed', m => m.hasEmbed);
    if (filters.has_sticker) add('has a sticker', m => m.hasSticker);
    if (filters.has_mention) add('has a mention', m => m.hasMention);
    if (filters.text_only) add('is plain text', m => !m.hasAttachment && !m.hasLink && !m.hasEmbed && !m.hasSticker);
    if (filters.from_bots) add('is from a bot', m => m.isBot || m.isWebhook);
    if (filters.from_humans) add('is from a human', m => !m.isBot && !m.isWebhook);

    const phrases = Array.isArray(filters.phrases) ? filters.phrases.filter(Boolean) : [];
    if (phrases.length) {
        const lowered = phrases.map(p => String(p).toLowerCase());
        add(`contains one of ${phrases.length} phrase(s)`, m => {
            const hay = m.content.toLowerCase();
            return lowered.some(p => hay.includes(p));
        });
    }

    if (filters.regex) {
        // Compiled once per evaluation pass, not per message.
        let re = null;
        try { re = new RegExp(filters.regex, 'i'); }
        catch { logger.warn(`[PurgeRules] Invalid regex filter — rule made inert: ${filters.regex}`); }
        // A regex that will not compile must fail CLOSED. Dropping it would
        // leave a rule whose only criterion was that regex with zero active
        // criteria, and "zero criteria" means "every message" — one typo in a
        // filter box would turn a targeted rule into a channel wipe.
        add(re ? `matches /${filters.regex}/i` : 'invalid regex (never matches)',
            re ? (m => re.test(m.content)) : (() => false));
    }

    const userIds = Array.isArray(filters.user_ids) ? filters.user_ids.map(String) : [];
    if (userIds.length) add('is from a listed user', m => userIds.includes(m.authorId));

    const roleIds = Array.isArray(filters.role_ids) ? filters.role_ids.map(String) : [];
    if (roleIds.length) add('author has a listed role', m => m.roleIds.some(r => roleIds.includes(r)));

    if (Number(filters.min_length) > 0) {
        const n = Number(filters.min_length);
        add(`is at least ${n} chars`, m => m.length >= n);
    }
    if (Number(filters.max_length) > 0) {
        const n = Number(filters.max_length);
        add(`is at most ${n} chars`, m => m.length <= n);
    }

    return c;
}

/** Does a rule need member roles resolved to make a correct decision? */
export function ruleNeedsRoles(rule) {
    return rule.exemptRoleIds.length > 0 ||
        (Array.isArray(rule.filters.role_ids) && rule.filters.role_ids.length > 0);
}

/**
 * Decide whether one message should be deleted by one rule.
 *
 * Order matters: exemptions are checked last and unconditionally, so a
 * `non_matching` rule can never delete a pinned message or a moderator's post
 * just because it failed the content filters.
 *
 * @returns {{ del: boolean, reason: string }}
 */
export function evaluateMessage(described, rule, criteria) {
    const m = described;

    if (rule.ttlSeconds > 0 && Date.now() - m.createdTimestamp < rule.ttlSeconds * 1000) {
        return { del: false, reason: 'not old enough yet' };
    }

    const crit = criteria || activeCriteria(rule.filters);
    let matched;
    let why;
    if (crit.length === 0) {
        matched = true;
        why = 'no content filters (every message)';
    } else if (rule.matchMode === 'all') {
        const failed = crit.find(x => !x.fn(m));
        matched = !failed;
        why = matched ? `all of: ${crit.map(x => x.label).join(', ')}` : `failed: ${failed.label}`;
    } else {
        const hit = crit.find(x => x.fn(m));
        matched = !!hit;
        why = matched ? hit.label : `matched none of ${crit.length} filter(s)`;
    }

    const wanted = rule.target === 'non_matching' ? !matched : matched;
    if (!wanted) {
        return { del: false, reason: rule.target === 'non_matching' ? `kept (${why})` : `no match (${why})` };
    }

    // --- Exemptions. Always win, whatever the targeting said. ---
    if (rule.exemptPinned && m.pinned) return { del: false, reason: 'pinned' };
    if (rule.exemptBots && (m.isBot || m.isWebhook)) return { del: false, reason: 'bot/webhook message' };
    if (m.authorId && rule.exemptUserIds.includes(m.authorId)) return { del: false, reason: 'exempt user' };
    if (rule.exemptRoleIds.length && m.roleIds.some(r => rule.exemptRoleIds.includes(r))) {
        return { del: false, reason: 'exempt role' };
    }

    return { del: true, reason: rule.target === 'non_matching' ? `no filter matched (${why})` : why };
}

/** Pre-compile a rule's criteria once per sweep pass. */
export function compileCriteria(rule) {
    return activeCriteria(rule.filters);
}

/** All enabled rules across every guild — used by the sweeper. */
export async function loadEnabledRules() {
    const [rows] = await pool.execute(
        'SELECT * FROM channel_purge_rules WHERE enabled = 1 AND delete_after_seconds > 0'
    );
    return rows.map(normaliseRule);
}

/** Rules for one guild, newest first — used by the dashboard. */
export async function loadGuildRules(guildId) {
    const [rows] = await pool.execute(
        'SELECT * FROM channel_purge_rules WHERE guild_id = ? ORDER BY created_at DESC',
        [guildId]
    );
    return rows;
}

/**
 * Cached per-channel lookup, for anything that wants to know "is this channel
 * governed by a purge rule" on the hot path.
 */
export async function getChannelRules(guildId, channelId) {
    return configCache.get('channel_purge_rules', `${guildId}:${channelId}`, async () => {
        const [rows] = await pool.execute(
            'SELECT * FROM channel_purge_rules WHERE guild_id = ? AND channel_id = ? AND enabled = 1',
            [guildId, channelId]
        );
        return rows.map(normaliseRule);
    });
}

/** Human-readable TTL, for the dashboard and log embeds. */
export function formatDuration(seconds) {
    const s = Number(seconds) || 0;
    const units = [['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
    const parts = [];
    let rest = s;
    for (const [name, size] of units) {
        const n = Math.floor(rest / size);
        if (n > 0) { parts.push(`${n} ${name}${n === 1 ? '' : 's'}`); rest -= n * size; }
        if (parts.length === 2) break;
    }
    return parts.join(' ') || '0 seconds';
}
