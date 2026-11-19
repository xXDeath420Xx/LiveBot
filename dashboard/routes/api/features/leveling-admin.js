/**
 * Leveling admin API — /api/guilds/:guildId/leveling-admin (dashboard Leveling page).
 *
 *   GET  /members?q=           members with their level and XP: the top 10 when q is empty, else a
 *                              search by name, ID or mention
 *   GET  /members/:userId      one member's level and XP
 *   POST /members/:userId      { action: 'set'|'add'|'remove'|'set-level', amount } — the same
 *                              change /level set-xp, add-xp and remove-xp make, then reward roles
 *                              are brought in line (core/leveling-manager.js adjustMemberXP).
 *                              Writes an audit_logs row (XP_ADJUSTED) and the xp.adjusted log.
 *   GET  /xp-event             the running (or next) XP event and the recent ones
 *   POST /xp-event             { name, multiplier, minutes } — start one now, like /level xp-event start
 *   POST /xp-event/stop        end it, like /level xp-event stop
 *   POST /test-message         { target: 'dm'|channelId, message } — a sample level-up embed
 *
 * Gated by apiCheckGuildAdmin at the parent router (req.guildObject is the guild).
 */
import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { resolveMany } from '../../../../core/user-display.js';
import { saveAuditLog } from '../../../../core/log-manager.js';
import { logFeatureEvent, userLabel } from '../../../../core/feature-log.js';
import { MAX_TOTAL_XP, MAX_LEVEL } from '../../../../core/leveling-manager.js';
import { EmbedBuilder } from 'discord.js';
import { renderLevelUpMessage, DEFAULT_LEVEL_UP_MESSAGE, MESSAGE_MAX } from '../../../../core/leveling-settings.js';
import { themeColor } from '../../../../core/guild-theme.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;
const ACTIONS = ['set', 'add', 'remove', 'set-level'];
const EVENT_MULT_MIN = 1.1;
const EVENT_MULT_MAX = 9.99;
const EVENT_MAX_MINUTES = 30 * 24 * 60;

function managerFor(guild) {
    return guild?.client?.levelingManager || global.botManager?.getDefaultClient?.()?.levelingManager || null;
}

function needGuild(req, res) {
    const guild = req.guildObject;
    if (!guild) { res.status(503).json({ error: 'The bot is not connected to this server right now.' }); return null; }
    const lm = managerFor(guild);
    if (!lm) { res.status(503).json({ error: 'Leveling is not running right now. Try again in a minute.' }); return null; }
    return { guild, lm };
}

/** Rows for ids, in the order given, with the user's name bits and their level/XP. */
async function rowsFor(guild, lm, ids) {
    if (!ids.length) return [];
    const [rows] = await pool.query(
        'SELECT user_id, level, xp FROM user_levels WHERE guild_id = ? AND user_id IN (?)',
        [guild.id, ids],
    );
    const byId = new Map(rows.map((r) => [String(r.user_id), r]));
    const users = resolveMany(guild, ids);
    return ids.map((id) => {
        const r = byId.get(id);
        const level = r ? Number(r.level) || 0 : 0;
        const xp = r ? Number(r.xp) || 0 : 0;
        return {
            user: users[id] || { id },
            level,
            xp,
            totalXP: lm.getTotalXP(level, xp),
            xpForNextLevel: lm.getXPForLevel(level + 1),
            hasRow: !!r,
        };
    });
}

router.get('/members', async (req, res) => {
    const ctx = needGuild(req, res);
    if (!ctx) return;
    const { guild, lm } = ctx;
    try {
        const q = String(req.query.q || '').trim().replace(/^<@!?(\d+)>$/, '$1').slice(0, 100);
        let ids;
        if (!q) {
            const [top] = await pool.query(
                'SELECT user_id FROM user_levels WHERE guild_id = ? ORDER BY level DESC, xp DESC LIMIT 10',
                [guild.id],
            );
            ids = top.map((r) => String(r.user_id));
            // (an empty list would ask Discord for every member)
            const uncached = ids.filter((id) => !guild.members.cache.has(id));
            if (uncached.length) await guild.members.fetch({ user: uncached, time: 3000 }).catch(() => {});
        } else if (SNOWFLAKE.test(q)) {
            await guild.members.fetch(q).catch(() => null);
            ids = [q];
        } else {
            const found = await guild.members.search({ query: q.slice(0, 32), limit: 10 }).catch(() => null);
            ids = found ? [...found.values()].filter((m) => !m.user.bot).map((m) => m.id) : [];
        }
        res.json({ members: await rowsFor(guild, lm, ids), top: !q });
    } catch (err) {
        logger.error(`[API leveling-admin] member search failed: ${err.message}`, { guildId: guild.id });
        res.status(500).json({ error: 'Search failed' });
    }
});

