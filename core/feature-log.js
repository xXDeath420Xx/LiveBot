/**
 * Server-log posts for bot features (moderation, tickets, giveaways, XP…): one call per completed action.
 *
 *   void logFeatureEvent(() => guild, 'giveaway.started', () => ({
 *       title: '🎉 Giveaway Started',
 *       description: `**${prize}**`,
 *       fields: [['Host', userLabel(host)], ['Channel', `${channel}`], ['Ends', `<t:${unix}:R>`]],
 *       url: message.url,
 *   }));
 *
 * The guild, a computed action (`() => (isReroll ? 'giveaway.rerolled' : 'giveaway.ended')`) and the details
 * are passed as functions and evaluated inside this function's try/catch — immediately, so they see the values
 * at the call — so a mistake in building a log entry can never throw into the feature that called it
 * (tests/log-actions.test.js enforces this form).
 *
 * The action key (core/log-actions.js) names the category and the colour: the server's pick for that
 * action, else its default (theme-aware). The post goes wherever that category is routed, only if the server
 * has it switched on. It never throws — a failed log must not break the feature — so call it with `void`.
 * `avoidChannelIds`: skip the post when the log channel IS one of these (the feature already posted there).
 */
import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, resolveLogTarget } from './log-manager.js';
import { defaultActionColor, isLogAction } from './log-actions.js';

// throttle key -> last post (ms). In memory: a restart may repeat one post, which is fine.
const lastPosted = new Map();
function throttled({ key, ms } = {}) {
    if (!key || !ms) return false;
    const now = Date.now();
    if (now - (lastPosted.get(key) || 0) < ms) return true;
    lastPosted.set(key, now);
    if (lastPosted.size > 5000) {
        for (const [k, at] of lastPosted) if (now - at > 24 * 3600 * 1000) lastPosted.delete(k);
    }
    return false;
}

const clip = (value, max) => {
    const text = String(value);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** '<@id> (name)' for a User/GuildMember, '<@id>' for an id, 'Automatic' for null/undefined. */
export function userLabel(who) {
    if (!who) return 'Automatic';
    if (typeof who === 'string' || typeof who === 'number') return `<@${who}>`;
    const user = who.user ?? who;
    const name = user.tag ?? user.username ?? who.displayName ?? null;
    return user.id ? `<@${user.id}>${name ? ` (${name})` : ''}` : (name ?? 'Unknown');
}

const lazy = (value) => (typeof value === 'function' ? value() : value);

/**
 * @param {() => import('discord.js').Guild} guildArg   (a Guild is accepted too)
 * @param {string | (() => string)} actionArg          key from core/log-actions.js, e.g. 'tickets.closed'
 * @param {() => { title: string, description?: string, fields?: Array<[string, any, boolean?]>, url?: string,
 *           footer?: string, thumbnail?: string, avoidChannelIds?: Array<string|null|undefined>,
 *           throttle?: { key: string, ms: number } }} details
 *        fields: [name, value, inline = true]; entries whose value is null/undefined/'' are skipped.
 *        throttle: post at most once per `ms` for `key` (repeating failures, e.g. a sync whose channel is gone).
 */
export async function logFeatureEvent(guildArg, actionArg, detailsArg = {}) {
    let guild, action, details;
    try {
        guild = lazy(guildArg);
        action = lazy(actionArg);
        details = lazy(detailsArg) || {};
    } catch (error) {
        logger.warn(`[FeatureLog] Could not build a log entry (${typeof actionArg === 'string' ? actionArg : 'computed action'}): ${error.message}`);
        return;
    }
    try {
        if (!guild?.id) return;
        if (!isLogAction(action)) {
            logger.warn(`[FeatureLog] Unknown log action '${action}' — add it to core/log-actions.js`);
            return;
        }
        if (throttled(details.throttle)) return;
        const category = action.split('.')[0];
        const avoid = (details.avoidChannelIds || []).filter(Boolean).map(String);
        if (avoid.length) {
            const target = await resolveLogTarget(guild.id, category).catch(() => null);
            if (!target || avoid.includes(String(target.channelId))) return;
        }

        const embed = new EmbedBuilder()
            .setColor(defaultActionColor(guild.id, action))
            .setTitle(clip(details.title || action, 256))
            .setTimestamp();
        if (details.description) embed.setDescription(clip(details.description, 4000));
        for (const [name, value, inline = true] of (details.fields || []).slice(0, 25)) {
            if (value === null || value === undefined || value === '') continue;
            embed.addFields({ name: clip(name, 256), value: clip(value, 1024), inline });
        }
        if (details.url) embed.setURL(details.url);
        if (details.footer) embed.setFooter({ text: clip(details.footer, 2048) });
        if (details.thumbnail) embed.setThumbnail(details.thumbnail);

        await sendLogEmbed(guild, category, embed, action);
    } catch (error) {
        logger.debug(`[FeatureLog] ${action} in guild ${guild?.id}: ${error.message}`);
    }
}
