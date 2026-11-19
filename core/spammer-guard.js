/*
 * Discord-flagged spammers — acting on Discord's own spam flag (core/spammer-flag.js has the rules).
 *
 *   on join   checkSpammerJoin(), called first thing by core/join-gate.js checkJoin
 *   scan      scanGuild() lists flagged members already inside; applyScan() acts on a chosen list.
 *             Used by `/protection joingate spammer-scan` and the dashboard's Security page.
 *
 * Settings are the spammer_* columns of join_gate_config (migrations/322_spammer_flag.js), read
 * through join-gate's cached getConfig. Allowlisted members, the owner and staff are never touched,
 * nor anyone the unified protection allowlist exempts; while protections are paused nothing is done.
 * Unable to act fails open and says so, like the rest of the gate.
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { observeFlags, getFirstFlaggedAt, FLAG_BITS } from './user-flag-observations.js';
import { whyCannot, whyFailed, reportManualAction } from './manual-action.js';
import {
    protectionHold, isExempt, isPaused, getState as protectionState,
    listAllowlist, addAllow as addProtectionAllow, removeAllow as removeProtectionAllow,
} from './protection-exempt.js';
import {
    isFlaggedSpammer, normaliseSpammerAction, planSpammerScan, spammerReason, spammerEventAction,
} from './spammer-flag.js';

export const FLAG_ROLE_NAME = 'Flagged Spammer';
const SCAN_CAP = 1000;           // most members one confirmation acts on
const UNKNOWN_FETCH_CAP = 200;   // members whose flags were missing, fetched one by one

// Permissions that make someone staff for the scan: never act on the people who run the server.
const STAFF_PERMS = [
    PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild, PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.KickMembers, PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageRoles,
];

const NEEDS = {
    ban: [PermissionFlagsBits.BanMembers, 'Ban Members'],
    kick: [PermissionFlagsBits.KickMembers, 'Kick Members'],
    flag: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
};

// ── allowlist ────────────────────────────────────────────────────────────────
// The server's protection allowlist (core/protection-exempt.js). This check had its own list
// (spammer_flag_allowlist) until migration 323 folded it in; these keep the old call sites working.
// `guild` is a Guild or a guild id.

const guildIdOf = (guild) => (typeof guild === 'string' ? guild : guild.id);

/** Allowlisted users: [{ user_id, added_by, added_at }]. */
export async function allowlist(guild) {
    const rows = await listAllowlist(guildIdOf(guild));
    return rows.filter(r => r.kind === 'user').map(r => ({ user_id: r.target_id, added_by: r.added_by, added_at: r.added_at }));
}

export async function isAllowlisted(guild, userId) {
    return (await protectionState(guildIdOf(guild))).users.has(userId);
}

export async function addAllow(guild, userId, addedBy) {
    const out = await addProtectionAllow(guild, 'user', userId, addedBy, 'allowed through the spammer check');
    if (!out.ok) throw new Error(out.error);
}

/** true when removed; throws with the reason when they can't be (they hold an allowlisted role). */
export async function removeAllow(guild, userId, by = null) {
    const out = await removeProtectionAllow(guild, 'user', userId, by);
    if (!out.ok) throw new Error(out.error);
    return !!out.removed;
}

// ── shared ───────────────────────────────────────────────────────────────────

/** The member's flag, fetching it when the payload that cached them didn't carry one. */
export async function memberIsSpammer(member) {
    let verdict = isFlaggedSpammer(member.user);
    if (verdict === null) {
        await member.user.fetchFlags(true).catch(() => null);
        verdict = isFlaggedSpammer(member.user);
    }
    // Record what we just saw so future "when was this user first flagged?" queries have an answer.
    // Fire-and-forget: swallows errors internally; must never affect the guard decision.
    observeFlags(member.user, member.guild?.id || null);
    return verdict;
}

/** Staff for the protections: owner or any moderation permission (also used by core/name-filters.js). */
export function isStaff(member) {
    return member.guild.ownerId === member.id || STAFF_PERMS.some(p => member.permissions?.has(p));
}