router.get('/members/:userId', async (req, res) => {
    const ctx = needGuild(req, res);
    if (!ctx) return;
    const { guild, lm } = ctx;
    const userId = String(req.params.userId);
    if (!SNOWFLAKE.test(userId)) return res.status(400).json({ error: 'That is not a Discord user ID.' });
    try {
        await guild.members.fetch(userId).catch(() => null);
        const [row] = await rowsFor(guild, lm, [userId]);
        res.json({ member: row });
    } catch (err) {
        logger.error(`[API leveling-admin] member read failed: ${err.message}`, { guildId: guild.id });
        res.status(500).json({ error: 'Could not load that member' });
    }
});

router.post('/members/:userId', async (req, res) => {
    const ctx = needGuild(req, res);
    if (!ctx) return;
    const { guild, lm } = ctx;
    const userId = String(req.params.userId);
    const action = String(req.body?.action || '');
    const amount = Number(req.body?.amount);
    if (!SNOWFLAKE.test(userId)) return res.status(400).json({ error: 'That is not a Discord user ID.' });
    if (!ACTIONS.includes(action)) return res.status(400).json({ error: 'Choose set, add, remove or set level.' });
    const max = action === 'set-level' ? MAX_LEVEL : MAX_TOTAL_XP;
    if (!Number.isInteger(amount) || amount < 0 || amount > max) {
        return res.status(400).json({ error: `Enter a whole number from 0 to ${max.toLocaleString('en-US')}.` });
    }
    if ((action === 'add' || action === 'remove') && amount === 0) {
        return res.status(400).json({ error: 'Enter how much XP to ' + action + '.' });
    }

    try {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member?.user?.bot) return res.status(400).json({ error: 'Bots do not earn XP.' });
        if (!member) {
            // Someone who left can still be corrected if they have XP here; nobody else.
            const [[row]] = await pool.query('SELECT 1 AS x FROM user_levels WHERE guild_id = ? AND user_id = ?', [guild.id, userId]);
            if (!row) return res.status(404).json({ error: 'That user is not in this server and has no XP here.' });
        }

        const result = await lm.adjustMemberXP(guild, userId, { action, amount });
        const { before, after, roles } = result;
        const change = action === 'set' ? `Set to ${amount.toLocaleString('en-US')} XP`
            : action === 'add' ? `+${amount.toLocaleString('en-US')} XP`
            : action === 'remove' ? `-${amount.toLocaleString('en-US')} XP`
            : `Set to level ${amount}`;
        const describe = (s) => `Level ${s.level}, ${s.totalXP} XP in total`;

        await saveAuditLog(guild.id, 'XP_ADJUSTED', userId, userId, req.user?.id, null, `xp_${action.replace('-', '_')}`,
            'Changed on the dashboard', describe(before), describe(after), {
                source: 'dashboard', action, amount,
                rolesAdded: roles.added.map((r) => r.id), rolesRemoved: roles.removed.map((r) => r.id),
            });
        void logFeatureEvent(() => guild, 'xp.adjusted', () => ({
            title: '🛠️ XP Adjusted',
            fields: [
                ['Member', userLabel(member ?? userId)],
                ['Change', change],
                ['Now', `Level ${after.level} · ${after.xp} XP`],
                ['Level', after.level !== before.level ? `${before.level} → ${after.level}` : null],
                ['Roles given', roles.added.length ? roles.added.map((r) => `<@&${r.id}>`).join(' ') : null],
                ['Roles taken', roles.removed.length ? roles.removed.map((r) => `<@&${r.id}>`).join(' ') : null],
                ['Admin', `${userLabel(req.user?.id)} on the dashboard`],
            ],
        }));
        logger.info(`[API leveling-admin] ${req.user?.username} (${req.user?.id}) ${change} for ${userId} in ${guild.id}`);

        const [row] = await rowsFor(guild, lm, [userId]);
        const roleOut = (list) => list.map((r) => ({ id: r.id, name: r.name }));
        res.json({
            member: row, before, after, change,
            roles: { added: roleOut(roles.added), removed: roleOut(roles.removed), skipped: roles.skipped.length },
        });
    } catch (err) {
        logger.error(`[API leveling-admin] XP change failed: ${err.message}`, { guildId: guild.id, userId });
        res.status(500).json({ error: 'The XP change could not be saved.' });
    }
});

const eventOut = (e) => (e ? {
    id: e.id, name: e.event_name, multiplier: Number.parseFloat(e.multiplier),
    startsAt: Number(e.start_ts) * 1000, endsAt: Number(e.end_ts) * 1000,
    active: e.is_active === undefined ? undefined : !!Number(e.is_active),
} : null);

router.get('/xp-event', async (req, res) => {
    const ctx = needGuild(req, res);
    if (!ctx) return;
    const { guild, lm } = ctx;
    try {
        const [current, recent] = await Promise.all([lm.getActiveXPEvent(guild.id), lm.listXPEvents(guild.id, 5)]);
        res.json({ current: eventOut(current), recent: recent.map(eventOut) });
    } catch (err) {
        logger.error(`[API leveling-admin] xp-event read failed: ${err.message}`, { guildId: guild.id });
        res.status(500).json({ error: 'Could not load XP events' });
    }
});

