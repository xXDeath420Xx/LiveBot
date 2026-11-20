import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/*
 * Slash command translations (2026-11-20): locales/commands/<locale>.json, loaded under commands.* by
 * utils/i18n-catalogue.js and applied by utils/command-localization.js.
 *   - Discord's size rule: one command may total 8,000 characters, counting the longest version of each
 *     field; one command over it fails the whole bulk PUT, so localizeCommand trims to LOCALIZED_BUDGET
 *   - the translation files: valid JSON, flat keys, 1-100 characters, placeholders and `code` kept
 *   - every key is a description path that is really deployed, and every deployed description is translated
 *   - the real payload (every command, all bots) fits after localization
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { discordCommandSize, fitLocalizedSize, localizeCommand, DISCORD_COMMAND_LIMIT, LOCALIZED_BUDGET } = await import('../utils/command-localization.js');
const { localizationMap } = await import('../utils/i18n-catalogue.js');
const { buildDeployJson, commandChars } = await import('../core/command-mounts.js');

const LOCALES = ['de', 'es-ES', 'fr', 'ja', 'pt-BR'];
const DISCORD_LOCALES = ['de', 'es-ES', 'es-419', 'fr', 'ja', 'pt-BR'];
const files = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(root, 'locales/commands', `${l}.json`), 'utf8'))]));

test('size: the longest version of each field counts, choices included', () => {
    const cmd = {
        name: 'demo', description: 'Short',
        description_localizations: { de: 'Ein viel längerer Text' },
        options: [{ name: 'opt', description: 'abc', description_localizations: { fr: 'a' }, choices: [{ name: 'One', value: 'one' }, { name: 'Two', value: 2 }] }],
    };
    // demo 4 + 22 (de) + opt 3 + abc 3 + One 3 + one 3 + Two 3 + 2 1
    assert.equal(discordCommandSize(cmd), 4 + 22 + 3 + 3 + 3 + 3 + 3 + 1);
    assert.equal(discordCommandSize({ name: 'x', description: 'y' }), commandChars({ name: 'x', description: 'y' }), 'without translations it matches the deploy check');
});

test('size: over the budget, the localizations that add the most are dropped first', () => {
    const big = (n) => 'x'.repeat(n);
    const cmd = { name: 'big', description: big(90), options: [] };
    for (let i = 0; i < 90; i++) {
        cmd.options.push({ name: `o${i}`, description: big(80), description_localizations: { de: big(i === 0 ? 100 : 85), fr: big(82) } });
    }
    const before = discordCommandSize(cmd);
    assert.ok(before > 7900);
    const dropped = fitLocalizedSize(cmd, 7900);
    assert.ok(dropped > 0);
    assert.ok(discordCommandSize(cmd) <= 7900);
    assert.equal(cmd.options[0].description_localizations?.de, undefined, 'the biggest one went first');
    assert.equal(fitLocalizedSize(cmd, 7900), 0, 'nothing more to do once it fits');
    assert.ok(LOCALIZED_BUDGET < DISCORD_COMMAND_LIMIT);
});

test('translation files: flat keys, valid lengths, placeholders and code kept', () => {
    const en = files.de;   // every file has the same keys
    for (const l of LOCALES) {
        const keys = Object.keys(files[l]).filter((k) => !k.startsWith('_'));
        assert.deepEqual(keys.sort(), Object.keys(en).filter((k) => !k.startsWith('_')).sort(), `${l}: same keys as de`);
        for (const k of keys) {
            const v = files[l][k];
            assert.ok(/^[\w-]+(\.[\w-]+)*\.description$/.test(k), `${l}: key ${k}`);
            assert.ok(typeof v === 'string' && v.length >= 1 && v.length <= 100, `${l} ${k}: 1-100 characters`);
            assert.equal(v, v.trim(), `${l} ${k}: no outer spaces`);
            assert.ok(!/[\r\n]/.test(v), `${l} ${k}: one line`);
        }
    }
    assert.equal(localizationMap('commands.help.description', { discordLocales: DISCORD_LOCALES })['es-419'], files['es-ES']['help.description'], 'es-419 is served from es-ES');
});

// The real payload: every command module, as runCommandDeploy builds it.
const modules = [];
for (const dir of fs.readdirSync(path.join(root, 'commands'))) {
    const d = path.join(root, 'commands', dir);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.js'))) {
        const m = await import(pathToFileURL(path.join(d, f)).href);
        if (m.default?.data?.toJSON) modules.push(m.default);
    }
}

test('every deployed description is translated, and every translation is for a deployed description', () => {
    const payload = buildDeployJson(modules);
    const paths = new Map();
    (function walkAll() {
        for (const json of payload) {
            (function walk(node, key) {
                if (node.description) paths.set(`${key}.description`, node.description);
                for (const o of node.options || []) walk(o, `${key}.${o.name}`);
            })(json, json.name);
        }
    })();
    assert.ok(paths.size > 1500, `read ${paths.size} description paths`);
    for (const l of LOCALES) {
        const missing = [...paths.keys()].filter((k) => !files[l][k]);
        assert.deepEqual(missing, [], `${l}: untranslated (node scripts/check-command-localizations.mjs --missing)`);
        const stale = Object.keys(files[l]).filter((k) => !k.startsWith('_') && !paths.has(k));
        assert.deepEqual(stale, [], `${l}: translations for paths that are not deployed`);
    }
    // Placeholders and `code` in the English must survive translation.
    for (const [k, en] of paths) {
        const marks = [...en.matchAll(/\{[\w.]+\}|`[^`]+`/g)].map((m) => m[0]);
        for (const l of LOCALES) for (const m of marks) assert.ok(files[l][k].includes(m), `${l} ${k}: keeps ${m}`);
    }
});

test('the localized payload fits Discord: every command at or under the limit', () => {
    const payload = buildDeployJson(modules);
    const over = [];
    let localized = 0;
    for (const json of payload) {
        const stats = { names: 0, descriptions: 0 };
        localizeCommand(json, stats);
        localized += stats.descriptions;
        const size = discordCommandSize(json);
        if (size > DISCORD_COMMAND_LIMIT) over.push(`/${json.name} ${size}`);
        assert.equal(json.name_localizations, undefined, `/${json.name}: names stay English`);
    }
    assert.deepEqual(over, []);
    assert.ok(localized > 10000, `${localized} description localizations applied`);
});

// The command modules open the database pool and a few listeners that keep the process alive; end this file once
// its tests are done (process.exit() keeps the exit code the test runner set).
test.after(() => setTimeout(() => process.exit(), 50));
