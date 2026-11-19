/**
 * Role Manager API — `/api/guilds/:guildId/role-manager/*`
 *
 * The dashboard's Roles page: every role top-down with member counts, edit / move / delete,
 * who holds a role, and per-member role history with "restore what they had when they left".
 *
 * Gated by `apiCheckGuildAdmin` at the parent router, which only proves Manage Server from
 * the login-time OAuth bitfield. Every write therefore re-checks against the LIVE member:
 * Manage Roles, and the hierarchy rules in core/role-manager-logic.js. Super-admins act with
 * the bot's authority (same as everywhere else on the dashboard).
 */

import express from 'express';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import {
    PERMISSION_CATALOG, resolveColor, resolvePermissions, hexOf,
} from '../../../../core/bulk-role-creator.js';
import { partitionRestorable } from '../../../../core/sticky-roles-logic.js';
import {
    actorAuthority, canManageRole, keyPermissions, validateRoleEdit, mergePermissionEdit,
    rolesAtLastLeave, roleIdsOf, auditReason,
} from '../../../../core/role-manager-logic.js';

const router = express.Router({ mergeParams: true });

const SNOWFLAKE = /^\d{15,25}$/;
const MEMBER_LIST_CAP = 500;
const HISTORY_CAP = 60;
// A full member fetch is a gateway request Discord rate-limits per guild; don't repeat it
// on every page load.
const FULL_FETCH_TTL_MS = 5 * 60 * 1000;
const lastFullFetch = new Map();

async function ensureMembers(guild) {
    const last = lastFullFetch.get(guild.id) || 0;
    if (Date.now() - last < FULL_FETCH_TTL_MS) return true;
    try {
        await guild.members.fetch({ time: 20_000 });
        lastFullFetch.set(guild.id, Date.now());
        return true;
    } catch (err) {
        logger.warn(`[API role-manager] member fetch failed in ${guild.id}: ${err.message}`);
        return guild.members.cache.size >= guild.memberCount;
    }
}

/** The live authority this request acts with, or null if they aren't in the server. */
async function resolveActor(req) {
    const guild = req.guildObject;
    if (req.isSuperAdmin) {
        return {
            member: null,
            permissions: guild.members.me?.permissions ?? null,
            authority: actorAuthority({ isSuperAdmin: true }),
            canManageRoles: true,
        };
    }
    const member = await guild.members.fetch(req.user.id).catch(() => null);
    if (!member) return null;
    const isOwner = guild.ownerId === member.id;
    return {
        member,
        permissions: member.permissions,
        authority: actorAuthority({ isOwner, topPosition: member.roles.highest.position }),
        canManageRoles: isOwner || member.permissions.has(PermissionFlagsBits.ManageRoles),
    };
}

function ctxFor(guild, actor) {
    return { guildId: guild.id, botTop: guild.members.me?.roles?.highest?.position ?? 0, actor: actor.authority };
}

/** Load the actor and refuse writes they can't make. Sends the error response itself. */
async function writer(req, res) {
    const actor = await resolveActor(req);
    if (!actor) { res.status(403).json({ error: "You're not a member of this server." }); return null; }
    if (!actor.canManageRoles) { res.status(403).json({ error: 'You need the Manage Roles permission in this server.' }); return null; }
    if (!req.guildObject.members.me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
        res.status(400).json({ error: "The bot doesn't have Manage Roles in this server." }); return null;
    }
    return actor;
}

function permNames(bits) {
    return new PermissionsBitField(bits).toArray();
}

/** Can this actor grant a permission bit? Owner/super-admin/Administrator: anything the bot has. */
function grantChecker(guild, actor) {
    const bot = guild.members.me?.permissions;
    const actorAdmin = actor.authority.ownerOrBypass || actor.permissions?.has(PermissionFlagsBits.Administrator);
    return (name) => {
        const bit = PermissionFlagsBits[name];
        if (bit === undefined || !bot) return false;
        if (!bot.has(bit)) return false;
        return actorAdmin || !!actor.permissions?.has(bit);
    };
}

