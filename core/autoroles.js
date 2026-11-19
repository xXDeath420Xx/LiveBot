/*
 * Autoroles — roles the bot gives members when they join (Utilities page, autoroles_config).
 *
 *   roles_to_assign   JSON role ids for people. Several are allowed. Each goes on with its own
 *                     add-one-role request, never a whole-role-list edit: a list built from a cache that is
 *                     a moment old would silently take away a role someone else gave in between.
 *   bot_roles         JSON role ids for bots. Bots get these and never the people roles.
 *   require_roles     JSON: a person must hold at least one of these. Someone who is given one later
 *                     (verification, a reaction role, staff) gets the join roles then
 *                     (events/guildMemberUpdate.js -> onRolesAdded).
 *   ignore_roles      JSON: people holding any of these are skipped.
 *   delay_minutes     wait this long after joining. The wait is a row on the shared deadline queue
 *                     (temp_access_members kind 'autorole'), so it survives restarts; jobs/temp-access-reaper.js
 *                     calls resolveAutoroleDeadline when it is due, and a member who leaves first is
 *                     closed off by markLeft like every other deadline.
 *   welcome_settings.auto_role_id   the older single-role setting. Still honoured for people while no
 *                     roles are chosen here (or autoroles are off), exactly as before: no conditions, no delay.
 *
 * Membership screening: nobody pending gets roles. The pending -> accepted update calls assignAutoroles
 * again (events/guildMemberUpdate.js), and the delay is counted from the join, not from accepting.
 *
 * "Give to existing members" (startBackfill) walks the member list a page at a time in the background,
 * one role request about every 1.1 s, and saves its place so a restart can carry on from where it was
 * (resumeBackfills). It never touches the server owner or anyone whose top role is level with or above
 * the bot's, and stops by itself if the bot keeps being refused.
 */
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { safeJsonArray } from '../utils/safeJson.js';
import { logFeatureEvent, userLabel } from './feature-log.js';
import { upsertDeadline, closeDeadline } from './temp-access-manager.js';

export const MAX_ROLES = 10;
export const MAX_DELAY_MINUTES = 10080;      // 7 days
const BACKFILL_PACE_MS = 1100;               // one role request a second, under the member-edit bucket
const BACKFILL_PAGE = 100;                // small pages keep each member's roles fresh when it is their turn
const BACKFILL_SAVE_MS = 4000;
const BACKFILL_MAX_REFUSALS = 15;            // consecutive refusals before the run gives up

/** A problem the person can fix; the message is shown to them as written. */
export class AutoroleError extends Error {}

const SNOWFLAKE = /^\d{17,20}$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A JSON (or legacy comma-separated) list of role ids, de-duplicated. */
export function roleIdList(raw) {
    let list = [];
    if (Array.isArray(raw)) list = raw;
    else if (typeof raw === 'string' && raw.trim().startsWith('[')) list = safeJsonArray(raw, 'autoroles');
    else if (raw) list = String(raw).split(',');
    return [...new Set(list.map((x) => String(x).trim()).filter((x) => SNOWFLAKE.test(x)))];
}

export function clampDelay(value) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(MAX_DELAY_MINUTES, n);
}

// guildId -> { at, cfg }. Role changes in every server ask for this, so it is cached briefly;
// the dashboard's save calls invalidateAutoroleConfig, and the backfill always reads fresh.
const configCache = new Map();
const CONFIG_TTL_MS = 60000;

export function invalidateAutoroleConfig(guildId) {
    if (guildId) configCache.delete(String(guildId)); else configCache.clear();
}

