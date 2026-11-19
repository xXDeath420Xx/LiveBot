import crypto from 'crypto';
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { loadAudit } from './activity-audit.js';
import { applyFilter, normaliseFilter, describeFilter } from './activity-audit-filter.js';
import { activeSinceIds } from './member-activity.js';

/**
 * Bulk membership actions driven by an audit filter.
 *
 * A kick cannot be undone and a mass kick is the single most destructive thing this bot can
 * do, so the whole module is built around one rule: NOTHING acts on the audit snapshot
 * alone. A snapshot is a photograph of the past. Between it being taken and someone
 * clicking the button, people post, join voice, get promoted, or leave — and every one of
 * those makes a member who was correctly in the list no longer a correct target.
 *
 * The flow is therefore always plan → confirm → execute:
 *   • plan  re-resolves every target against LIVE guild state and live activity, drops
 *           whatever no longer qualifies with a stated reason, and returns a token bound to
 *           the exact surviving member-id set
 *   • execute refuses any token whose set no longer matches, then re-checks each member one
 *           final time immediately before acting on them
 *
 * The token is what stops a filter changing under the operator: if the plan they approved
 * said 46 people and the set has since become 47, the token no longer matches and the run
 * is refused rather than quietly kicking someone nobody reviewed.
 */

export const ACTIONS = {
    kick: { label: 'Kick from server', destructive: true, needsRole: false },
    add_role: { label: 'Add a role', destructive: false, needsRole: true },
    remove_role: { label: 'Remove a role', destructive: false, needsRole: true },
};

/** Hard ceiling per run, whatever the filter selected. */
export const MAX_TARGETS = 200;
/** A snapshot older than this must be re-run before a destructive action will plan. */
export const MAX_SNAPSHOT_AGE_HOURS = 48;
/** Newly-joined members are never kickable by default — "no activity" is expected of them. */
export const DEFAULT_MIN_MEMBERSHIP_DAYS = 7;

const BOT_OWNER_ID = process.env.BOT_OWNER_ID || '365905620060340224';

/**
 * Permissions that mark someone as staff. Staff routinely read without posting, so an
 * activity filter is exactly the thing that would sweep up a quiet moderator.
 */
const STAFF_PERMISSIONS = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ModerateMembers,
];