/** The configured role, or a "Flagged Spammer" role created (and saved) the first time it is needed. */
async function flagRole(guild, cfg) {
    const existing = cfg.spammer_role_id ? guild.roles.cache.get(cfg.spammer_role_id) : null;
    if (existing) return existing;
    const byName = guild.roles.cache.find(r => r.name === FLAG_ROLE_NAME && !r.managed);
    const role = byName || await guild.roles.create({
        name: FLAG_ROLE_NAME, color: 0xC0392B, permissions: [], mentionable: false,
        reason: 'Spammer check: role for members Discord flagged as spammers',
    });
    const { setConfig } = await import('./join-gate.js');
    await setConfig(guild.id, { spammer_role_id: role.id });
    return role;
}

/** Can the bot carry out `action` on this member right now? */
function actionable(member, action, role) {
    if (action === 'ban') return member.bannable;
    if (action === 'kick') return member.kickable;
    if (action === 'flag') return !role || role.editable;
    return true;
}

async function recordEvent(guildId, user, action, detail) {
    await pool.execute(
        `INSERT INTO join_gate_events (guild_id, user_id, username, action, account_age_hours, dm_delivered, detail)
         VALUES (?, ?, ?, ?, NULL, 0, ?)`,
        [guildId, user.id, user.username?.slice(0, 100) ?? null, action, detail?.slice(0, 255) ?? null],
    ).catch(err => logger.error(`[Spammer] could not record ${action} for ${user.id}: ${err.message}`));
}

/** Carry out the action on one member. Never throws. */
async function punish(member, action, cfg, source) {
    const reason = spammerReason(source);
    try {
        if (action === 'ban') await member.ban({ reason, deleteMessageSeconds: 3600 });
        else if (action === 'kick') await member.kick(reason);
        else if (action === 'flag') {
            const role = await flagRole(member.guild, cfg);
            await member.roles.add(role, reason);
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, problem: err.message, err };
    }
}

function spammerDM(guild, action) {
    return {
        embeds: [new EmbedBuilder().setColor(0xC0392B)
            .setTitle(action === 'ban' ? `You were banned from ${guild.name}` : `You were removed from ${guild.name}`)
            .setDescription('This is automatic.\n\n**Why:** Discord itself has flagged your account as a spammer, '
                + 'and this server does not admit flagged accounts. The server did not set this flag and cannot remove it.\n\n'
                + "**If this is a mistake:** appeal to Discord at https://dis.gd/request. Once Discord clears the flag "
                + "you can join again, or ask the server's staff to let you in.")],
    };
}

// ── enrichment ───────────────────────────────────────────────────────────────

/**
 * Build the enriched context fields for the spammer embed. Everything a mod
 * needs to decide "real flag or false positive" at a glance.
 *
 * Returns:
 *   { thumbnail: url, fields: [[label, value, inline?]...] }
 *
 * All DB lookups are best-effort — a failure degrades the embed to the basic
 * two-field version rather than throwing.
 */
