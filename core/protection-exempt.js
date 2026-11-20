/*
 * Protection exemptions, bot-manager roles and the global pause — the live side (the rules are in
 * core/protection-exempt-logic.js). One API every automated protection calls before it acts:
 *
 *   const held = await protectionHold(member, 'ban', 'Raid detection');
 *   if (held) return;            // exempt or paused: already logged, do nothing
 *
 * protectionHold never throws. If the lookup itself fails it returns null and the protection acts
 * as it did before this existed (fail open, like the rest of the protections).
 *
 * Storage (migrations/323_protection_core.js), per guild, cached 60s and dropped on every change
 * made through this module:
 *   protection_allowlist  kind user | role | held (once held an allowlisted role) | manager
 *                         | channel | category (the message protections' ignore list, migration 327:
 *                         a category covers every channel in it, including ones made later)
 *                         | bot (trusted bots, migration 338: read by events/guildAuditLogEntryCreate.js)
 *                         | globalban (migration 471: a global ban appeal this server accepted; exempts
 *                           that person from the global ban only, never from the other protections)
 *   guilds.protection_*   the pause (+ optional auto-resume time)
 *
 * This is THE server allowlist. The automod whitelist (utils/automod-whitelist.js) and the spammer
 * allowlist (core/spammer-guard.js) were folded into it and now read and write it. Lists with a
 * different meaning stay where they are and are shown beside it on the dashboard: the anti-nuke
 * whitelist (trusted to do destructive admin actions — anti-nuke ignores this allowlist and honours
 * only the pause), invite-link permissions (automod_link_whitelist), self-bot / global-ban exempt
 * roles and commission-filter rulings.
 *
 * Managed by `/protection allowlist|managers|pause|resume|status` (commands/admin/protection/core.js)
 * and the dashboard's Protection Settings page (dashboard/routes/api/features/protection-settings.js).
 */
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { isIgnored } from './message-threat-logic.js';
import {
    decideExempt, pauseState, holdDecision, allowUserRemoval, isManagerRoles, canConfigure, whyText,
    formatDuration, MAX_ALLOWLIST, MAX_MANAGER_ROLES,
} from './protection-exempt-logic.js';

const TTL = 60_000;
const cache = new Map();   // guildId -> { at, state }

const EMPTY = () => ({
    users: new Set(), roles: new Set(), managers: new Set(), seen: new Map(), channels: new Set(), categories: new Set(), globalBan: new Set(), settings: null,
});

/** Everything for one guild, cached. A missing table (migration not yet run) reads as empty. */
export async function getState(guildId) {
    const hit = cache.get(guildId);
    if (hit && Date.now() - hit.at < TTL) return hit.state;
    const state = EMPTY();
    try {
        const [rows] = await pool.execute(
            'SELECT kind, target_id, via_role_id FROM protection_allowlist WHERE guild_id = ?', [guildId]);
        for (const r of rows) {
            if (r.kind === 'user') state.users.add(r.target_id);
            else if (r.kind === 'role') state.roles.add(r.target_id);
            else if (r.kind === 'manager') state.managers.add(r.target_id);
            else if (r.kind === 'held') state.seen.set(r.target_id, r.via_role_id);
            else if (r.kind === 'channel') state.channels.add(r.target_id);
            else if (r.kind === 'category') state.categories.add(r.target_id);
            else if (r.kind === 'globalban') state.globalBan.add(r.target_id);
        }
        const [[settings]] = await pool.execute(
            `SELECT protection_paused AS enforcement_paused, protection_paused_until AS paused_until,
                    protection_paused_by AS paused_by, protection_paused_at AS paused_at, protection_pause_reason AS pause_reason
             FROM guilds WHERE guild_id = ?`, [guildId]);
        state.settings = settings || null;
    } catch (err) {
        logger.warn(`[Protection] could not load exemptions for ${guildId}: ${err.message}`);
        return state;   // not cached: try again next time
    }
    cache.set(guildId, { at: Date.now(), state });
    return state;
}

export function invalidate(guildId) { cache.delete(guildId); }

function subjectOf(target) {
    const guild = target?.guild;
    const id = target?.id ?? target?.user?.id;
    const roleIds = target?.roles?.cache ? [...target.roles.cache.keys()].filter(r => r !== guild?.id) : [];
    return { guild, id, bot: !!(target?.user?.bot ?? target?.bot), owner: !!guild && guild.ownerId === id, roleIds };
}