function serialiseRole(role, guild, ctx, memberCounts) {
    const isEveryone = role.id === guild.id;
    // Prefer the authoritative count from the Discord `role-member-counts`
    // endpoint when the caller passed one in — role.members.size is only
    // reliable when the full member cache is populated, which guilds past a
    // few thousand members can't afford on every dashboard load.
    const liveCount = memberCounts?.get?.(role.id);
    // 2026 role tag additions. Each flag is `null` on the raw payload when
    // present and absent otherwise — discord.js materialises them as the
    // corresponding boolean/snowflake properties:
    //   premium_subscriber_role         → `role.tags.premiumSubscriberRole`  (Nitro Booster role)
    //   available_for_purchase          → `role.tags.availableForPurchase`   (role sold on the server shop)
    //   guild_connections               → `role.tags.guildConnections`       (role gated by Linked Role metadata)
    //   subscription_listing_id         → `role.tags.subscriptionListingId`  (shop subscription SKU)
    //   integration_id                  → `role.tags.integrationId`          (3rd-party integration)
    const tags = role.tags || {};
    return {
        id: role.id,
        name: isEveryone ? '@everyone' : role.name,
        color: role.color ? hexOf(role.color) : null,
        position: role.position,
        managed: role.managed,
        botRole: !!tags.botId,
        boosterRole: !!tags.premiumSubscriberRole,
        linkedRole: !!tags.guildConnections,
        storeRole: !!tags.availableForPurchase,
        subscriptionListingId: tags.subscriptionListingId || null,
        integrationId: tags.integrationId || null,
        hoist: role.hoist,
        mentionable: role.mentionable,
        isEveryone,
        memberCount: isEveryone
            ? guild.memberCount
            : (typeof liveCount === 'number' ? liveCount : role.members.size),
        keyPermissions: keyPermissions(role.permissions.bitfield),
        permissions: permNames(role.permissions.bitfield),
        manage: canManageRole(role, ctx),
    };
}

function serialiseMember(m) {
    return {
        id: m.id,
        username: m.user.username,
        displayName: m.displayName,
        avatar: m.displayAvatarURL({ size: 64 }),
        bot: m.user.bot,
    };
}

function sendDiscordError(res, err, what) {
    const code = err?.code;
    if (code === 50013) return res.status(403).json({ error: `Discord refused to ${what}: the bot is missing permissions or the role is above it.` });
    if (code === 10011) return res.status(404).json({ error: 'That role no longer exists.' });
    if (code === 10007) return res.status(404).json({ error: "That member isn't in the server." });
    logger.error(`[API role-manager] ${what} failed: ${err?.message}`);
    return res.status(500).json({ error: `Failed to ${what}.` });
}

// ── overview ─────────────────────────────────────────────────────────────────