async function buildSpammerContext(member) {
    const u = member.user;
    const createdMs = u.createdTimestamp;
    const ageDays = Math.floor((Date.now() - createdMs) / 86_400_000);
    const ageText = ageDays >= 365
        ? `${(ageDays / 365).toFixed(1)} yr`
        : (ageDays >= 60 ? `${Math.floor(ageDays / 30)} mo` : `${ageDays} d`);

    // Decode current flag names (SPAMMER is 1 << 20; discord.js UserFlags.Flags
    // doesn't expose it, so we also check our known-moderation-flag constants).
    const flagNames = [];
    const bits = BigInt(u.flags?.bitfield ?? 0);
    if (bits & FLAG_BITS.SPAMMER)     flagNames.push('SPAMMER');
    if (bits & FLAG_BITS.QUARANTINED) flagNames.push('QUARANTINED');
    // Also show badge/misc flags so a Nitro / HypeSquad user doesn't look like just "SPAMMER".
    try {
        const { UserFlags } = await import('discord.js');
        for (const [name, bit] of Object.entries(UserFlags.Flags || {})) {
            if (typeof bit !== 'number' && typeof bit !== 'bigint') continue;
            if ((bits & BigInt(bit)) && !flagNames.includes(name)) flagNames.push(name);
        }
    } catch { /* fall through — the SPAMMER label alone is still useful */ }

    // Observation history + prior join count. Both are "best effort — never throw into the embed".
    let firstObserved = null, priorJoins = 0;
    try {
        [firstObserved, priorJoins] = await Promise.all([
            getFirstFlaggedAt(u.id, FLAG_BITS.SPAMMER),
            pool.execute(
                'SELECT COUNT(*) AS n FROM member_join_history WHERE guild_id = ? AND user_id = ?',
                [member.guild.id, u.id]).then(([r]) => Number(r[0]?.n || 0)).catch(() => 0),
        ]);
    } catch { /* ignore */ }

    const fields = [
        ['Member', userLabel(member)],
        ['Username', u.username ? `\`${u.username}\`${u.globalName && u.globalName !== u.username ? ` (display: ${u.globalName})` : ''}` : null],
        ['Account age', `${ageText}  ·  <t:${Math.floor(createdMs / 1000)}:D>  (<t:${Math.floor(createdMs / 1000)}:R>)`, true],
        ['Prior joins here', priorJoins > 1 ? `${priorJoins} (incl. this attempt)` : 'First attempt', true],
        ['Public flags', flagNames.length ? flagNames.join(', ') : null, true],
    ];
    if (firstObserved) {
        const ts = Math.floor(new Date(firstObserved).getTime() / 1000);
        fields.push(['First seen flagged', `<t:${ts}:F>  (<t:${ts}:R>)`, false]);
    }
    return { thumbnail: u.displayAvatarURL({ size: 256 }), fields };
}

// ── on join ──────────────────────────────────────────────────────────────────

/**
 * Called by checkJoin before the other rules. Returns 'spammer_removed' when it removed the member,
 * otherwise null (not flagged, allowlisted, flagged with a role, observing, or unable to act).
 */
