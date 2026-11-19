/**
 * Bulk Role Creator
 *
 * Turns a line-separated list of role names into real Discord roles. Shared by the
 * `/admin roles bulk-create` modal and the dashboard's Bulk Roles page so both paths
 * parse, validate, and create identically.
 *
 * Per-line syntax (everything after the name is optional, pipe-separated):
 *
 *     Moderator | #ff0000 | hoist | mentionable | perms=moderator
 *     Subscriber | random
 *     // a comment line, ignored
 *
 * Tokens are order-independent: a `#hex` (or colour name, or `random`) sets the colour,
 * `hoist`/`mentionable` turn the flags on, `nohoist`/`nomentionable` turn them off, and
 * `perms=<preset>` or `perms=ManageMessages+KickMembers` overrides the permissions for
 * that one role. Anything not given falls back to the form-level defaults.
 */

import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';

/** Discord's hard ceiling on roles per guild (including @everyone and managed roles). */
export const GUILD_ROLE_LIMIT = 250;

/** How many roles one submission may create. Keeps a typo'd paste from eating the guild. */
export const MAX_PER_BATCH = 50;

/** Discord's own role-name ceiling. */
export const MAX_NAME_LENGTH = 100;

/** Pause between creates — role creation is a low-limit bucket and 429s cascade. */
const CREATE_DELAY_MS = 350;

const MEMBER_PERMS = [
    'ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads',
    'EmbedLinks', 'AttachFiles', 'AddReactions', 'UseExternalEmojis', 'UseExternalStickers',
    'ReadMessageHistory', 'Connect', 'Speak', 'Stream', 'UseVAD', 'UseApplicationCommands',
    'ChangeNickname',
];

const HELPER_PERMS = [
    ...MEMBER_PERMS, 'CreatePrivateThreads', 'ManageMessages', 'ManageThreads',
    'MuteMembers', 'DeafenMembers', 'MoveMembers',
];

const MODERATOR_PERMS = [
    ...HELPER_PERMS, 'KickMembers', 'BanMembers', 'ModerateMembers',
    'ManageNicknames', 'ViewAuditLog',
];

const MANAGER_PERMS = [
    ...MODERATOR_PERMS, 'ManageRoles', 'ManageChannels', 'ManageGuild',
    'ManageWebhooks', 'ManageEvents', 'CreateGuildExpressions', 'ManageGuildExpressions', 'MentionEveryone',
];

/**
 * Named permission bundles offered in both UIs. `perms` are discord.js
 * `PermissionFlagsBits` keys; anything the actor or the bot lacks is stripped later.
 */
export const PERMISSION_PRESETS = {
    none: { label: 'No permissions', description: 'Cosmetic / grouping only', perms: [] },
    member: { label: 'Member', description: 'Talk, react, join voice', perms: MEMBER_PERMS },
    helper: { label: 'Helper', description: 'Member plus message and voice management', perms: HELPER_PERMS },
    moderator: { label: 'Moderator', description: 'Helper plus kick, ban, and timeout', perms: MODERATOR_PERMS },
    manager: { label: 'Manager', description: 'Moderator plus role, channel, and server management', perms: MANAGER_PERMS },
    admin: { label: 'Administrator', description: 'Full control — grants everything', perms: ['Administrator'] },
};

/** Colour words accepted in place of a hex code. */
export const NAMED_COLORS = {
    default: 0x000000, blurple: 0x5865f2, red: 0xed4245, dark_red: 0x992d22,
    orange: 0xe67e22, gold: 0xf1c40f, yellow: 0xfee75c, green: 0x57f287,
    dark_green: 0x1f8b4c, teal: 0x1abc9c, aqua: 0x11806a, blue: 0x3498db,
    dark_blue: 0x206694, purple: 0x9b59b6, magenta: 0xe91e63, pink: 0xeb459e,
    grey: 0x95a5a6, gray: 0x95a5a6, dark_grey: 0x607d8b, dark_gray: 0x607d8b,
    white: 0xffffff, black: 0x000000,
};

/**
 * Permissions offered as individual checkboxes on the dashboard, grouped the way Discord's
 * own role editor groups them. Any flag discord.js knows but this table omits still works
 * when typed as `perms=Flag` — this is a UI convenience, not the allowlist.
 */
