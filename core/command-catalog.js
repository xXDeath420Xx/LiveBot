/*
 * Command catalog — the single source of truth behind the public /commands page.
 *
 * Everything here is derived, never hand-maintained, so the page cannot drift from the bot.
 * Four questions it answers for every command path:
 *
 *   1. How do I run it?      Every prefix, plus the @mention form.
 *   2. What are its aliases? Two independent systems, see below.
 *   3. Can I alias it?       Yes if chat can reach it. Aliases are added in the dashboard's Command
 *                            Center, which accepts a registry name or any bridge path
 *                            (dashboard/routes/api/features/prefix-commands.js POST /aliases).
 *   4. Why is it slash-only? A modal cannot be opened from a chat message. A file option is not a
 *                            reason: typed in chat, the files attached to the message fill the
 *                            file options in order (core/universal-commands.js parseOptions).
 *
 * On the two alias systems:
 *   • `prefix-command-registry.js` — a curated registry with hand-written `aliases: []`. This is
 *     is one of the two things the Command Center accepts as an alias target.
 *   • `universal-commands.js` — the bridge that exposes *every* slash command to chat. It adds
 *     `CURATED` shortcuts (`p` → `music play`) and auto-derives unambiguous bare-subcommand
 *     shortcuts. These are built in and cannot be changed per-server.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionsBitField } from 'discord.js';
import { DEFAULT_PREFIXES, listCommandPaths, getGroups, _internals, describePath, SLASH_TEXT_PREFIX } from './universal-commands.js';
import { commandType } from './command-registration.js';
import { getAllCommands } from './prefix-command-registry.js';
import { _internals as owoInternals } from './owo-natural-prefix.js';
import logger from '../utils/logger.js';
import { MOUNTS, slashPath, isContainer } from './command-mounts.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUB = 1, GROUP = 2, ATTACHMENT = 11;

/**
 * Commands with a natural chat prefix that needs no space and no `!`, handled outside the slash
 * bridge entirely. `owoh` is the canonical example: people type it as one word, so `messageCreate`
 * parses "whatever follows `owo`". These forms exist only in chat and have no slash equivalent
 * spelling, which is exactly why a catalog derived from slash commands would never show them.
 */
function naturalPrefixFor(name) {
    if (name !== 'owo') return null;
    const aliases = owoInternals?.ALIASES;
    const prefix = owoInternals?.PREFIX ?? 'owo';
    if (!aliases) return null;

    // Group every alias by the subcommand it runs: hunt <- hunt, h, catch.
    const bySub = new Map();
    for (const [alias, sub] of aliases.entries()) {
        if (!bySub.has(sub)) bySub.set(sub, []);
        bySub.get(sub).push(alias);
    }
    return {
        prefix,
        note: `Type it as one word, no symbol prefix and no space — \`${prefix}h\` is the same as \`${prefix} hunt\`. ` +
              `Bare \`${prefix}\` or \`uwu\` silently earns a point.`,
        forms: [...bySub.entries()]
            .map(([sub, list]) => ({ sub, forms: [...new Set(list)].sort((a, b) => a.length - b.length || a.localeCompare(b)) }))
            .sort((a, b) => a.sub.localeCompare(b.sub)),
    };
}

const OPTION_TYPES = {
    1: 'subcommand', 2: 'group', 3: 'text', 4: 'integer', 5: 'true/false',
    6: 'user', 7: 'channel', 8: 'role', 9: 'user or role', 10: 'number', 11: 'attachment',
};

/**
 * A message cannot open a modal. If any code path of a command calls `showModal`, at least one
 * of its subcommands is slash-only — so we scan the command file and the handlers it pulls in
 * from the same directory. Static, one level deep, cached for the process lifetime.
 */
