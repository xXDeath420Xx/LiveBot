/**
 * Bulk Roles API — `/api/guilds/:guildId/bulk-roles/*`
 *
 * Already gated by `apiCheckGuildAdmin` at the parent router, so every request here is
 * from someone with Manage Server. That is NOT enough to hand out arbitrary permissions,
 * so the plan step caps requested permissions to what the requesting member actually
 * holds — see `capPermissions` in core/bulk-role-creator.js.
 */

import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import logger from '../../../../utils/logger.js';
import {
    PERMISSION_PRESETS,
    PERMISSION_CATALOG,
    GUILD_ROLE_LIMIT,
    MAX_PER_BATCH,
    MAX_NAME_LENGTH,
    parseRoleList,
    planRoles,
    createRoles,
    resolveColor,
    resolvePermissions,
    clampPosition,
    maxCreatablePosition,
    hexOf,
} from '../../../../core/bulk-role-creator.js';

const router = express.Router({ mergeParams: true });

/**
 * The dashboard session only proves Manage Server. Fetch the live member so permission
 * capping and the position clamp run against their real roles, not the cached OAuth bitfield.
 * Super-admins managing a guild they aren't in fall back to the bot's own permissions.
 */
async function resolveActor(req) {
    const guild = req.guildObject;
    try {
        const member = await guild.members.fetch(req.user.id);
        return { member, permissions: member.permissions };
    } catch {
        if (req.isSuperAdmin) return { member: null, permissions: guild.members.me?.permissions ?? null };
        return { member: null, permissions: null };
    }
}

function serialiseEntry(entry) {
    return {
        line: entry.line,
        name: entry.name,
        color: hexOf(entry.color),
        hoist: entry.hoist,
        mentionable: entry.mentionable,
        permissions: entry.permissions,
        ...(entry.reason ? { reason: entry.reason } : {}),
    };
}