export const PERMISSION_CATALOG = [
    {
        group: 'General', perms: [
            'ViewChannel', 'ManageChannels', 'ManageRoles', 'CreateGuildExpressions', 'ManageGuildExpressions',
            'ViewAuditLog', 'ManageWebhooks', 'ManageGuild', 'CreateInstantInvite',
            'ChangeNickname', 'ManageNicknames', 'ManageEvents', 'Administrator',
        ],
    },
    {
        group: 'Membership', perms: ['KickMembers', 'BanMembers', 'ModerateMembers'],
    },
    {
        group: 'Text', perms: [
            'SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads',
            'EmbedLinks', 'AttachFiles', 'AddReactions', 'UseExternalEmojis', 'UseExternalStickers',
            'MentionEveryone', 'ManageMessages', 'ManageThreads', 'ReadMessageHistory',
            'SendTTSMessages', 'UseApplicationCommands', 'SendPolls',
        ],
    },
    {
        group: 'Voice', perms: [
            'Connect', 'Speak', 'Stream', 'UseEmbeddedActivities', 'UseSoundboard',
            'UseExternalSounds', 'UseVAD', 'PrioritySpeaker', 'MuteMembers', 'DeafenMembers',
            'MoveMembers', 'RequestToSpeak',
        ],
    },
];

const FLAG_NAMES = Object.keys(PermissionFlagsBits);
const FLAG_LOOKUP = new Map(FLAG_NAMES.map(n => [n.toLowerCase(), n]));

/**
 * Resolve a colour token to an integer.
 * @returns {{ color: number } | { error: string }}
 */
export function resolveColor(raw) {
    // Already-resolved ints come back through here when they're reused as form defaults.
    if (typeof raw === 'number') {
        return Number.isInteger(raw) && raw >= 0 && raw <= 0xffffff
            ? { color: raw }
            : { error: `${raw} is not a valid colour value` };
    }

    const token = String(raw ?? '').trim();
    if (!token || token.toLowerCase() === 'none') return { color: 0 };
    if (token.toLowerCase() === 'random') {
        return { color: Math.floor(Math.random() * 0xffffff) };
    }

    const named = NAMED_COLORS[token.toLowerCase().replace(/[\s-]+/g, '_')];
    if (named !== undefined) return { color: named };

    let hex = token.startsWith('#') ? token.slice(1) : token;
    if (/^0x/i.test(hex)) hex = hex.slice(2);
    if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split('').map(c => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(hex)) return { error: `"${token}" is not a colour I recognise` };

    return { color: parseInt(hex, 16) };
}

/** Normalise a permission spec (preset key, array of flag names, or `A+B` string) to flag names. */
export function resolvePermissions(spec) {
    if (spec == null || spec === '') return { perms: [] };

    if (Array.isArray(spec)) {
        const perms = [];
        const unknown = [];
        for (const entry of spec) {
            const name = FLAG_LOOKUP.get(String(entry).trim().toLowerCase());
            if (name) perms.push(name); else unknown.push(entry);
        }
        if (unknown.length) return { error: `Unknown permission(s): ${unknown.join(', ')}` };
        return { perms: [...new Set(perms)] };
    }

    const token = String(spec).trim();
    const preset = PERMISSION_PRESETS[token.toLowerCase()];
    if (preset) return { perms: [...preset.perms], preset: token.toLowerCase() };

    return resolvePermissions(token.split(/[+,]/).map(s => s.trim()).filter(Boolean));
}

/**
 * Parse the textarea into role specs. Never throws — bad lines come back with an `error`
 * so the caller can show the whole list at once instead of failing on the first typo.
 *
 * @param {string} text            Line-separated names, optionally with `| token` overrides.
 * @param {object} defaults        `{ color, permissions, hoist, mentionable }` from the form.
 * @returns {{ entries: Array, errors: Array<{line:number, name:string, error:string}> }}
 */
