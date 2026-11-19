/*
 * Slash commands that Discord shows inside another command, to keep the top-level list far under the 100 cap
 * (it sat at exactly 100 on 2026-11-05). `/owoify` is deployed as `/fun owoify`, `/namefilter add` as
 * `/admin namefilter add`, and so on.
 *
 * The moved command keeps its own file, execute, autocomplete, buttons, cooldown and category, and keeps its
 * own name everywhere inside the bot: applyMount() turns the incoming interaction back into the child's
 * (commandName = child, options without the extra level) before any gate runs, so per-guild restriction rows,
 * COMMAND_FEATURE_MAP entries and logs keyed on the old name keep working. Prefix commands (`!owoify`) are
 * untouched because the child is still in client.commands under its name.
 *
 * Only commands without subcommand groups can move (Discord nests one level), and only under a parent with the
 * same default_member_permissions, so nobody gains or loses sight of a command. A command with subcommands
 * becomes a group, one without becomes a subcommand. `as` renames it where the parent already uses the name.
 *
 * `drop` removes a pure alias from the slash list: /movie is /watch, /lookup is /user profile info.
 */

import { forSlashDeploy, relPaths } from './command-registration.js';

const SUB = 1, GROUP = 2;

// child → { parent, as? } | { drop: true }
export const MOUNTS = {
    // Everyone
    owoify: { parent: 'fun' },
    luck: { parent: 'fun' },
    imagine: { parent: 'fun' },
    deals: { parent: 'media' },
    steam: { parent: 'arcade' },
    tree: { parent: 'arcade' },
    windrose: { parent: 'arcade' },
    stats: { parent: 'server', as: 'charts' },
    sprites: { parent: 'tools' },
    ping: { parent: 'tools' },
    cc: { parent: 'tools' },
    'owo-profile': { parent: 'owo2', as: 'profile' },
    autohunt: { parent: 'owo2' },
    loyalty: { parent: 'level' },
    'soundboard-play': { parent: 'soundboard', as: 'native' },
    'report-dm': { parent: 'engage' },
    kofi: { parent: 'creator' },
    buymeacoffee: { parent: 'creator' },
    throne: { parent: 'creator' },
    showcase: { parent: 'creator' },
    'stream-analytics': { parent: 'creator', as: 'analytics' },
    // Manage Server
    announce: { parent: 'manage' },
    'member-flag': { parent: 'manage' },
    'logs-setup': { parent: 'manage' },
    ai: { parent: 'manage' },
    namefilter: { parent: 'moderation' },
    'commission-filter': { parent: 'moderation' },
    activity: { parent: 'moderation' },
    highlight: { parent: 'moderation' },
    vision: { parent: 'moderation' },
    // /lockdown dm-pause and /lockdown discord were retired for /lockdown dms|invites (H-660, migration 447).
    livecheck: { parent: 'stream' },
    subs: { parent: 'stream' },
    rumble: { parent: 'socials' },
    // Manage Messages
    'ai-reply': { parent: 'support' },
    // Administrator
    erase: { parent: 'utilities' },
    takeover: { parent: 'utilities' },
    orientation: { parent: 'systems' },
    shoutout: { parent: 'alerts' },
    // Aliases
    movie: { drop: true },
    lookup: { drop: true },
};

// Discord's per-command budget for names, descriptions and choice names/values is 8,000 (/admin is accepted at
// 7,832). A parent that takes children must stay under 7,500, because each locale is counted on its own and
// translated text runs longer than English. That is why nothing moves into /admin.
export const MAX_COMMAND_CHARS = 7500;
const MAX_OPTIONS = 25;

const mountName = child => MOUNTS[child]?.as ?? child;

/** parent → [{ child, as }] for the mounts whose parent and child are both loaded. */
function mountsByParent(names) {
    const out = new Map();
    for (const [child, m] of Object.entries(MOUNTS)) {
        if (m.drop || !names.has(child) || !names.has(m.parent)) continue;
        if (!out.has(m.parent)) out.set(m.parent, []);
        out.get(m.parent).push({ child, as: mountName(child) });
    }
    return out;
}

/** The slash path a member types for a command: "fun owoify" for owoify, "help" for help. */
export function slashPath(name) {
    const m = MOUNTS[name];
    return m && !m.drop ? `${m.parent} ${mountName(name)}` : name;
}

/**
 * True for a parent that exists only to hold moved commands (/creator, /moderation): it has no options of
 * its own, so listings show its children instead of an empty command.
 */
export function isContainer(name, json) {
    return !(json?.options?.length) && Object.values(MOUNTS).some(m => m.parent === name);
}

/** True when a command is not deployed at the top level (moved or dropped). */
export function isMounted(name) {
    return Boolean(MOUNTS[name]);
}

/** Characters Discord counts toward its 8,000 budget (English; each locale is counted on its own). */
export function commandChars(json) {
    let n = (json.name?.length ?? 0) + (json.description?.length ?? 0);
    for (const o of json.options ?? []) {
        n += commandChars(o);
        for (const c of o.choices ?? []) n += String(c.name).length + String(c.value).length;
    }
    return n;
}

