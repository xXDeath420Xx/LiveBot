/**
 * Protection Settings API — `/api/guilds/:guildId/protection-settings/*`
 *
 * The dashboard's Protection Settings page (views/partials/manage/protection-settings.ejs): the
 * server's protection allowlist (users, roles, and members recorded as once holding an allowlisted
 * role), bot-manager roles, the global pause, and an overview of which protections are on plus the
 * feature-specific lists that stay separate. Everything `/protection allowlist|managers|pause|resume|status`
 * does. The rules live in core/protection-exempt.js.
 *
 * Also the AI second opinion block (`GET|POST /ai`, core/ai-judge.js): per-surface mode, act confidence,
 * the NSFW third opinion, the daily cap, and the daily usage chart.
 *
 * Gated by `apiCheckGuildAdmin` at the parent router (Manage Server from the OAuth bitfield, or a
 * bot-manager role checked live). Every write re-checks the LIVE member: configure access (owner,
 * Administrator, Manage Server or a manager role) for the allowlist and pause; owner or Administrator
 * for manager roles. Super-admins act with the bot's authority, as everywhere else on the dashboard.
 */

import express from 'express';
import logger from '../../../../utils/logger.js';
import {
    listAllowlist, listSeen, addAllow, removeAllow, listManagers, addManager, removeManager, listGlobalBanAllowed,
    pause, resume, getPause, liveConfigAccess, protectionsOverview,
} from '../../../../core/protection-exempt.js';
import { parseDuration, canEditManagers, MAX_ALLOWLIST, MAX_MANAGER_ROLES } from '../../../../core/protection-exempt-logic.js';
import aiJudge from '../../../../core/ai-judge.js';
import { AI_MODES, MIN_CONFIDENCE, MAX_CONFIDENCE, MIN_DAILY_CAP, MAX_DAILY_CAP } from '../../../../core/ai-judge-logic.js';

const router = express.Router({ mergeParams: true });
const SNOWFLAKE = /^\d{15,25}$/;

/** What this request may do, judged live. */
async function actorFor(req) {
    if (req.isSuperAdmin) return { canConfigure: true, canEditManagers: true, viaManager: false, superAdmin: true };
    const a = await liveConfigAccess(req.guildObject, req.user.id);
    return {
        canConfigure: a.ok,
        canEditManagers: canEditManagers({ isOwner: a.isOwner, isAdmin: a.isAdmin }),
        viaManager: a.viaManager,
        superAdmin: false,
    };
}

/** Refuse a write the live member can't make. Sends the response itself; returns the actor or null. */
async function writer(req, res, { managers = false } = {}) {
    const actor = await actorFor(req);
    if (managers ? !actor.canEditManagers : !actor.canConfigure) {
        res.status(403).json({ error: managers
            ? 'Only the server owner or an Administrator can change bot-manager roles.'
            : 'You need Manage Server, Administrator or a bot-manager role in this server.' });
        return null;
    }
    return actor;
}

const roleRow = (guild, id) => {
    const r = guild.roles.cache.get(id);
    return r
        ? { id, name: r.name, color: r.hexColor === '#000000' ? null : r.hexColor, members: r.members.size, managed: r.managed, deleted: false }
        : { id, name: null, color: null, members: 0, managed: false, deleted: true };
};

async function userRow(guild, id) {
    const member = guild.members.cache.get(id) || await guild.members.fetch(id).catch(() => null);
    const user = member?.user || guild.client.users.cache.get(id) || await guild.client.users.fetch(id).catch(() => null);
    return {
        id,
        username: user?.username ?? null,
        displayName: member?.displayName ?? user?.globalName ?? user?.username ?? null,
        avatar: user?.displayAvatarURL?.({ size: 64 }) ?? null,
        inServer: !!member,
        roleIds: member ? [...member.roles.cache.keys()] : [],
    };
}

