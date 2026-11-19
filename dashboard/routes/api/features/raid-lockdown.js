/**
 * Raid Lockdown API — `/api/guilds/:guildId/raid-lockdown/*`
 *
 * The Advanced Protection page's "Raid Lockdown" section (views/partials/manage/raid-lockdown-panel.ejs):
 * the join lockdown (start with a typed "LOCKDOWN", stop, extend, live counter), the auto-trigger,
 * same-name join floods, Discord's invite / DM pause switches, and the lockdown history with who
 * was blocked. Everything `/lockdown` does. The rules live in core/raid-lockdown.js.
 *
 * Gated by `apiCheckGuildAdmin` at the parent router. Every write re-checks the LIVE member:
 * configure access (owner, Administrator, Manage Server or a bot-manager role), plus the permission
 * the chosen action needs (Ban / Kick / Timeout Members, Manage Roles) to start a lockdown or set an
 * action that removes people. Super-admins act with the bot's authority.
 */

import express from 'express';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import logger from '../../../../utils/logger.js';
import pool from '../../../../utils/db.js';
import { liveConfigAccess } from '../../../../core/protection-exempt.js';
import {
    getRaidConfig, saveSettings, getActive, startLockdown, endLockdown, extendLockdown,
    syncIncidents, readIncidents, history,
} from '../../../../core/raid-lockdown.js';
import {
    LIMITS, LOCKDOWN_ACTIONS, ACTION_LABEL, lockdownSettings, parseLength, summarise, normaliseAction,
} from '../../../../core/raid-lockdown-logic.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;
const NEEDS = {
    ban: [PermissionFlagsBits.BanMembers, 'Ban Members'],
    kick: [PermissionFlagsBits.KickMembers, 'Kick Members'],
    timeout: [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
    quarantine: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
};

/** What this request may do, judged live. */
async function actorFor(req) {
    if (req.isSuperAdmin) {
        return { canConfigure: true, superAdmin: true, may: Object.fromEntries(LOCKDOWN_ACTIONS.map(a => [a, true])) };
    }
    const a = await liveConfigAccess(req.guildObject, req.user.id);
    const may = {};
    for (const action of LOCKDOWN_ACTIONS) {
        const need = NEEDS[action];
        may[action] = a.ok && (!need || a.isOwner || !!a.member?.permissions.has(need[0]));
    }
    return { canConfigure: a.ok, superAdmin: false, may };
}

/** Refuse a write the live member can't make. Sends the response itself; returns the actor or null. */
async function writer(req, res, action = null) {
    const actor = await actorFor(req);
    if (!actor.canConfigure) {
        res.status(403).json({ error: 'You need Manage Server, Administrator or a bot-manager role in this server.' });
        return null;
    }
    if (action && !actor.may[action]) {
        res.status(403).json({ error: `That needs the ${NEEDS[action][1]} permission in this server.` });
        return null;
    }
    return actor;
}

const iso = (d) => (d ? new Date(d).toISOString() : null);

function lockdownView(guild, row) {
    if (!row) return null;
    const sum = summarise(row);
    const name = (id) => {
        const m = guild.members.cache.get(id);
        const u = m?.user || guild.client.users.cache.get(id);
        return u ? (u.globalName || u.username) : null;
    };
    let channels = [];
    try { channels = JSON.parse(row.channels_locked || '[]'); } catch { channels = []; }
    return {
        id: Number(row.id),
        status: row.status,
        action: row.action,
        actionLabel: ACTION_LABEL[row.action] || row.action,
        trigger: row.trigger_kind,
        triggerDetail: row.trigger_detail,
        reason: row.reason,
        startedBy: row.started_by ? { id: row.started_by, name: name(row.started_by) } : null,
        startedAt: iso(row.started_at),
        endsAt: iso(row.ends_at),
        endedAt: iso(row.ended_at),
        endedBy: row.ended_by ? { id: row.ended_by, name: name(row.ended_by) } : null,
        endReason: row.end_reason,
        pauseInvites: !!row.pause_invites,
        invitesPaused: !!row.invites_paused,
        channelsLocked: channels.map(id => ({ id, name: guild.channels.cache.get(id)?.name ?? null })),
        counts: { blocked: sum.blocked, held: sum.held, failed: sum.failed, logged: sum.logged, total: sum.total },
        users: sum.users.map(u => ({ id: u.id, username: u.n ?? null, outcome: u.r, at: u.t ? new Date(u.t).toISOString() : null })),
    };
}

async function incidentView(guild, cfg, { fetch = true } = {}) {
    const cur = await readIncidents(guild, { fetch }).catch(() => ({}));
    const live = (d) => (d && new Date(d).getTime() > Date.now() ? iso(d) : null);
    const owned = (mine, now) => !!(mine && now && Math.abs(new Date(mine).getTime() - new Date(now).getTime()) <= 120_000);
    return {
        dmsUntil: live(cur.dms),
        invitesUntil: live(cur.invites),
        dmsOurs: owned(cfg?.incident_dms_owned_until, live(cur.dms)),
        invitesOurs: owned(cfg?.incident_invites_owned_until, live(cur.invites)),
        raidDetectedAt: iso(cur.raidDetectedAt),
        dmSpamDetectedAt: iso(cur.dmSpamDetectedAt),
        checkedAt: iso(cfg?.incident_checked_at),
        error: cfg?.incident_error ?? null,
        botCanManage: !!guild.members.me?.permissions?.has(PermissionFlagsBits.ManageGuild),
    };
}

async function quarantineReady(guild) {
    try {
        const [[q]] = await pool.execute('SELECT is_enabled, quarantine_role_id FROM quarantine_config WHERE guild_id = ?', [guild.id]);
        return !!(q?.is_enabled && q.quarantine_role_id && guild.roles.cache.has(q.quarantine_role_id));
    } catch { return false; }
}

router.get('/', async (req, res) => {
    const guild = req.guildObject;
    try {
        const cfg = await getRaidConfig(guild.id);
        const [active, rows, actor, incidents, qReady] = await Promise.all([
            getActive(guild.id, { fresh: true }), history(guild.id, 25), actorFor(req), incidentView(guild, cfg), quarantineReady(guild)]);
        const me = guild.members.me;
        res.json({
            actor,
            settings: { ...lockdownSettings(cfg), alertChannelId: cfg?.alert_channel_id ?? null },
            raidDetection: { enabled: !!cfg?.enabled, action: cfg?.action ?? null },
            active: lockdownView(guild, active),
            history: rows.map(r => lockdownView(guild, r)),
            incidents,
            quarantineReady: qReady,
            botPerms: {
                ban: !!me?.permissions.has(PermissionFlagsBits.BanMembers),
                kick: !!me?.permissions.has(PermissionFlagsBits.KickMembers),
                timeout: !!me?.permissions.has(PermissionFlagsBits.ModerateMembers),
                quarantine: !!me?.permissions.has(PermissionFlagsBits.ManageRoles),
                log: true,
                channels: !!me?.permissions.has(PermissionFlagsBits.ManageChannels) || !!me?.permissions.has(PermissionFlagsBits.ManageRoles),
            },
            channels: guild.channels.cache
                .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
                .sort((a, b) => a.rawPosition - b.rawPosition)
                .map(c => ({ id: c.id, name: c.name })),
            limits: LIMITS,
            actions: LOCKDOWN_ACTIONS.map(a => ({ value: a, label: ACTION_LABEL[a] })),
        });
    } catch (err) {
        logger.error(`[API raid-lockdown] load failed in ${guild.id}: ${err.message}`);
        res.status(500).json({ error: 'Could not load the lockdown state.' });
    }
});

/** Just the live bit, for the counter while a lockdown runs. */
router.get('/active', async (req, res) => {
    const guild = req.guildObject;
    try {
        res.json({ active: lockdownView(guild, await getActive(guild.id, { fresh: true })) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/start', async (req, res) => {
    const guild = req.guildObject;
    const b = req.body || {};
    if (String(b.confirm ?? '').trim().toUpperCase() !== 'LOCKDOWN') {
        return res.status(400).json({ error: 'Type LOCKDOWN to confirm.' });
    }
    const s = lockdownSettings(await getRaidConfig(guild.id));
    const action = normaliseAction(b.action, s.lockdownAction);
    if (!(await writer(req, res, action))) return;
    const len = b.duration ? parseLength(b.duration) : { ok: true, ms: s.lockdownDurationMinutes * 60_000 };
    if (!len.ok) return res.status(400).json({ error: len.error });
    const out = await startLockdown(guild, {
        action, durationMs: len.ms, trigger: 'manual', by: { id: req.user.id },
        reason: b.reason ? String(b.reason).slice(0, 200) : null,
        pauseInvites: b.pauseInvites === undefined ? undefined : !!b.pauseInvites,
        lockChannels: b.lockChannels === undefined ? undefined : !!b.lockChannels,
    });
    if (!out.ok) return res.status(409).json({ error: out.error });
    logger.warn(`[API raid-lockdown] ${req.user.username} started lockdown #${out.row.id} in ${guild.id}`);
    res.json({ ok: true, active: lockdownView(guild, out.row) });
});

router.post('/stop', async (req, res) => {
    const guild = req.guildObject;
    if (!(await writer(req, res))) return;
    const out = await endLockdown(guild, { by: { id: req.user.id }, why: 'manual' });
    if (!out.ok) return res.status(409).json({ error: out.error });
    logger.warn(`[API raid-lockdown] ${req.user.username} ended lockdown #${out.row.id} in ${guild.id}`);
    res.json({ ok: true, ended: lockdownView(guild, out.row) });
});

router.post('/extend', async (req, res) => {
    const guild = req.guildObject;
    if (!(await writer(req, res))) return;
    const running = await getActive(guild.id, { fresh: true });
    if (!running) return res.status(409).json({ error: 'No lockdown is running.' });
    const len = parseLength(req.body?.by);
    if (!len.ok) return res.status(400).json({ error: len.error });
    const out = await extendLockdown(guild, new Date(running.ends_at).getTime() + len.ms, { id: req.user.id });
    if (!out.ok) return res.status(400).json({ error: out.error });
    res.json({ ok: true, active: lockdownView(guild, out.row) });
});

const int = (v, [min, max]) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < min || n > max) return null;
    return n;
};
const bool = (v) => (v ? 1 : 0);

router.put('/settings', async (req, res) => {
    const guild = req.guildObject;
    const b = req.body || {};
    const patch = {};
    const bad = [];
    const num = (key, col, range) => {
        if (b[key] === undefined) return;
        const n = int(b[key], range);
        if (n == null) bad.push(`${key} must be ${range[0]}-${range[1]}`); else patch[col] = n;
    };
    const act = (key, col) => {
        if (b[key] === undefined) return;
        if (!LOCKDOWN_ACTIONS.includes(b[key])) bad.push(`${key} is not an action`); else patch[col] = b[key];
    };
    act('lockdownAction', 'lockdown_action');
    num('lockdownDurationMinutes', 'lockdown_duration_minutes', [1, 7 * 1440]);
    if (b.lockdownPauseInvites !== undefined) patch.lockdown_pause_invites = bool(b.lockdownPauseInvites);
    if (b.lockdownLockChannels !== undefined) patch.lockdown_lock_channels = bool(b.lockdownLockChannels);
    if (b.lockdownDm !== undefined) patch.lockdown_dm = bool(b.lockdownDm);
    if (b.lockdownChannelIds !== undefined) {
        const ids = Array.isArray(b.lockdownChannelIds) ? b.lockdownChannelIds.map(String).filter(id => SNOWFLAKE.test(id) && guild.channels.cache.has(id)) : [];
        if (ids.length > 25) bad.push('at most 25 channels');
        else patch.lockdown_channel_ids = JSON.stringify([...new Set(ids)]);
    }
    if (b.autoEnabled !== undefined) patch.auto_lockdown_enabled = bool(b.autoEnabled);
    num('autoJoins', 'auto_lockdown_joins', LIMITS.autoJoins);
    num('autoWindowSeconds', 'auto_lockdown_window_seconds', LIMITS.autoWindowSeconds);
    num('autoDurationMinutes', 'auto_lockdown_duration_minutes', LIMITS.autoDurationMinutes);
    act('autoAction', 'auto_lockdown_action');
    if (b.autoPauseInvites !== undefined) patch.auto_lockdown_pause_invites = bool(b.autoPauseInvites);
    if (b.autoLockChannels !== undefined) patch.auto_lockdown_lock_channels = bool(b.autoLockChannels);
    if (b.sameNameEnabled !== undefined) patch.same_name_enabled = bool(b.sameNameEnabled);
    num('sameNameCount', 'same_name_count', LIMITS.sameNameCount);
    num('sameNameWindowSeconds', 'same_name_window_seconds', LIMITS.sameNameWindowSeconds);
    act('sameNameAction', 'same_name_action');
    if (b.alertChannelId !== undefined) {
        const id = b.alertChannelId ? String(b.alertChannelId) : null;
        if (id && !(SNOWFLAKE.test(id) && guild.channels.cache.has(id))) bad.push('alert channel not found');
        else patch.alert_channel_id = id;
    }
    if (bad.length) return res.status(400).json({ error: `Not saved: ${bad.join('; ')}.` });
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to save.' });

    // An action that removes people needs the person setting it to be allowed to do that themselves.
    const actor = await writer(req, res);
    if (!actor) return;
    for (const col of ['lockdown_action', 'auto_lockdown_action', 'same_name_action']) {
        const a = patch[col];
        if (a && !actor.may[a]) return res.status(403).json({ error: `Setting "${ACTION_LABEL[a]}" needs the ${NEEDS[a][1]} permission in this server.` });
    }
    try {
        const cfg = await saveSettings(guild.id, patch);
        logger.info(`[API raid-lockdown] ${req.user.username} saved settings in ${guild.id}: ${Object.keys(patch).join(', ')}`);
        res.json({ ok: true, settings: { ...lockdownSettings(cfg), alertChannelId: cfg?.alert_channel_id ?? null } });
    } catch (err) {
        logger.error(`[API raid-lockdown] save failed in ${guild.id}: ${err.message}`);
        res.status(500).json({ error: 'Could not save.' });
    }
});

/** Keep DMs / invites disabled (Discord incident actions), applied at once. Off lifts a running pause now (H-660). */
router.post('/incidents', async (req, res) => {
    const guild = req.guildObject;
    const kind = req.body?.kind;
    if (kind !== 'dms' && kind !== 'invites') return res.status(400).json({ error: 'kind must be dms or invites.' });
    if (!(await writer(req, res))) return;
    await saveSettings(guild.id, { [kind === 'dms' ? 'keep_dms_disabled' : 'keep_invites_disabled']: req.body.enabled ? 1 : 0 });
    const out = await syncIncidents(guild, { why: `dashboard (${req.user.username})`, lift: { [kind]: !req.body.enabled } });
    const cfg = await getRaidConfig(guild.id);
    res.status(out.error ? 502 : 200).json({
        ok: !out.error,
        error: out.error ? `Saved, but Discord refused the change: ${out.error}` : undefined,
        settings: { ...lockdownSettings(cfg), alertChannelId: cfg?.alert_channel_id ?? null },
        incidents: await incidentView(guild, cfg, { fetch: false }),
    });
});

/** Re-read Discord's state and re-apply what this server wants. */
router.post('/incidents/sync', async (req, res) => {
    const guild = req.guildObject;
    if (!(await writer(req, res))) return;
    const out = await syncIncidents(guild, { why: `dashboard re-check (${req.user.username})` });
    const cfg = await getRaidConfig(guild.id);
    res.json({ ok: !out.error, error: out.error, incidents: await incidentView(guild, cfg, { fetch: false }) });
});

export default router;