router.post('/xp-event', async (req, res) => {
    const ctx = needGuild(req, res);
    if (!ctx) return;
    const { guild, lm } = ctx;
    const multiplier = Math.round(Number(req.body?.multiplier) * 100) / 100;
    const minutes = Number(req.body?.minutes);
    if (!Number.isFinite(multiplier) || multiplier < EVENT_MULT_MIN || multiplier > EVENT_MULT_MAX) {
        return res.status(400).json({ error: `The multiplier must be from ${EVENT_MULT_MIN} to ${EVENT_MULT_MAX}.` });
    }
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > EVENT_MAX_MINUTES) {
        return res.status(400).json({ error: 'The length must be from 1 minute to 30 days.' });
    }
    const name = (String(req.body?.name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100)) || `${multiplier}x XP`;
    try {
        const { event, conflict } = await lm.startXPEvent(guild.id, { name, multiplier, durationSeconds: minutes * 60 });
        if (conflict) {
            return res.status(409).json({ error: `"${conflict.event_name}" is already running. End it first.`, current: eventOut(conflict) });
        }
        await saveAuditLog(guild.id, 'XP_EVENT_START', null, null, req.user?.id, null, 'xp_event_start',
            'Started on the dashboard', null, `${name} (${multiplier}x, ${minutes} min)`, { source: 'dashboard', name, multiplier, minutes });
        res.json({ current: eventOut(event) });
    } catch (err) {
        logger.error(`[API leveling-admin] xp-event start failed: ${err.message}`, { guildId: guild.id });
        res.status(500).json({ error: 'Could not start the XP event' });
    }
});

router.post('/xp-event/stop', async (req, res) => {
    const ctx = needGuild(req, res);
    if (!ctx) return;
    const { guild, lm } = ctx;
    try {
        const stopped = await lm.stopXPEvents(guild.id);
        if (stopped > 0) {
            await saveAuditLog(guild.id, 'XP_EVENT_STOP', null, null, req.user?.id, null, 'xp_event_stop',
                'Ended on the dashboard', null, null, { source: 'dashboard', stopped });
        }
        res.json({ stopped });
    } catch (err) {
        logger.error(`[API leveling-admin] xp-event stop failed: ${err.message}`, { guildId: guild.id });
        res.status(500).json({ error: 'Could not end the XP event' });
    }
});

/**
 * POST /test-message { target: 'dm' | channelId, message } — posts the level-up embed exactly as a
 * real level-up would look (the requesting admin as the member, level 10), to that channel or to
 * the admin's own DMs. At most one test per server every 10 seconds.
 */
const lastTest = new Map();
router.post('/test-message', async (req, res) => {
    const guild = req.guildObject;
    if (!guild) return res.status(503).json({ error: 'The bot is not connected to this server right now.' });
    const now = Date.now();
    if (now - (lastTest.get(guild.id) || 0) < 10000) return res.status(429).json({ error: 'Wait a few seconds before sending another test.' });
    const target = String(req.body?.target || '').trim();
    const template = String(req.body?.message ?? '').replace(/\r\n/g, '\n').trim().slice(0, MESSAGE_MAX) || DEFAULT_LEVEL_UP_MESSAGE;
    try {
        const me = await guild.members.fetch(req.user.id).catch(() => null);
        const level = 10;
        const embed = new EmbedBuilder()
            .setColor(themeColor(guild.id, 'warning'))
            .setTitle('Level Up!')
            .setDescription(renderLevelUpMessage(template, { userId: req.user.id, username: me?.user?.username || req.user.username, level, serverName: guild.name }))
            .setFooter({ text: (target === 'dm' ? `Level ${level} in ${guild.name}` : `You are now level ${level}!`).slice(0, 2000) + ' (test from the dashboard)' });
        if (me) embed.setThumbnail(me.user.displayAvatarURL());
        let where;
        if (target === 'dm') {
            if (!me) return res.status(400).json({ error: 'You are not in this server, so the bot cannot DM you from it.' });
            await me.send({ embeds: [embed] }).catch(() => { throw Object.assign(new Error('Your DMs are closed to this server, so the test could not be delivered.'), { status: 400 }); });
            where = 'your DMs';
        } else {
            if (!SNOWFLAKE.test(target)) return res.status(400).json({ error: 'Choose a channel or DMs for the test.' });
            const channel = guild.channels.cache.get(target);
            if (!channel || !channel.isTextBased?.() || channel.isVoiceBased?.()) return res.status(400).json({ error: 'That channel is gone or is not a text channel.' });
            const perms = guild.members.me ? channel.permissionsFor(guild.members.me) : null;
            if (!perms?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) return res.status(400).json({ error: `The bot needs View Channel, Send Messages and Embed Links in #${channel.name}.` });
            await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
            where = `#${channel.name}`;
        }
        lastTest.set(guild.id, now);
        logger.info(`[API leveling-admin] ${req.user?.username} (${req.user?.id}) sent a level-up test to ${target} in ${guild.id}`);
        res.json({ ok: true, where });
    } catch (err) {
        if (err.status === 400) return res.status(400).json({ error: err.message });
        logger.error(`[API leveling-admin] test message failed: ${err.message}`, { guildId: guild.id });
        res.status(500).json({ error: 'Could not send the test message.' });
    }
});

export default router;
