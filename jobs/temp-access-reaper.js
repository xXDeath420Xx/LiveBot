/**
 * Closes out temporary-access trials whose deadline has passed.
 *
 * This job can remove people from a guild, so its blast radius is deliberately
 * tiny: it reads ONLY `temp_access_members` rows that are still 'pending' and
 * already past `expires_at`. It never enumerates guild members and never decides
 * on its own that somebody looks idle. If no row exists for a member, this job
 * cannot touch them.
 *
 * Four things save a member at the deadline, checked in this order:
 *   - they are already gone           -> 'left'
 *   - they hold a role we didn't give -> 'exempt'
 *   - they showed activity            -> 'passed'
 *   - they are sitting in a voice channel right now -> 'passed'
 *
 * The last one exists because voice sessions are only written to the DB when
 * they END. Someone who joined voice and never left has no completed session,
 * and on a naive check would look every bit as idle as someone who never showed
 * up. The gateway's live voice state is the authority here, not the log.
 *
 * Runs every minute rather than daily: `expires_at` is per member, so a
 * frequent sweep is what makes "24 hours" mean roughly 24 hours instead of
 * "sometime the next night" (and a 5-minute CAPTCHA window mean 5 minutes).
 *
 * THE one member reaper (migration 328). The same queue now carries three kinds
 * of deadline, and each due row goes to its owner:
 *   'trial'   temporary access (below)
 *   'prune'   auto-prune: no real role N minutes after joining (core/auto-prune.js)
 *   'verify'  the CAPTCHA completion window ran out (core/verification.js)
 * plus, once a day at 03:00 UTC, the older verification rule "still Unverified
 * after N days" (core/verification.js sweepUnverifiedDays; it used to be
 * jobs/unverified-reaper.js, now a stub). Every removal goes through
 * protectionHold, and one kick cap covers the whole sweep.
 *
 * Also the inactivity prune (core/inactivity-prune.js, migration 332): every 15
 * minutes it sweeps the servers with an inactivity rule on whose last sweep is
 * 6+ hours old, one server at a time, with that feature's own per-sweep and
 * per-day kick caps. And it drives the member-activity flush (core/member-
 * activity.js: last message / voice join per member, written once a minute).
 */
import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import {
    getConfig, primeTempAccess, hasForeignRole, postLog, resyncInviteCounts,
} from '../core/temp-access-manager.js';
import { protectionHold } from '../core/protection-exempt.js';
import { resolvePruneDeadline } from '../core/auto-prune.js';
import { resolveVerifyDeadline, sweepUnverifiedDays } from '../core/verification.js';
import { resolveAutoroleDeadline } from '../core/autoroles.js';
import { whyCannot, reportManualAction } from '../core/manual-action.js';
import { sweepInactivityDue } from '../core/inactivity-prune.js';
import { startActivityFlush, stopActivityFlush } from '../core/member-activity.js';

let dailyTask = null;
let inactivityTask = null;

let task = null;

// A runaway sweep should stop and shout rather than empty a server. Reaching
// this in normal operation is unlikely: it needs 25 deadlines that end in a
// removal inside one minute. The rest wait for the next sweep, not forever.
const MAX_KICKS_PER_SWEEP = 25;
// 'autorole' (delayed join roles, core/autoroles.js) never removes anyone, so it never counts toward the cap.
const OTHER_KINDS = { prune: resolvePruneDeadline, verify: resolveVerifyDeadline, autorole: resolveAutoroleDeadline };

function resolveGuild(guildId) {
    if (!global.botManager?.clients) return null;
    for (const [, client] of global.botManager.clients) {
        const guild = client.guilds.cache.get(guildId);
        if (guild) return guild;
    }
    return null;
}

