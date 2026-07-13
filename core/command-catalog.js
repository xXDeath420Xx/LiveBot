/*
 * Command catalog — the single source of truth behind the public /commands page.
 *
 * Everything here is derived, never hand-maintained, so the page cannot drift from the bot.
 * Four questions it answers for every command path:
 *
 *   1. How do I run it?      Every prefix, plus the @mention form.
 *   2. What are its aliases? Two independent systems, see below.
 *   3. Can I alias it?       Only if the legacy registry knows it — `/alias add` validates
 *                            against `prefix-command-registry`, not the universal bridge.
 *   4. Why is it slash-only? A modal cannot be opened from a chat message, and an attachment
 *                            cannot be passed as text. Those paths are `/` only, permanently.
 *
 * On the two alias systems:
 *   • `prefix-command-registry.js` — a curated registry with hand-written `aliases: []`. This is
 *     what `/alias add` checks against, so it alone decides what is user-aliasable.
 *   • `universal-commands.js` — the bridge that exposes *every* slash command to chat. It adds
 *     `CURATED` shortcuts (`p` → `music play`) and auto-derives unambiguous bare-subcommand
 *     shortcuts. These are built in and cannot be changed per-server.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionsBitField } from 'discord.js';
import { DEFAULT_PREFIXES, listCommandPaths, getGroups, _internals } from './universal-commands.js';
import { getAllCommands } from './prefix-command-registry.js';
import { _internals as owoInternals } from './owo-natural-prefix.js';
import logger from '../utils/logger.js';

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

    // Legacy registry — the only thing `/alias add` will accept as a target.
    const registry = new Map(getAllCommands().map(c => [c.name, c]));

    const commands = [];

    for (const cmd of client.commands.values()) {
        const json = typeof cmd.data?.toJSON === 'function' ? cmd.data.toJSON() : null;
        if (!json) continue;

        const perms = decodePermissions(json.default_member_permissions);
        const modal = opensModal(cmd.__filePath ?? null);
        const reg = registry.get(json.name);

        const paths = pathsFor(json).map(p => {
            const attachment = p.options.filter(o => o.type === ATTACHMENT).map(o => o.name);
            const bridged = bridgePaths.has(p.path);

            // Built-in shortcuts pointing at this exact path.
            const groupForm = groupFormFor(p.path);
            const shortcuts = [
                ...Object.entries(curated).filter(([, target]) => target === p.path).map(([a]) => a),
                ...(bridgePaths.get(p.path)?.shortcuts ?? []),
                ...(groupForm ? [groupForm] : []),
            ];

            const slashOnlyReasons = [];
            if (attachment.length) slashOnlyReasons.push(`takes a file (${attachment.join(', ')}) — a chat message cannot attach one to a command`);
            if (!bridged) slashOnlyReasons.push('not reachable from chat');

            const slashOnly = slashOnlyReasons.length > 0;

            return {
                path: p.path,
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

                // `/alias add` accepts any target the chat bridge can resolve — a bare name or a
                // full slash path. A path chat cannot reach cannot usefully be aliased either.
                aliasable: !slashOnly,
            };
        });

        commands.push({
            name: json.name,
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

            // Aliasing. Custom aliases are per-server (`/alias add`, or the Command Center).
            aliasable: paths.some(p => p.aliasable),
            builtinAliases: reg?.aliases?.length ? [...reg.aliases].sort() : [],

            // Chat-only forms handled outside the slash bridge (`owoh`).
            naturalPrefix: naturalPrefixFor(json.name),
        });
    }

    commands.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

    const allPaths = commands.flatMap(c => c.paths);
    return {
        prefixes: DEFAULT_PREFIXES,
        mentionForm: client.user ? `@${client.user.username}` : '@bot',
        commands,
        stats: {
            commands: commands.length,
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