/** GET / — everything the page needs to render: presets, existing roles, headroom. */
router.get('/', async (req, res) => {
    try {
        const guild = req.guildObject;
        const ceiling = maxCreatablePosition(guild);

        const roles = [...guild.roles.cache.values()]
            .filter(r => r.id !== guild.id)
            .sort((a, b) => b.position - a.position)
            .map(r => ({
                id: r.id,
                name: r.name,
                color: hexOf(r.color),
                position: r.position,
                managed: r.managed,
                creatableBelow: r.position <= ceiling,
            }));

        // The actor's own permissions bound what the checkboxes may offer — anything they
        // lack would be stripped server-side anyway, so don't dangle it in the UI.
        const actor = await resolveActor(req);
        const actorIsAdmin = actor.permissions?.has(PermissionFlagsBits.Administrator) ?? false;

        res.json({
            roles,
            presets: Object.entries(PERMISSION_PRESETS).map(([key, p]) => ({
                key, label: p.label, description: p.description, permissions: p.perms,
            })),
            permissionCatalog: PERMISSION_CATALOG.map(g => ({
                group: g.group,
                perms: g.perms
                    .filter(name => PermissionFlagsBits[name] !== undefined)
                    .map(name => ({
                        key: name,
                        label: name.replace(/([a-z])([A-Z])/g, '$1 $2'),
                        allowed: actorIsAdmin || !!actor.permissions?.has(PermissionFlagsBits[name]),
                    })),
            })),
            limits: {
                guildRoleLimit: GUILD_ROLE_LIMIT,
                maxPerBatch: MAX_PER_BATCH,
                maxNameLength: MAX_NAME_LENGTH,
                currentRoleCount: guild.roles.cache.size,
                remaining: Math.max(0, GUILD_ROLE_LIMIT - guild.roles.cache.size),
            },
            botCanManageRoles: !!guild.members.me?.permissions?.has('ManageRoles'),
        });
    } catch (err) {
        logger.error(`[API bulk-roles] load failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to load role data' });
    }
});

/** Shared body validation for preview and create. */
function readBody(body) {
    const { names, color, permissions, preset, hoist, mentionable, below } = body || {};

    if (typeof names !== 'string' || !names.trim()) {
        return { error: 'Paste at least one role name.' };
    }
    if (names.length > 20000) {
        return { error: 'That list is too long — split it into smaller batches.' };
    }

    let resolvedColor = 0;
    if (color) {
        const c = resolveColor(color);
        if (c.error) return { error: c.error };
        resolvedColor = c.color;
    }

    // An explicit permission array wins over the preset, so the page's "customise" mode
    // doesn't have to fake a preset key.
    const permSpec = Array.isArray(permissions) && permissions.length
        ? permissions
        : (preset || 'none');
    const perms = resolvePermissions(permSpec);
    if (perms.error) return { error: perms.error };

    return {
        names,
        defaults: {
            color: resolvedColor,
            permissions: perms.perms,
            hoist: !!hoist,
            mentionable: !!mentionable,
        },
        below: below && /^\d{15,25}$/.test(String(below)) ? String(below) : null,
    };
}

/** POST /preview — parse and validate without touching Discord. */
router.post('/preview', async (req, res) => {
    const parsed = readBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    try {
        const guild = req.guildObject;
        const actor = await resolveActor(req);
        if (!actor.permissions) return res.status(403).json({ error: "You're not a member of this server." });

        const { entries, errors } = parseRoleList(parsed.names, parsed.defaults);
        const plan = planRoles(guild, entries, { actorPermissions: actor.permissions });

        const anchor = parsed.below ? guild.roles.cache.get(parsed.below) : null;
        const position = clampPosition(guild, anchor ? anchor.position : null, actor.member);

        res.json({
            create: plan.create.map(serialiseEntry),
            skip: plan.skip.map(serialiseEntry),
            errors,
            blocked: plan.blocked,
            permissionNotes: plan.permissionNotes,
            placement: anchor
                ? { anchor: { id: anchor.id, name: anchor.name }, position, clamped: position !== anchor.position }
                : null,
        });
    } catch (err) {
        logger.error(`[API bulk-roles] preview failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to preview those roles' });
    }
});

/** POST /create — actually create them. */
router.post('/create', async (req, res) => {
    const parsed = readBody(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    try {
        const guild = req.guildObject;
        const actor = await resolveActor(req);
        if (!actor.permissions) return res.status(403).json({ error: "You're not a member of this server." });
        if (!actor.permissions.has('ManageRoles')) {
            return res.status(403).json({ error: 'You need the Manage Roles permission in this server.' });
        }

        const { entries, errors } = parseRoleList(parsed.names, parsed.defaults);
        const plan = planRoles(guild, entries, { actorPermissions: actor.permissions });

        if (plan.blocked) return res.status(400).json({ error: plan.blocked });
        if (!plan.create.length) {
            return res.status(400).json({
                error: entries.length
                    ? 'Every name on that list already exists as a role here.'
                    : 'No usable role names in that list.',
                errors,
                skip: plan.skip.map(serialiseEntry),
            });
        }

        const anchor = parsed.below ? guild.roles.cache.get(parsed.below) : null;
        const position = clampPosition(guild, anchor ? anchor.position : null, actor.member);

        const { created, failed } = await createRoles(guild, plan.create, {
            position,
            reason: `Bulk role creation by ${req.user.username} (${req.user.id}) via dashboard`,
        });

        logger.info(`[API bulk-roles] ${req.user.username} created ${created.length} role(s) in ${guild.name} (${guild.id})`);

        res.json({
            created: created.map(r => ({ id: r.id, name: r.name, color: hexOf(r.color), position: r.position })),
            failed,
            skip: plan.skip.map(serialiseEntry),
            errors,
            permissionNotes: plan.permissionNotes,
        });
    } catch (err) {
        logger.error(`[API bulk-roles] create failed: ${err.message}`);
        res.status(500).json({ error: 'Failed to create those roles' });
    }
});

export default router;