/** The server's autorole settings, normalised. Tolerates a table that predates migration 419. */
export async function getAutoroleConfig(guildId, { fresh = false } = {}) {
    const hit = configCache.get(guildId);
    if (!fresh && hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.cfg;
    const cfg = await readAutoroleConfig(guildId);
    configCache.set(guildId, { at: Date.now(), cfg });
    if (configCache.size > 5000) for (const [k, v] of configCache) if (Date.now() - v.at > CONFIG_TTL_MS) configCache.delete(k);
    return cfg;
}

async function readAutoroleConfig(guildId) {
    const [rows] = await pool.execute('SELECT * FROM autoroles_config WHERE guild_id = ?', [guildId]);
    const r = rows[0] || {};
    const cfg = {
        enabled: !!Number(r.is_enabled),
        roles: roleIdList(r.roles_to_assign),
        botRoles: roleIdList(r.bot_roles),
        requireRoles: roleIdList(r.require_roles),
        ignoreRoles: roleIdList(r.ignore_roles),
        delayMinutes: clampDelay(r.delay_minutes),
        legacyRoleId: null,
    };
    if (!cfg.enabled || !cfg.roles.length) {
        const [legacy] = await pool.execute(
            "SELECT auto_role_id FROM welcome_settings WHERE guild_id = ? AND auto_role_id IS NOT NULL AND auto_role_id <> ''",
            [guildId]
        );
        if (legacy[0]?.auto_role_id && SNOWFLAKE.test(String(legacy[0].auto_role_id))) cfg.legacyRoleId = String(legacy[0].auto_role_id);
    }
    return cfg;
}

/**
 * What this member should get right now.
 * @returns {{ skip?: string, give: import('discord.js').Role[], broken: string[], configured: boolean, isBot: boolean }}
 *   skip: 'none' (nothing set up for them) | 'pending' (rules not accepted) | 'ignored' | 'requirement'
 */
export function planFor(member, cfg) {
    const isBot = !!member.user?.bot;
    let ids = [];
    let configured = false;
    if (isBot) ids = cfg.enabled ? cfg.botRoles : [];
    else if (cfg.enabled && cfg.roles.length) { ids = cfg.roles; configured = true; }
    else if (cfg.legacyRoleId) ids = [cfg.legacyRoleId];

    const out = { give: [], broken: [], configured, isBot };
    if (!ids.length) return { ...out, skip: 'none' };
    if (!isBot && member.pending) return { ...out, skip: 'pending' };
    if (configured) {
        if (cfg.ignoreRoles.some((id) => member.roles.cache.has(id))) return { ...out, skip: 'ignored' };
        if (cfg.requireRoles.length && !cfg.requireRoles.some((id) => member.roles.cache.has(id))) return { ...out, skip: 'requirement' };
    }
    for (const id of ids) {
        if (member.roles.cache.has(id)) continue;
        const role = member.guild.roles.cache.get(id);
        // role.editable: the bot has Manage Roles, the role sits below the bot's top role, and it is not
        // an integration's own role. Anything else would fail the whole request, so it is reported instead.
        if (role && role.editable && role.id !== member.guild.id) out.give.push(role);
        else out.broken.push(id);
    }
    return out;
}

/** Owner, or a top role level with or above the bot's: the backfill leaves these members alone. */
function outranksBot(member) {
    const me = member.guild.members.me;
    if (!me) return true;
    if (member.id === member.guild.ownerId) return true;
    return member.roles.highest.comparePositionTo(me.roles.highest) >= 0;
}

function reportFailure(member, ids) {
    if (!ids.length) return;
    void logFeatureEvent(() => member.guild, 'autorole.failed', () => ({
        title: '⚠️ Autorole Failed',
        description: 'These autoroles could not be given — the role was deleted, or the bot cannot manage it (Manage Roles, or the role sits above the bot).',
        fields: [
            ['Member', userLabel(member)],
            ['Roles', ids.map((id) => `<@&${id}>`).join(', '), false],
        ],
        // A broken autorole fails for every join until it is fixed: once an hour per broken set is enough.
        throttle: { key: `autorole-fail:${member.guild.id}:${ids.join(',')}`, ms: 3600000 },
    }));
}

/**
 * Give a member their autoroles (or queue them when a delay is set).
 * @param {import('discord.js').GuildMember} member
 * @param {{ source?: 'join'|'screening'|'requirement'|'delay' }} [opts]
 * @returns {Promise<{ status: string, given?: string[] }>}
 *   status: 'given' | 'queued' | 'nothing' | 'failed' | one of planFor's skip reasons
 */
export async function assignAutoroles(member, { source = 'join' } = {}) {
    const guildId = member.guild.id;
    try {
        const cfg = await getAutoroleConfig(guildId);
        const plan = planFor(member, cfg);
        if (plan.skip) {
            if (plan.skip === 'pending') {
                logger.info(`Skipping autorole for ${member.user.tag} - rules screening not completed (pending: true)`, {
                    guildId, userId: member.id, category: 'greeting',
                });
            }
            return { status: plan.skip };
        }

        // The wait counts from the join. A member who accepts the rules or picks up a required role
        // later only waits for what is left of it.
        if (plan.configured && cfg.delayMinutes > 0 && source !== 'delay') {
            const joined = member.joinedTimestamp || Date.now();
            const leftMs = joined + cfg.delayMinutes * 60000 - Date.now();
            if (leftMs > 5000) {
                try {
                    await upsertDeadline(guildId, member.id, 'autorole', Math.ceil(leftMs / 1000), `join roles after ${cfg.delayMinutes} min`);
                    return { status: 'queued' };
                } catch (error) {
                    // The queue is not ready (migration 419 not applied yet): better early than never.
                    logger.warn(`[Autoroles] could not queue the delayed roles for ${member.id}, giving them now: ${error.message}`, { guildId });
                }
            }
        }

        reportFailure(member, plan.broken);
        if (!plan.give.length) return { status: plan.broken.length ? 'failed' : 'nothing' };

        const reason = { join: 'Autoroles', screening: 'Autoroles (accepted the rules)', requirement: 'Autoroles (got a required role)', delay: 'Autoroles (after the wait)' }[source] || 'Autoroles';
        const given = [];
        const failed = [];
        for (const role of plan.give) {
            try {
                await member.roles.add(role, reason);   // one role: PUT .../roles/:id, atomic
                given.push(role);
            } catch (error) {
                failed.push(role.id);
                logger.error(`Failed to assign autorole ${role.id}`, { guildId, userId: member.id, category: 'greeting', error: error.message });
            }
        }
        reportFailure(member, failed);
        if (!given.length) return { status: 'failed' };
        const names = given.map((r) => r.name);
        logger.info(`Assigned autoroles to ${member.user.tag}: ${names.join(', ')}`, { guildId, userId: member.id, category: 'greeting' });
        void logFeatureEvent(() => member.guild, 'autorole.assigned', () => ({
            title: '🎭 Autoroles Given',
            fields: [
                ['Member', userLabel(member)],
                ['Roles', names.join(', '), false],
            ],
        }));
        return { status: 'given', given: names };
    } catch (error) {
        logger.error('Error assigning autoroles', { guildId, userId: member.id, category: 'greeting', error: error.message, stack: error.stack });
        return { status: 'failed' };
    }
}

/**
 * Roles were added to a member (events/guildMemberUpdate.js). When one of them is a required role, the
 * member now qualifies: give the join roles (or start what is left of the wait).
 */
export async function onRolesAdded(oldMember, newMember) {
    try {
        if (newMember.user?.bot || newMember.pending) return;
        // Accepting the rules in this same update is handled by the screening path, which already gives them.
        if (oldMember.pending === true) return;
        const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id));
        if (!added.size) return;
        const cfg = await getAutoroleConfig(newMember.guild.id);
        if (!cfg.enabled || !cfg.roles.length || !cfg.requireRoles.length) return;
        if (!cfg.requireRoles.some((id) => added.has(id))) return;
        // Already has every join role: nothing to do (and no log line).
        if (cfg.roles.every((id) => newMember.roles.cache.has(id))) return;
        await assignAutoroles(newMember, { source: 'requirement' });
    } catch (error) {
        logger.warn(`[Autoroles] required-role check failed for ${newMember.id}: ${error.message}`, { guildId: newMember.guild?.id });
    }
}

