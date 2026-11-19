/**
 * What `/manage logs-setup` sets up (register H-656), kept apart from the command so it can be tested.
 *
 * The log manager (core/log-manager.js resolveLogTarget) routes by Logging-page CATEGORY: sendLogEmbed is
 * called with a category key such as 'automod' or 'memberJoin', and log_event_config is looked up by that
 * key. The old wizard wrote action keys ('automod.removed', 'memberJoin.joined', ...), which nothing reads,
 * left whole categories out (bans, unbans, moderation, join gate, AutoMod actions) and never created the
 * logging_config row, without which nothing is logged at all.
 *
 * Here every category on the Logging page (core/log-actions.js LOG_ACTIONS) goes to exactly one channel. A
 * category added to LOG_ACTIONS later, and not named below, goes to the bot log channel, so the wizard
 * never leaves one unrouted. Emoji, sticker and soundboard changes are never logged (sendLogEmbed drops
 * them), so they get no channel.
 */
import { LOG_ACTIONS } from './log-actions.js';

export const LOGS_CATEGORY_NAME = 'CF Logs';

/** The channel unlisted categories and the server-wide default use. */
export const FALLBACK_CHANNEL = 'cf-system-log';

/**
 * Channel name → the Logging-page categories it receives. Names match the old wizard's channels, so a
 * server that ran it keeps the same channels.
 */
export const LOG_CHANNEL_GROUPS = Object.freeze({
    'cf-mod-log': ['ban', 'unban', 'memberKick', 'memberTimeout', 'moderation', 'automod', 'automodAction',
        'automodRuleCreate', 'automodRuleUpdate', 'automodRuleDelete', 'join-gate'],
    'cf-member-log': ['memberJoin', 'memberLeave', 'memberUpdate', 'sticky-roles', 'autorole'],
    'cf-message-log': ['messageDelete', 'messageUpdate', 'channelPinsUpdate', 'reactionAdd', 'reactionRemove',
        'reactionRemoveAll', 'reactionRemoveEmoji', 'pollVoteAdd', 'pollVoteRemove', 'poll'],
    'cf-voice-log': ['voiceUpdate', 'voiceServerMute', 'voiceServerDeaf', 'voiceSelfMute', 'voiceStream', 'voiceVideo',
        'voiceChannelEffect', 'stageInstanceCreate', 'stageInstanceUpdate', 'stageInstanceDelete', 'temp-channels'],
    'cf-channel-log': ['channelCreate', 'channelDelete', 'channelUpdate', 'threadCreate', 'threadDelete', 'threadUpdate',
        'threadMembersUpdate', 'guildUpdate'],
    'cf-role-log': ['roleCreate', 'roleDelete', 'roleUpdate'],
    'cf-invite-log': ['inviteCreate', 'inviteDelete'],
    'cf-webhook-log': ['webhookUpdate', 'integrationUpdate'],
    'cf-event-log': ['scheduledEventCreate', 'scheduledEventUpdate', 'scheduledEventDelete', 'scheduledEventUserAdd',
        'scheduledEventUserRemove'],
    'cf-system-log': ['system', 'commandUsage', 'backup', 'team-sync', 'http', 'auto-publisher', 'twitch-schedule',
        'tickets', 'giveaway', 'xp', 'starboard', 'owoRareCatch', 'owoAdminAction'],
});

/** Categories log-manager never posts (sendLogEmbed returns early for them). */
export const isNeverLogged = (category) => /^(emoji|sticker|soundboard)/i.test(category);

/**
 * The full plan: channel name → categories, every loggable category exactly once.
 * @param {Record<string, unknown>} actions  the Logging page's categories (LOG_ACTIONS)
 * @returns {Array<{ name: string, categories: string[] }>}
 */
export function logsSetupPlan(actions = LOG_ACTIONS) {
    const known = Object.keys(actions).filter((c) => !isNeverLogged(c));
    const placed = new Set();
    const out = [];
    for (const [name, cats] of Object.entries(LOG_CHANNEL_GROUPS)) {
        const mine = cats.filter((c) => known.includes(c) && !placed.has(c));
        mine.forEach((c) => placed.add(c));
        out.push({ name, categories: mine });
    }
    const rest = known.filter((c) => !placed.has(c));
    if (rest.length) out.find((g) => g.name === FALLBACK_CHANNEL).categories.push(...rest);
    return out;
}

function parseList(raw) {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v.map(String) : [];
    } catch { return []; }
}

/**
 * What applying does to the server's logging_config row.
 *  - no row, or no event list saved: logging is switched on with every routed category ticked (and the
 *    page counted as saved, so the categories that need an explicit tick post too)
 *  - an event list the server saved on the Logging page is kept as it is: the wizard routes channels, it
 *    does not tick categories the server switched off (they are reported instead)
 *  - an empty default log channel becomes the system log channel; a chosen one is kept
 *  - logging switched off is switched on (running apply asks for logs)
 * @param {object|null} row          the logging_config row, or null
 * @param {string[]} categories      every routed category
 * @returns {{ enabledEvents: string[], setEvents: boolean, setDefaultChannel: boolean, switchOn: boolean, off: string[] }}
 */
export function planLoggingConfig(row, categories) {
    const saved = parseList(row?.enabled_events);
    const setEvents = !row || saved.length === 0;
    const enabledEvents = setEvents ? [...categories] : saved;
    return {
        enabledEvents,
        setEvents,
        setDefaultChannel: !row?.log_channel_id,
        switchOn: !!row && Number(row.enabled) === 0,
        off: categories.filter((c) => !enabledEvents.includes(c)),
    };
}
