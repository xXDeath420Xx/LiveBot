/*
 * core/guild-shortcuts.js registers /confess, /birthday … per server. A shortcut must reach the handler exactly as
 * the nested command does, carry the same options and permissions, and never take a real command's name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SHORTCUTS, buildShortcutJson, applyShortcut } from '../core/guild-shortcuts.js';
import { applyMount, MOUNTS } from '../core/command-mounts.js';

const engage = { name: 'engage', description: 'Engage', options: [
    { type: 2, name: 'birthday', description: 'Birthdays', description_localizations: { fr: 'Anniversaires' },
      options: [{ type: 1, name: 'set', description: 'Set', options: [{ type: 3, name: 'date', description: 'd' }] }] },
    { type: 1, name: 'other', description: 'o' },
] };
const fun = { name: 'fun', description: 'Fun', options: [
    { type: 1, name: 'confess', description: 'Submit an anonymous confession' },
    { type: 1, name: 'owoify', description: 'UwU', options: [{ type: 3, name: 'text', description: 't', required: true }] },
] };
const manage = { name: 'manage', description: 'Manage', default_member_permissions: '32', options: [
    { type: 2, name: 'giveaway', description: 'Giveaways', options: [{ type: 1, name: 'start', description: 's' }] },
] };

test('a group shortcut carries the group\'s subcommands; a plain one carries its options', () => {
    const [birthday, confess, owoify] = buildShortcutJson([engage, fun], ['birthday', 'confess', 'owoify']);
    assert.equal(birthday.name, 'birthday');
    assert.deepEqual(birthday.options.map(o => [o.type, o.name]), [[1, 'set']]);
    assert.deepEqual(birthday.description_localizations, { fr: 'Anniversaires' });
    assert.deepEqual(confess.options, []);
    assert.equal(owoify.options[0].name, 'text');
    assert.equal(birthday.default_member_permissions, null);
});

test('staff shortcuts keep the parent\'s permission', () => {
    const [giveaway] = buildShortcutJson([manage], ['giveaway']);
    assert.equal(giveaway.default_member_permissions, '32');
});

test('a name that is already a real top-level command, or whose target is missing, is skipped', () => {
    assert.deepEqual(buildShortcutJson([fun, { name: 'confess', description: 'real' }], ['confess']), []);
    assert.deepEqual(buildShortcutJson([fun], ['birthday', 'nope']), []);
});

function interaction(commandName, group, sub, extra = {}) {
    const options = {
        _group: group, _subcommand: sub,
        getSubcommandGroup: () => group,
        getSubcommand: (required = true) => { if (!sub && required) throw new TypeError('no sub'); return sub; },
        getString: k => (k === 'date' ? '03-14' : null),
    };
    return { commandName, options, commandGuildId: '1', ...extra };
}

test('/birthday set arrives as /engage birthday set', () => {
    const i = interaction('birthday', null, 'set');
    assert.equal(applyShortcut(i), 'engage');
    assert.equal(i.commandName, 'engage');
    assert.equal(i.shortcutFrom, 'birthday');
    assert.equal(i.options.getSubcommandGroup(false), 'birthday');
    assert.equal(i.options.getSubcommand(), 'set');
    assert.equal(i.options.getString('date'), '03-14', 'option lookups still work');
});

test('/confess arrives as /fun confess', () => {
    const i = interaction('confess', null, null);
    assert.equal(applyShortcut(i), 'fun');
    assert.equal(i.options.getSubcommandGroup(false), null);
    assert.equal(i.options.getSubcommand(), 'confess');
    assert.equal(i.options._subcommand, 'confess');
});

test('a shortcut to a moved command continues on to the child (/ping → /tools ping → /ping)', () => {
    const i = interaction('ping', null, null);
    applyShortcut(i);
    assert.equal(applyMount(i), 'ping');
    assert.equal(i.commandName, 'ping');
    assert.equal(i.options.getSubcommand(false), null);
    const charts = interaction('charts', null, 'export');
    applyShortcut(charts);
    assert.equal(applyMount(charts), 'stats');
    assert.equal(charts.options.getSubcommand(), 'export');
    assert.equal(charts.options.getSubcommandGroup(false), null);
});

test('global commands and unknown names are left alone', () => {
    const global = interaction('confess', null, null, { commandGuildId: null });
    assert.equal(applyShortcut(global), null);
    assert.equal(global.commandName, 'confess');
    assert.equal(applyShortcut(interaction('fun', null, 'joke')), null);
});

test('every shortcut points at a real parent and never reuses a command file\'s name', () => {
    const names = new Set();
    for (const dir of fs.readdirSync('commands')) {
        if (!fs.statSync(`commands/${dir}`).isDirectory()) continue;
        for (const f of fs.readdirSync(`commands/${dir}`).filter(f => f.endsWith('.js'))) {
            const src = fs.readFileSync(`commands/${dir}/${f}`, 'utf8');
            const m = src.slice(src.indexOf('SlashCommandBuilder()')).match(/\.setName\(\s*['"]([a-z0-9-]+)['"]/);
            if (m) names.add(m[1]);
        }
    }
    for (const [name, s] of Object.entries(SHORTCUTS)) {
        assert.ok(names.has(s.parent), `no command file for parent /${s.parent}`);
        // A command moved under a parent keeps its file; only those may share a shortcut's name.
        if (names.has(name)) assert.ok(MOUNTS[name], `/${name} is a real command name`);
        assert.ok(!['jellyfin', 'spotify'].includes(name));
    }
});