router.get('/', async (req, res) => {
    const guild = req.guildObject;
    try {
        const [allow, held, managers, paused, overview, actor, globalBan] = await Promise.all([
            listAllowlist(guild.id), listSeen(guild.id), listManagers(guild.id), getPause(guild.id),
            protectionsOverview(guild.id), actorFor(req), listGlobalBanAllowed(guild.id).catch(() => [])]);
        const allowRoleIds = new Set(allow.filter(r => r.kind === 'role').map(r => r.target_id));
        const meta = (r) => ({ addedBy: r.added_by, addedAt: r.added_at, note: r.note ?? null });
        res.json({
            actor,
            limits: { allowlist: MAX_ALLOWLIST, managers: MAX_MANAGER_ROLES },
            pause: { ...paused, byName: paused.by ? (await userRow(guild, paused.by)).username : null },
            users: await Promise.all(allow.filter(r => r.kind === 'user').map(async r => {
                const u = await userRow(guild, r.target_id);
                // The removal rule: someone holding an allowlisted role can't come off the list.
                const heldRole = u.roleIds.find(id => allowRoleIds.has(id)) ?? null;
                delete u.roleIds;
                return { ...u, ...meta(r), lockedByRole: heldRole ? roleRow(guild, heldRole) : null };
            })),
            roles: allow.filter(r => r.kind === 'role').map(r => ({ ...roleRow(guild, r.target_id), ...meta(r) })),
            // Global ban appeals this server accepted for itself: past the global ban only (migration 471)
            globalBan: await Promise.all(globalBan.map(async r => {
                const u = await userRow(guild, r.target_id);
                delete u.roleIds;
                return { ...u, ...meta(r) };
            })),
            bots: await Promise.all(allow.filter(r => r.kind === 'bot').map(async r => {
                // Resolve the bot's displayable info best-effort. Many trusted bots won't be
                // currently in-cache, so we fall back to just the id when fetch fails.
                let display = { id: r.target_id, username: null, avatar: null, inServer: false };
                try {
                    const u = await guild.client.users.fetch(r.target_id).catch(() => null);
                    if (u) { display.username = u.username; display.avatar = u.displayAvatarURL({ size: 64 }); }
                    const m = guild.members.cache.get(r.target_id) || await guild.members.fetch(r.target_id).catch(() => null);
                    if (m) { display.inServer = true; }
                } catch { /* best-effort */ }
                return { ...display, ...meta(r) };
            })),
            held: await Promise.all(held.map(async r => {
                const u = await userRow(guild, r.target_id);
                const stillHolds = u.roleIds.includes(r.via_role_id);
                delete u.roleIds;
                return { ...u, via: roleRow(guild, r.via_role_id), stillHolds, since: r.added_at };
            })),
            managers: managers.map(r => ({ ...roleRow(guild, r.target_id), ...meta(r) })),
            guildRoles: [...guild.roles.cache.values()]
                .filter(r => r.id !== guild.id)
                .sort((a, b) => b.position - a.position)
                .map(r => ({ id: r.id, name: r.name, color: r.hexColor === '#000000' ? null : r.hexColor, managed: r.managed })),
            overview,
        });
    } catch (err) {
        logger.error(`[API protection-settings] load failed in ${guild.id}: ${err.message}`);
        res.status(500).json({ error: 'Could not load the protection settings.' });
    }
});

/** Find members to allowlist: a name fragment, an @mention or a user ID. */
router.get('/members', async (req, res) => {
    const guild = req.guildObject;
    const q = String(req.query.q ?? '').replace(/[<@!>]/g, '').trim().slice(0, 64);
    if (!q) return res.json({ members: [] });
    try {
        const found = new Map();
        if (SNOWFLAKE.test(q)) {
            const m = await guild.members.fetch(q).catch(() => null);
            if (m) found.set(m.id, m);
            else {
                const u = await guild.client.users.fetch(q).catch(() => null);
                if (u) return res.json({ members: [{ id: u.id, username: u.username, displayName: u.globalName ?? u.username, avatar: u.displayAvatarURL({ size: 64 }), inServer: false }] });
            }
        } else {
            const hits = await guild.members.search({ query: q, limit: 10 }).catch(() => null);
            for (const m of hits?.values() ?? []) found.set(m.id, m);
        }
        res.json({
            members: [...found.values()].slice(0, 10).map(m => ({
                id: m.id, username: m.user.username, displayName: m.displayName, avatar: m.user.displayAvatarURL({ size: 64 }), inServer: true, bot: m.user.bot,
            })),
        });
    } catch (err) {
        logger.warn(`[API protection-settings] member search failed in ${guild.id}: ${err.message}`);
        res.status(500).json({ error: 'Search failed.' });
    }
});

router.post('/allowlist', async (req, res) => {
    const guild = req.guildObject;
    const kind = req.body?.kind;
    const id = String(req.body?.id ?? '').replace(/[<@!&>]/g, '').trim();
    if (kind !== 'user' && kind !== 'role' && kind !== 'bot') return res.status(400).json({ error: 'Pick a user, role, or bot.' });
    if (!SNOWFLAKE.test(id)) return res.status(400).json({ error: 'That is not a valid ID.' });
    if (kind === 'role' && (id === guild.id || !guild.roles.cache.has(id))) {
        return res.status(400).json({ error: id === guild.id ? 'Allowlisting @everyone would switch every protection off. Use the pause instead.' : 'No such role in this server.' });
    }
    if (!(await writer(req, res))) return;
    try {
        const out = await addAllow(guild, kind, id, req.user.id, req.body?.note ? String(req.body.note).slice(0, 200) : null);
        if (!out.ok) return res.status(400).json({ error: out.error });
        logger.info(`[API protection-settings] ${req.user.username} allowlisted ${kind} ${id} in ${guild.id}`);
        res.json({ ok: true });
    } catch (err) {
        logger.error(`[API protection-settings] allowlist add failed in ${guild.id}: ${err.message}`);
        res.status(500).json({ error: 'Could not save.' });
    }
});