async function recordHeld(guildId, userId, roleId) {
    await pool.execute(
        "INSERT IGNORE INTO protection_allowlist (guild_id, kind, target_id, via_role_id) VALUES (?, 'held', ?, ?)",
        [guildId, userId, roleId]).catch(err => logger.warn(`[Protection] could not record ${userId} holding ${roleId}: ${err.message}`));
    const hit = cache.get(guildId);
    if (hit && !hit.state.seen.has(userId)) hit.state.seen.set(userId, roleId);
}

/**
 * Is this member exempt from automated protections? Accepts a GuildMember, or `{ guild, id, user }`
 * when only the user is known (roles then come from the member cache if present).
 * @returns {Promise<{ exempt:boolean, why:string|null, text:string|null }>}
 */
export async function isExempt(target, { exemptBots = true } = {}) {
    try {
        let subject = subjectOf(target);
        if (!subject.guild || !subject.id) return { exempt: false, why: null, text: null };
        if (!target?.roles?.cache) {
            const cached = subject.guild.members?.cache?.get(subject.id);
            if (cached) subject = subjectOf(cached);
        }
        const state = await getState(subject.guild.id);
        const d = decideExempt(subject, state, { exemptBots });
        if (d.record) void recordHeld(subject.guild.id, subject.id, d.record);
        return { exempt: d.exempt, why: d.why, text: d.exempt ? whyText(d.why) : null };
    } catch (err) {
        logger.warn(`[Protection] exemption check failed: ${err.message}`);
        return { exempt: false, why: null, text: null };
    }
}

/**
 * Is enforcement paused here? Clears an auto-resume time that has passed (and says so in the log
 * when `guild` is given).
 */
export async function isPaused(guildId, guild = null) {
    try {
        const state = await getState(guildId);
        const p = pauseState(state.settings);
        if (p.expired) await autoResume(guildId, guild);
        return p.paused;
    } catch (err) {
        logger.warn(`[Protection] pause check failed for ${guildId}: ${err.message}`);
        return false;
    }
}

async function autoResume(guildId, guild) {
    const [r] = await pool.execute(
        `UPDATE guilds SET protection_paused = 0, protection_paused_until = NULL
         WHERE guild_id = ? AND protection_paused = 1 AND protection_paused_until IS NOT NULL AND protection_paused_until <= ?`,
        [guildId, new Date()]);
    invalidate(guildId);
    if (r.affectedRows) {
        logger.info(`[Protection] enforcement auto-resumed in ${guildId}`);
        if (guild) {
            void logFeatureEvent(() => (guild), 'moderation.protectionResumed', () => ({
                title: '▶️ Protections Resumed',
                description: 'The timed pause ended. Automatic protections are acting again.',
            }));
        }
    }
}

/** Pause details for status displays. */
export async function getPause(guildId) {
    const state = await getState(guildId);
    const p = pauseState(state.settings);
    const s = state.settings || {};
    return {
        paused: p.paused,
        until: p.until ? p.until.toISOString() : null,
        by: p.paused ? s.paused_by ?? null : null,
        at: p.paused && s.paused_at ? new Date(s.paused_at).toISOString() : null,
        reason: p.paused ? s.pause_reason ?? null : null,
    };
}

/**
 * The gate. Call right before an automated protection acts on a member.
 * @param target   GuildMember, or `{ guild, id, user }`
 * @param action   'ban' | 'kick' | 'timeout' | 'strip' | 'flag' | 'warn' | 'delete' | 'purge' | 'lockdown'
 * @param source   who is asking, for the log ('Raid detection')
 * @param opts.pauseOnly  honour the pause but not the allowlist (anti-nuke: trust to do destructive
 *                        admin actions is its own whitelist, not this one)
 * @returns {Promise<null | { why:'exempt'|'paused', text:string }>} null = go ahead
 */
