import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Collection } from 'discord.js';

/*
 * Since the 2026-11-18 command split, /owo2 (and autohunt under it) is typed as /owo ... (core/command-registration.js
 * TEXT_MERGE). Messages members see still said /owo2 .... They now say /owo ..., and each of those forms resolves.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['commands/fun/autohunt.js', 'commands/fun/owo2.js', 'core/owo/autohunt-service.js', 'core/owo/profile-view.js', 'handlers/owo-social.js', 'handlers/owo-prefix.js', 'commands/fun/owo.js'];

/** Lines of code that are not comments. */
function codeLines(src) {
    let inBlock = false;
    return src.split('\n').filter((line) => {
        const t = line.trim();
        if (inBlock) { if (t.includes('*/')) inBlock = false; return false; }
        if (t.startsWith('/*')) { inBlock = !t.includes('*/'); return false; }
        return !t.startsWith('//') && !t.startsWith('*');
    });
}

test('no message members see tells them to type /owo2', () => {
    for (const f of FILES) {
        const hits = codeLines(fs.readFileSync(path.join(root, f), 'utf8')).filter((l) => /\/owo2[\s`'"]/.test(l));
        assert.deepEqual(hits, [], f);
    }
});

test('every /owo ... form those messages give resolves', async () => {
    const { buildIndex, resolve } = await import('../core/universal-commands.js');
    const commands = new Collection();
    const dir = path.join(root, 'commands/fun');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
        const c = (await import(`file://${path.join(dir, f)}`)).default;
        if (c?.data && c.execute) commands.set(c.data.name, c);
    }
    buildIndex({ commands });
    const want = {
        'owo autohunt claim': 'autohunt claim', 'owo autohunt enable': 'autohunt enable',
        'owo ranch-claim': 'owo2 ranch-claim', 'owo dismantle': 'owo2 dismantle',
        'owo wallpaper shop': 'owo2 wallpaper shop', 'owo wallpaper equip': 'owo2 wallpaper equip',
        'owo marry accept': 'owo2 marry accept', 'owo marry decline': 'owo2 marry decline',
    };
    for (const [typed, pathName] of Object.entries(want)) assert.equal(resolve(typed.split(' '))?.path, pathName, typed);
});