router.delete('/allowlist/:kind/:id', async (req, res) => {
    const { kind, id } = req.params;
    if (!['user', 'role', 'bot', 'globalban'].includes(kind) || !SNOWFLAKE.test(id)) return res.status(400).json({ error: 'Bad request.' });
    if (!(await writer(req, res))) return;
    try {
        const out = await removeAllow(req.guildObject, kind, id, req.user.id);
        if (!out.ok) return res.status(409).json({ error: out.error });
        logger.info(`[API protection-settings] ${req.user.username} removed ${kind} ${id} from the allowlist in ${req.guildObject.id}`);
        res.json({ ok: true, removed: out.removed });
    } catch (err) {
        logger.error(`[API protection-settings] allowlist remove failed: ${err.message}`);
        res.status(500).json({ error: 'Could not save.' });
    }
});

router.post('/managers', async (req, res) => {
    const guild = req.guildObject;
    const id = String(req.body?.roleId ?? '').trim();
    const role = SNOWFLAKE.test(id) ? guild.roles.cache.get(id) : null;
    if (!role || role.id === guild.id) return res.status(400).json({ error: 'Pick a role.' });
    if (role.managed) return res.status(400).json({ error: "That role belongs to an integration and can't be a bot-manager role." });
    if (!(await writer(req, res, { managers: true }))) return;
    try {
        const out = await addManager(guild, id, req.user.id);
        if (!out.ok) return res.status(400).json({ error: out.error });
        logger.info(`[API protection-settings] ${req.user.username} made role ${id} a bot manager in ${guild.id}`);
        res.json({ ok: true });
    } catch (err) {
        logger.error(`[API protection-settings] manager add failed: ${err.message}`);
        res.status(500).json({ error: 'Could not save.' });
    }
});

router.delete('/managers/:roleId', async (req, res) => {
    if (!SNOWFLAKE.test(req.params.roleId)) return res.status(400).json({ error: 'Bad role ID.' });
    if (!(await writer(req, res, { managers: true }))) return;
    try {
        const removed = await removeManager(req.guildObject, req.params.roleId, req.user.id);
        logger.info(`[API protection-settings] ${req.user.username} removed bot-manager role ${req.params.roleId} in ${req.guildObject.id}`);
        res.json({ ok: true, removed });
    } catch (err) {
        logger.error(`[API protection-settings] manager remove failed: ${err.message}`);
        res.status(500).json({ error: 'Could not save.' });
    }
});

router.post('/pause', async (req, res) => {
    const d = parseDuration(req.body?.duration);
    if (!d.ok) return res.status(400).json({ error: d.error });
    if (!(await writer(req, res))) return;
    try {
        await pause(req.guildObject, {
            untilMs: d.ms ? Date.now() + d.ms : null,
            by: req.user.id,
            reason: req.body?.reason ? String(req.body.reason).slice(0, 200) : null,
        });
        logger.info(`[API protection-settings] ${req.user.username} paused protections in ${req.guildObject.id}`);
        res.json({ ok: true, pause: await getPause(req.guildObject.id) });
    } catch (err) {
        logger.error(`[API protection-settings] pause failed: ${err.message}`);
        res.status(500).json({ error: 'Could not pause.' });
    }
});

// ── AI second opinion (core/ai-judge.js) ─────────────────────────────────────

router.get('/ai', async (req, res) => {
    try {
        const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
        const [u, actor] = await Promise.all([aiJudge.usage(req.guildObject.id, days), actorFor(req)]);
        res.json({
            actor, ...u,
            limits: { modes: AI_MODES, minConfidence: MIN_CONFIDENCE, maxConfidence: MAX_CONFIDENCE, minCap: MIN_DAILY_CAP, maxCap: MAX_DAILY_CAP },
        });
    } catch (err) {
        logger.error(`[API protection-settings] AI usage failed: ${err.message}`);
        res.status(500).json({ error: 'Could not load the AI settings.' });
    }
});

router.post('/ai', async (req, res) => {
    if (!(await writer(req, res))) return;
    const b = req.body || {};
    const patch = {};
    for (const k of ['ai_avatar_mode', 'ai_avatar_confidence', 'ai_text_mode', 'ai_text_confidence', 'ai_nsfw_advise', 'ai_daily_cap']) {
        if (b[k] !== undefined) patch[k] = b[k];
    }
    try {
        const r = await aiJudge.saveSettings(req.guildObject, patch, req.user.id);
        if (!r.ok) return res.status(400).json({ error: r.error });
        logger.info(`[API protection-settings] ${req.user.username} changed AI settings in ${req.guildObject.id}: ${r.changed.join(', ')}`);
        res.json({ ok: true, changed: r.changed, settings: await aiJudge.getSettings(req.guildObject.id) });
    } catch (err) {
        logger.error(`[API protection-settings] AI settings failed: ${err.message}`);
        res.status(500).json({ error: 'Could not save the AI settings (has migration 331 run?).' });
    }
});

router.post('/resume', async (req, res) => {
    if (!(await writer(req, res))) return;
    try {
        const was = await resume(req.guildObject, req.user.id);
        logger.info(`[API protection-settings] ${req.user.username} resumed protections in ${req.guildObject.id}`);
        res.json({ ok: true, wasPaused: was });
    } catch (err) {
        logger.error(`[API protection-settings] resume failed: ${err.message}`);
        res.status(500).json({ error: 'Could not resume.' });
    }
});

export default router;