const modalCache = new Map();
function opensModal(commandFilePath) {
    if (!commandFilePath) return false;
    if (modalCache.has(commandFilePath)) return modalCache.get(commandFilePath);

    let found = false;
    try {
        const src = readFileSync(commandFilePath, 'utf8');
        found = /\.showModal\s*\(/.test(src);

        if (!found) {
            // Follow relative imports one level: routers keep `showModal` in `*-handler.js`.
            const dir = dirname(commandFilePath);
            for (const m of src.matchAll(/from\s+['"](\.[^'"]+\.js)['"]/g)) {
                const dep = resolvePath(dir, m[1]);
                if (!existsSync(dep)) continue;
                if (/\.showModal\s*\(/.test(readFileSync(dep, 'utf8'))) { found = true; break; }
            }
        }
    } catch (err) {
        logger.warn(`[Catalog] could not scan ${commandFilePath}: ${err.message}`);
    }
    modalCache.set(commandFilePath, found);
    return found;
}

/** `default_member_permissions` is a decimal bitfield string, or null (everyone), or '0' (admins only). */
export function decodePermissions(dmp) {
    if (dmp == null) return { gated: false, adminOnly: false, permissions: [] };
    let bits;
    try { bits = BigInt(dmp); } catch { return { gated: false, adminOnly: false, permissions: [] }; }
    if (bits === 0n) return { gated: true, adminOnly: true, permissions: [] };
    return { gated: true, adminOnly: false, permissions: new PermissionsBitField(bits).toArray() };
}

const humanPerm = (p) => p.replace(/([a-z])([A-Z])/g, '$1 $2');

/** Flatten a command's option tree into runnable paths. */
function pathsFor(json) {
    const out = [];
    const leaf = (path, opts, description) => out.push({ path, description, options: opts ?? [] });

    const subs = (json.options ?? []).filter(o => o.type === SUB);
    const groups = (json.options ?? []).filter(o => o.type === GROUP);

    if (!subs.length && !groups.length) {
        leaf(json.name, json.options ?? [], json.description);
        return out;
    }
    for (const s of subs) leaf(`${json.name} ${s.name}`, s.options ?? [], s.description);
    for (const g of groups) {
        for (const s of (g.options ?? []).filter(o => o.type === SUB)) {
            leaf(`${json.name} ${g.name} ${s.name}`, s.options ?? [], s.description);
        }
    }
    return out;
}

/**
 * Build the whole catalog from a live client's command collection.
 * @returns {{prefixes, mentionForm, commands, stats}}
 */
export function buildCatalog(client) {
    if (!client?.commands?.size) return { prefixes: DEFAULT_PREFIXES, commands: [], stats: {}, mentionForm: null };

    // Bridge shortcuts: bare-subcommand names the universal index resolves unambiguously.
    const bridgePaths = new Map(listCommandPaths().map(p => [p.path, p]));
    const curated = _internals.CURATED;
    // Group shortcuts: `birthday list` reaches `/engage birthday list`. Without these the page
    // would claim a whole subsystem is only reachable as `!engage birthday list`, which nobody types.
    const groupPrefix = getGroups(); // group name -> "engage birthday"
    const groupFormFor = (path) => {
        for (const [name, prefix] of groupPrefix) {
            if (path === prefix || path.startsWith(prefix + ' ')) return name + path.slice(prefix.length);
        }
        return null;
    };

    // Legacy registry: its names (and their built-in aliases) are alias targets too.
    const registry = new Map(getAllCommands().map(c => [c.name, c]));

    const commands = [];

    for (const cmd of client.commands.values()) {
        const json = typeof cmd.data?.toJSON === 'function' ? cmd.data.toJSON() : null;
        if (!json) continue;
        // /creator and /moderation only hold moved commands; their children have their own cards.
        if (isContainer(json.name, json)) continue;

        const perms = decodePermissions(json.default_member_permissions);
        const modal = opensModal(cmd.__filePath ?? null);
        const reg = registry.get(json.name);

        const paths = pathsFor(json).map(p => {
            const bridged = bridgePaths.has(p.path);

            // Built-in shortcuts pointing at this exact path.
            const groupForm = groupFormFor(p.path);
            const shortcuts = [
                ...Object.entries(curated).filter(([, target]) => target === p.path).map(([a]) => a),
                ...(bridgePaths.get(p.path)?.shortcuts ?? []),
                ...(groupForm ? [groupForm] : []),
            ];

            const slashOnlyReasons = [];
            if (!bridged) slashOnlyReasons.push('not reachable from chat');

            const slashOnly = slashOnlyReasons.length > 0;
            // Slash/text split (core/command-registration.js): `slash` is null for a text command, and
            // `text` is the "/" form typed as a message (null when that first word is a registered command).
            const form = (() => { try { return describePath(p.path); } catch { return null; } })();

            return {
                path: p.path,
                // The slash form differs from the chat path for moved commands (`/fun owoify`, chat `!owoify`)
                // and does not exist for dropped aliases (core/command-mounts.js) or text commands.
                slash: (json.type ?? 1) !== 1 ? json.name : form ? (form.slash ? form.slash.slice(1) : null)
                    : (MOUNTS[json.name]?.drop ? null : slashPath(json.name) + p.path.slice(json.name.length)),
                text: form?.text ?? null,
                type: form?.type ?? 'slash',
                description: p.description,
                options: p.options
                    .filter(o => o.type !== SUB && o.type !== GROUP)
                    .map(o => ({
                        name: o.name, type: OPTION_TYPES[o.type] ?? String(o.type),
                        required: !!o.required,
                        choices: (o.choices ?? []).map(c => c.name),
                        min: o.min_value ?? null, max: o.max_value ?? null,
                    })),
                shortcuts: [...new Set(shortcuts)].sort(),
                slashOnly,
                slashOnlyReasons,

                // The Command Center accepts any target the chat bridge can resolve — a bare name or a
                // full slash path. A path chat cannot reach cannot usefully be aliased either.
                aliasable: !slashOnly,
            };
        });

        const type = (json.type ?? 1) !== 1 ? 'slash' : commandType(json.name, cmd, json);
        const firstSlash = paths.find(p => p.slash);
        const textFirsts = [...new Set(paths.map(p => p.text && p.text.split(' ')[0]).filter(Boolean))];
        commands.push({
            name: json.name,
            // What a member types in Discord (`fun owoify` for owoify); null for a dropped alias or a text
            // command (`text` is then what to type as a message, "/owo").
            slash: type === 'text' || MOUNTS[json.name]?.drop ? null
                : (firstSlash ? firstSlash.slash.split(' ').slice(0, firstSlash.slash.split(' ').length - (firstSlash.path.split(' ').length - 1)).join(' ') : slashPath(json.name)),
            text: type === 'text' && textFirsts.length === 1 ? textFirsts[0] : null,
            type,
            menu: (json.type ?? 1) !== 1,
            // Deployed only to the servers that use it (cannabis, /ban, /modreason, /weekly-recap).
            serverOnly: Boolean(cmd.guildScoped),
            description: json.description,
            category: cmd.category ?? 'General',
            paths,

            // Permissions. Chat and slash are equally gated: the bridge re-checks
            // `default_member_permissions` in code, because Discord only enforces it for `/`.
            gated: perms.gated,
            adminOnly: perms.adminOnly,
            permissions: perms.permissions.map(humanPerm),

            // At least one subcommand opens a modal, so that subcommand is `/` only.
            opensModal: modal,

            // Aliasing. Custom aliases are per-server, added in the Command Center.
            aliasable: paths.some(p => p.aliasable),
            builtinAliases: reg?.aliases?.length ? [...reg.aliases].sort() : [],

            // Chat-only forms handled outside the slash bridge (`owoh`).
            naturalPrefix: naturalPrefixFor(json.name),
        });
    }

    commands.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

    const allPaths = commands.flatMap(c => c.paths);
    return {
        // "/" is listed on its own: it is the text-command prefix, shown as /command already.
        prefixes: DEFAULT_PREFIXES.filter(p => p !== SLASH_TEXT_PREFIX),
        mentionForm: client.user ? `@${client.user.username}` : '@bot',
        commands,
        stats: {
            commands: commands.length,
            textCommands: commands.filter(c => c.type === 'text').length,
            textPaths: allPaths.filter(p => !p.slash && p.text).length,
            // Top-level slash commands as Discord lists them in every server (moved ones count under their
            // parent), and the extra ones only some servers get.
            topLevel: new Set(commands.filter(c => !c.menu && !c.serverOnly).map(c => c.slash?.split(' ')[0]).filter(Boolean)).size,
            serverOnly: commands.filter(c => !c.menu && c.serverOnly && c.slash).length,
            paths: allPaths.length,
            slashOnly: allPaths.filter(p => p.slashOnly).length,
            gated: commands.filter(c => c.gated).length,
            aliasable: commands.filter(c => c.aliasable).length,
            modal: commands.filter(c => c.opensModal).length,
        },
    };
}

/** Cached per command-collection identity: custom bots share one collection. */
let cache = null;
let cachedFor = null;
export function getCatalog(client) {
    if (cache && cachedFor === client?.commands) return cache;
    cache = buildCatalog(client);
    cachedFor = client?.commands ?? null;
    return cache;
}
export function invalidateCatalog() { cache = null; cachedFor = null; }