function liveGuild(guildId, fallback = null) {
    return global.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.get(guildId) || fallback;
}

/** A due 'autorole' deadline (jobs/temp-access-reaper.js). Never removes anyone, so always false. */
export async function resolveAutoroleDeadline(guild, row) {
    const g = liveGuild(guild.id, guild);
    const member = await g.members.fetch(row.user_id).catch(() => null);
    if (!member) {
        await closeDeadline(g.id, row.user_id, 'autorole', 'left', 'not in the server when the wait ended');
        return false;
    }
    const res = await assignAutoroles(member, { source: 'delay' });
    await closeDeadline(g.id, row.user_id, 'autorole', res.status === 'failed' ? 'failed' : 'passed', `autoroles: ${res.status}`);
    return false;
}

/* ------------------------------------------------------------------ *
 * Give to existing members
 * ------------------------------------------------------------------ */

const jobs = new Map(); // guildId -> { cancel, counts, total, startedAt }

const STATUS_COLUMNS = `backfill_status, backfill_total, backfill_scanned, backfill_given, backfill_skipped, backfill_failed,
    backfill_cursor, backfill_started_by, backfill_note,
    UNIX_TIMESTAMP(backfill_started_at) * 1000 AS started_ms, UNIX_TIMESTAMP(backfill_finished_at) * 1000 AS finished_ms`;