export async function runTempAccessSweep() {
    let due;
    try {
        const [rows] = await pool.execute(
            `SELECT id, guild_id, user_id, kind, attempts, first_activity_at, activity_kind, expires_at
               FROM temp_access_members
              WHERE status = 'pending' AND expires_at <= NOW()
              ORDER BY expires_at ASC
              LIMIT 200`
        );
        due = rows;
    } catch (err) {
        logger.error(`[TempAccessReaper] could not read due trials: ${err.message}`);
        return;
    }
    if (!due.length) return;

    logger.info(`[TempAccessReaper] ${due.length} deadline(s) due`);

    let kicksThisSweep = 0;
    const byGuild = new Map();
    const others = [];
    for (const row of due) {
        if (row.kind && row.kind !== 'trial') { others.push(row); continue; }
        if (!byGuild.has(row.guild_id)) byGuild.set(row.guild_id, []);
        byGuild.get(row.guild_id).push(row);
    }

    // Auto-prune and CAPTCHA windows: their own modules decide; the cap is shared.
    for (const row of others) {
        if (kicksThisSweep >= MAX_KICKS_PER_SWEEP) {
            logger.error(`[TempAccessReaper] kick cap (${MAX_KICKS_PER_SWEEP}) hit — deferring the rest to the next sweep`);
            break;
        }
        const guild = resolveGuild(row.guild_id);
        if (!guild) continue;
        try {
            if (await OTHER_KINDS[row.kind]?.(guild, row)) kicksThisSweep++;
        } catch (err) {
            logger.error(`[TempAccessReaper] ${row.kind} ${row.guild_id}/${row.user_id} failed: ${err.message}`, { stack: err.stack });
            await close(row.id, 'error', err.message.slice(0, 255));
        }
    }

    for (const [guildId, rows] of byGuild) {
        const cfg = await getConfig(guildId);
        if (!cfg) {
            // Config deleted out from under live trials — close them rather than
            // leaving rows that will be re-read on every sweep forever.
            await closeAll(rows, 'cancelled', 'temp access config removed');
            continue;
        }
        if (!cfg.enabled) {
            logger.info(`[TempAccessReaper] ${guildId}: disabled, leaving ${rows.length} trial(s) pending`);
            continue;
        }

        const guild = resolveGuild(guildId);
        if (!guild) {
            logger.warn(`[TempAccessReaper] ${guildId}: no client has this guild cached, skipping`);
            continue;
        }

        for (const row of rows) {
            if (kicksThisSweep >= MAX_KICKS_PER_SWEEP) {
                logger.error(`[TempAccessReaper] kick cap (${MAX_KICKS_PER_SWEEP}) hit — deferring the rest to the next sweep`);
                break;
            }
            try {
                const kicked = await resolveTrial(guild, cfg, row);
                if (kicked) kicksThisSweep++;
            } catch (err) {
                logger.error(`[TempAccessReaper] ${guildId}/${row.user_id} failed: ${err.message}`, { stack: err.stack });
                await close(row.id, 'error', err.message.slice(0, 255));
            }
        }
    }

    // Memory and DB agree again — resolved rows drop out of the pending set.
    await primeTempAccess();
}

/** @returns {Promise<boolean>} true if the member was kicked */
async function resolveTrial(guild, cfg, row) {
    const member = await guild.members.fetch(row.user_id).catch(() => null);
    if (!member) {
        await close(row.id, 'left', 'not in guild at deadline');
        return false;
    }

    if (hasForeignRole(member, cfg)) {
        await close(row.id, 'exempt', 'holds a role from outside this system');
        await postLog(guild, cfg, 'exempt', row.user_id, 'was given another role');
        return false;
    }

    if (row.first_activity_at) {
        await close(row.id, 'passed', `activity: ${row.activity_kind || 'unknown'}`);
        await dropTempRole(member, cfg);
        return false;
    }

    // Live voice state — see the header note about unterminated sessions.
    if (member.voice?.channelId) {
        await pool.execute(
            `UPDATE temp_access_members
                SET first_activity_at = NOW(), activity_kind = 'voice',
                    status = 'passed', resolved_at = NOW(), note = 'in voice at deadline'
              WHERE id = ? AND status = 'pending'`,
            [row.id]
        );
        await dropTempRole(member, cfg);
        await postLog(guild, cfg, 'passed', row.user_id, 'in voice at deadline');
        return false;
    }

    // Last guard: never remove someone who can moderate the server, whatever the
    // roles say. A staff member who somehow ended up with a trial row is a bug,
    // not a guest.
    if (member.permissions.has('ManageGuild') || member.permissions.has('Administrator') || member.id === guild.ownerId) {
        await close(row.id, 'exempt', 'holds elevated permissions');
        return false;
    }

    // Exempt members (allowlist, bot managers) and a paused server: the trial ends without a kick.
    const held = await protectionHold(member, 'kick', 'Temporary access');
    if (held) {
        await close(row.id, 'exempt', `held: ${held.why}`);
        return false;
    }

    const cannot = whyCannot(guild, 'kick', { member });
    if (cannot) {
        await reportManualAction(guild, { action: 'kick', member, source: 'Temporary access', problem: cannot });
        await close(row.id, 'error', 'member not kickable (role hierarchy or missing permission)');
        logger.warn(`[TempAccessReaper] ${guild.id}: cannot kick ${member.user.tag} — check the bot's role position`);
        return false;
    }

    if (cfg.dm_on_kick) {
        const hours = Number(cfg.trial_hours) || 24;
        await member.send(
            `You were given temporary access to **${guild.name}**, but there was no activity from you ` +
            `within ${hours} hours, so the access lapsed and you've been removed.\n\n` +
            `No hard feelings — if you'd still like to join, ask whoever invited you for a fresh link.`
        ).catch(() => { /* DMs closed */ });
    }

    await member.kick('Temporary access expired: no activity during the trial window');
    await close(row.id, 'kicked', 'no activity before deadline');
    await postLog(guild, cfg, 'kicked', row.user_id);
    logger.info(`[TempAccessReaper] kicked ${member.user.tag} from ${guild.id} (temp access expired)`);
    return true;
}