export async function protectionHold(target, action, source, { pauseOnly = false } = {}) {
    try {
        const { guild, id } = subjectOf(target);
        if (!guild || !id) return null;
        const exempt = pauseOnly ? { exempt: false, why: null } : await isExempt(target);
        const paused = exempt.exempt ? false : await isPaused(guild.id, guild);
        const held = holdDecision({ exempt, paused, action, source });
        if (!held) { noteAutomatedAction(guild.id, id, action, source); return null; }
        const user = target.user ?? target;
        logger.info(`[Protection] ${held.text} — ${user.tag ?? user.username ?? id} in ${guild.id}`);
        void logFeatureEvent(() => (guild), 'moderation.protectionHeld', () => ({
            title: held.why === 'paused' ? '⏸️ Held — Protections Paused' : '🛡️ Held — Member Is Exempt',
            description: held.text,
            fields: [['Member', userLabel(target.user ?? id)], ['Protection', source],
                held.why === 'exempt' ? ['Exempt because', whyText(held.reason)] : ['Resume', '`/protection resume` or the dashboard']],
            // One post per member per protection per 10 minutes: an exempt spammer would otherwise post one per message.
            throttle: { key: `prot-held:${guild.id}:${id}:${source}`, ms: 600_000 },
        }));
        return { why: held.why, text: held.text };
    } catch (err) {
        logger.warn(`[Protection] hold check failed (${source}): ${err.message}`);
        return null;
    }
}

// ── automated removals in flight ─────────────────────────────────────────────
// Every go-ahead for a ban or kick is noted for two minutes, so the ban event that follows
// (events/guildBanAdd.js: the global ban network and the dashboard ban log) knows WHICH protection
// removed the member — the audit log only shows our bot. In memory: every bot runs in this process.
const PENDING_TTL = 120_000;
const pendingActions = new Map();   // `${guildId}:${userId}` -> { action, source, at }

function noteAutomatedAction(guildId, userId, action, source) {
    if (action !== 'ban' && action !== 'kick') return;
    const now = Date.now();
    if (pendingActions.size > 500) {
        for (const [k, v] of pendingActions) if (now - v.at > PENDING_TTL) pendingActions.delete(k);
    }
    pendingActions.set(`${guildId}:${userId}`, { action, source: String(source ?? ''), at: now });
}

/** The protection that was cleared to remove this member in the last two minutes (consumed), or null. */
export function takeAutomatedAction(guildId, userId) {
    const key = `${guildId}:${userId}`;
    const hit = pendingActions.get(key);
    if (!hit) return null;
    pendingActions.delete(key);
    return Date.now() - hit.at <= PENDING_TTL ? hit : null;
}

// ── bot managers ─────────────────────────────────────────────────────────────

/** Does this member hold a bot-manager role? */
export async function isManager(member) {
    if (!member?.guild) return false;
    const state = await getState(member.guild.id);
    return isManagerRoles([...member.roles.cache.keys()], state.managers);
}

/**
 * May this user configure the bot for this guild, judged live (owner, Administrator, Manage Server,
 * or a bot-manager role)? `viaManager` is true when only the manager role let them in.
 * @returns {Promise<{ ok:boolean, viaManager:boolean, isOwner:boolean, isAdmin:boolean, member:import('discord.js').GuildMember|null }>}
 */
export async function liveConfigAccess(guild, userId) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return { ok: false, viaManager: false, isOwner: false, isAdmin: false, member: null };
    const isOwner = guild.ownerId === member.id;
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
    const hasManageGuild = member.permissions.has(PermissionFlagsBits.ManageGuild);
    const state = await getState(guild.id);
    const roleIds = [...member.roles.cache.keys()];
    const ok = canConfigure({ isOwner, isAdmin, hasManageGuild, roleIds, managers: state.managers });
    return { ok, viaManager: ok && !isOwner && !isAdmin && !hasManageGuild, isOwner, isAdmin, member };
}

/** guild may be a discord.js Guild or just `{ id }` (logging then needs the real Guild and is skipped). */
const gid = (guild) => (typeof guild === 'string' ? guild : guild?.id);
const realGuild = (guild) => (guild && typeof guild === 'object' && guild.members ? guild : null);

async function listKind(guildId, kind) {
    const [rows] = await pool.execute(
        'SELECT target_id, via_role_id, added_by, note, added_at FROM protection_allowlist WHERE guild_id = ? AND kind = ? ORDER BY added_at DESC',
        [guildId, kind]);
    return rows;
}

export async function listManagers(guildId) { return listKind(guildId, 'manager'); }

export async function addManager(guild, roleId, by) {
    const state = await getState(gid(guild));
    if (!state.managers.has(roleId) && state.managers.size >= MAX_MANAGER_ROLES) {
        return { ok: false, error: `A server can have at most ${MAX_MANAGER_ROLES} manager roles.` };
    }
    await pool.execute(
        `INSERT INTO protection_allowlist (guild_id, kind, target_id, added_by) VALUES (?, 'manager', ?, ?)
         ON DUPLICATE KEY UPDATE added_by = VALUES(added_by)`,
        [gid(guild), roleId, by ?? null]);
    invalidate(gid(guild));
    listChanged(guild, 'Bot-manager role added', `<@&${roleId}>`, by);
    return { ok: true };
}