/**
 * Where the last run is. `interrupted` = the database says running but this process is not running it
 * (the bot restarted mid-run); starting again carries on from where it stopped.
 */
export async function getBackfillStatus(guildId) {
    let row = {};
    try {
        const [rows] = await pool.execute(`SELECT ${STATUS_COLUMNS} FROM autoroles_config WHERE guild_id = ?`, [guildId]);
        row = rows[0] || {};
    } catch (error) {
        if (error.code === 'ER_BAD_FIELD_ERROR') return { status: null, unavailable: true };
        throw error;
    }
    const job = jobs.get(guildId);
    const n = (v) => Number(v) || 0;
    const status = {
        status: row.backfill_status || null,
        running: !!job,
        interrupted: row.backfill_status === 'running' && !job,
        total: n(job?.total ?? row.backfill_total),
        scanned: n(job?.counts.scanned ?? row.backfill_scanned),
        given: n(job?.counts.given ?? row.backfill_given),
        skipped: n(job?.counts.skipped ?? row.backfill_skipped),
        failed: n(job?.counts.failed ?? row.backfill_failed),
        startedAt: row.started_ms == null ? null : Number(row.started_ms),
        finishedAt: row.finished_ms == null ? null : Number(row.finished_ms),
        note: row.backfill_note || null,
        paceMs: BACKFILL_PACE_MS,
    };
    return status;
}

/**
 * Start (or carry on with) giving the autoroles to members who are already in the server.
 * @param {import('discord.js').Guild} guild  from the client that runs this server
 * @param {{ startedBy?: string|null }} [opts]
 */
export async function startBackfill(guild, { startedBy = null } = {}) {
    const guildId = guild.id;
    if (jobs.has(guildId)) throw new AutoroleError('Already running. It shows its progress below.');
    const cfg = await getAutoroleConfig(guildId, { fresh: true });
    if (!cfg.enabled) throw new AutoroleError('Switch "Give roles on join" on and save first.');
    const ids = [...cfg.roles, ...cfg.botRoles];
    if (!ids.length) throw new AutoroleError('Choose at least one role and save first.');
    const me = guild.members.me;
    if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) throw new AutoroleError('The bot needs the Manage Roles permission.');
    const usable = ids.map((id) => guild.roles.cache.get(id)).filter((r) => r && r.editable);
    if (!usable.length) throw new AutoroleError("None of the chosen roles can be given by the bot. Move the bot's role above them in Server Settings > Roles.");

    const prev = await getBackfillStatus(guildId);
    if (prev.unavailable) throw new AutoroleError('This needs a database update that has not been applied yet.');
    const resume = prev.interrupted;
    const counts = resume
        ? { scanned: prev.scanned, given: prev.given, skipped: prev.skipped, failed: prev.failed }
        : { scanned: 0, given: 0, skipped: 0, failed: 0 };
    let cursor = null;
    if (resume) {
        const [[row]] = await pool.execute('SELECT backfill_cursor FROM autoroles_config WHERE guild_id = ?', [guildId]);
        cursor = row?.backfill_cursor || null;
    }

    const total = guild.memberCount || 0;
    if (resume) {
        await pool.execute(
            "UPDATE autoroles_config SET backfill_status = 'running', backfill_total = ?, backfill_note = NULL, backfill_finished_at = NULL WHERE guild_id = ?",
            [total, guildId]
        );
    } else {
        await pool.execute(
            `UPDATE autoroles_config SET backfill_status = 'running', backfill_total = ?, backfill_scanned = 0, backfill_given = 0,
                    backfill_skipped = 0, backfill_failed = 0, backfill_cursor = NULL, backfill_started_by = ?,
                    backfill_started_at = NOW(), backfill_finished_at = NULL, backfill_note = NULL
              WHERE guild_id = ?`,
            [total, startedBy, guildId]
        );
    }

    const job = { cancel: false, counts, total, cursor };
    jobs.set(guildId, job);
    logger.info(`[Autoroles] ${resume ? 'resuming' : 'starting'} the existing-member run in ${guildId} (${total} members)`, { guildId });
    runBackfill(guildId, job, guild)
        .catch((error) => logger.error(`[Autoroles] existing-member run crashed in ${guildId}: ${error.message}`, { guildId, stack: error.stack }))
        .finally(() => jobs.delete(guildId));
    return getBackfillStatus(guildId);
}

