import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import configCache from '../utils/configCache.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|avif|heic)(\?|#|$)/i;
const URL_RE = /https?:\/\/[^\s<>]+/gi;

function parseJsonArray(value, label) {
    if (!value) return [];
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        logger.warn(`[ChannelPostRules] Malformed ${label} JSON — treating as empty`);
        return [];
    }
}

async function getRule(guildId, channelId) {
    return configCache.get('channel_post_rules', `${guildId}:${channelId}`, async () => {
        const [rows] = await pool.execute(
            'SELECT * FROM channel_post_rules WHERE guild_id = ? AND channel_id = ? AND enabled = 1',
            [guildId, channelId]
        );
        return rows[0] || null;
    });
}

/**
 * Does this message carry a real image?
 *
 * Deliberately does NOT count `message.embeds`. Discord generates link previews
 * asynchronously — at messageCreate they're empty — and when they do arrive a
 * twitch.tv preview carries a thumbnail, which would let the exact post we're
 * trying to block satisfy an "has an image" check.
 */
function hasImage(message) {
    for (const att of message.attachments.values()) {
        if (att.contentType?.startsWith('image/')) return true;
        if (IMAGE_EXT.test(att.name || att.url || '')) return true;
    }
    // A direct link to an image file counts — some people paste a CDN URL.
    for (const url of message.content.match(URL_RE) || []) {
        if (IMAGE_EXT.test(url)) return true;
    }
    return false;
}

function blockedDomainHit(message, domains) {
    if (!domains.length) return null;
    for (const url of message.content.match(URL_RE) || []) {
        let host;
        try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; }
        const hit = domains.find(d => {
            const dom = String(d).toLowerCase().replace(/^www\./, '');
            return host === dom || host.endsWith(`.${dom}`);
        });
        if (hit) return hit;
    }
    return null;
}

/**
 * Messages the author has sent in this guild recently, EXCLUDING the gated
 * channel itself — otherwise posting in the events channel would build the
 * activity that grants access to the events channel.
 */
async function recentMessageCount(guildId, userId, channelId, windowDays) {
    const [rows] = await pool.execute(
        `SELECT COALESCE(SUM(count), 0) AS n FROM activity_logs
         WHERE guild_id = ? AND user_id = ? AND type = 'message'
           AND channel_id <> ? AND log_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`,
        [guildId, userId, channelId, windowDays]
    );
    return Number(rows[0]?.n) || 0;
}

/**
 * Check a message against its channel's posting rules.
 *
 * @returns {Promise<{allowed: boolean, reasons?: string[], rule?: object}>}
 */
export async function checkChannelPostRules(message) {
    if (!message.guild || !message.author || message.author.bot || message.webhookId) {
        return { allowed: true };
    }

    const rule = await getRule(message.guild.id, message.channel.id);
    if (!rule) return { allowed: true };

    const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return { allowed: true };

    // Staff always post freely — they're the ones announcing most events.
    if (member.permissions.has(PermissionFlagsBits.ManageMessages)
        || member.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return { allowed: true };
    }
    const exemptRoles = parseJsonArray(rule.exempt_role_ids, 'exempt_role_ids');
    if (exemptRoles.some(id => member.roles.cache.has(id))) return { allowed: true };

    const reasons = [];

    if (rule.require_image && !hasImage(message)) {
        reasons.push('Posts here need an **image attached to the same message**. A link on its own, or a link with a caption, is not enough.');
    }

    const blocked = blockedDomainHit(message, parseJsonArray(rule.blocked_link_domains, 'blocked_link_domains'));
    if (blocked) {
        reasons.push(`**${blocked}** links aren't allowed in this channel.`);
    }

    if (rule.min_level > 0) {
        // Same source /rank and the self-promo announce gate read, so the number
        // a member sees on their rank card is the number that gates them here.
        const lm = message.client?.levelingManager;
        const rank = lm?.getUserRank ? await lm.getUserRank(message.guild.id, message.author.id).catch(() => null) : null;
        const level = Number(rank?.level) || 0;
        if (level < rule.min_level) {
            reasons.push(`You need to be **level ${rule.min_level}+** to post here (you're level ${level}). Chat around the server to earn XP — check yours with \`/level\`.`);
        }
    }

    if (rule.min_messages > 0) {
        const sent = await recentMessageCount(
            message.guild.id, message.author.id, message.channel.id, rule.activity_window_days
        );
        if (sent < rule.min_messages) {
            reasons.push(`You need to be **active in the server first** — at least ${rule.min_messages} messages elsewhere in the last ${rule.activity_window_days} days (you have ${sent}).`);
        }
    }

    if (rule.min_member_days > 0 && member.joinedTimestamp) {
        const days = Math.floor((Date.now() - member.joinedTimestamp) / 86400000);
        if (days < rule.min_member_days) {
            reasons.push(`You need to have been in the server at least **${rule.min_member_days} days** (you joined ${days} day${days === 1 ? '' : 's'} ago).`);
        }
    }

    // Checked last on purpose. If a post is going to be refused for missing its
    // image anyway, the member should hear that — not "come back tomorrow".
    if (rule.cooldown_hours > 0 && reasons.length === 0) {
        const waited = await cooldownRemaining(
            message.guild.id, message.channel.id, message.author.id, rule.cooldown_hours
        );
        if (waited) {
            reasons.push(`You can post here **once every ${describeHours(rule.cooldown_hours)}**. Your next one is ready in **${waited}**.`);
        }
    }

    if (reasons.length === 0) {
        // Passed everything: start their clock. Only a post that actually stands counts.
        if (rule.cooldown_hours > 0) {
            await recordPost(message.guild.id, message.channel.id, message.author.id);
        }
        return { allowed: true };
    }
    return { allowed: false, reasons, rule };
}