export async function checkSpammerJoin(member, cfg) {
    if (!cfg?.spammer_enabled || member.user.bot) return null;
    if (!(await memberIsSpammer(member))) return null;
    const guild = member.guild;
    if (await isAllowlisted(guild.id, member.id)) {
        logger.info(`[Spammer] ${member.user.tag} is flagged by Discord but allowlisted in ${guild.id}`);
        return null;
    }

    const action = normaliseSpammerAction(cfg.spammer_action);
    const silent = !!cfg.spammer_silent;
    const ctx = await buildSpammerContext(member);
    const fields = ctx.fields;
    const thumbnail = ctx.thumbnail;

    if (action === 'none') {
        await recordEvent(guild.id, member.user, 'spammer_observed', 'on join');
        logger.info(`[Spammer] ${member.user.tag} joined ${guild.id} flagged by Discord — observe only`);
        if (!silent) {
            void logFeatureEvent(() => (guild), 'join-gate.spammer', () => ({
                title: '👀 Discord-Flagged Spammer Joined (Observe Only)',
                description: 'Discord has flagged this account as a spammer. The rule is set to observe only, so nothing was done.',
                thumbnail,
                fields,
            }));
        }
        return null;
    }

    // Unified allowlist / global pause (core/protection-exempt.js logs the skip).
    if (await protectionHold(member, action, 'Spammer check')) return null;

    const role = action === 'flag' && cfg.spammer_role_id ? guild.roles.cache.get(cfg.spammer_role_id) : null;
    const cannot = whyCannot(guild, action, { member, role });
    if (cannot) {
        await recordEvent(guild.id, member.user, 'failed', `spammer: ${cannot.text.replace(/\*\*/g, '')}`);
        await reportManualAction(guild, { action, member, source: 'Spammer check', problem: cannot });
        return null;
    }

    // DM first (kick/ban): Discord only reliably delivers while a mutual server exists.
    let delivered = false;
    if (action !== 'flag') {
        try { await member.send(spammerDM(guild, action)); delivered = true; } catch { delivered = false; }
    }

    const result = await punish(member, action, cfg, 'join');
    if (!result.ok) {
        await recordEvent(guild.id, member.user, 'failed', `spammer: ${result.problem}`);
        logger.error(`[Spammer] ${action} failed for ${member.user.tag} in ${guild.id}: ${result.problem}`);
        const cause = whyFailed(result.err, guild, action, { member, role });
        if (cause) await reportManualAction(guild, { action, member, source: 'Spammer check', problem: cause });
        else {
            void logFeatureEvent(() => (guild), 'join-gate.failed', () => ({
                title: '⚠️ Spammer Check Could Not Act',
                fields: [...fields, ['Tried to', action], ['Problem', result.problem, false]],
            }));
        }
        return null;
    }

    await recordEvent(guild.id, member.user, spammerEventAction(action), 'on join');
    logger.info(`[Spammer] ${action} ${member.user.tag} on joining ${guild.id} — flagged by Discord`);
    if (!silent) {
        void logFeatureEvent(() => (guild), 'join-gate.spammer', () => ({
            title: { ban: '🔨 Banned — Discord-Flagged Spammer', kick: '🚪 Removed — Discord-Flagged Spammer',
                flag: '🚩 Flagged — Discord-Flagged Spammer' }[action],
            thumbnail,
            fields: [...fields,
                ['They were told', action === 'flag' ? null : (delivered ? 'Yes — by DM' : 'No — their DMs are closed')],
                ['If this is a false positive',
                    '`/protection joingate spammer-allow user:' + member.id + '`' +
                    ' or Dashboard → Protection Settings → Allowlist', false]],
        }));
    }
    return action === 'flag' ? null : 'spammer_removed';
}

// ── scan ─────────────────────────────────────────────────────────────────────

/**
 * Every member Discord has flagged, and what the configured action would do to each.
 * @returns {Promise<{ action:string, total:number, targets:GuildMember[], skipped:object, unknown:number, complete:boolean }>}
 */
export async function scanGuild(guild, cfg) {
    const action = normaliseSpammerAction(cfg?.spammer_action);
    let complete = true;
    try {
        await guild.members.fetch({ time: 60_000 });
    } catch (err) {
        logger.warn(`[Spammer] member fetch failed in ${guild.id}: ${err.message}`);
        complete = guild.members.cache.size >= guild.memberCount;
    }
    const members = [...guild.members.cache.values()];

    // Flags missing from the cached payload: fetch a bounded number individually.
    let fetched = 0;
    for (const m of members) {
        if (fetched >= UNKNOWN_FETCH_CAP) break;
        if (!m.user.bot && isFlaggedSpammer(m.user) === null) {
            fetched++;
            await m.user.fetchFlags(true).catch(() => null);
        }
    }

    const allowed = new Set((await allowlist(guild.id)).map(r => r.user_id));
    // The unified protection allowlist counts as allowlisted here too.
    for (const m of members) {
        if (!allowed.has(m.id) && isFlaggedSpammer(m.user) && (await isExempt(m)).exempt) allowed.add(m.id);
    }
    const role = action === 'flag' && cfg?.spammer_role_id ? guild.roles.cache.get(cfg.spammer_role_id) : null;
    const plan = planSpammerScan(members.map(m => ({
        id: m.id,
        bot: m.user.bot,
        spammer: isFlaggedSpammer(m.user),
        owner: guild.ownerId === m.id,
        staff: isStaff(m),
        allowlisted: allowed.has(m.id),
        actionable: action === 'none' ? true : actionable(m, action, role),
        hasFlagRole: !!role && m.roles.cache.has(role.id),
    })), action);

    return {
        action,
        total: members.length,
        targets: plan.targets.map(id => guild.members.cache.get(id)).filter(Boolean),
        skipped: plan.skipped,
        unknown: plan.unknown.length,
        complete,
    };
}

