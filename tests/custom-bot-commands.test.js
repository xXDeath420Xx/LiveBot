import test from 'node:test';
import assert from 'node:assert/strict';
import { fitCustomBotCommands, MAX_SLASH_COMMANDS } from '../core/custom-bot-commands.js';

const slash = (...names) => names.map(name => ({ name, type: 1 }));
const filler = n => slash(...Array.from({ length: n }, (_, i) => `cmd-${i}`));
const names = out => out.commands.map(c => c.name);

test('cannabis commands stay off custom bots even under the limit', () => {
    const out = fitCustomBotCommands([...filler(5), ...slash('cannabis', 'grow', 'join')]);
    assert.deepEqual(names(out), names({ commands: filler(5) }));
    assert.deepEqual(out.dropped, []);
});

test('nothing optional is dropped at exactly the limit', () => {
    const out = fitCustomBotCommands([...filler(MAX_SLASH_COMMANDS - 2), ...slash('movie', 'lookup')]);
    assert.equal(out.commands.length, MAX_SLASH_COMMANDS);
    assert.deepEqual(out.dropped, []);
});

test('only as many as needed are dropped, aliases first', () => {
    const out = fitCustomBotCommands([...filler(MAX_SLASH_COMMANDS - 1), ...slash('windrose', 'lookup', 'movie')]);
    assert.deepEqual(out.dropped, ['movie', 'lookup']);
    assert.ok(names(out).includes('windrose'));
    assert.equal(out.overBy, 0);
});

test('context menus do not count towards the slash limit and are kept', () => {
    const menu = { name: 'Report Message', type: 3 };
    const out = fitCustomBotCommands([...filler(MAX_SLASH_COMMANDS), menu]);
    assert.equal(out.commands.length, MAX_SLASH_COMMANDS + 1);
    assert.deepEqual(out.dropped, []);
});

test('a context menu sharing an optional name is not dropped for it', () => {
    const out = fitCustomBotCommands([...filler(MAX_SLASH_COMMANDS + 1), { name: 'movie', type: 3 }]);
    assert.ok(names(out).includes('movie'));
    assert.equal(out.overBy, 1);
});

test('reports the shortfall when the overflow list runs out', () => {
    assert.equal(fitCustomBotCommands(filler(MAX_SLASH_COMMANDS + 3)).overBy, 3);
});

test('reserved slots make room for guild-only commands, aliases first', () => {
    const out = fitCustomBotCommands([...filler(MAX_SLASH_COMMANDS - 2), ...slash('movie', 'lookup', 'owoify', 'windrose')], 1);
    assert.deepEqual(out.dropped, ['movie', 'lookup', 'owoify']);
    assert.equal(out.commands.length, MAX_SLASH_COMMANDS - 1);
    assert.equal(out.overBy, 0);
});

test('with no reserve the same list keeps the next overflow command', () => {
    const out = fitCustomBotCommands([...filler(MAX_SLASH_COMMANDS - 2), ...slash('movie', 'lookup', 'owoify', 'windrose')]);
    assert.deepEqual(out.dropped, ['movie', 'lookup']);
});

test('a reserve the list cannot cover is reported as overBy', () => {
    const out = fitCustomBotCommands(filler(MAX_SLASH_COMMANDS), 1);
    assert.equal(out.overBy, 1);
});