export function parseRoleList(text, defaults = {}) {
    const defaultColorResolved = defaults.color != null ? resolveColor(defaults.color) : { color: 0 };
    const defaultPermsResolved = resolvePermissions(defaults.permissions ?? []);

    const entries = [];
    const errors = [];
    const seen = new Map();

    const lines = String(text ?? '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        const raw = lines[i].trim();
        if (!raw || raw.startsWith('//')) continue;

        const [namePart, ...tokens] = raw.split('|').map(p => p.trim());
        const name = namePart;

        if (!name) {
            errors.push({ line: lineNo, name: raw, error: 'No role name before the first "|"' });
            continue;
        }
        if (name.length > MAX_NAME_LENGTH) {
            errors.push({ line: lineNo, name, error: `Name is ${name.length} characters — Discord allows ${MAX_NAME_LENGTH}` });
            continue;
        }
        if (/^@(everyone|here)$/i.test(name)) {
            errors.push({ line: lineNo, name, error: 'That name is reserved by Discord' });
            continue;
        }

        const entry = {
            line: lineNo,
            name,
            color: defaultColorResolved.color ?? 0,
            permissions: [...(defaultPermsResolved.perms ?? [])],
            hoist: !!defaults.hoist,
            mentionable: !!defaults.mentionable,
        };

        let bad = null;
        for (const token of tokens) {
            if (!token) continue;
            const lower = token.toLowerCase();

            if (lower === 'hoist' || lower === 'display' || lower === 'separate') { entry.hoist = true; continue; }
            if (lower === 'nohoist' || lower === 'no-hoist') { entry.hoist = false; continue; }
            if (lower === 'mentionable' || lower === 'ping') { entry.mentionable = true; continue; }
            if (lower === 'nomentionable' || lower === 'no-mentionable') { entry.mentionable = false; continue; }

            const permMatch = /^perms?\s*[=:]\s*(.+)$/i.exec(token);
            if (permMatch) {
                const resolved = resolvePermissions(permMatch[1]);
                if (resolved.error) { bad = resolved.error; break; }
                entry.permissions = resolved.perms;
                continue;
            }

            const colorMatch = resolveColor(token);
            if (colorMatch.error) { bad = `${colorMatch.error} (in "${token}")`; break; }
            entry.color = colorMatch.color;
        }

        if (bad) {
            errors.push({ line: lineNo, name, error: bad });
            continue;
        }

        const key = name.toLowerCase();
        if (seen.has(key)) {
            errors.push({ line: lineNo, name, error: `Duplicate of line ${seen.get(key)}` });
            continue;
        }
        seen.set(key, lineNo);
        entries.push(entry);
    }

    return { entries, errors };
}

/**
 * Strip permission bits the actor or the bot can't hand out.
 *
 * Discord rejects the whole create when the bot lacks a bit, and a Manage Server user
 * must not be able to mint an Administrator role they couldn't otherwise grant. An actor
 * with Administrator is allowed to grant anything the bot has.
 */
export function capPermissions(permNames, actorPermissions, botPermissions) {
    const actorIsAdmin = actorPermissions?.has?.(PermissionFlagsBits.Administrator) ?? false;

    const granted = [];
    const blockedByActor = [];
    const blockedByBot = [];

    for (const name of permNames) {
        const bit = PermissionFlagsBits[name];
        if (bit === undefined) continue;
        if (botPermissions && !botPermissions.has(bit)) { blockedByBot.push(name); continue; }
        if (!actorIsAdmin && actorPermissions && !actorPermissions.has(bit)) { blockedByActor.push(name); continue; }
        granted.push(name);
    }

    return { granted, blockedByActor, blockedByBot };
}

/**
 * Highest role position the bot may create at. Discord refuses to place a role at or above
 * the bot's own top role, so every requested position is clamped to one below it.
 */
export function maxCreatablePosition(guild) {
    const botMember = guild.members.me;
    return Math.max(1, (botMember?.roles?.highest?.position ?? 1) - 1);
}

/**
 * Clamp a requested position to what both the bot and the requesting member may reach.
 * Without the actor clamp, a Manage Server user could park a new role above their own
 * top role — something Discord's own UI never lets them do.
 *
 * @returns {number|null} null when no anchor was requested (role lands at the bottom).
 */
