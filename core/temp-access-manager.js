/**
 * Temporary guest access.
 *
 * A guest arrives through a tracked invite (or is handed the temp role) and gets
 * a trial: show any sign of life inside `trial_hours`, or be removed from the
 * guild. "Sign of life" is a text message, joining voice, or being given any
 * role beyond the ones this system handed out.
 *
 * Two things in here are load-bearing and easy to get wrong if this file is
 * refactored:
 *
 * 1. `pendingKeys` is the fast path. messageCreate fires on every message in
 *    every guild of every bot in this process; a DB round-trip there would be a
 *    query per message forever. The set holds only members with a live trial —
 *    normally single digits — so the common case is one Set.has() and a return.
 *    It is primed at boot and kept in step by every write path below. If it ever
 *    drifts the failure is benign in the dangerous direction (a missed activity
 *    ping would be caught by the reaper's live voice check, or at worst kicks
 *    someone who was active — which is why `recordActivity` writes to the DB
 *    rather than trusting memory alone).
 *
 * 2. Attribution is a use-count diff, serialized per guild. Discord does not
 *    report which invite a joiner used, so the only signal is "this code's use
 *    count went up". Two joins landing concurrently would both read the same
 *    pre-increment snapshot and both claim the invite, so joins queue per guild.
 *
 * `temp_access_members` is also THE queue of members on a deadline (migration 328): besides trials
 * (kind 'trial') it holds auto-prune deadlines (kind 'prune', core/auto-prune.js) and CAPTCHA
 * completion windows (kind 'verify', core/verification.js). Every trial query here filters on
 * kind = 'trial'; the generic queue helpers at the bottom serve the other kinds, and the one reaper
 * (jobs/temp-access-reaper.js) sweeps all of them.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

// guild_id -> config row (null when the guild has no config at all)
const configCache = new Map();
// "guildId:userId" for every trial currently in 'pending'
const pendingKeys = new Set();
// "guildId:userId:kind" for every pending auto-prune / CAPTCHA deadline (kinds 'prune' and 'verify'):
// lets role changes and departures skip the database for everyone not on the clock.
const deadlineKeys = new Set();
// guild_id -> tail of the attribution promise chain
const attributionChains = new Map();

let primed = false;

const key = (guildId, userId) => `${guildId}:${userId}`;
const dkey = (guildId, userId, kind) => `${guildId}:${userId}:${kind}`;
// 'autorole': join roles given after a wait (core/autoroles.js; migration 419 adds it to the enum).
const DEADLINE_KINDS = ['prune', 'verify', 'autorole'];

function parseRoleIds(raw) {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
    } catch {
        // Tolerate a hand-edited comma-separated value rather than throwing away
        // the whole config over a formatting slip.
        return String(raw).split(',').map(s => s.trim()).filter(Boolean);
    }
}

/**
 * Load every live trial into memory. Called once at boot and again after each
 * reaper sweep, so a restart or a row written by another process is picked up.
 */
export async function primeTempAccess() {
    try {
        const [rows] = await pool.execute(
            "SELECT guild_id, user_id FROM temp_access_members WHERE status = 'pending' AND kind = 'trial'"
        );
        pendingKeys.clear();
        for (const r of rows) pendingKeys.add(key(r.guild_id, r.user_id));
        const [deadlines] = await pool.execute(
            "SELECT guild_id, user_id, kind FROM temp_access_members WHERE status = 'pending' AND kind <> 'trial'"
        ).catch(() => [[]]);
        deadlineKeys.clear();
        for (const r of deadlines) deadlineKeys.add(dkey(r.guild_id, r.user_id, r.kind));
        primed = true;
        logger.info(`[TempAccess] primed ${pendingKeys.size} pending trial(s), ${deadlineKeys.size} other deadline(s)`);
    } catch (err) {
        // A missing table (migration not run) must not take the bot down.
        logger.warn(`[TempAccess] prime failed: ${err.message}`);
    }
    return pendingKeys.size;
}

export function isPrimed() {
    return primed;
}