/** GET / — every role top-down, plus who's asking and what they can do. */
router.get('/', async (req, res) => {
    try {
        const guild = req.guildObject;
        const actor = await resolveActor(req);
        if (!actor) return res.status(403).json({ error: "You're not a member of this server." });
        const ctx = ctxFor(guild, actor);
        const may = grantChecker(guild, actor);

        // Fetch per-role member counts in one lightweight call instead of
        // populating the full member cache. Falls back to the previous
        // ensureMembers() path on older bots where the endpoint is missing.
        let memberCounts = null;
        let complete = true;
        try {
            if (typeof guild.roles.fetchMemberCounts === 'function') {
                memberCounts = await guild.roles.fetchMemberCounts();
            } else {
                complete = await ensureMembers(guild);
            }
        } catch (err) {
            logger.warn(`[API role-manager] fetchMemberCounts failed, falling back to member cache: ${err.message}`);
            complete = await ensureMembers(guild);
        }

        const roles = [...guild.roles.cache.values()]
            .sort((a, b) => b.position - a.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
            .map(r => serialiseRole(r, guild, ctx, memberCounts));

        const botRole = guild.members.me?.roles?.highest;
        res.json({
            roles,
            memberCountsComplete: complete,
            roleLimit: 250,
            bot: {
                topRole: botRole ? { id: botRole.id, name: botRole.name, position: botRole.position } : null,
                canManageRoles: !!guild.members.me?.permissions?.has(PermissionFlagsBits.ManageRoles),
            },
            actor: {
                ownerOrBypass: actor.authority.ownerOrBypass,
                superAdmin: !!req.isSuperAdmin,
                canManageRoles: actor.canManageRoles,
                topRole: actor.member ? { id: actor.member.roles.highest.id, name: actor.member.roles.highest.name } : null,
            },
            permissionCatalog: PERMISSION_CATALOG.map(g => ({
                group: g.group,
                perms: g.perms.filter(n => PermissionFlagsBits[n] !== undefined)
                    .map(n => ({ key: n, label: n.replace(/([a-z])([A-Z])/g, '$1 $2'), allowed: may(n) })),
            })),
        });
    } catch (err) {
        logger.error(`[API role-manager] load failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to load roles' });
    }
});

// ── a single role ────────────────────────────────────────────────────────────

/** GET /roles/:roleId/members — who holds it. */
router.get('/roles/:roleId/members', async (req, res) => {
    try {
        const guild = req.guildObject;
        const role = guild.roles.cache.get(req.params.roleId);
        if (!role || role.id === guild.id) return res.status(404).json({ error: 'Role not found.' });
        const complete = await ensureMembers(guild);
        const members = [...role.members.values()]
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
            .slice(0, MEMBER_LIST_CAP)
            .map(serialiseMember);
        res.json({ members, total: role.members.size, truncated: role.members.size > MEMBER_LIST_CAP, complete });
    } catch (err) {
        logger.error(`[API role-manager] members failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to load members' });
    }
});

/** PATCH /roles/:roleId — name, colour, hoist, mentionable, permissions. */
router.patch('/roles/:roleId', async (req, res) => {
    const guild = req.guildObject;
    const actor = await writer(req, res);
    if (!actor) return;
    const role = guild.roles.cache.get(req.params.roleId);
    const check = canManageRole(role, ctxFor(guild, actor));
    if (!check.ok) return res.status(403).json({ error: check.reason });

    const v = validateRoleEdit(req.body, { resolveColor, resolvePermissions });
    if (v.error) return res.status(400).json({ error: v.error });

    const edit = { ...v.patch };
    let refused = [];
    if (edit.permissions) {
        const current = permNames(role.permissions.bitfield);
        const merged = mergePermissionEdit(edit.permissions, current, grantChecker(guild, actor));
        refused = merged.refused;
        const same = merged.final.length === current.length && merged.final.every(p => current.includes(p));
        if (same) delete edit.permissions; else edit.permissions = merged.final;
    }
    if (!Object.keys(edit).length) return res.json({ role: serialiseRole(role, guild, ctxFor(guild, actor)), refused });

    try {
        const updated = await role.edit({ ...edit, reason: auditReason(`Role edited by ${req.user.username} (${req.user.id}) via dashboard`) });
        logger.info(`[API role-manager] ${req.user.username} edited role ${updated.id} in ${guild.id} (${Object.keys(edit).join(', ')})`);
        res.json({ role: serialiseRole(updated, guild, ctxFor(guild, actor)), refused });
    } catch (err) {
        sendDiscordError(res, err, 'edit that role');
    }
});

/** POST /roles/:roleId/move — { direction: 'up' | 'down' }, one step. */
router.post('/roles/:roleId/move', async (req, res) => {
    const guild = req.guildObject;
    const actor = await writer(req, res);
    if (!actor) return;
    const ctx = ctxFor(guild, actor);
    const role = guild.roles.cache.get(req.params.roleId);
    const check = canManageRole(role, ctx);
    if (!check.ok) return res.status(403).json({ error: check.reason });

    const dir = req.body?.direction === 'up' ? 1 : req.body?.direction === 'down' ? -1 : 0;
    if (!dir) return res.status(400).json({ error: 'direction must be up or down.' });
    const target = role.position + dir;
    if (target < 1) return res.status(400).json({ error: 'Already at the bottom.' });
    if (target >= ctx.botTop || (!ctx.actor.ownerOrBypass && target >= ctx.actor.top)) {
        return res.status(403).json({ error: "Can't move it any higher — that's the limit of what you (or the bot) can manage." });
    }
    try {
        await role.setPosition(target, { reason: auditReason(`Role moved ${dir > 0 ? 'up' : 'down'} by ${req.user.username} (${req.user.id}) via dashboard`) });
        res.json({ ok: true });
    } catch (err) {
        sendDiscordError(res, err, 'move that role');
    }
});

/** DELETE /roles/:roleId — body { confirmName } must match exactly. */
router.delete('/roles/:roleId', async (req, res) => {
    const guild = req.guildObject;
    const actor = await writer(req, res);
    if (!actor) return;
    const role = guild.roles.cache.get(req.params.roleId);
    const check = canManageRole(role, ctxFor(guild, actor));
    if (!check.ok) return res.status(403).json({ error: check.reason });
    if (String(req.body?.confirmName ?? '') !== role.name) {
        return res.status(400).json({ error: 'Type the role name exactly to confirm.' });
    }
    try {
        const name = role.name;
        await role.delete(auditReason(`Role deleted by ${req.user.username} (${req.user.id}) via dashboard`));
        logger.info(`[API role-manager] ${req.user.username} deleted role ${role.id} in ${guild.id}`);
        res.json({ deleted: { id: role.id, name } });
    } catch (err) {
        sendDiscordError(res, err, 'delete that role');
    }
});

// ── members ──────────────────────────────────────────────────────────────────

/** GET /members/search?q= — by ID, @mention, or name. */
router.get('/members/search', async (req, res) => {
    try {
        const guild = req.guildObject;
        const q = String(req.query.q || '').trim().replace(/^<@!?(\d+)>$/, '$1');
        if (!q) return res.json({ members: [] });
        if (SNOWFLAKE.test(q)) {
            const m = await guild.members.fetch(q).catch(() => null);
            // Not in the server, but they may have history here — let the page open them anyway.
            return res.json({ members: m ? [serialiseMember(m)] : [], userId: q });
        }
        const found = await guild.members.search({ query: q.slice(0, 32), limit: 25 });
        res.json({ members: [...found.values()].map(serialiseMember) });
    } catch (err) {
        logger.error(`[API role-manager] search failed: ${err.message}`);
        res.status(500).json({ error: 'Search failed' });
    }
});

async function loadRoleEvents(guildId, userId) {
    const [rows] = await pool.query(
        `SELECT id, event_type, metadata, timestamp FROM audit_logs
          WHERE guild_id = ? AND user_id = ?
            AND event_type IN ('MEMBER_ROLES_ADDED', 'MEMBER_ROLES_REMOVED', 'GUILD_MEMBER_LEAVE', 'GUILD_MEMBER_JOIN')
          ORDER BY id`,
        [guildId, userId],
    );
    return rows;
}

/** What they held when they last left, split into restorable and skipped. */
async function lastLeaveFor(guild, member, userId, ctx) {
    const events = await loadRoleEvents(guild.id, userId);
    const replay = rolesAtLastLeave(events);

    // Sticky roles keeps an exact snapshot when it's on — prefer it over the replay.
    const [sticky] = await pool.query(
        'SELECT role_ids, left_at FROM role_persistence WHERE guild_id = ? AND user_id = ? AND left_at IS NOT NULL ORDER BY left_at DESC LIMIT 1',
        [guild.id, userId],
    ).catch(() => [[]]);
    let source = 'history';
    let saved = replay;
    if (sticky[0]) {
        let ids = sticky[0].role_ids;
        if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = []; } }
        saved = { leftAt: sticky[0].left_at, roleIds: Array.isArray(ids) ? ids.map(String) : [] };
        source = 'sticky';
    }

    const roles = new Map([...guild.roles.cache.values()].map(r => [r.id, { managed: r.managed, editable: canManageRole(r, ctx).ok }]));
    const memberRoleIds = new Set(member ? member.roles.cache.keys() : []);
    const parted = saved ? partitionRestorable(saved.roleIds, { guildId: guild.id, roles, memberRoleIds }) : null;
    return { events, saved, source, parted };
}