async function dropTempRole(member, cfg) {
    if (cfg.keep_role_on_pass || !cfg.temp_role_id) return;
    if (!member.roles.cache.has(cfg.temp_role_id)) return;
    await member.roles.remove(cfg.temp_role_id, 'Temporary access: trial passed')
        .catch(err => logger.warn(`[TempAccessReaper] could not drop temp role: ${err.message}`));
}

async function close(id, status, note) {
    await pool.execute(
        `UPDATE temp_access_members
            SET status = ?, resolved_at = NOW(), note = ?
          WHERE id = ? AND status = 'pending'`,
        [status, note ? String(note).slice(0, 255) : null, id]
    );
}

async function closeAll(rows, status, note) {
    for (const row of rows) await close(row.id, status, note).catch(() => {});
}

/**
 * Invite use counts drift while the process is down: joins that happened during
 * the outage already bumped them. Re-reading at boot means the next real join is
 * measured against reality instead of a stale snapshot — otherwise the first
 * member through the door after a restart inherits somebody else's increment.
 */
async function resyncAllInvites() {
    try {
        const [guilds] = await pool.execute(
            'SELECT DISTINCT guild_id FROM temp_access_invites WHERE active = 1'
        );
        for (const { guild_id } of guilds) {
            const guild = resolveGuild(guild_id);
            if (guild) await resyncInviteCounts(guild);
        }
        if (guilds.length) logger.info(`[TempAccessReaper] resynced invite counts for ${guilds.length} guild(s)`);
    } catch (err) {
        logger.warn(`[TempAccessReaper] invite resync failed: ${err.message}`);
    }
}

export function startTempAccessReaper() {
    if (task) return;

    primeTempAccess().catch(err => logger.error(`[TempAccessReaper] prime failed: ${err.message}`));
    // Delay the resync until the guild caches are populated; at the moment jobs
    // start, a custom bot may still be logging in.
    setTimeout(() => { resyncAllInvites(); }, 60_000).unref?.();

    let sweeping = false;
    task = cron.schedule('* * * * *', () => {
        if (sweeping) return;                   // a slow sweep is never stacked on itself
        sweeping = true;
        runTempAccessSweep()
            .catch(err => logger.error(`[TempAccessReaper] sweep error: ${err.message}`))
            .finally(() => { sweeping = false; });
    }, { timezone: 'UTC' });

    // Daily at 03:00 UTC: the "still Unverified after N days" rule (verify_config.unverified_kick_days).
    dailyTask = cron.schedule('0 3 * * *', () => {
        runUnverifiedSweep().catch(err => logger.error(`[UnverifiedReaper] sweep error: ${err.message}`));
    }, { timezone: 'UTC' });

    // Inactivity prune: each server at most every 6 hours (the module tracks per-server last sweeps).
    let inactivitySweeping = false;
    inactivityTask = cron.schedule('*/15 * * * *', () => {
        if (inactivitySweeping) return;
        inactivitySweeping = true;
        sweepInactivityDue(resolveGuild)
            .catch(err => logger.error(`[InactivityPrune] sweep error: ${err.message}`))
            .finally(() => { inactivitySweeping = false; });
    }, { timezone: 'UTC' });

    // Last message / voice join per member, batched (core/member-activity.js).
    startActivityFlush();

    logger.info('[TempAccessReaper] scheduler started (* * * * * UTC; unverified cleanup 0 3 * * * UTC; inactivity */15 * * * * UTC)');
}

/** The daily "still Unverified after N days" sweep (was jobs/unverified-reaper.js). */
export async function runUnverifiedSweep() {
    logger.info('[UnverifiedReaper] sweep starting');
    await sweepUnverifiedDays(resolveGuild);
    logger.info('[UnverifiedReaper] sweep complete');
}

export function stopTempAccessReaper() {
    if (task) { task.stop(); task = null; }
    if (dailyTask) { dailyTask.stop(); dailyTask = null; }
    if (inactivityTask) { inactivityTask.stop(); inactivityTask = null; }
    // Write the last minute of activity on the way down (the shutdown carries on meanwhile).
    stopActivityFlush().catch(() => {});
}