export async function getConfig(guildId) {
    if (configCache.has(guildId)) return configCache.get(guildId);
    let cfg = null;
    try {
        const [rows] = await pool.execute('SELECT * FROM temp_access_config WHERE guild_id = ?', [guildId]);
        if (rows.length) {
            cfg = { ...rows[0], accessRoleIds: parseRoleIds(rows[0].access_role_ids) };
        }
    } catch (err) {
        logger.warn(`[TempAccess] config load failed for ${guildId}: ${err.message}`);
    }
    configCache.set(guildId, cfg);
    return cfg;
}

export function invalidateConfig(guildId) {
    if (guildId) configCache.delete(guildId); else configCache.clear();
}

/**
 * Roles this system is responsible for. Holding only these means the member has
 * not been adopted by anyone; holding anything else means they have.
 */
function systemRoleIds(cfg) {
    return new Set([cfg.temp_role_id, ...cfg.accessRoleIds].filter(Boolean));
}

/**
 * True when the member holds a role nobody from this system gave them.
 * `@everyone` is excluded because every member has it.
 *
 * Managed roles (Nitro boost, Twitch subscriber sync) deliberately COUNT here.
 * They are not "grabbed" in the literal sense, but a booster or a synced
 * subscriber is unambiguously not a stranger, and the cost of being wrong in
 * that direction is kicking a paying supporter.
 */
export function hasForeignRole(member, cfg) {
    const own = systemRoleIds(cfg);
    return member.roles.cache.some(r => r.id !== member.guild.id && !own.has(r.id));
}

/* ------------------------------------------------------------------ *
 * Starting a trial
 * ------------------------------------------------------------------ */

/**
 * Put a member on trial and give them the roles that make the server usable.
 * Idempotent: a member who already has a live trial is left alone.
 *
 * @returns {'started'|'already-pending'|'exempt'|'skipped'|'error'}
 */
export async function startTrial(member, { source = 'invite', inviteCode = null, cfg = null } = {}) {
    const guildId = member.guild.id;
    const config = cfg || await getConfig(guildId);
    if (!config || !config.enabled) return 'skipped';
    if (member.user.bot) return 'skipped';

    // Someone who already has real roles was never a guest.
    if (hasForeignRole(member, config)) return 'exempt';

    const hours = Math.max(1, Number(config.trial_hours) || 24);

    let alreadyRunning;
    try {
        // Read first, then upsert. MariaDB reports affectedRows = 1 for an
        // ON DUPLICATE KEY UPDATE that changes nothing — the same value MySQL
        // uses for a fresh insert — so the return code cannot tell us whether a
        // trial was already running. The SQL below still guards the deadline;
        // this SELECT only decides what we report and whether we announce it.
        const [existing] = await pool.execute(
            "SELECT status FROM temp_access_members WHERE guild_id = ? AND user_id = ? AND kind = 'trial'",
            [guildId, member.id]
        );
        alreadyRunning = existing.length > 0 && existing[0].status === 'pending';

        await pool.execute(
            `INSERT INTO temp_access_members
                 (guild_id, user_id, source, invite_code, started_at, expires_at, status)
             VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? HOUR), 'pending')
             ON DUPLICATE KEY UPDATE
                 -- A resolved trial can restart (rejoin, re-granted role); a live
                 -- one is left exactly as it is so nobody gets a second deadline.
                 source            = IF(status = 'pending', source, VALUES(source)),
                 invite_code       = IF(status = 'pending', invite_code, VALUES(invite_code)),
                 started_at        = IF(status = 'pending', started_at, NOW()),
                 expires_at        = IF(status = 'pending', expires_at, VALUES(expires_at)),
                 first_activity_at = IF(status = 'pending', first_activity_at, NULL),
                 activity_kind     = IF(status = 'pending', activity_kind, NULL),
                 resolved_at       = IF(status = 'pending', resolved_at, NULL),
                 note              = IF(status = 'pending', note, NULL),
                 status            = 'pending'`,
            [guildId, member.id, source, inviteCode, hours]
        );
    } catch (err) {
        logger.error(`[TempAccess] could not start trial for ${member.id} in ${guildId}: ${err.message}`);
        return 'error';
    }

    pendingKeys.add(key(guildId, member.id));

    const toAdd = [config.temp_role_id, ...config.accessRoleIds]
        .filter(Boolean)
        .filter(id => !member.roles.cache.has(id))
        .filter(id => member.guild.roles.cache.has(id));

    if (toAdd.length) {
        try {
            // ASCII-only reason: the audit-log header rejects anything above 255.
            await member.roles.add(toAdd, 'Temporary access granted');
        } catch (err) {
            logger.warn(`[TempAccess] role grant failed for ${member.id} in ${guildId}: ${err.message}`);
        }
    }

    if (alreadyRunning) return 'already-pending';

    logger.info(`[TempAccess] trial started for ${member.user.tag} in ${guildId} (source=${source}, ${hours}h)`);
    await postLog(member.guild, config, 'started', member.id, `${hours}h`);
    return 'started';
}

