/*
 * The slash/text split (core/command-registration.js, docs/command-split-2026-11-18.md).
 *
 * Walks every real command module and checks that:
 *  - every subcommand path is reachable: registered as slash, or typed as text with "/" (and the text
 *    form resolves back to the same path through the chat bridge);
 *  - no text form starts with a registered slash name (global, per-server shortcut or guildScoped) or a
 *    Discord built-in, because Discord's client takes those over;
 *  - the default bot's global payload and a custom bot's payload stay inside Discord's limits
 *    (100 slash commands, 25 subcommands/groups/options, names, descriptions, 8,000 characters);
 *  - paths that open a popup form, or take secrets, stay slash.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Collection } from 'discord.js';
import { buildDeployJson, commandChars, MOUNTS } from '../core/command-mounts.js';
import { fitCustomBotCommands, fitSlashLimit, MAX_SLASH_COMMANDS } from '../core/custom-bot-commands.js';
import {
    relPaths, isSlashPath, slashJson, TEXT_ALIASES, TEXT_MERGE, BUILTIN_NAMES, TEXT_COMMANDS, SLASH_PATHS, TEXT_PATHS,
} from '../core/command-registration.js';
import { buildIndex, describePath, deployInfo, resolve, DEFAULT_PREFIXES } from '../core/universal-commands.js';
import { SHORTCUTS } from '../core/guild-shortcuts.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function loadModules() {
    const commands = new Collection();
    for (const folder of fs.readdirSync(path.join(ROOT, 'commands'))) {
        const dir = path.join(ROOT, 'commands', folder);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
            const mod = await import(`file://${path.join(dir, f)}`);
            const c = mod.default;
            if (c?.data && c.execute) { c.__filePath = path.join(dir, f); commands.set(c.data.name, c); }
        }
    }
    return commands;
}

const commands = await loadModules();
buildIndex({ commands });
const modules = [...commands.values()];
const { registered, slashOf } = deployInfo();
const isContainerModule = (name, json) => !(json.options?.length) && Object.values(MOUNTS).some(m => m.parent === name);

test('commands loaded', () => {
    assert.ok(commands.size > 100, `only ${commands.size} command modules loaded`);
    assert.ok(DEFAULT_PREFIXES.includes('/'), '"/" is a default prefix');
});

test('every subcommand path is reachable as slash or as text', () => {
    const unreachable = [];
    let n = 0;
    for (const c of modules) {
        const json = c.data.toJSON();
        if ((json.type ?? 1) !== 1) continue;                  // context menus: always registered (checked below)
        if (isContainerModule(json.name, json)) continue;      // /creator, /moderation: hold other commands only
        for (const rel of relPaths(json)) {
            const p = rel ? `${json.name} ${rel}` : json.name;
            n++;
            const d = describePath(p);
            const slash = isSlashPath(json.name, rel, c);
            if (slash && !slashOf.has(p)) unreachable.push(`${p}: marked slash but not in the deployed payload`);
            if (!slash && !d.text) unreachable.push(`${p}: text only but has no "/" form`);
            if (!d.slash && !d.text) unreachable.push(`${p}: no way in`);
        }
    }
    assert.ok(n > 1000, `walked only ${n} paths`);
    assert.deepEqual(unreachable, []);
});

test('every text form resolves back to its own path through the bridge', () => {
    const bad = [];
    for (const c of modules) {
        const json = c.data.toJSON();
        if ((json.type ?? 1) !== 1) continue;
        for (const rel of relPaths(json)) {
            const p = rel ? `${json.name} ${rel}` : json.name;
            const { text } = describePath(p);
            if (!text) continue;
            const hit = resolve(text.slice(1).split(' '));
            if (!hit?.entry || hit.path !== p || hit.rest.length) bad.push(`${text} -> ${hit?.path ?? 'nothing'} (want ${p})`);
        }
    }
    assert.deepEqual(bad, []);
});

test('no text form starts with a registered slash name or a Discord built-in', () => {
    // Registered somewhere: the global list, every per-server shortcut that can be built, guildScoped commands.
    for (const name of Object.keys(SHORTCUTS)) {
        const s = SHORTCUTS[name];
        if (slashOf.has(`${s.parent} ${s.sub}`) || [...slashOf.values()].some(v => v.startsWith(`${s.parent} ${s.sub}`))) {
            assert.ok(registered.has(name), `shortcut /${name} is deployable, so it must count as registered`);
        }
    }
    const bad = [];
    for (const c of modules) {
        const json = c.data.toJSON();
        if ((json.type ?? 1) !== 1) continue;
        for (const rel of relPaths(json)) {
            const p = rel ? `${json.name} ${rel}` : json.name;
            const d = describePath(p);
            if (!d.text) continue;
            const first = d.text.slice(1).split(' ')[0];
            if (registered.has(first)) bad.push(`${d.text} starts with registered /${first}`);
            if (BUILTIN_NAMES.has(first)) bad.push(`${d.text} is a Discord built-in`);
        }
    }
    assert.deepEqual(bad, []);
    for (const b of BUILTIN_NAMES) assert.ok(!registered.has(b), `/${b} is a Discord built-in and must not be registered`);
});

test('aliases and merges are all usable and never shadow a real name', () => {
    const names = new Set(modules.map(c => c.data.name));
    for (const [alias, target] of Object.entries(TEXT_ALIASES)) {
        assert.ok(!names.has(alias), `alias ${alias} is a command name`);
        assert.ok(!registered.has(alias), `alias ${alias} is a registered slash name`);
        assert.ok(!BUILTIN_NAMES.has(alias), `alias ${alias} is a Discord built-in`);
        const hit = resolve(alias.split(' '));
        const wantTop = target.split(' ')[0];
        assert.ok(hit && (hit.entry ? hit.path === target || hit.path.startsWith(target + ' ') || hit.path === target : hit.needsSub),
            `alias ${alias} does not reach ${target}`);
        assert.ok(names.has(wantTop), `alias ${alias} points at missing /${wantTop}`);
    }
    for (const [src, m] of Object.entries(TEXT_MERGE)) {
        assert.ok(names.has(src) && names.has(m.into), `merge ${src} -> ${m.into} names a missing command`);
        assert.equal(TEXT_COMMANDS.has(src) && TEXT_COMMANDS.has(m.into), true, 'only text trees are merged');
    }
    // Every exception names a real path.
    for (const [cmd, list] of [...Object.entries(SLASH_PATHS), ...Object.entries(TEXT_PATHS)]) {
        const c = commands.get(cmd);
        assert.ok(c, `exception for missing /${cmd}`);
        const rels = relPaths(c.data.toJSON());
        for (const e of list) assert.ok(rels.some(r => r === e || r.startsWith(e + ' ')), `/${cmd} has no "${e}"`);
    }
});

/** Discord's documented limits for one application command (chat input). */
function limitProblems(cmd) {
    const out = [];
    const name = /^[-_\p{L}\p{N}]{1,32}$/u;
    const check = (o, where, depth) => {
        if (!name.test(o.name) || o.name !== o.name.toLowerCase()) out.push(`${where}: bad name "${o.name}"`);
        if (!o.description || o.description.length > 100) out.push(`${where}: description length ${o.description?.length ?? 0}`);
        const opts = o.options ?? [];
        if (opts.length > 25) out.push(`${where}: ${opts.length} options (max 25)`);
        for (const x of opts) {
            if (x.choices && x.choices.length > 25) out.push(`${where} ${x.name}: ${x.choices.length} choices (max 25)`);
            if (x.type === 1 || x.type === 2) check(x, `${where} ${x.name}`, depth + 1);
            else if (!name.test(x.name) || !x.description || x.description.length > 100) out.push(`${where} ${x.name}: bad option name/description`);
        }
        if (depth > 2) out.push(`${where}: nested too deep`);
    };
    check(cmd, `/${cmd.name}`, 0);
    if (commandChars(cmd) > 8000) out.push(`/${cmd.name}: ${commandChars(cmd)} characters (max 8000)`);
    return out;
}