/**
 * Act on members a scan listed. Each one is re-checked first (still here, still flagged, still not
 * allowlisted or staff), so a stale list never hits the wrong person.
 * @returns {Promise<{ done:number, failed:Array<{id:string, problem:string}>, skipped:number, action:string }>}
 */
export async function applyScan(guild, cfg, userIds, actorId) {
    const action = normaliseSpammerAction(cfg?.spammer_action);
    const out = { done: 0, failed: [], skipped: 0, action };
    if (action === 'none') return out;
    const [perm, permName] = NEEDS[action];
    if (!guild.members.me?.permissions?.has(perm)) {
        out.failed.push({ id: '*', problem: `The bot is missing the ${permName} permission` });
        return out;
    }
    if (await isPaused(guild.id, guild)) {
        out.failed.push({ id: '*', problem: 'Protections are paused in this server. Resume them first (/protection resume).' });
        return out;
    }
    const allowed = new Set((await allowlist(guild.id)).map(r => r.user_id));
    for (const id of [...new Set(userIds)].slice(0, SCAN_CAP)) {
        const member = await guild.members.fetch(id).catch(() => null);
        if (!member || member.user.bot || allowed.has(id) || isStaff(member) || !(await memberIsSpammer(member))) {
            out.skipped++;
            continue;
        }
        const role = action === 'flag' && cfg.spammer_role_id ? guild.roles.cache.get(cfg.spammer_role_id) : null;
        if (role && member.roles.cache.has(role.id)) { out.skipped++; continue; }
        if (await protectionHold(member, action, 'Spammer scan')) { out.skipped++; continue; }
        if (!actionable(member, action, role)) {
            out.failed.push({ id, problem: 'Their highest role is above the bot' });
            continue;
        }
        const result = await punish(member, action, cfg, 'scan');
        if (result.ok) {
            out.done++;
            await recordEvent(guild.id, member.user, spammerEventAction(action), `scan by ${actorId ?? 'staff'}`);
        } else {
            out.failed.push({ id, problem: result.problem });
        }
    }
    logger.info(`[Spammer] scan in ${guild.id} by ${actorId}: ${action} ${out.done}, failed ${out.failed.length}, skipped ${out.skipped}`);
    if (!cfg?.spammer_silent && (out.done || out.failed.length)) {
        void logFeatureEvent(() => (guild), 'join-gate.spammer', () => ({
            title: '🧹 Spammer Scan Finished',
            fields: [
                ['Run by', userLabel(actorId)],
                ['Action', { ban: 'Ban', kick: 'Kick', flag: 'Flag with a role' }[action]],
                ['Done', String(out.done)],
                ['Failed', out.failed.length ? String(out.failed.length) : null],
            ],
        }));
    }
    return out;
}

// Pending command scans, confirmed or cancelled from buttons (interactions/buttons/spammer_scan.js).
const pending = new Map();
const PENDING_TTL = 15 * 60_000;

export function rememberScan(guildId, actorId, userIds) {
    const token = Math.random().toString(36).slice(2, 10);
    pending.set(token, { guildId, actorId, userIds, at: Date.now() });
    for (const [k, v] of pending) if (Date.now() - v.at > PENDING_TTL) pending.delete(k);
    return token;
}

export function takeScan(token) {
    const entry = pending.get(token);
    pending.delete(token);
    if (!entry || Date.now() - entry.at > PENDING_TTL) return null;
    return entry;
}

export function peekScan(token) {
    const entry = pending.get(token);
    return entry && Date.now() - entry.at <= PENDING_TTL ? entry : null;
}

export default {
    checkSpammerJoin, scanGuild, applyScan, allowlist, isAllowlisted, addAllow, removeAllow,
    memberIsSpammer, rememberScan, takeScan, peekScan, FLAG_ROLE_NAME,
};