/* ------------------------------------------------------------------ *
 * Activity
 * ------------------------------------------------------------------ */

/**
 * The hot path. Returns immediately for anyone not on trial.
 */
export function hasPendingTrial(guildId, userId) {
    return pendingKeys.has(key(guildId, userId));
}

/**
 * First sign of life ends the trial in the member's favour. Fire-and-forget:
 * callers are event handlers that must not be slowed down or made to fail.
 */
export function markActivity(guildId, userId, kind, member = null) {
    if (!pendingKeys.has(key(guildId, userId))) return;
    // Drop the key first so a burst of messages produces one write, not twenty.
    pendingKeys.delete(key(guildId, userId));
    resolveActive(guildId, userId, kind, member).catch(err => {
        logger.error(`[TempAccess] activity write failed for ${userId} in ${guildId}: ${err.message}`);
        // Put it back — better a duplicate write later than a silently lost pass.
        pendingKeys.add(key(guildId, userId));
    });
}

async function resolveActive(guildId, userId, kind, member) {
    const [res] = await pool.execute(
        `UPDATE temp_access_members
            SET first_activity_at = NOW(), activity_kind = ?, status = 'passed', resolved_at = NOW()
          WHERE guild_id = ? AND user_id = ? AND status = 'pending' AND kind = 'trial'`,
        [String(kind).slice(0, 16), guildId, userId]
    );
    if (!res.affectedRows) return;

    logger.info(`[TempAccess] ${userId} passed trial in ${guildId} via ${kind}`);

    const cfg = await getConfig(guildId);
    if (cfg && !cfg.keep_role_on_pass && cfg.temp_role_id && member?.roles?.cache?.has(cfg.temp_role_id)) {
        await member.roles.remove(cfg.temp_role_id, 'Temporary access: member became active')
            .catch(err => logger.warn(`[TempAccess] could not drop temp role from ${userId}: ${err.message}`));
    }
    await postLog(member?.guild, cfg, 'passed', userId, kind);
}

/**
 * A member who was given a role by staff is no longer a guest, whatever else
 * they have or have not done.
 */
export async function markExempt(guildId, userId, note = 'received another role') {
    if (!pendingKeys.has(key(guildId, userId))) return false;
    pendingKeys.delete(key(guildId, userId));
    try {
        const [res] = await pool.execute(
            `UPDATE temp_access_members
                SET status = 'exempt', resolved_at = NOW(), note = ?
              WHERE guild_id = ? AND user_id = ? AND status = 'pending' AND kind = 'trial'`,
            [String(note).slice(0, 255), guildId, userId]
        );
        if (res.affectedRows) logger.info(`[TempAccess] ${userId} exempt in ${guildId} (${note})`);
        return res.affectedRows > 0;
    } catch (err) {
        logger.error(`[TempAccess] exempt write failed for ${userId}: ${err.message}`);
        pendingKeys.add(key(guildId, userId));
        return false;
    }
}

/**
 * Member left (or was removed) — close the trial, and any auto-prune or CAPTCHA deadline, without
 * judging it. Both in-memory sets make this free for the (almost always) member with neither.
 */
export async function markLeft(guildId, userId) {
    const k = key(guildId, userId);
    const onClock = DEADLINE_KINDS.filter(kind => deadlineKeys.has(dkey(guildId, userId, kind)));
    if (!pendingKeys.has(k) && !onClock.length) return;
    pendingKeys.delete(k);
    for (const kind of onClock) deadlineKeys.delete(dkey(guildId, userId, kind));
    await pool.execute(
        `UPDATE temp_access_members
            SET status = 'left', resolved_at = NOW()
          WHERE guild_id = ? AND user_id = ? AND status = 'pending'`,
        [guildId, userId]
    ).catch(err => logger.warn(`[TempAccess] left-write failed for ${userId}: ${err.message}`));
}

