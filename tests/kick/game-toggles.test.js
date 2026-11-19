/**
 * Kick channel page game switches (Tokes, Daily spark, Smoke sessions, Trivia) were saved in
 * features_enabled and never read, so switching a game off did nothing. services/certifried-bot/
 * game-switches.js decides; command-handler.js must ask it before running a built-in command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_FEATURE_BY_COMMAND, isGameSwitchedOff } from '../../services/certifried-bot/game-switches.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('a game switched off silences every command of that game', () => {
    const feats = { commands: true, tokes: false, spark: true, sessions: false, trivia: false };
    for (const key of ['lit', 'sesh', 'hit', 'pass', 'doused', 'trivia', 'answer']) {
        assert.equal(isGameSwitchedOff(feats, key), true, key);
    }
    assert.equal(isGameSwitchedOff(feats, 'spark'), false, 'spark is on');
});

test('absent or true switches leave games on (the page shows them on)', () => {
    for (const feats of [null, undefined, {}, { commands: true }, { tokes: true, spark: true, sessions: true, trivia: true }]) {
        for (const key of Object.keys(GAME_FEATURE_BY_COMMAND)) {
            assert.equal(isGameSwitchedOff(feats, key), false, `${JSON.stringify(feats)} ${key}`);
        }
    }
});

test('commands outside the four games are never affected', () => {
    const allOff = { tokes: false, spark: false, sessions: false, trivia: false };
    for (const key of ['fireboard', 'embers', 'strain', 'lineage', 'elevated', 'tokes', 'so', 'cfx', 'toString', '__proto__']) {
        assert.equal(isGameSwitchedOff(allOff, key), false, key);
    }
});

test('the page offers exactly the switches the bot reads', () => {
    const page = fs.readFileSync(path.join(root, 'dashboard/views/kick/channel.ejs'), 'utf8');
    const keys = [...page.matchAll(/\{ key: '([a-z_]+)', label: '[^']+', desc: '![a-z]+/g)].map(m => m[1]).sort();
    assert.deepEqual(keys, [...new Set(Object.values(GAME_FEATURE_BY_COMMAND))].sort());
});

test('command-handler checks the switch before running a built-in command', () => {
    const src = fs.readFileSync(path.join(root, 'services/certifried-bot/command-handler.js'), 'utf8');
    assert.match(src, /import \{ isGameSwitchedOff \} from '\.\/game-switches\.js';/);
    const lookup = src.indexOf('const command = await getCommand(channel.id, commandName);');
    const check = src.indexOf('isGameSwitchedOff(channelFeats, command.key)');
    const run = src.indexOf('await command.handler(cmdContext)');
    assert.ok(lookup > 0 && check > lookup && run > check, 'switch checked after lookup and before the handler runs');
});