/** Ask a running job to stop after the member it is on. @returns whether one was running here. */
export async function cancelBackfill(guildId) {
    const job = jobs.get(guildId);
    if (job) { job.cancel = true; return true; }
    // Interrupted by a restart and never resumed: just mark it stopped.
    const [res] = await pool.execute(
        "UPDATE autoroles_config SET backfill_status = 'cancelled', backfill_finished_at = NOW(), backfill_note = 'Stopped.' WHERE guild_id = ? AND backfill_status = 'running'",
        [guildId]
    ).catch(() => [{ affectedRows: 0 }]);
    return res.affectedRows > 0;
}

async function saveProgress(guildId, job) {
    const c = job.counts;
    await pool.execute(
        `UPDATE autoroles_config SET backfill_total = ?, backfill_scanned = ?, backfill_given = ?, backfill_skipped = ?,
                backfill_failed = ?, backfill_cursor = ? WHERE guild_id = ?`,
        [job.total, c.scanned, c.given, c.skipped, c.failed, job.cursor, guildId]
    ).catch((error) => logger.warn(`[Autoroles] could not save run progress in ${guildId}: ${error.message}`));
}

async function finish(guildId, job, status, note) {
    await saveProgress(guildId, job);
    await pool.execute(
        'UPDATE autoroles_config SET backfill_status = ?, backfill_finished_at = NOW(), backfill_note = ? WHERE guild_id = ?',
        [status, note ? String(note).slice(0, 255) : null, guildId]
    ).catch((error) => logger.warn(`[Autoroles] could not close the run in ${guildId}: ${error.message}`));
    const c = job.counts;
    logger.info(`[Autoroles] existing-member run in ${guildId} ${status}: checked ${c.scanned}, given ${c.given}, skipped ${c.skipped}, failed ${c.failed}${note ? ` (${note})` : ''}`, { guildId });
    const guild = liveGuild(guildId);
    if (guild) {
        void logFeatureEvent(() => guild, 'autorole.backfill', () => ({
            title: status === 'done' ? 'Autoroles given to existing members' : 'Autoroles for existing members stopped',
            description: note || undefined,
            fields: [['Checked', String(c.scanned)], ['Given', String(c.given)], ['Skipped', String(c.skipped)], ['Failed', String(c.failed)]],
        }));
    }
}