/** Admin-initiated stop: keep the member, close the trial. */
export async function pardon(guildId, userId, note = 'pardoned by staff') {
    pendingKeys.delete(key(guildId, userId));
    const [res] = await pool.execute(
        `UPDATE temp_access_members
            SET status = 'exempt', resolved_at = NOW(), note = ?
          WHERE guild_id = ? AND user_id = ? AND status = 'pending' AND kind = 'trial'`,
        [String(note).slice(0, 255), guildId, userId]
    );
    return res.affectedRows > 0;
}

/* ------------------------------------------------------------------ *
 * The deadline queue: auto-prune ('prune') and CAPTCHA windows ('verify')
 * ------------------------------------------------------------------ */

/** Is this member on the clock for `kind`? Memory only — the fast path for role changes. */
export function hasDeadline(guildId, userId, kind) {
    return deadlineKeys.has(dkey(guildId, userId, kind));
}

/**
 * Put a member on the clock. A live deadline of the same kind is left exactly as it is (nobody gets
 * a second, later deadline by triggering this twice); a resolved one starts over.
 * @param seconds  from now; null = no deadline (the row still counts CAPTCHA attempts)
 */
export async function upsertDeadline(guildId, userId, kind, seconds, note = null) {
    if (!DEADLINE_KINDS.includes(kind)) throw new Error(`unknown deadline kind: ${kind}`);
    const secs = seconds == null ? null : Math.max(0, Math.round(Number(seconds)));
    await pool.execute(
        `INSERT INTO temp_access_members
             (guild_id, user_id, kind, source, started_at, expires_at, status, attempts, note)
         VALUES (?, ?, ?, 'join', NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND), 'pending', 0, ?)
         ON DUPLICATE KEY UPDATE
             source            = IF(status = 'pending', source, 'join'),
             invite_code       = IF(status = 'pending', invite_code, NULL),
             started_at        = IF(status = 'pending', started_at, NOW()),
             expires_at        = IF(status = 'pending', expires_at, VALUES(expires_at)),
             attempts          = IF(status = 'pending', attempts, 0),
             first_activity_at = IF(status = 'pending', first_activity_at, NULL),
             activity_kind     = IF(status = 'pending', activity_kind, NULL),
             resolved_at       = IF(status = 'pending', resolved_at, NULL),
             note              = IF(status = 'pending', note, VALUES(note)),
             status            = 'pending'`,
        [guildId, userId, kind, secs, note ? String(note).slice(0, 255) : null]
    );
    deadlineKeys.add(dkey(guildId, userId, kind));
}

const DEADLINE_COLUMNS = `id, guild_id, user_id, kind, status, attempts, note,
    UNIX_TIMESTAMP(started_at) * 1000 AS started_ms,
    UNIX_TIMESTAMP(expires_at) * 1000 AS expires_ms`;

const asDeadline = (r) => (r ? {
    ...r,
    started_ms: r.started_ms == null ? null : Number(r.started_ms),
    expires_ms: r.expires_ms == null ? null : Number(r.expires_ms),
    attempts: Number(r.attempts) || 0,
} : null);

/** The member's row for `kind` (any status), or null. */
export async function getDeadline(guildId, userId, kind) {
    const [[row]] = await pool.execute(
        `SELECT ${DEADLINE_COLUMNS} FROM temp_access_members WHERE guild_id = ? AND user_id = ? AND kind = ?`,
        [guildId, userId, kind]
    );
    return asDeadline(row);
}

/** One more wrong CAPTCHA answer on a live row. @returns the new count (null when not pending). */
export async function addAttempt(guildId, userId, kind = 'verify') {
    const [res] = await pool.execute(
        `UPDATE temp_access_members SET attempts = attempts + 1
          WHERE guild_id = ? AND user_id = ? AND kind = ? AND status = 'pending'`,
        [guildId, userId, kind]
    );
    if (!res.affectedRows) return null;
    return (await getDeadline(guildId, userId, kind))?.attempts ?? null;
}

