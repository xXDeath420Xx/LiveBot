import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Collection } from 'discord.js';

/*
 * H-717: the Orientation guide (core/orientation-manager.js) named commands that do not exist (/admin tickets,
 * /reactionroles, /info...) and listed text commands as if they were slash commands. Every command it names now
 * exists in the form it is named: a `slash` hint or "pick ... from the / menu" is a registered slash path (or the
 * start of one); a "type ... as a message" command is a text command that the chat bridge resolves.
 * The check runs on the rendered embed, so a command added to the text later is checked too.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { buildIndex, deployInfo, resolve, isTextOnlyPath } = await import('../core/universal-commands.js');
const { BUILTIN_NAMES } = await import('../core/command-registration.js');
const orientation = await import('../core/orientation-manager.js');
const { PAGES: MANAGE_PAGES } = await import('../core/manage-nav.js');

async function loadModules() {
    const commands = new Collection();
    for (const folder of fs.readdirSync(path.join(root, 'commands'))) {
        const dir = path.join(root, 'commands', folder);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.js'))) {
            const c = (await import(`file://${path.join(dir, f)}`)).default;
            if (c?.data && c.execute) commands.set(c.data.name, c);
        }
    }
    return commands;
}
const commands = await loadModules();
buildIndex({ commands });
const { slashOf, registered } = deployInfo();
const slashPaths = new Set(slashOf.values());

/** A slash form exists: the exact path, or the start of registered paths (`/music`, `/schedule`). */
function slashExists(name) {
    const p = name.replace(/^\//, '');
    return slashPaths.has(p) || [...slashPaths].some(v => v.startsWith(p + ' '));
}

/** A typed (text) form exists: Discord leaves its first word alone and the bridge reaches a text path with it. */
function typedExists(name) {
    const words = name.replace(/^\//, '').split(' ');
    if (registered.has(words[0]) || BUILTIN_NAMES.has(words[0])) return false;
    const hit = resolve(words);
    if (!hit) return false;
    if (hit.entry) return hit.rest.length === 0 && isTextOnlyPath(hit.path);
    const base = hit.path || hit.needsSub;   // a bare group name answers with its full prefix (`engage birthday`)
    return (hit.subs || []).some(s => isTextOnlyPath(`${base} ${s}`));
}

test('every setup hint is a real slash command or a real dashboard page', () => {
    const titles = new Set(MANAGE_PAGES.map(p => p.title));
    const bad = [];
    for (const f of orientation.FEATURE_CHECKS) {
        if (f.hint?.slash) { if (!slashExists(f.hint.slash)) bad.push(`${f.name}: ${f.hint.slash}`); }
        else if (f.hint?.page) { if (!titles.has(f.hint.page)) bad.push(`${f.name}: page ${f.hint.page}`); }
        else bad.push(`${f.name}: no hint`);
    }
    assert.deepEqual(bad, []);
});

test('every Always Available command exists in the form it is named', () => {
    const bad = [];
    for (const item of orientation.ALWAYS_AVAILABLE) {
        for (const s of item.slash || []) if (!slashExists(s)) bad.push(`${item.title}: ${s} is not a slash command`);
        for (const t of item.typed || []) if (!typedExists(t)) bad.push(`${item.title}: ${t} is not a text command`);
    }
    assert.deepEqual(bad, []);
});

test('the rendered guide names only commands that exist, and only in their real form', async () => {
    const client = {
        guilds: { cache: new Map() },
        user: { displayName: 'CertiFried', username: 'CertiFried', displayAvatarURL: () => 'https://example.invalid/a.png' },
    };
    const all = orientation.FEATURE_CHECKS;
    const texts = [];
    for (const split of [{ enabled: [], available: all }, { enabled: all, available: [] }]) {
        const embed = (await orientation.buildOrientationEmbed(client, '1', { detect: async () => split })).toJSON();
        texts.push(embed.description, embed.footer?.text, ...(embed.fields || []).flatMap(f => [f.name, f.value]));
    }
    const named = new Map();   // "/x y" -> 'slash' | 'typed' | 'any'
    for (const raw of texts.filter(Boolean)) {
        const text = raw.replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, '');
        // One line can name both kinds: "pick `/music` from the / menu; type `/voice` as a message".
        for (const line of text.split('\n')) {
            for (const seg of line.split(';')) {
                const kind = /as a message/.test(seg) ? 'typed' : /from the \/ menu/.test(seg) ? 'slash' : 'any';
                for (const m of seg.matchAll(/`(\/[^`]+)`/g)) named.set(m[1].trim(), kind);
                for (const m of seg.replace(/`[^`]*`/g, '').matchAll(/(?:^|[\s(])(\/[a-z][a-z0-9-]*)/g)) named.set(m[1], 'any');
            }
        }
    }
    assert.ok(named.size >= 20, `found only ${named.size} commands in the guide`);
    const bad = [];
    for (const [name, kind] of named) {
        const ok = kind === 'typed' ? typedExists(name)
            : kind === 'slash' ? slashExists(name)
            : slashExists(name) || typedExists(name);
        if (!ok) bad.push(`${name} (${kind})`);
        // A bare `/x` outside "pick"/"type" wording must be a slash command: members pick it from the menu.
        if (kind === 'any' && !slashExists(name)) bad.push(`${name} is named without "type ... as a message" but is not a slash command`);
    }
    assert.deepEqual(bad, []);
});

test('the commands the old guide named that do not exist are gone', async () => {
    const src = fs.readFileSync(path.join(root, 'core/orientation-manager.js'), 'utf8');
    for (const old of ['/admin tickets', '/admin leveling', '/reactionroles', '/admin logging', '/admin moderation',
        '/admin economy', '/admin welcome', '/admin confessions', "'/info'", '`/info`', 'Setup script']) {
        assert.ok(!src.includes(old), `${old} is still in the guide`);
    }
});
