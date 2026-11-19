/**
 * Spammer scan API — `/api/guilds/:guildId/spammer-scan/*`
 *
 * The Security page's "Discord-flagged spammers" panel: scan the member list for accounts Discord
 * has flagged, act on them, and manage the allowlist. The rules and actions are core/spammer-guard.js;
 * settings are saved by the plain form post in dashboard/server.js (/security/spammer).
 *
 * GET /activity: the recent spammer outcomes (join_gate_events spammer_* rows, plus failures) and the
 * 30-day counts, for the panel's "Recent activity" list.
 *
 * Gated by `apiCheckGuildAdmin` at the parent router (Manage Server from the login-time OAuth
 * bitfield). Acting re-checks the LIVE member for the permission the action needs; super-admins
 * act with the bot's authority.
 */

import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { getConfig } from '../../../../core/join-gate.js';
import { scanGuild, applyScan, allowlist, addAllow, removeAllow } from '../../../../core/spammer-guard.js';
import { normaliseSpammerAction } from '../../../../core/spammer-flag.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;
const NEEDS = {
    kick: [PermissionFlagsBits.KickMembers, 'Kick Members'],
    ban: [PermissionFlagsBits.BanMembers, 'Ban Members'],
    flag: [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
};

// One scan at a time per server: a full member fetch is rate-limited by Discord.
const running = new Set();

function memberRow(m) {
    return {
        id: m.id,
        username: m.user.username,
        displayName: m.displayName,
        avatar: m.displayAvatarURL({ size: 64 }),
        joinedAt: m.joinedTimestamp ?? null,
        createdAt: m.user.createdTimestamp,
    };
}

/** May this request act? Sends the refusal itself and returns false. */
async function mayAct(req, res, action) {
    if (req.isSuperAdmin) return true;
    const guild = req.guildObject;
    const member = await guild.members.fetch(req.user.id).catch(() => null);
    if (!member) { res.status(403).json({ error: "You're not a member of this server." }); return false; }
    const need = NEEDS[action];
    if (need && guild.ownerId !== member.id && !member.permissions.has(need[0])) {
        res.status(403).json({ error: `You need the ${need[1]} permission in this server.` });
        return false;
    }
    return true;
}

router.get('/scan', async (req, res) => {
    const guild = req.guildObject;
    if (running.has(guild.id)) return res.status(409).json({ error: 'A scan is already running for this server.' });
    running.add(guild.id);
    try {
        const cfg = await getConfig(guild.id);
        const result = await scanGuild(guild, cfg);
        res.json({
            action: result.action,
            total: result.total,
            complete: result.complete,
            unknown: result.unknown,
            targets: result.targets.map(memberRow),
            skipped: Object.fromEntries(Object.entries(result.skipped).map(([k, ids]) => [k, ids.length])),
        });
    } catch (err) {
        logger.error(`[API spammer-scan] scan failed in ${guild.id}: ${err.message}`);
        res.status(500).json({ error: 'The scan failed. Try again in a few minutes.' });
    } finally {
        running.delete(guild.id);
    }
});

router.post('/apply', async (req, res) => {
    const guild = req.guildObject;
    const ids = Array.isArray(req.body?.userIds) ? req.body.userIds.filter(id => SNOWFLAKE.test(String(id))).map(String) : [];
    if (!ids.length) return res.status(400).json({ error: 'No members given.' });
    const cfg = await getConfig(guild.id);
    const action = normaliseSpammerAction(cfg?.spammer_action);
    if (action === 'none') return res.status(400).json({ error: 'The spammer action is set to "nothing". Pick kick, ban or flag first.' });
    if (!(await mayAct(req, res, action))) return;
    try {
        const out = await applyScan(guild, cfg, ids, req.user.id);
        logger.info(`[API spammer-scan] ${req.user.username} applied ${action} in ${guild.id}: ${out.done} done`);
        res.json(out);
    } catch (err) {
        logger.error(`[API spammer-scan] apply failed in ${guild.id}: ${err.message}`);
        res.status(500).json({ error: 'Stopped part-way. Run the scan again to see who is left.' });
    }
});

router.get('/activity', async (req, res) => {
    const guild = req.guildObject;
    try {
        const [rows] = await pool.execute(
            `SELECT user_id, username, action, detail, created_at FROM join_gate_events
              WHERE guild_id = ? AND (action LIKE 'spammer\\_%' OR (action = 'failed' AND detail LIKE 'spammer:%'))
              ORDER BY created_at DESC LIMIT 50`, [guild.id]);
        const [counts] = await pool.execute(
            `SELECT action, COUNT(*) AS n FROM join_gate_events
              WHERE guild_id = ? AND action LIKE 'spammer\\_%' AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
              GROUP BY action`, [guild.id]);
        res.json({
            events: rows.map(r => ({
                userId: r.user_id, username: r.username, action: r.action, detail: r.detail, at: r.created_at,
                avatar: guild.client.users.cache.get(r.user_id)?.displayAvatarURL({ size: 32 }) ?? null,
            })),
            last30: Object.fromEntries(counts.map(c => [c.action, Number(c.n)])),
        });
    } catch (err) {
        logger.error(`[API spammer-scan] activity failed in ${guild.id}: ${err.message}`);
        res.status(500).json({ error: 'Could not load recent activity.' });
    }
});

router.get('/allowlist', async (req, res) => {
    const rows = await allowlist(req.guildObject.id);
    const guild = req.guildObject;
    res.json({
        users: await Promise.all(rows.map(async r => {
            const user = guild.client.users.cache.get(r.user_id) || await guild.client.users.fetch(r.user_id).catch(() => null);
            return { id: r.user_id, username: user?.username ?? null, addedBy: r.added_by, addedAt: r.added_at };
        })),
    });
});

router.post('/allowlist', async (req, res) => {
    const id = String(req.body?.userId ?? '').replace(/[<@!>]/g, '').trim();
    if (!SNOWFLAKE.test(id)) return res.status(400).json({ error: 'Give a user ID.' });
    try {
        await addAllow(req.guildObject, id, req.user.id);
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
    res.json({ ok: true });
});

router.delete('/allowlist/:userId', async (req, res) => {
    if (!SNOWFLAKE.test(req.params.userId)) return res.status(400).json({ error: 'Bad user ID.' });
    try {
        res.json({ ok: await removeAllow(req.guildObject, req.params.userId, req.user.id) });
    } catch (err) {
        res.status(409).json({ error: err.message });
    }
});

export default router;