/** Resolve a live deadline. @returns true when a pending row was closed. */
export async function closeDeadline(guildId, userId, kind, status, note = null) {
    deadlineKeys.delete(dkey(guildId, userId, kind));
    const [res] = await pool.execute(
        `UPDATE temp_access_members SET status = ?, resolved_at = NOW(), note = ?
          WHERE guild_id = ? AND user_id = ? AND kind = ? AND status = 'pending'`,
        [status, note ? String(note).slice(0, 255) : null, guildId, userId, kind]
    );
    return res.affectedRows > 0;
}

/** Pending deadlines of one kind in a guild, soonest first. */
export async function listDeadlines(guildId, kind, limit = 200) {
    const n = Math.max(1, Math.min(1000, Number(limit) || 200));
    const [rows] = await pool.execute(
        `SELECT ${DEADLINE_COLUMNS} FROM temp_access_members
          WHERE guild_id = ? AND kind = ? AND status = 'pending'
          ORDER BY expires_at IS NULL, expires_at ASC LIMIT ${n}`,
        [guildId, kind]
    );
    return rows.map(asDeadline);
}

export async function countDeadlines(guildId, kind) {
    const [[row]] = await pool.execute(
        "SELECT COUNT(*) AS n FROM temp_access_members WHERE guild_id = ? AND kind = ? AND status = 'pending'",
        [guildId, kind]
    );
    return Number(row?.n ?? 0);
}

/** Close every live deadline of one kind in a guild ("disabling clears the queue"). @returns how many. */
export async function cancelDeadlines(guildId, kind, note = 'feature switched off') {
    const prefix = `${guildId}:`;
    for (const k of deadlineKeys) if (k.startsWith(prefix) && k.endsWith(`:${kind}`)) deadlineKeys.delete(k);
    const [res] = await pool.execute(
        `UPDATE temp_access_members SET status = 'cancelled', resolved_at = NOW(), note = ?
          WHERE guild_id = ? AND kind = ? AND status = 'pending'`,
        [String(note).slice(0, 255), guildId, kind]
    );
    return res.affectedRows;
}

/* ------------------------------------------------------------------ *
 * Invite attribution
 * ------------------------------------------------------------------ */

export async function getTrackedInvites(guildId, activeOnly = true) {
    const [rows] = await pool.execute(
        `SELECT * FROM temp_access_invites WHERE guild_id = ?${activeOnly ? ' AND active = 1' : ''}`,
        [guildId]
    );
    return rows;
}

export async function trackInvite(guildId, invite, createdBy) {
    await pool.execute(
        `INSERT INTO temp_access_invites
             (guild_id, invite_code, channel_id, created_by, max_uses, max_age, uses_seen, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
             channel_id = VALUES(channel_id), max_uses = VALUES(max_uses),
             max_age = VALUES(max_age), uses_seen = VALUES(uses_seen), active = 1`,
        [guildId, invite.code, invite.channelId ?? invite.channel?.id ?? null, createdBy,
            invite.maxUses ?? 0, invite.maxAge ?? 0, invite.uses ?? 0]
    );
}

export async function untrackInvite(guildId, code) {
    const [res] = await pool.execute(
        'UPDATE temp_access_invites SET active = 0 WHERE guild_id = ? AND invite_code = ?',
        [guildId, code]
    );
    return res.affectedRows > 0;
}

/**
 * Decide whether this join came through a tracked invite.
 *
 * Serialized per guild: concurrent joins would otherwise read the same use-count
 * snapshot and both claim the same increment.
 *
 * @returns {Promise<string|null>} the invite code, or null
 */
export function attributeJoin(guild) {
    const prev = attributionChains.get(guild.id) || Promise.resolve();
    const next = prev.then(() => attributeJoinInner(guild)).catch(err => {
        logger.error(`[TempAccess] attribution failed in ${guild.id}: ${err.message}`);
        return null;
    });
    // Keep the chain alive but don't let it hold a rejection or grow unbounded.
    attributionChains.set(guild.id, next.then(() => {}, () => {}));
    return next;
}