function roleRef(guild, id) {
    const r = guild.roles.cache.get(id);
    return { id, name: r?.name ?? null, color: r?.color ? hexOf(r.color) : null, deleted: !r };
}

/** GET /members/:userId — current roles, role history, and what they had when they last left. */
router.get('/members/:userId', async (req, res) => {
    try {
        const guild = req.guildObject;
        const userId = req.params.userId;
        if (!SNOWFLAKE.test(userId)) return res.status(400).json({ error: 'Not a valid user ID.' });
        const actor = await resolveActor(req);
        if (!actor) return res.status(403).json({ error: "You're not a member of this server." });
        const ctx = ctxFor(guild, actor);
        const member = await guild.members.fetch(userId).catch(() => null);
        const { events, saved, source, parted } = await lastLeaveFor(guild, member, userId, ctx);

        const history = events.slice(-HISTORY_CAP).reverse()
            .map(e => ({
                type: e.event_type,
                at: e.timestamp,
                roles: roleIdsOf(e.metadata).map(id => roleRef(guild, id)),
            }));

        res.json({
            userId,
            member: member ? serialiseMember(member) : null,
            roles: member
                ? [...member.roles.cache.values()].filter(r => r.id !== guild.id)
                    .sort((a, b) => b.position - a.position)
                    .map(r => ({ ...roleRef(guild, r.id), manage: canManageRole(r, ctx) }))
                : [],
            history,
            lastLeave: saved ? {
                leftAt: saved.leftAt,
                source,
                restorable: parted.restore.map(id => roleRef(guild, id)),
                skipped: Object.fromEntries(Object.entries(parted.skipped).map(([k, ids]) => [k, ids.map(id => roleRef(guild, id))])),
            } : null,
            historyStartsAt: events[0]?.timestamp ?? null,
        });
    } catch (err) {
        logger.error(`[API role-manager] member load failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to load that member' });
    }
});

async function changeMemberRole(req, res, add) {
    const guild = req.guildObject;
    const actor = await writer(req, res);
    if (!actor) return;
    const role = guild.roles.cache.get(req.params.roleId);
    const check = canManageRole(role, ctxFor(guild, actor));
    if (!check.ok) return res.status(403).json({ error: check.reason });
    const member = await guild.members.fetch(req.params.userId).catch(() => null);
    if (!member) return res.status(404).json({ error: "That member isn't in the server." });
    try {
        const reason = auditReason(`Role ${add ? 'given' : 'removed'} by ${req.user.username} (${req.user.id}) via dashboard`);
        if (add) await member.roles.add(role, reason); else await member.roles.remove(role, reason);
        res.json({ ok: true });
    } catch (err) {
        sendDiscordError(res, err, add ? 'give that role' : 'remove that role');
    }
}

router.put('/members/:userId/roles/:roleId', (req, res) => changeMemberRole(req, res, true));
router.delete('/members/:userId/roles/:roleId', (req, res) => changeMemberRole(req, res, false));

/** POST /members/:userId/restore — give back every restorable role from their last leave. */
router.post('/members/:userId/restore', async (req, res) => {
    const guild = req.guildObject;
    const actor = await writer(req, res);
    if (!actor) return;
    const member = await guild.members.fetch(req.params.userId).catch(() => null);
    if (!member) return res.status(404).json({ error: "That member isn't in the server." });
    try {
        const { parted } = await lastLeaveFor(guild, member, member.id, ctxFor(guild, actor));
        if (!parted) return res.status(404).json({ error: 'No record of them leaving this server.' });
        if (!parted.restore.length) return res.json({ restored: [] });
        await member.roles.add(parted.restore, auditReason(`Roles restored from before they left, by ${req.user.username} (${req.user.id}) via dashboard`));
        logger.info(`[API role-manager] ${req.user.username} restored ${parted.restore.length} role(s) to ${member.id} in ${guild.id}`);
        res.json({ restored: parted.restore.map(id => roleRef(guild, id)) });
    } catch (err) {
        sendDiscordError(res, err, 'restore those roles');
    }
});

export default router;