export function clampPosition(guild, requestedPosition, actorMember = null) {
    if (requestedPosition == null) return null;

    let ceiling = maxCreatablePosition(guild);
    if (actorMember && guild.ownerId !== actorMember.id) {
        ceiling = Math.min(ceiling, actorMember.roles.highest.position);
    }
    return Math.min(Math.max(1, requestedPosition), Math.max(1, ceiling));
}

/** X-Audit-Log-Reason must be plain ASCII — em-dashes and emoji make Discord 400. */
function asciiReason(reason) {
    return String(reason ?? 'Bulk role creation')
        .replace(/[^\x20-\x7E]/g, '')
        .slice(0, 400) || 'Bulk role creation';
}

/**
 * Check a parsed list against the live guild without creating anything.
 *
 * @returns {{ create: Array, skip: Array, blocked: string|null, permissionNotes: object }}
 */
export function planRoles(guild, entries, options = {}) {
    const { actorPermissions = null, allowExisting = false } = options;
    const botPermissions = guild.members.me?.permissions ?? null;

    const existing = new Map();
    for (const role of guild.roles.cache.values()) existing.set(role.name.toLowerCase(), role);

    const create = [];
    const skip = [];
    const blockedByActor = new Set();
    const blockedByBot = new Set();

    for (const entry of entries) {
        const clash = existing.get(entry.name.toLowerCase());
        if (clash && !allowExisting) {
            skip.push({ ...entry, reason: 'A role with that name already exists' });
            continue;
        }

        const capped = capPermissions(entry.permissions, actorPermissions, botPermissions);
        capped.blockedByActor.forEach(p => blockedByActor.add(p));
        capped.blockedByBot.forEach(p => blockedByBot.add(p));

        create.push({ ...entry, permissions: capped.granted });
    }

    let blocked = null;
    if (!guild.members.me?.permissions?.has(PermissionFlagsBits.ManageRoles)) {
        blocked = 'I need the Manage Roles permission in this server.';
    } else if (create.length > MAX_PER_BATCH) {
        blocked = `That's ${create.length} roles — I create at most ${MAX_PER_BATCH} at a time. Split the list.`;
    } else if (guild.roles.cache.size + create.length > GUILD_ROLE_LIMIT) {
        const room = GUILD_ROLE_LIMIT - guild.roles.cache.size;
        blocked = `This server has ${guild.roles.cache.size} of ${GUILD_ROLE_LIMIT} roles — only ${Math.max(room, 0)} more will fit.`;
    }

    return {
        create,
        skip,
        blocked,
        permissionNotes: {
            blockedByActor: [...blockedByActor],
            blockedByBot: [...blockedByBot],
        },
    };
}

/**
 * Create the planned roles, in list order.
 *
 * When `position` is given, every role is inserted at that same slot, so each new role
 * pushes the previous one up — the first line ends up highest, matching how the list reads.
 *
 * @returns {Promise<{ created: Array, failed: Array }>}
 */
export async function createRoles(guild, plan, options = {}) {
    const { reason, position = null, onProgress = null } = options;
    const auditReason = asciiReason(reason);

    const ceiling = maxCreatablePosition(guild);
    const targetPosition = position == null ? null : Math.min(Math.max(1, position), ceiling);

    const created = [];
    const failed = [];

    for (let i = 0; i < plan.length; i++) {
        const entry = plan[i];
        try {
            const role = await guild.roles.create({
                name: entry.name,
                color: entry.color || 0,
                hoist: !!entry.hoist,
                mentionable: !!entry.mentionable,
                permissions: new PermissionsBitField(entry.permissions.map(p => PermissionFlagsBits[p])),
                ...(targetPosition != null ? { position: targetPosition } : {}),
                reason: auditReason,
            });
            created.push({ id: role.id, name: role.name, color: entry.color, position: role.position });
        } catch (err) {
            failed.push({ name: entry.name, error: err?.message || String(err) });
        }

        if (onProgress) await onProgress({ index: i, total: plan.length, created, failed });
        if (i < plan.length - 1) await new Promise(r => setTimeout(r, CREATE_DELAY_MS));
    }

    return { created, failed };
}

/** `#rrggbb` for a colour int, for echoing choices back in the UI. */
export function hexOf(color) {
    return `#${(color >>> 0 & 0xffffff).toString(16).padStart(6, '0')}`;
}