export async function removeManager(guild, roleId, by) {
    const [r] = await pool.execute("DELETE FROM protection_allowlist WHERE guild_id = ? AND kind = 'manager' AND target_id = ?", [gid(guild), roleId]);
    invalidate(gid(guild));
    if (r.affectedRows) listChanged(guild, 'Bot-manager role removed', `<@&${roleId}>`, by);
    return r.affectedRows > 0;
}

// ── allowlist ────────────────────────────────────────────────────────────────

/** Allowlisted users, roles and trusted bots: [{ kind, target_id, added_by, note, added_at }]. */
export async function listAllowlist(guildId) {
    const [rows] = await pool.execute(
        "SELECT kind, target_id, added_by, note, added_at FROM protection_allowlist WHERE guild_id = ? AND kind IN ('user','role','bot') ORDER BY added_at DESC",
        [guildId]);
    return rows;
}

/** Members recorded holding an allowlisted role: [{ target_id (user), via_role_id, added_at }]. */
export async function listSeen(guildId) { return listKind(guildId, 'held'); }

/**
 * Allowlist a user or a role. Adding a role also records every cached member holding it now, so they
 * keep their exemption if the role is later taken off them.
 * @returns {Promise<{ ok:boolean, error?:string }>}
 */
export async function addAllow(guild, kind, targetId, by, note = null) {
    // 'bot': a trusted bot (migration 338). The Protection Settings page offered it, but this refused it
    // ("Unknown kind.") and the list left it out, so no bot could ever be trusted (fixed in fix wave 6).
    if (kind !== 'user' && kind !== 'role' && kind !== 'bot') return { ok: false, error: 'Unknown kind.' };
    const guildId = gid(guild);
    const [[{ n }]] = await pool.execute(
        "SELECT COUNT(*) AS n FROM protection_allowlist WHERE guild_id = ? AND kind IN ('user','role')", [guildId]);
    if (Number(n) >= MAX_ALLOWLIST) return { ok: false, error: `The allowlist holds at most ${MAX_ALLOWLIST} entries.` };
    await pool.execute(
        `INSERT INTO protection_allowlist (guild_id, kind, target_id, added_by, note) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE added_by = VALUES(added_by), note = COALESCE(VALUES(note), note)`,
        [guildId, kind, targetId, by ?? null, note ? String(note).slice(0, 255) : null]);
    if (kind === 'role') {
        const holders = realGuild(guild)?.roles.cache.get(targetId)?.members;
        for (const m of holders?.values() ?? []) {
            await pool.execute(
                "INSERT IGNORE INTO protection_allowlist (guild_id, kind, target_id, via_role_id) VALUES (?, 'held', ?, ?)",
                [guildId, m.id, targetId]).catch(() => {});
        }
    }
    invalidate(guildId);
    listChanged(guild, kind === 'role' ? 'Role allowlisted' : kind === 'bot' ? 'Bot trusted' : 'User allowlisted', kind === 'role' ? `<@&${targetId}>` : `<@${targetId}>`, by);
    return { ok: true };
}

/**
 * Take a user or role off. A role's recorded holders go with it. A user still holding an allowlisted
 * role can't be removed (they would stay exempt anyway); taking a user off also clears their
 * "once held" record.
 * @returns {Promise<{ ok:boolean, removed?:boolean, error?:string }>}
 */
