/**
 * Security insight API — `/api/guilds/:guildId/insight/*`
 *
 *   GET  /overview                 the overview's "Server security" panel (core/security-overview.js):
 *                                  protections grid + score, threats stopped (30d), 30-day ban chart,
 *                                  top rules, lockdown history, last scans, recent automated bans
 *   GET  /score                    just the grid + score (the Security page's tile)
 *   GET  /checklist                the overview's setup checklist (core/setup-checklist.js) and whether
 *                                  this user dismissed it on this server
 *   GET  /member/:userId           one user's risk insight (core/member-insight.js) — Users page and
 *                                  Roles > Members; works for people who left
 *   GET  /settings, PUT /settings  join-log insight on/off and the "new account" days (Logging page)
 *   GET  /ban-log?days=            automated bans by our protections (core/ban-log.js) — Moderation page
 *   POST /ban-log/:userId/unban    one-click unban (live Ban Members check for the person and the bot;
 *                                  restarts the rejoin limit's count)
 *
 * Gated by `apiCheckGuildAdmin` + botContext at the parent router; writes re-check the LIVE member.
 */

import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import logger from '../../../../utils/logger.js';
import { liveConfigAccess } from '../../../../core/protection-exempt.js';
import { getSecurityOverview, getProtectionScore } from '../../../../core/security-overview.js';
import { getSetupChecklist } from '../../../../core/setup-checklist.js';
import { getPreferences } from '../../../../core/user-preferences.js';
import { memberInsight, getSettings, setSettings } from '../../../../core/member-insight.js';
import { getBanLog, unbanFromLog } from '../../../../core/ban-log.js';
import { userBits } from '../../../../core/user-display.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;

router.get('/overview', async (req, res) => {
    try {
        res.json(await getSecurityOverview(req.guildObject));
    } catch (err) {
        logger.error(`[API insight] overview failed in ${req.guildObject?.id}: ${err.message}`);
        res.status(500).json({ error: 'Could not load the security overview.' });
    }
});

router.get('/score', async (req, res) => {
    try {
        res.json(await getProtectionScore(req.guildObject.id));
    } catch (err) {
        logger.error(`[API insight] score failed in ${req.guildObject?.id}: ${err.message}`);
        res.status(500).json({ error: 'Could not load the protection score.' });
    }
});

// The overview's setup checklist (core/setup-checklist.js): the basics plus the high-weight rows of
// the same grid /score reads, so the two cannot disagree. `hidden` = this user dismissed it here.
router.get('/checklist', async (req, res) => {
    try {
        const out = await getSetupChecklist(req.guildObject.id);
        const prefs = await getPreferences(req.user.id).catch(() => null);
        res.json({ ...out, hidden: !!prefs?.hiddenChecklists?.includes(req.guildObject.id) });
    } catch (err) {
        logger.error(`[API insight] checklist failed in ${req.guildObject?.id}: ${err.message}`);
        res.status(500).json({ error: 'Could not load the setup checklist.' });
    }
});

router.get('/member/:userId', async (req, res) => {
    const userId = String(req.params.userId || '').replace(/[<@!>]/g, '');
    if (!SNOWFLAKE.test(userId)) return res.status(400).json({ error: 'Give a user ID.' });
    try {
        const out = await memberInsight(req.guildObject, userId);
        if (!out) return res.status(404).json({ error: 'No Discord user has that ID.' });
        res.json(out);
    } catch (err) {
        logger.error(`[API insight] member insight failed in ${req.guildObject?.id}: ${err.message}`);
        res.status(500).json({ error: 'Could not load this member\'s insight.' });
    }
});

router.get('/settings', async (req, res) => {
    res.json(await getSettings(req.guildObject.id));
});

router.put('/settings', async (req, res) => {
    if (!req.isSuperAdmin) {
        const a = await liveConfigAccess(req.guildObject, req.user.id);
        if (!a.ok) return res.status(403).json({ error: 'You need Manage Server, Administrator or a bot-manager role in this server.' });
    }
    try {
        const out = await setSettings(req.guildObject.id, {
            enabled: !!req.body?.enabled,
            newAccountDays: req.body?.newAccountDays,
        });
        logger.info(`[API insight] ${req.user.username} set join insight in ${req.guildObject.id}: ${out.enabled ? 'on' : 'off'}, ${out.newAccountDays}d`);
        res.json(out);
    } catch (err) {
        logger.error(`[API insight] settings save failed in ${req.guildObject?.id}: ${err.message}`);
        res.status(500).json({ error: 'Could not save.' });
    }
});

router.get('/ban-log', async (req, res) => {
    try {
        const rows = await getBanLog(req.guildObject, { days: req.query.days });
        const guild = req.guildObject;
        // Names for people no longer in the server: the bot's user cache, else the name logged at ban time
        // (core/user-display.js). `username`/`avatar` stay for older readers of this route.
        res.json({
            rows: rows.map(r => {
                const user = userBits(guild, r.userId, { storedName: r.username });
                return { ...r, user, username: user.username, avatar: user.avatar };
            }),
        });
    } catch (err) {
        logger.error(`[API insight] ban log failed in ${req.guildObject?.id}: ${err.message}`);
        res.status(500).json({ error: 'Could not load the ban log.' });
    }
});

router.post('/ban-log/:userId/unban', async (req, res) => {
    const userId = req.params.userId;
    if (!SNOWFLAKE.test(userId)) return res.status(400).json({ error: 'Bad user ID.' });
    const guild = req.guildObject;
    if (!req.isSuperAdmin) {
        const member = await guild.members.fetch(req.user.id).catch(() => null);
        if (!member) return res.status(403).json({ error: "You're not a member of this server." });
        if (guild.ownerId !== member.id && !member.permissions.has(PermissionFlagsBits.BanMembers)) {
            return res.status(403).json({ error: 'You need the Ban Members permission in this server.' });
        }
    }
    const out = await unbanFromLog(guild, userId, { id: req.user.id, username: req.user.username });
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    res.json({ ok: true });
});

export default router;
