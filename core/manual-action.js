/*
 * "Manual action needed" — the one alert every automated punitive path sends when the bot cannot act
 * (rules in core/manual-action-logic.js). Started life inside core/message-threats.js (manualActionNeeded);
 * moved here so raid detection, raid lockdown, the join gate, the spammer check, name filters, avatar
 * protection, NSFW protection, verification, auto-prune, the temporary-access reaper, selfbot and adaptive
 * spam detection all say the same thing in the same place instead of each logging its own variant (or
 * nothing at all — raid detection used to skip un-kickable members silently).
 *
 *   whyCannot(guild, action, { member, channel, role })   pre-flight: the cause, or null when the bot can act
 *   whyFailed(err, guild, action, opts)                    after Discord refused: the cause, or null when it is
 *                                                          not something staff can fix by hand
 *   reportManualAction(guild, { … })                       the alert: the server log (automod.manualAction),
 *                                                          plus an extra channel when the caller has one
 *                                                          (message threats' evidence-card channel)
 *   actOrReport(guild, action, { member, channel, source }, fn)
 *                                                          the three together: pre-flight, run fn, classify a
 *                                                          refusal; true only when fn ran. The two automod
 *                                                          modules (core/automod.js, core/advanced-automod-
 *                                                          manager.js) use it for every rule action.
 *
 * The alert names exactly what is missing (Ban Members / Kick Members / Moderate Members / Manage Messages /
 * Manage Roles) or which role sits above the bot, and is throttled to one per server per cause per
 * 10 minutes (core/manual-action-logic.js throttleKey), so a raid against a bot without Ban Members is one
 * alert, not two hundred.
 */
import crypto from 'node:crypto';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import logger from '../utils/logger.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { themeColor } from './guild-theme.js';
import { classifyCannotAct, classifyError, throttleKey, needsStaff, THROTTLE_MS } from './manual-action-logic.js';

const VERB = { ban: 'ban', kick: 'kick', timeout: 'time out', delete: 'delete a message from', flag: 'flag', role: 'give a role to', quarantine: 'quarantine' };
const sentAt = new Map();   // throttle key -> ms, for the extra channel (the log has its own throttle)

/** What the bot may do in this server (and channel, for Manage Messages). */
export function botPermsIn(guild, channel = null) {
    const me = guild?.members?.me;
    const has = (p) => !!me?.permissions?.has(p);
    const inChannel = channel && me ? channel.permissionsFor?.(me) : null;
    return {
        ban: has(PermissionFlagsBits.BanMembers),
        kick: has(PermissionFlagsBits.KickMembers),
        timeout: has(PermissionFlagsBits.ModerateMembers),
        delete: inChannel ? inChannel.has(PermissionFlagsBits.ManageMessages) : has(PermissionFlagsBits.ManageMessages),
        roles: has(PermissionFlagsBits.ManageRoles),
    };
}

/**
 * Why the bot cannot do `action` to this member, or null.
 * @param {import('discord.js').Guild} guild
 * @param {string} action   ban | kick | timeout | delete | flag | role | quarantine
 * @param {{ member?:import('discord.js').GuildMember|null, channel?:object|null, role?:import('discord.js').Role|null }} [opts]
 */
export function whyCannot(guild, action, { member = null, channel = null, role = null } = {}) {
    const me = guild?.members?.me;
    const top = member?.roles?.highest ?? null;
    return classifyCannotAct({
        action,
        botPerms: botPermsIn(guild, channel),
        botTop: me?.roles?.highest?.position ?? 0,
        botTopName: me?.roles?.highest?.name ?? null,
        targetTop: member ? top?.position ?? 0 : null,
        targetTopName: top?.name ?? null,
        targetTopId: top?.id ?? null,
        targetOwner: !!member && guild?.ownerId === member.id,
        targetAdmin: !!member?.permissions?.has?.(PermissionFlagsBits.Administrator),
        rolePosition: role ? role.position : null,
        roleName: role?.name ?? null,
        roleId: role?.id ?? null,
    });
}

/** After Discord refused: the pre-flight cause if it now applies, else the error's own cause, else null. */
export function whyFailed(err, guild, action, opts = {}) {
    return whyCannot(guild, action, opts) || classifyError(err, action);
}

function keyFor(guildId, problem) {
    if (problem && typeof problem === 'object') return throttleKey(guildId, problem);
    return `manual:${guildId}:text:${crypto.createHash('sha1').update(String(problem ?? '')).digest('hex').slice(0, 12)}`;
}