export async function removeAllow(guild, kind, targetId, by) {
    const guildId = gid(guild);
    if (kind === 'bot' || kind === 'globalban') {
        const [r] = await pool.execute('DELETE FROM protection_allowlist WHERE guild_id = ? AND kind = ? AND target_id = ?', [guildId, kind, targetId]);
        invalidate(guildId);
        if (r.affectedRows) listChanged(guild, kind === 'bot' ? 'Bot no longer trusted' : 'Global ban appeal allowance removed', `<@${targetId}>`, by);
        return { ok: true, removed: r.affectedRows > 0 };
    }
    if (kind === 'role') {
        const [r] = await pool.execute("DELETE FROM protection_allowlist WHERE guild_id = ? AND kind = 'role' AND target_id = ?", [guildId, targetId]);
        const [s] = await pool.execute("DELETE FROM protection_allowlist WHERE guild_id = ? AND kind = 'held' AND via_role_id = ?", [guildId, targetId]);
        invalidate(guildId);
        if (r.affectedRows) listChanged(guild, 'Role taken off the allowlist', `<@&${targetId}>${s.affectedRows ? ` (and ${s.affectedRows} recorded holder(s))` : ''}`, by);
        return { ok: true, removed: r.affectedRows > 0 };
    }
    const state = await getState(guildId);
    const member = realGuild(guild) ? await guild.members.fetch(targetId).catch(() => null) : null;
    const check = allowUserRemoval(member ? [...member.roles.cache.keys()] : [], state.roles);
    if (!check.ok) {
        return { ok: false, error: `They still hold an allowlisted role (<@&${check.roleId}>). Take the role off them, or the role off the allowlist, first.` };
    }
    const [r] = await pool.execute(
        "DELETE FROM protection_allowlist WHERE guild_id = ? AND kind IN ('user','held') AND target_id = ?", [guildId, targetId]);
    invalidate(guildId);
    if (r.affectedRows) listChanged(guild, 'User taken off the allowlist', `<@${targetId}>`, by);
    return { ok: true, removed: r.affectedRows > 0 };
}

// ── global ban only (kind 'globalban', migration 471) ────────────────────────────

/*
 * A global ban appeal this server's moderators accepted for their own server (core/global-ban-manager.js
 * approveAppealForServer, H-802 follow-up). It stops the global ban acting on that person here and nothing
 * else: raid, phishing, name filters, spam and every other protection still apply. That is why it is a kind
 * of its own and not a 'user' allowlist entry, which exempts someone from all of them.
 */

let globalBanKindReady = false;
/** Does the database know the 'globalban' kind yet (migration 471)? Checked until it does. */
export async function globalBanKindAvailable() {
    if (globalBanKindReady) return true;
    try {
        const [[row]] = await pool.execute(
            "SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'protection_allowlist' AND COLUMN_NAME = 'kind'");
        globalBanKindReady = /'globalban'/.test(String(row?.t || ''));
    } catch { globalBanKindReady = false; }
    return globalBanKindReady;
}

/** Has this server accepted this person's global ban appeal for itself? A failed lookup reads as no. */
export async function isGlobalBanAllowed(guildId, userId) {
    if (!guildId || !userId) return false;
    const state = await getState(String(guildId));
    return state.globalBan.has(String(userId));
}

/** People this server let past the global ban: [{ target_id, added_by, note, added_at }]. */
export async function listGlobalBanAllowed(guildId) { return listKind(guildId, 'globalban'); }

/**
 * Let someone past the global ban in this server only. Refuses (changing nothing) until migration 471 is
 * applied, rather than falling back to the full allowlist.
 * @returns {Promise<{ ok:boolean, error?:string }>}
 */
export async function allowGlobalBan(guild, userId, by, note = null) {
    if (!(await globalBanKindAvailable())) {
        return { ok: false, error: 'This needs a database update (migration 471) that has not been applied yet, so nothing was changed. The CertiFried team still reviews the appeal.' };
    }
    const guildId = gid(guild);
    const [[{ n }]] = await pool.execute(
        "SELECT COUNT(*) AS n FROM protection_allowlist WHERE guild_id = ? AND kind = 'globalban'", [guildId]);
    if (Number(n) >= MAX_ALLOWLIST) return { ok: false, error: `This server can let at most ${MAX_ALLOWLIST} people past the global ban.` };
    await pool.execute(
        `INSERT INTO protection_allowlist (guild_id, kind, target_id, added_by, note) VALUES (?, 'globalban', ?, ?, ?)
         ON DUPLICATE KEY UPDATE added_by = VALUES(added_by), note = COALESCE(VALUES(note), note)`,
        [guildId, String(userId), by ?? null, note ? String(note).slice(0, 255) : null]);
    invalidate(guildId);
    listChanged(guild, 'Global ban appeal accepted for this server', `<@${userId}>`, by);
    return { ok: true };
}

/**
 * Called from guildMemberUpdate: someone losing (or holding) an allowlisted role is recorded, so a
 * later removal doesn't strip their exemption (the once-held rule). Never throws.
 */
