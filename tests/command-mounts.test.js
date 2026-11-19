/*
 * core/command-mounts.js keeps the top-level slash list far under Discord's 100 cap by deploying commands
 * inside others. Two things must hold: the deployed JSON is valid for Discord, and a mounted interaction
 * reaches the child exactly as if it had been sent to the child directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MOUNTS, buildDeployJson as buildWithRegistration, applyMount, slashPath, commandChars, MAX_COMMAND_CHARS } from '../core/command-mounts.js';

// These tests are about the mount rules alone. The slash/text split (core/command-registration.js) would
// drop the text-only commands used as fixtures here; tests/command-split.test.js covers it.
const buildDeployJson = (commands) => buildWithRegistration(commands, { applyRegistration: false });

const mod = json => ({ data: { name: json.name, toJSON: () => structuredClone(json) } });
const fun = { name: 'fun', description: 'Fun', options: [{ type: 1, name: 'joke', description: 'Joke', options: [] }] };
const owoify = { name: 'owoify', description: 'UwU', options: [{ type: 3, name: 'text', description: 'Text', required: true }] };
const luck = { name: 'luck', description: 'Luck' };
const movie = { name: 'movie', description: 'Alias', options: [{ type: 1, name: 'play', description: 'Play' }] };

test('moved commands fold into their parent, aliases drop, others pass through', () => {
    const out = buildDeployJson([mod(fun), mod(owoify), mod(luck), mod(movie), mod({ name: 'ping-x', description: 'p' })]);
    assert.deepEqual(out.map(c => c.name).sort(), ['fun', 'ping-x']);
    const f = out.find(c => c.name === 'fun');
    assert.deepEqual(f.options.map(o => [o.type, o.name]), [[1, 'joke'], [1, 'owoify'], [1, 'luck']]);
    assert.equal(f.options[1].options[0].name, 'text', 'the child keeps its options');
});

test('a child with subcommands becomes a group', () => {
    const tools = { name: 'tools', description: 't', options: [] };
    const sprites = { name: 'sprites', description: 's', options: [{ type: 1, name: 'link', description: 'l' }] };
    const [t] = buildDeployJson([mod(tools), mod(sprites)]);
    assert.equal(t.options[0].type, 2);
    assert.equal(t.options[0].options[0].name, 'link');
});

test('impossible mounts fail loudly', () => {
    const manage = { name: 'manage', description: 'a', default_member_permissions: '32', options: [] };
    assert.throws(() => buildDeployJson([mod(manage), mod({ name: 'ai', description: 'x', options: [] })]), /different permissions/);
    assert.throws(() => buildDeployJson([mod(fun), mod({ name: 'imagine', description: 'x', options: [{ type: 2, name: 'g', description: 'g', options: [] }] })]), /groups/);
});

test('a missing parent leaves the child at the top level', () => {
    assert.deepEqual(buildDeployJson([mod(owoify)]).map(c => c.name), ['owoify']);
});

function interaction(commandName, group, sub, extra = {}) {
    const options = {
        _group: group, _subcommand: sub,
        getSubcommandGroup: () => group,
        getSubcommand: () => sub,
        getString: k => (k === 'text' ? 'hello' : null),
    };
    return { commandName, options, ...extra };
}

test('a mounted subcommand reaches the child as the child, with no subcommand', () => {
    const i = interaction('fun', null, 'owoify');
    assert.equal(applyMount(i), 'owoify');
    assert.equal(i.commandName, 'owoify');
    assert.equal(i.mountedFrom, 'fun');
    assert.equal(i.options.getSubcommand(false), null);
    assert.throws(() => i.options.getSubcommand());
    assert.equal(i.options.getSubcommandGroup(false), null);
    assert.equal(i.options.getString('text'), 'hello', 'option lookups still work');
});

test('a mounted group reaches the child with its own subcommand and no group', () => {
    const i = interaction('moderation', 'namefilter', 'add');
    assert.equal(applyMount(i), 'namefilter');
    assert.equal(i.options.getSubcommand(), 'add');
    assert.equal(i.options.getSubcommandGroup(false), null);
    const renamed = interaction('server', 'charts', 'export');
    assert.equal(applyMount(renamed), 'stats');
});

test('the parent\'s own subcommands are left alone', () => {
    const i = interaction('fun', null, 'joke');
    assert.equal(applyMount(i), null);
    assert.equal(i.commandName, 'fun');
    assert.equal(applyMount(interaction('admin', 'backup', 'create')), null);
});

test('every mount names a real command file and slash paths read right', () => {
    const names = new Set();
    for (const dir of fs.readdirSync('commands')) {
        if (!fs.statSync(`commands/${dir}`).isDirectory()) continue;
        for (const f of fs.readdirSync(`commands/${dir}`).filter(f => f.endsWith('.js'))) {
            // Top-level names only: the builder's first .setName( is the command itself.
            const src = fs.readFileSync(`commands/${dir}/${f}`, 'utf8');
            const m = src.slice(src.indexOf('SlashCommandBuilder()')).match(/\.setName\(\s*['"]([a-z0-9-]+)['"]/);
            if (m) names.add(m[1]);
        }
    }
    for (const [child, m] of Object.entries(MOUNTS)) {
        assert.ok(names.has(child), `no command file for /${child}`);
        if (!m.drop) assert.ok(names.has(m.parent), `no command file for parent /${m.parent}`);
    }
    assert.equal(slashPath('owoify'), 'fun owoify');
    assert.equal(slashPath('stats'), 'server charts');
    assert.equal(slashPath('help'), 'help');
});

test('character budget counts names, descriptions and choices', () => {
    assert.equal(commandChars({ name: 'ab', description: 'cd', options: [{ name: 'e', description: 'f', choices: [{ name: 'g', value: 'h' }] }] }), 8);
    assert.ok(MAX_COMMAND_CHARS <= 8000);
});