function tokenFor(auditId, actionType, roleId, userIds) {
    const payload = [auditId, actionType, roleId ?? '-', ...[...userIds].sort()].join(':');
    return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/**
 * Anyone with activity recorded after the snapshot was taken. Read from activity_logs,
 * which the bot writes live for both messages and voice, so this costs one query rather
 * than re-sweeping the guild — and it is the difference between kicking someone for being
 * inactive and kicking someone who posted this morning.
 */
async function activeSince(guildId, sinceDate) {
    const [rows] = await pool.execute(
        `SELECT DISTINCT user_id FROM activity_logs
          WHERE guild_id = ? AND log_date >= DATE(?)`,
        [guildId, sinceDate]
    );
    const set = new Set(rows.map(r => r.user_id));

    // voice_activity is finer-grained than activity_logs' per-day rows and is the table the
    // audit itself trusts, so it gets consulted too rather than assuming the two agree.
    const [voice] = await pool.execute(
        `SELECT DISTINCT user_id FROM voice_activity
          WHERE guild_id = ? AND joined_at >= ?`,
        [guildId, sinceDate]
    );
    for (const v of voice) set.add(v.user_id);

    // member_activity (core/member-activity.js) sees a voice JOIN as it happens (voice_activity only gets
    // the session when it ends) and a message within a minute (activity_logs flushes every five).
    try {
        for (const id of await activeSinceIds(guildId, new Date(sinceDate))) set.add(id);
    } catch { /* table not there yet: the two logs above still apply */ }
    return set;
}

/**
 * Work out why a member must not be touched, or null if they may be.
 * Ordered most-important-first so the reported reason is the most meaningful one.
 */
function protectionFor(member, gm, opts) {
    const { guild, me, actorId, actionType, minMembershipDays, nowMs, recentlyActive } = opts;

    if (!gm) return 'no longer in the server';
    if (gm.user.bot) return 'is a bot';
    if (gm.id === guild.ownerId) return 'is the server owner';
    if (gm.id === BOT_OWNER_ID) return 'is the bot owner';
    if (gm.id === actorId) return 'is you';
    if (gm.id === me.id) return 'is the bot itself';

    if (recentlyActive.has(gm.id)) return 'has been active since this audit was taken';

    const perms = gm.permissions;
    if (STAFF_PERMISSIONS.some(p => perms.has(p))) return 'holds staff permissions';

    if (actionType === 'kick') {
        if (!me.permissions.has(PermissionFlagsBits.KickMembers)) return 'bot lacks Kick Members';
        if (!gm.kickable) return 'bot cannot kick them (role hierarchy)';
        if (minMembershipDays > 0 && gm.joinedTimestamp) {
            const days = Math.floor((nowMs - gm.joinedTimestamp) / 86400000);
            if (days < minMembershipDays) return `joined ${days}d ago (under the ${minMembershipDays}d grace period)`;
        }
        if (minMembershipDays > 0 && !gm.joinedTimestamp) return 'join date unknown, cannot check grace period';
    }

    if (actionType === 'add_role' || actionType === 'remove_role') {
        if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return 'bot lacks Manage Roles';
        const role = guild.roles.cache.get(opts.roleId);
        if (!role) return 'target role no longer exists';
        if (role.managed) return 'target role is managed by an integration';
        if (role.position >= me.roles.highest.position) return 'target role is above the bot';
        if (actionType === 'add_role' && gm.roles.cache.has(role.id)) return 'already has the role';
        if (actionType === 'remove_role' && !gm.roles.cache.has(role.id)) return 'does not have the role';
    }

    return null;
}

/**
 * Build a plan. Never mutates anything in Discord.
 *
 * @returns {{token, action, filterLabel, eligible[], blocked[], counts, warnings[]}}
 */
export async function planAction(client, guildId, {
    auditId, actionType, roleId = null, filter: rawFilter = {},
    actorId, minMembershipDays = DEFAULT_MIN_MEMBERSHIP_DAYS, reason = null,
}) {
    if (!ACTIONS[actionType]) throw new Error(`Unknown action: ${actionType}`);
    if (ACTIONS[actionType].needsRole && !/^\d{17,20}$/.test(String(roleId ?? ''))) {
        throw new Error('That action needs a role');
    }

    const loaded = await loadAudit(auditId);
    if (!loaded) throw new Error('Audit not found');
    if (loaded.audit.guildId !== guildId) throw new Error('Audit belongs to a different server');
    if (loaded.audit.status !== 'complete') throw new Error('That audit did not finish');

    const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId);
    const me = guild.members.me ?? await guild.members.fetchMe();

    // Hierarchy and role checks need the real roster, but a full fetch is a gateway
    // member-chunk round trip — expensive, and executeAction re-plans, so an unconditional
    // fetch would pay for it twice per action. Inside the bot the GuildMembers intent keeps
    // the cache warm, so only fill it when it is visibly short.
    if (guild.memberCount && guild.members.cache.size < guild.memberCount) {
        await guild.members.fetch();
    }

    const warnings = [];
    const snapshotAgeHours = (Date.now() - new Date(loaded.audit.completedAt).getTime()) / 3600000;
    if (snapshotAgeHours > MAX_SNAPSHOT_AGE_HOURS && ACTIONS[actionType].destructive) {
        throw new Error(
            `This audit is ${Math.round(snapshotAgeHours)}h old. Re-run it before kicking — ` +
            `members will have been active since it was taken.`);
    }
    if (snapshotAgeHours > 6) {
        warnings.push(`Snapshot is ${Math.round(snapshotAgeHours)}h old; anyone active since then is excluded automatically.`);
    }
    if (!loaded.audit.voiceTracked) {
        warnings.push('Voice was not tracked for this window — members active only in voice look inactive here.');
    }

    const filter = normaliseFilter(rawFilter);
    const roleMap = new Map(guild.members.cache.map(m => [m.id, [...m.roles.cache.keys()]]));
    const selected = applyFilter(loaded.members, filter, loaded.ctx, roleMap);

    const recentlyActive = await activeSince(guildId, loaded.audit.completedAt);

    const opts = {
        guild, me, actorId, actionType, roleId,
        minMembershipDays: actionType === 'kick' ? minMembershipDays : 0,
        nowMs: Date.now(), recentlyActive,
    };

    const eligible = [], blocked = [];
    for (const m of selected) {
        const gm = guild.members.cache.get(m.userId);
        const why = protectionFor(m, gm, opts);
        const row = {
            userId: m.userId,
            displayName: gm?.displayName ?? m.displayName ?? m.userId,
            messages: m.messages, voiceSeconds: m.voiceSeconds,
            daysSinceActive: m.daysSinceActive,
            joinedGuildAt: gm?.joinedAt?.toISOString() ?? m.joinedGuildAt,
        };
        if (why) blocked.push({ ...row, reason: why });
        else eligible.push(row);
    }

    eligible.sort((a, b) => a.displayName.localeCompare(b.displayName));
    const capped = eligible.slice(0, MAX_TARGETS);
    if (eligible.length > MAX_TARGETS) {
        warnings.push(`${eligible.length} members matched; capped to ${MAX_TARGETS} for this run. Run again for the rest.`);
    }

    return {
        token: tokenFor(auditId, actionType, roleId, capped.map(e => e.userId)),
        auditId, actionType, roleId, reason,
        filter, filterLabel: describeFilter(filter),
        eligible: capped,
        blocked,
        counts: { selected: selected.length, eligible: capped.length, blocked: blocked.length },
        warnings,
        snapshotAgeHours: Math.round(snapshotAgeHours * 10) / 10,
    };
}