/**
 * The top-level command JSON to deploy, from command modules (anything with data.toJSON()).
 * Moved commands are folded into their parent; dropped aliases are left out. Throws if a mount is impossible,
 * so a bad entry fails the deploy loudly instead of half-applying.
 *
 * Only slash-registered commands and paths are deployed (core/command-registration.js): a text-only command is
 * left out, a mixed one keeps its slash paths, and a moved command whose parent is text only goes to the top
 * level. `{ applyRegistration: false }` deploys everything (tests of the mount rules only).
 * `{ paths: Map }` is filled with chat path -> slash path for every deployed path ("owoify" -> "fun owoify").
 */
export function buildDeployJson(commands, { applyRegistration = true, paths = null } = {}) {
    const list = [...commands].map(c => (applyRegistration ? forSlashDeploy(c) : c)).filter(Boolean);
    const byName = new Map(list.map(c => [c.data.name, c]));
    const mounts = mountsByParent(new Set(byName.keys()));
    const out = [];
    const note = (chat, slash, json) => {
        if (!paths || (json.type ?? 1) !== 1) return;
        for (const rel of relPaths(json)) paths.set(rel ? `${chat} ${rel}` : chat, rel ? `${slash} ${rel}` : slash);
    };
    for (const cmd of list) {
        const name = cmd.data.name;
        if (isMounted(name) && (MOUNTS[name].drop || mounts.get(MOUNTS[name].parent)?.some(m => m.child === name))) continue;
        const json = cmd.data.toJSON();
        const extra = mounts.get(name);
        // A parent that only holds moved commands (/creator) is not deployed once none of them is left.
        if (applyRegistration && !extra && !(json.options?.length) && (json.type ?? 1) === 1
            && Object.values(MOUNTS).some(m => m.parent === name)) continue;
        if (!(extra && !(json.options?.length))) note(name, name, json);   // a pure container is no path itself
        if (extra) {
            json.options = [...(json.options ?? [])];
            for (const { child, as } of extra) {
                const c = byName.get(child).data.toJSON();
                const opts = c.options ?? [];
                if (opts.some(o => o.type === GROUP)) throw new Error(`/${child} has subcommand groups and cannot move under /${name}`);
                if ((c.default_member_permissions ?? null) !== (json.default_member_permissions ?? null)) {
                    throw new Error(`/${child} (${c.default_member_permissions ?? 'everyone'}) and /${name} (${json.default_member_permissions ?? 'everyone'}) have different permissions`);
                }
                if (json.options.some(o => o.name === as)) throw new Error(`/${name} already has "${as}"`);
                const hasSubs = opts.some(o => o.type === SUB);
                note(child, `${name} ${as}`, c);
                json.options.push({
                    type: hasSubs ? GROUP : SUB,
                    name: as,
                    description: c.description,
                    ...(c.description_localizations ? { description_localizations: c.description_localizations } : {}),
                    options: opts,
                });
            }
            if (json.options.length > MAX_OPTIONS) throw new Error(`/${name} would have ${json.options.length} options (max ${MAX_OPTIONS})`);
            const chars = commandChars(json);
            if (chars > MAX_COMMAND_CHARS) throw new Error(`/${name} would be ${chars} characters (max ${MAX_COMMAND_CHARS})`);
        }
        out.push(json);
    }
    return out;
}

/**
 * Turn an interaction for a moved command back into the child's own, in place, before dispatch.
 * Returns the child's name, or null when the interaction is not for a moved command.
 */
export function applyMount(interaction) {
    const parent = interaction.commandName;
    const options = interaction.options;
    if (!options) return null;
    const group = options.getSubcommandGroup?.(false) ?? null;
    const sub = options.getSubcommand?.(false) ?? null;
    for (const [child, m] of Object.entries(MOUNTS)) {
        if (m.drop || m.parent !== parent) continue;
        const as = mountName(child);
        if (group === as) {
            // Was a group: the child sees its own subcommand and no group.
            interaction.options = shimOptions(options, { group: null });
        } else if (!group && sub === as) {
            // Was a subcommand: the child sees no subcommand at all.
            interaction.options = shimOptions(options, { group: null, sub: null });
        } else continue;
        interaction.commandName = child;
        interaction.mountedFrom = parent;
        return child;
    }
    return null;
}

function shimOptions(base, { group, sub }) {
    const shim = Object.create(base);
    shim.getSubcommandGroup = () => group;
    if (sub === null) {
        shim.getSubcommand = (required = true) => {
            if (required) throw new TypeError('This command has no subcommand');
            return null;
        };
    }
    // _group / _subcommand back discord.js internals and code that reads them directly.
    Object.defineProperty(shim, '_group', { value: group });
    if (sub === null) Object.defineProperty(shim, '_subcommand', { value: null });
    return shim;
}