export async function noteRoleChange(oldMember, newMember) {
    try {
        const guild = newMember?.guild;
        if (!guild || !oldMember?.roles?.cache) return;
        const state = await getState(guild.id);
        if (!state.roles.size || state.seen.has(newMember.id)) return;
        const lost = [...oldMember.roles.cache.keys()].find(r => state.roles.has(r) && !newMember.roles.cache.has(r));
        const held = lost ?? [...newMember.roles.cache.keys()].find(r => state.roles.has(r));
        if (held) await recordHeld(guild.id, newMember.id, held);
    } catch (err) {
        logger.warn(`[Protection] role-change note failed: ${err.message}`);
    }
}

// ── ignored channels and categories ──────────────────────────────────────────
// The message protections (phishing / link checks, obfuscated-URL scam, anti-everyone, QR and image-text
// rules, link policy, invite filter, scam-image blocklist, AutoMod escalation) skip these. Unlike the
// allowlist this is about WHERE, not WHO, so it is not part of protectionHold.

export const MAX_IGNORED = 100;

/**
 * Is this channel ignored by the message protections? Accepts a channel (thread → its parent channel and
 * that channel's category) or `{ guildId, id, parentId, parentParentId }`. Never throws; false on error.
 */
export async function isIgnoredChannel(channel) {
    try {
        const guildId = channel?.guildId ?? channel?.guild?.id;
        if (!guildId || !channel?.id) return false;
        const state = await getState(guildId);
        if (!state.channels.size && !state.categories.size) return false;
        const parent = channel.parent ?? (channel.parentId ? channel.guild?.channels?.cache?.get(channel.parentId) : null);
        return isIgnored({
            id: channel.id,
            parentId: channel.parentId ?? null,
            parentParentId: channel.parentParentId ?? parent?.parentId ?? null,
        }, state);
    } catch (err) {
        logger.warn(`[Protection] ignore check failed: ${err.message}`);
        return false;
    }
}

/** Ignored channels and categories: [{ kind, target_id, added_by, note, added_at }]. */
export async function listIgnored(guildId) {
    const [rows] = await pool.execute(
        "SELECT kind, target_id, added_by, note, added_at FROM protection_allowlist WHERE guild_id = ? AND kind IN ('channel','category') ORDER BY added_at DESC",
        [guildId]);
    return rows;
}

/** Ignore a channel or a category. @returns {Promise<{ ok:boolean, error?:string }>} */
export async function addIgnored(guild, kind, targetId, by, note = null) {
    if (kind !== 'channel' && kind !== 'category') return { ok: false, error: 'Unknown kind.' };
    const guildId = gid(guild);
    const [[{ n }]] = await pool.execute(
        "SELECT COUNT(*) AS n FROM protection_allowlist WHERE guild_id = ? AND kind IN ('channel','category')", [guildId]);
    if (Number(n) >= MAX_IGNORED) return { ok: false, error: `At most ${MAX_IGNORED} channels and categories can be ignored.` };
    await pool.execute(
        `INSERT INTO protection_allowlist (guild_id, kind, target_id, added_by, note) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE added_by = VALUES(added_by), note = COALESCE(VALUES(note), note)`,
        [guildId, kind, targetId, by ?? null, note ? String(note).slice(0, 255) : null]);
    invalidate(guildId);
    listChanged(guild, kind === 'category' ? 'Category ignored by message protections' : 'Channel ignored by message protections', `<#${targetId}>`, by);
    return { ok: true };
}

export async function removeIgnored(guild, kind, targetId, by) {
    const guildId = gid(guild);
    const [r] = await pool.execute('DELETE FROM protection_allowlist WHERE guild_id = ? AND kind = ? AND target_id = ?', [guildId, kind, targetId]);
    invalidate(guildId);
    if (r.affectedRows) listChanged(guild, kind === 'category' ? 'Category no longer ignored' : 'Channel no longer ignored', `<#${targetId}>`, by);
    return r.affectedRows > 0;
}

// ── pause ────────────────────────────────────────────────────────────────────