/**
 * Tell staff the bot could not act, and exactly why. Never throws.
 * @param {import('discord.js').Guild} guild
 * @param {object} p
 * @param {string} p.action          ban | kick | timeout | delete | flag | role | quarantine
 * @param {string} p.source          the protection, as staff know it ("Raid detection", "Name filter", …)
 * @param {object|string} p.problem  a cause from whyCannot / whyFailed, or a sentence
 * @param {import('discord.js').GuildMember|null} [p.member]
 * @param {string|null} [p.userId]
 * @param {object|null} [p.channel]
 * @param {string|null} [p.messageUrl]
 * @param {object|null} [p.alsoChannel]  a text channel to post the alert in as well (throttled the same way)
 * @param {number} [p.count]          how many members this covers (a raid batch)
 * @returns {Promise<boolean>} true when the alert went out (false when throttled or nothing to fix)
 */
export async function reportManualAction(guild, { action, source, problem, member = null, userId = null, channel = null, messageUrl = null, alsoChannel = null, count = null }) {
    try {
        if (!guild || !problem) return false;
        if (typeof problem === 'object' && !needsStaff(problem)) return false;
        const text = typeof problem === 'object' ? problem.text : String(problem);
        const who = member?.user ?? userId;
        const target = member ? `<@${member.id}>` : userId ? `<@${userId}>` : count ? `${count} members` : 'a member';
        const verb = VERB[action] || action;
        logger.warn(`[ManualAction] ${source} could not ${action} ${member?.id ?? userId ?? ''} in ${guild.id}: ${text.replace(/\*\*/g, '')}`);
        const key = keyFor(guild.id, problem);
        void logFeatureEvent(() => (guild), 'automod.manualAction', () => ({
            title: '🛠️ Manual Action Needed',
            description: `${source} wanted to **${verb}** ${target} but could not.\n${text}`,
            fields: [['Member', who ? userLabel(who) : null], ['Members affected', count ? String(count) : null],
                ['Channel', channel ? `${channel}` : null], ['Message', messageUrl]],
            throttle: { key, ms: THROTTLE_MS },
        }));
        if (!alsoChannel?.send) return true;
        const now = Date.now();
        if (now - (sentAt.get(key) || 0) < THROTTLE_MS) return true;
        sentAt.set(key, now);
        if (sentAt.size > 5000) for (const [k, at] of sentAt) if (now - at > THROTTLE_MS) sentAt.delete(k);
        const embed = new EmbedBuilder()
            .setColor(themeColor(guild.id, 'warning'))
            .setTitle('🛠️ Manual action needed')
            .setDescription(`${source} wanted to **${verb}** ${target} but could not.\n\n${text}`.slice(0, 4000))
            .setTimestamp();
        if (messageUrl) embed.addFields({ name: 'Message', value: messageUrl, inline: false });
        await alsoChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});
        return true;
    } catch (err) {
        logger.debug(`[ManualAction] alert failed in ${guild?.id}: ${err.message}`);
        return false;
    }
}

/**
 * Do one punitive step, or say exactly why the bot could not. `fn` runs only when the pre-flight check passes
 * (skipped when the bot's own member is not cached, so a cold cache never stops an action); when Discord
 * refuses, the refusal is classified and staff are alerted if it is something they can fix. Other failures
 * (network, the message already gone) are logged at debug and swallowed. Never throws.
 * @param {import('discord.js').Guild} guild
 * @param {string} action   ban | kick | timeout | delete | flag | role | quarantine
 * @param {{ member?:object|null, channel?:object|null, role?:object|null, messageUrl?:string|null, source:string }} ctx
 * @param {() => Promise<unknown>} fn
 * @returns {Promise<boolean>} true when fn ran without throwing
 */
export async function actOrReport(guild, action, { member = null, channel = null, role = null, messageUrl = null, source }, fn) {
    const opts = { member, channel, role };
    const cannot = guild?.members?.me ? whyCannot(guild, action, opts) : null;
    if (cannot) {
        await reportManualAction(guild, { action, source, problem: cannot, member, channel, messageUrl });
        return false;
    }
    try {
        await fn();
        return true;
    } catch (err) {
        const cause = guild?.members?.me ? whyFailed(err, guild, action, opts) : classifyError(err, action);
        if (cause) await reportManualAction(guild, { action, source, problem: cause, member, channel, messageUrl });
        else logger.debug(`[ManualAction] ${source} could not ${action} in ${guild?.id}: ${err?.message}`);
        return false;
    }
}

export default { botPermsIn, whyCannot, whyFailed, reportManualAction, actOrReport };