async function runBackfill(guildId, job, startGuild) {
    let lastSave = Date.now();
    let refusals = 0;
    let after = job.cursor || '0';
    for (;;) {
        if (job.cancel) return finish(guildId, job, 'cancelled', 'Stopped.');
        const guild = liveGuild(guildId, startGuild);
        if (!guild || !guild.members.me) return finish(guildId, job, 'failed', 'The bot is no longer in the server.');
        // Re-read each page, so a change saved mid-run (or switching autoroles off) is honoured.
        const cfg = await getAutoroleConfig(guildId, { fresh: true });
        if (!cfg.enabled) return finish(guildId, job, 'cancelled', 'Autoroles were switched off.');
        job.total = Math.max(job.total, guild.memberCount || 0);

        let page = null;
        for (let attempt = 1; attempt <= 3 && !page; attempt++) {
            try {
                page = await guild.members.list({ limit: BACKFILL_PAGE, after, cache: false });
            } catch (error) {
                logger.warn(`[Autoroles] member list page failed in ${guildId} (try ${attempt}): ${error.message}`, { guildId });
                if (attempt === 3) return finish(guildId, job, 'failed', 'Could not read the member list from Discord.');
                await sleep(5000 * attempt);
            }
        }
        if (!page.size) break;
        const members = [...page.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));

        for (const member of members) {
            if (job.cancel) break;
            job.cursor = member.id;
            after = member.id;
            job.counts.scanned++;

            const plan = planFor(member, cfg);
            if (plan.skip || !plan.give.length || outranksBot(member)) {
                job.counts.skipped++;
            } else if (plan.configured && cfg.delayMinutes > 0
                && (member.joinedTimestamp || 0) + cfg.delayMinutes * 60000 - Date.now() > 5000) {
                // Joined too recently: put them on the normal wait instead of giving the roles early.
                try {
                    const left = (member.joinedTimestamp || Date.now()) + cfg.delayMinutes * 60000 - Date.now();
                    await upsertDeadline(guildId, member.id, 'autorole', Math.ceil(left / 1000), `join roles after ${cfg.delayMinutes} min`);
                } catch { /* the join path will have queued them already */ }
                job.counts.skipped++;
            } else {
                let ok = 0;
                for (const role of plan.give) {
                    try {
                        // PUT .../members/:user/roles/:role — adds one role and leaves every other role alone.
                        await guild.members.addRole({ user: member.id, role: role.id, reason: 'Autoroles: given to existing members' });
                        ok++;
                        refusals = 0;
                    } catch (error) {
                        // 50013 Missing Permissions, 50001 Missing Access: the bot lost the ability, not this member.
                        if (error.code === 50013 || error.code === 50001) refusals++;
                        logger.warn(`[Autoroles] existing-member run: could not give ${role.id} to ${member.id} in ${guildId}: ${error.message}`, { guildId });
                    }
                    await sleep(BACKFILL_PACE_MS);
                    if (refusals >= BACKFILL_MAX_REFUSALS) break;
                }
                if (ok) job.counts.given++; else job.counts.failed++;
                if (refusals >= BACKFILL_MAX_REFUSALS) {
                    return finish(guildId, job, 'failed', 'Discord kept refusing: check that the bot still has Manage Roles and its role is above the autoroles.');
                }
            }
            if (Date.now() - lastSave > BACKFILL_SAVE_MS) {
                lastSave = Date.now();
                await saveProgress(guildId, job);
            }
        }
        if (job.cancel) return finish(guildId, job, 'cancelled', 'Stopped.');
        await saveProgress(guildId, job);
        if (page.size < BACKFILL_PAGE) break;
    }
    return finish(guildId, job, 'done', null);
}

/**
 * Carry on with runs the last process left half done. Call once after the bots are ready; servers whose
 * bot is not connected yet are left 'running' (the page offers to resume them).
 */
export async function resumeBackfills() {
    let rows = [];
    try {
        [rows] = await pool.execute("SELECT guild_id, backfill_started_by FROM autoroles_config WHERE backfill_status = 'running'");
    } catch (error) {
        if (error.code !== 'ER_BAD_FIELD_ERROR') logger.warn(`[Autoroles] could not look for runs to resume: ${error.message}`);
        return 0;
    }
    let resumed = 0;
    for (const row of rows) {
        const guild = liveGuild(row.guild_id);
        if (!guild || jobs.has(row.guild_id)) continue;
        try {
            await startBackfill(guild, { startedBy: row.backfill_started_by });
            resumed++;
        } catch (error) {
            const note = error instanceof AutoroleError ? error.message : 'Could not resume after a restart.';
            await pool.execute(
                "UPDATE autoroles_config SET backfill_status = 'failed', backfill_finished_at = NOW(), backfill_note = ? WHERE guild_id = ?",
                [note.slice(0, 255), row.guild_id]
            ).catch(() => {});
        }
    }
    if (resumed) logger.info(`[Autoroles] resumed ${resumed} existing-member run(s)`);
    return resumed;
}

export default {
    getAutoroleConfig, invalidateAutoroleConfig, planFor, assignAutoroles, onRolesAdded, resolveAutoroleDeadline,
    getBackfillStatus, startBackfill, cancelBackfill, resumeBackfills, roleIdList, clampDelay,
};