test('the default bot global payload is inside Discord limits', () => {
    const built = buildDeployJson(modules.filter(c => !c.guildScoped));
    const fitted = fitSlashLimit(built);
    assert.equal(fitted.overBy, 0);
    assert.deepEqual(fitted.dropped, [], 'nothing should need the overflow list any more');
    const slash = built.filter(c => (c.type ?? 1) === 1);
    assert.ok(slash.length <= MAX_SLASH_COMMANDS, `${slash.length} global slash commands`);
    assert.ok(slash.length <= 60, `${slash.length} global slash commands: the split should keep this well under the cap`);
    assert.ok(built.filter(c => c.type === 2).length <= 5 && built.filter(c => c.type === 3).length <= 5, 'at most 5 user and 5 message menus');
    assert.deepEqual(slash.flatMap(limitProblems), []);
    // Context menus stay registered.
    for (const c of modules) {
        const t = c.data.toJSON().type ?? 1;
        if (t !== 1 && !c.guildScoped) assert.ok(built.some(b => b.name === c.data.name), `context menu ${c.data.name} not deployed`);
    }
});

test('a custom bot payload is inside Discord limits', () => {
    const fitted = fitCustomBotCommands(buildDeployJson(modules));
    assert.equal(fitted.overBy, 0);
    const slash = fitted.commands.filter(c => (c.type ?? 1) === 1);
    assert.ok(slash.length <= MAX_SLASH_COMMANDS, `${slash.length} slash commands for a custom bot`);
    assert.deepEqual(slash.flatMap(limitProblems), []);
});

test('text-only commands are not deployed and mixed ones keep only their slash paths', () => {
    const built = buildDeployJson(modules);
    const names = new Set(built.map(c => c.name));
    for (const t of ['owo', 'owo2', 'cat', 'rpg', 'knowledge', 'tools', 'economy']) assert.ok(!names.has(t), `/${t} is text only`);
    for (const s of ['admin', 'help', 'music', 'level', 'digimon', 'privacy', 'setup']) assert.ok(names.has(s), `/${s} stays slash`);
    const fun = built.find(c => c.name === 'fun');
    assert.deepEqual(fun.options.map(o => o.name), ['confess']);
    assert.equal(slashJson('fun', { name: 'fun', options: [{ type: 1, name: 'joke' }] }), null);
});

// Paths that open a popup form (a chat message cannot) or take a secret as input stay slash.
const MUST_STAY_SLASH = [
    'fun confess', 'grow journal log', 'spotify link', 'spotify finish', 'sprites link', 'steam link',
    'selfcare wellness mood', 'privacy delete', 'settings language',
];
test('forms and secrets stay slash', () => {
    for (const p of MUST_STAY_SLASH) {
        const [name, ...rest] = p.split(' ');
        assert.ok(commands.has(name), `missing /${name}`);
        assert.ok(isSlashPath(name, rest.join(' '), commands.get(name)), `${p} must stay a slash command`);
    }
    // Any module whose own file opens a modal keeps at least one slash path.
    for (const c of modules) {
        const src = fs.readFileSync(c.__filePath, 'utf8');
        if (!src.includes('showModal(')) continue;
        const json = c.data.toJSON();
        assert.ok(relPaths(json).some(r => isSlashPath(json.name, r, c)), `/${json.name} opens a form but has no slash path`);
    }
});