/** Pause enforcement, optionally until `untilMs` (epoch ms). */
export async function pause(guild, { untilMs = null, by = null, reason = null } = {}) {
    const until = untilMs ? new Date(untilMs) : null;
    const why = reason ? String(reason).slice(0, 200) : null;
    await pool.execute(
        `INSERT INTO guilds (guild_id, protection_paused, protection_paused_until, protection_paused_by, protection_paused_at, protection_pause_reason)
         VALUES (?, 1, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE protection_paused = 1, protection_paused_until = VALUES(protection_paused_until),
           protection_paused_by = VALUES(protection_paused_by), protection_paused_at = VALUES(protection_paused_at),
           protection_pause_reason = VALUES(protection_pause_reason)`,
        [guild.id, until, by, new Date(), why]);
    invalidate(guild.id);
    logger.info(`[Protection] enforcement paused in ${guild.id} by ${by}${until ? ` until ${until.toISOString()}` : ''}`);
    void logFeatureEvent(() => (guild), 'moderation.protectionPaused', () => ({
        title: '⏸️ Protections Paused',
        description: 'Automatic protections keep watching and logging, but take no action until resumed.',
        fields: [
            ['By', userLabel(by)],
            ['Until', until ? `<t:${Math.floor(until.getTime() / 1000)}:f> (in ${formatDuration(until.getTime() - Date.now())})` : 'Resumed by hand'],
            ['Reason', why, false],
        ],
    }));
}

export async function resume(guild, by = null) {
    const [r] = await pool.execute(
        'UPDATE guilds SET protection_paused = 0, protection_paused_until = NULL WHERE guild_id = ? AND protection_paused = 1', [guild.id]);
    invalidate(guild.id);
    if (r.affectedRows) {
        logger.info(`[Protection] enforcement resumed in ${guild.id} by ${by}`);
        void logFeatureEvent(() => (guild), 'moderation.protectionResumed', () => ({
            title: '▶️ Protections Resumed',
            description: 'Automatic protections are acting again.',
            fields: [['By', userLabel(by)]],
        }));
    }
    return r.affectedRows > 0;
}

function listChanged(guild, what, target, by) {
    logger.info(`[Protection] ${what} in ${gid(guild)}: ${target} by ${by}`);
    const real = realGuild(guild);
    if (!real) return;
    void logFeatureEvent(() => (real), 'moderation.protectionLists', () => ({
        title: `🛡️ ${what}`,
        fields: [['Target', target], ['By', userLabel(by)]],
    }));
}

// ── overview ─────────────────────────────────────────────────────────────────

/**
 * Which protections are switched on (each feature's own config), and the feature-specific trust
 * lists that stay separate from the allowlist. Unknown (table missing) = null.
 */