async function attributeJoinInner(guild) {
    const tracked = await getTrackedInvites(guild.id);
    if (!tracked.length) return null;

    let live;
    try {
        live = await guild.invites.fetch();
    } catch (err) {
        // Missing ManageGuild is the usual cause and it is worth shouting about:
        // without it the whole invite half of this feature is inert.
        logger.warn(`[TempAccess] cannot read invites in ${guild.id}: ${err.message}`);
        return null;
    }

    const byCode = new Map(live.map(i => [i.code, i]));
    const grew = [];
    const vanished = [];

    for (const row of tracked) {
        const inv = byCode.get(row.invite_code);
        if (!inv) {
            // Gone from the guild. A single-use invite that was just consumed
            // looks exactly like this, so it stays a candidate for THIS join and
            // is then retired.
            vanished.push(row);
            continue;
        }
        if ((inv.uses ?? 0) > row.uses_seen) grew.push({ row, uses: inv.uses ?? 0 });
    }

    // Write the new counts back before deciding anything, so a crash between
    // here and the caller can't hand the same increment to a second joiner.
    for (const g of grew) {
        await pool.execute(
            'UPDATE temp_access_invites SET uses_seen = ? WHERE guild_id = ? AND invite_code = ?',
            [g.uses, guild.id, g.row.invite_code]
        ).catch(() => {});
    }
    for (const v of vanished) {
        await pool.execute(
            'UPDATE temp_access_invites SET active = 0 WHERE guild_id = ? AND invite_code = ?',
            [guild.id, v.invite_code]
        ).catch(() => {});
    }

    if (grew.length === 1) return grew[0].row.invite_code;
    if (grew.length > 1) {
        // Two tracked codes advanced between fetches — we cannot say which one
        // this member used, but they used one of ours, so the trial is correct
        // either way. Record the first and say so in the log.
        logger.warn(`[TempAccess] ${guild.id}: ${grew.length} tracked invites advanced at once, attributing to ${grew[0].row.invite_code}`);
        return grew[0].row.invite_code;
    }
    if (!grew.length && vanished.length === 1) {
        logger.info(`[TempAccess] ${guild.id}: attributing join to consumed invite ${vanished[0].invite_code}`);
        return vanished[0].invite_code;
    }
    return null;
}

/**
 * Re-read every tracked invite's use count without attributing anything. Run at
 * boot: joins that happened while the bot was down have already bumped the
 * counters, and treating that backlog as a fresh join would put the wrong member
 * on trial.
 */
export async function resyncInviteCounts(guild) {
    const tracked = await getTrackedInvites(guild.id).catch(() => []);
    if (!tracked.length) return;
    let live;
    try {
        live = await guild.invites.fetch();
    } catch {
        return;
    }
    const byCode = new Map(live.map(i => [i.code, i]));
    for (const row of tracked) {
        const inv = byCode.get(row.invite_code);
        if (!inv) {
            await pool.execute('UPDATE temp_access_invites SET active = 0 WHERE guild_id = ? AND invite_code = ?',
                [guild.id, row.invite_code]).catch(() => {});
        } else if ((inv.uses ?? 0) !== row.uses_seen) {
            await pool.execute('UPDATE temp_access_invites SET uses_seen = ? WHERE guild_id = ? AND invite_code = ?',
                [inv.uses ?? 0, guild.id, row.invite_code]).catch(() => {});
        }
    }
}

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */

export async function postLog(guild, cfg, outcome, userId, detail = null) {
    if (!guild || !cfg?.log_channel_id) return;
    try {
        const channel = guild.channels.cache.get(cfg.log_channel_id)
            || await guild.channels.fetch(cfg.log_channel_id).catch(() => null);
        if (!channel?.isTextBased?.()) return;

        const line = {
            passed: `✅ <@${userId}> stayed — first activity: ${detail}`,
            kicked: `👋 <@${userId}> removed — no activity within the trial window`,
            exempt: `🎟️ <@${userId}> keeps access — ${detail}`,
            started: `⏳ <@${userId}> started a temporary-access trial${detail ? ` (${detail})` : ''}`,
        }[outcome] || `<@${userId}> — ${outcome}`;

        await channel.send({ content: line, allowedMentions: { parse: [] } });
    } catch (err) {
        logger.debug(`[TempAccess] log post failed in ${guild.id}: ${err.message}`);
    }
}

export default {
    primeTempAccess, getConfig, invalidateConfig, startTrial, hasPendingTrial,
    markActivity, markExempt, markLeft, pardon, hasForeignRole,
    getTrackedInvites, trackInvite, untrackInvite, attributeJoin, resyncInviteCounts, postLog,
    hasDeadline, upsertDeadline, getDeadline, addAttempt, closeDeadline, listDeadlines, countDeadlines, cancelDeadlines,
};