/**
 * Execute a previously-approved plan.
 *
 * The token must still match the current eligible set — if anything has shifted, the run is
 * refused so a human re-reviews rather than acting on a list nobody saw.
 */
export async function executeAction(client, guildId, {
    auditId, actionType, roleId = null, filter = {}, actorId, token,
    minMembershipDays = DEFAULT_MIN_MEMBERSHIP_DAYS, reason = null, source = 'dashboard',
}) {
    const plan = await planAction(client, guildId, {
        auditId, actionType, roleId, filter, actorId, minMembershipDays, reason,
    });

    if (plan.token !== token) {
        const err = new Error(
            'The set of members changed since you reviewed it — nothing was done. ' +
            'Re-check the plan and confirm again.');
        err.code = 'STALE_PLAN';
        err.plan = plan;
        throw err;
    }
    if (!plan.eligible.length) {
        const err = new Error('Nothing to do — no members are eligible.');
        err.code = 'EMPTY_PLAN';
        throw err;
    }

    const [ins] = await pool.execute(
        `INSERT INTO activity_audit_actions
            (audit_id, guild_id, action_type, role_id, filter_json, filter_label, reason,
             requested_by, source, status, planned_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
        [auditId, guildId, actionType, roleId, JSON.stringify(plan.filter),
         plan.filterLabel.slice(0, 500), reason?.slice(0, 400) ?? null,
         actorId, source, plan.eligible.length]
    );
    const actionId = ins.insertId;

    await pool.query(
        `INSERT INTO activity_audit_action_targets (action_id, user_id, display_name, outcome)
         VALUES ? ON DUPLICATE KEY UPDATE outcome = VALUES(outcome)`,
        [plan.eligible.map(e => [actionId, e.userId, e.displayName.slice(0, 64), 'pending'])]
    );

    const guild = client.guilds.cache.get(guildId);
    const me = guild.members.me;
    const recentlyActive = await activeSince(guildId, (await loadAudit(auditId)).audit.completedAt);
    const auditReason = sanitiseReason(reason ?? `Activity audit #${auditId}`);

    let done = 0, failed = 0, skipped = 0;
    for (const target of plan.eligible) {
        const gm = guild.members.cache.get(target.userId);
        // Re-checked immediately before acting: the plan may have been approved minutes ago
        // and this is the last moment a change can still be caught.
        const why = protectionFor(target, gm, {
            guild, me, actorId, actionType, roleId,
            minMembershipDays: actionType === 'kick' ? minMembershipDays : 0,
            nowMs: Date.now(), recentlyActive,
        });
        if (why) {
            skipped++;
            await markTarget(actionId, target.userId, 'skipped', why);
            continue;
        }

        try {
            if (actionType === 'kick') await gm.kick(auditReason);
            else if (actionType === 'add_role') await gm.roles.add(roleId, auditReason);
            else if (actionType === 'remove_role') await gm.roles.remove(roleId, auditReason);
            done++;
            await markTarget(actionId, target.userId, 'done', null);
        } catch (e) {
            failed++;
            await markTarget(actionId, target.userId, 'failed', String(e.message).slice(0, 300));
            logger.warn('[ActivityAudit] Action failed for member', {
                actionId, userId: target.userId, actionType, error: e.message,
            });
        }
        // Paced deliberately: a burst of kicks trips Discord's rate limiter and looks
        // identical to a compromised token from the API's side.
        await new Promise(r => setTimeout(r, 1200));
    }

    await pool.execute(
        `UPDATE activity_audit_actions
            SET status = 'complete', completed_at = NOW(),
                success_count = ?, failed_count = ?, skipped_count = ?
          WHERE action_id = ?`,
        [done, failed, skipped, actionId]
    );

    logger.info('[ActivityAudit] Bulk action complete', {
        actionId, guildId, actionType, done, failed, skipped, actor: actorId,
    });

    return { actionId, done, failed, skipped, planned: plan.eligible.length };
}

async function markTarget(actionId, userId, outcome, detail) {
    await pool.execute(
        `UPDATE activity_audit_action_targets
            SET outcome = ?, detail = ?, acted_at = NOW()
          WHERE action_id = ? AND user_id = ?`,
        [outcome, detail, actionId, userId]
    );
}

/**
 * Discord rejects an X-Audit-Log-Reason containing anything outside Latin-1, and the
 * failure surfaces as an opaque 400 on the action itself rather than on the header.
 */
function sanitiseReason(text) {
    return String(text)
        .replace(/[‐-―]/g, '-')
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[^\x20-\xFF]/g, '')
        .slice(0, 400) || 'Activity audit';
}

/** Recent bulk actions for a guild, for the history panel. */
export async function recentActions(guildId, limit = 15) {
    const [rows] = await pool.execute(
        `SELECT * FROM activity_audit_actions WHERE guild_id = ?
          ORDER BY action_id DESC LIMIT ${Math.min(50, Math.max(1, Number(limit) || 15))}`,
        [guildId]
    );
    return rows.map(r => ({
        id: r.action_id, auditId: r.audit_id, actionType: r.action_type, roleId: r.role_id,
        filterLabel: r.filter_label, reason: r.reason, requestedBy: r.requested_by,
        source: r.source, status: r.status, createdAt: r.created_at, completedAt: r.completed_at,
        counts: { planned: r.planned_count, done: r.success_count, failed: r.failed_count, skipped: r.skipped_count },
    }));
}

/** Per-member outcomes for one action. */
export async function actionTargets(actionId) {
    const [rows] = await pool.execute(
        'SELECT * FROM activity_audit_action_targets WHERE action_id = ? ORDER BY outcome, display_name',
        [actionId]
    );
    return rows.map(r => ({
        userId: r.user_id, displayName: r.display_name,
        outcome: r.outcome, detail: r.detail, actedAt: r.acted_at,
    }));
}