export async function protectionsOverview(guildId) {
    const one = async (sql, pick) => {
        try { const [[row]] = await pool.execute(sql, [guildId]); return row ? pick(row) : false; } catch { return null; }
    };
    const count = async (sql) => {
        try { const [[row]] = await pool.execute(sql, [guildId]); return Number(row?.n ?? 0); } catch { return null; }
    };
    const json = (v) => { try { const a = typeof v === 'string' ? JSON.parse(v) : v; return Array.isArray(a) ? a : []; } catch { return []; } };
    return {
        protections: {
            joinGate: await one('SELECT age_gate_enabled, rejoin_limit_enabled, spammer_enabled FROM join_gate_config WHERE guild_id = ?',
                r => ({ ageGate: !!r.age_gate_enabled, rejoinLimit: !!r.rejoin_limit_enabled, spammer: !!r.spammer_enabled })),
            nameFilters: await one('SELECT name_filters_enabled, name_generated_enabled FROM join_gate_config WHERE guild_id = ?',
                r => ({ on: !!r.name_filters_enabled || !!r.name_generated_enabled })),
            avatarProtection: await one('SELECT avatar_enabled, avatar_action FROM join_gate_config WHERE guild_id = ?',
                r => ({ on: !!r.avatar_enabled, action: r.avatar_action })),
            nsfwAvatars: await one('SELECT nsfw_avatar_enabled, nsfw_avatar_action FROM join_gate_config WHERE guild_id = ?',
                r => ({ on: !!r.nsfw_avatar_enabled, action: r.nsfw_avatar_action })),
            nsfwImages: await one('SELECT nsfw_img_enabled, nsfw_img_action FROM phishing_config WHERE guild_id = ?',
                r => ({ on: !!r.nsfw_img_enabled, action: r.nsfw_img_action })),
            antiNuke: await one('SELECT enabled, action_on_trigger FROM anti_nuke_config WHERE guild_id = ?', r => ({ on: !!r.enabled, action: r.action_on_trigger })),
            raid: await one('SELECT enabled, action FROM raid_detection_config WHERE guild_id = ?', r => ({ on: !!r.enabled, action: r.action })),
            selfbot: await one('SELECT enabled, action FROM selfbot_detection_config WHERE guild_id = ?', r => ({ on: !!r.enabled, action: r.action })),
            adaptiveSpam: await one('SELECT enabled, action FROM adaptive_spam_config WHERE guild_id = ?', r => ({ on: !!r.enabled, action: r.action })),
            phishing: await one('SELECT enabled, action FROM phishing_config WHERE guild_id = ?', r => ({ on: !!r.enabled, action: r.action })),
            globalBan: await one('SELECT enabled FROM global_ban_config WHERE guild_id = ?', r => ({ on: !!r.enabled })),
            commissionFilter: await one('SELECT enabled FROM commission_spam_config WHERE guild_id = ?', r => ({ on: !!r.enabled })),
            linkPolicy: await one('SELECT enabled FROM link_policy_config WHERE guild_id = ?', r => ({ on: !!r.enabled })),
            verification: await one(
                'SELECT enabled, mode, fail_action FROM verify_config WHERE guild_id = ?',
                r => ({ on: !!r.enabled, action: r.mode === 'captcha' ? `captcha, fails: ${r.fail_action === 'none' ? 'log' : r.fail_action}` : 'button' })),
            autoPrune: await one('SELECT prune_enabled, prune_action FROM join_gate_config WHERE guild_id = ?',
                r => ({ on: !!r.prune_enabled, action: r.prune_action })),
            // Inactivity prune (core/inactivity-prune.js, migration 332): on when either rule is.
            inactivityPrune: await one(
                'SELECT inactive_never_enabled, inactive_never_action, inactive_quiet_enabled, inactive_quiet_action FROM join_gate_config WHERE guild_id = ?',
                r => {
                    const parts = [r.inactive_never_enabled ? `never active: ${r.inactive_never_action}` : null,
                        r.inactive_quiet_enabled ? `gone quiet: ${r.inactive_quiet_action}` : null].filter(Boolean);
                    return { on: parts.length > 0, action: parts.join(', ') || null };
                }),
            // AI second opinion (core/ai-judge.js, migration 331): on when any surface is.
            aiJudge: await one(
                'SELECT ai_avatar_mode, ai_text_mode, ai_nsfw_advise FROM phishing_config WHERE guild_id = ?',
                r => {
                    const parts = [r.ai_avatar_mode !== 'off' ? `avatars ${r.ai_avatar_mode}` : null, r.ai_text_mode !== 'off' ? `text ${r.ai_text_mode}` : null,
                        r.ai_nsfw_advise ? 'NSFW advise' : null].filter(Boolean);
                    return { on: parts.length > 0, action: parts.join(', ') || null };
                }),
            messageThreats: await one(
                'SELECT obf_enabled, everyone_enabled, qr_enabled, ocr_rules_enabled, esc_enabled FROM phishing_config WHERE guild_id = ?',
                r => ({ on: !!(r.obf_enabled || r.everyone_enabled || r.qr_enabled || r.ocr_rules_enabled || r.esc_enabled) })),
        },
        // Kept separate on purpose (different meaning); shown beside the allowlist so nothing is hidden.
        otherLists: {
            antiNukeTrusted: await count('SELECT COUNT(*) AS n FROM anti_nuke_whitelist WHERE guild_id = ?'),
            inviteLinkAllowed: await count('SELECT COUNT(*) AS n FROM automod_link_whitelist WHERE guild_id = ?'),
            selfbotExemptRoles: await one('SELECT exempt_roles FROM selfbot_detection_config WHERE guild_id = ?', r => json(r.exempt_roles)),
            globalBanExemptRoles: await one('SELECT exempt_roles FROM global_ban_config WHERE guild_id = ?', r => json(r.exempt_roles)),
            globalBanAppealsAllowed: await count("SELECT COUNT(*) AS n FROM protection_allowlist WHERE guild_id = ? AND kind = 'globalban'"),
            commissionRulings: await count('SELECT COUNT(*) AS n FROM commission_spam_exemptions WHERE guild_id = ?'),
        },
    };
}

export default {
    getState, invalidate, isExempt, isPaused, getPause, protectionHold, takeAutomatedAction, isManager, liveConfigAccess,
    listManagers, addManager, removeManager, listAllowlist, listSeen, addAllow, removeAllow, noteRoleChange,
    globalBanKindAvailable, isGlobalBanAllowed, listGlobalBanAllowed, allowGlobalBan,
    pause, resume, protectionsOverview, isIgnoredChannel, listIgnored, addIgnored, removeIgnored,
};