/** "24 hours" reads better than "1 day" for a limit people are counting down. */
function describeHours(hours) {
    if (hours % 24 === 0 && hours >= 24) {
        const d = hours / 24;
        return d === 1 ? '24 hours' : `${d} days`;
    }
    return hours === 1 ? 'hour' : `${hours} hours`;
}

/** How long is left, as a human phrase, or null if they're free to post. */
async function cooldownRemaining(guildId, channelId, userId, hours) {
    let rows;
    try {
        [rows] = await pool.execute(
            'SELECT last_post_at FROM channel_post_cooldowns WHERE guild_id = ? AND channel_id = ? AND user_id = ?',
            [guildId, channelId, userId]
        );
    } catch (e) {
        // A cooldown table that cannot be read must not silently block the channel.
        logger.warn(`[ChannelPostRules] cooldown lookup failed, allowing: ${e.message}`, { category: 'moderation' });
        return null;
    }
    if (!rows.length) return null;

    const readyAt = new Date(rows[0].last_post_at).getTime() + hours * 3600000;
    const left = readyAt - Date.now();
    if (left <= 0) return null;

    const h = Math.floor(left / 3600000);
    const m = Math.ceil((left % 3600000) / 60000);
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
}

async function recordPost(guildId, channelId, userId) {
    try {
        await pool.execute(
            `INSERT INTO channel_post_cooldowns (guild_id, channel_id, user_id, last_post_at, post_count)
             VALUES (?, ?, ?, NOW(), 1)
             ON DUPLICATE KEY UPDATE last_post_at = NOW(), post_count = post_count + 1`,
            [guildId, channelId, userId]
        );
    } catch (e) {
        logger.warn(`[ChannelPostRules] could not record the post: ${e.message}`, { category: 'moderation' });
    }
}

/**
 * Enforce the rules: delete the offending message, tell the author why, and log it.
 *
 * @returns {Promise<boolean>} true if the message was handled (caller should stop).
 */
/**
 * The member's notice. With "Delete posts that break a rule" off the post stays up, so it must not
 * say it was removed (it always did).
 */
export function violationNotice(channelId, reasons, deleted) {
    const lead = deleted ? `Your message in <#${channelId}> was removed:` : `Your message in <#${channelId}> breaks this channel's posting rules:`;
    return `${lead}\n${reasons.map(r => `• ${r}`).join('\n')}`;
}

export async function enforceChannelPostRules(message) {
    let result;
    try {
        result = await checkChannelPostRules(message);
    } catch (error) {
        // Never let a rules failure eat a message — fail open.
        logger.error('[ChannelPostRules] Check failed — allowing message', {
            error: error.message, guildId: message.guild?.id, channelId: message.channel?.id,
        });
        return false;
    }
    if (result.allowed) return false;

    const { reasons, rule } = result;

    if (rule.delete_violations) {
        await message.delete().catch(err => {
            logger.warn('[ChannelPostRules] Could not delete message', {
                error: err.message, messageId: message.id, channelId: message.channel.id,
            });
        });
    }

    if (rule.notify_user) {
        const body = violationNotice(message.channel.id, reasons, !!rule.delete_violations);
        // DM first; fall back to a self-deleting in-channel note if DMs are closed.
        const dmed = await message.author.send(body).then(() => true).catch(() => false);
        if (!dmed && rule.delete_violations) {
            const note = await message.channel.send({
                content: `<@${message.author.id}> ${body}`,
                allowedMentions: { users: [message.author.id] },
            }).catch(() => null);
            if (note) setTimeout(() => note.delete().catch(() => {}), 30_000);
        }
    }

    if (rule.log_channel_id) {
        const logCh = await message.guild.channels.fetch(rule.log_channel_id).catch(() => null);
        if (logCh) {
            await logCh.send({
                embeds: [{
                    title: rule.delete_violations ? 'Post removed by channel post rules' : 'Post broke the channel post rules (left up)',
                    color: 0xE74C3C,
                    fields: [
                        { name: 'Author', value: `<@${message.author.id}> (${message.author.id})` },
                        { name: 'Channel', value: `<#${message.channel.id}>` },
                        { name: 'Why', value: reasons.join('\n').slice(0, 1024) },
                        { name: 'Content', value: (message.content || '*(no text)*').slice(0, 1024) },
                    ],
                    timestamp: new Date().toISOString(),
                }],
            }).catch(() => {});
        }
    }

    logger.info('[ChannelPostRules] Removed non-conforming post', {
        guildId: message.guild.id, channelId: message.channel.id,
        userId: message.author.id, reasons,
    });
    return true;
}

export default { checkChannelPostRules, enforceChannelPostRules, violationNotice };
