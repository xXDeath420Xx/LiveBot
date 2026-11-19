import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * H-713: /modreason aliases expand in every moderation command that takes a reason, not only /ban.
 * The shared reason path is core/moderation-aliases.js reasonOption; commands/admin/admin-mod-handler.js
 * (/admin mod warn, mute, kick, ban, unban, unmute, clearinfractions, slowmode, lock, temprole, and the
 * !warn / !kick prefix commands that call the same handlers) reads every reason through it.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const { expandReason, reasonOption } = await import('../core/moderation-aliases.js');

const ALIASES = { G1: { gh: 'guideline hopper (repeat offender)' } };
const db = {
    calls: [],
    async execute(sql, params) {
        this.calls.push(sql);
        if (/^SELECT full_reason/.test(sql.trim())) {
            const full = ALIASES[params[0]]?.[params[1]];
            return [full ? [{ full_reason: full }] : []];
        }
        return [{ affectedRows: 1 }];   // the uses counter
    },
};
const fakeInteraction = (guildId, reason) => ({ guildId, options: { getString: (n) => (n === 'reason' ? reason : null) } });

test('expandReason: a whole-input alias expands; anything else comes back unchanged', async () => {
    assert.equal(await expandReason('G1', 'gh', { db }), 'guideline hopper (repeat offender)');
    assert.equal(await expandReason('G1', 'GH', { db }), 'guideline hopper (repeat offender)');
    assert.equal(await expandReason('G1', 'ugh they did it again', { db }), 'ugh they did it again');
    assert.equal(await expandReason('G2', 'gh', { db }), 'gh');
    assert.equal(await expandReason('G1', null, { db }), null);
    assert.equal(await expandReason('G1', '', { db }), '');
    const broken = { execute: async () => { throw new Error('down'); } };
    assert.equal(await expandReason('G1', 'gh', { db: broken }), 'gh');
});

test('reasonOption reads the reason option and expands it', async () => {
    assert.equal(await reasonOption(fakeInteraction('G1', 'gh'), { db }), 'guideline hopper (repeat offender)');
    assert.equal(await reasonOption(fakeInteraction('G1', 'spam'), { db }), 'spam');
    assert.equal(await reasonOption(fakeInteraction('G1', null), { db }), null);
    assert.equal(await reasonOption({ guild: { id: 'G1' }, options: { getString: () => 'gh' } }, { db }), 'guideline hopper (repeat offender)');
});

test('every /admin mod handler reads its reason through the shared path', () => {
    // assert.ok rather than assert.match: a failure message holding the whole file stalls the test reporter.
    const src = read('commands/admin/admin-mod-handler.js');
    assert.ok(/import \{ reasonOption, expandReason \} from '\.\.\/\.\.\/core\/moderation-aliases\.js';/.test(src), 'imports the shared reason path');
    assert.equal((src.match(/options\.getString\('reason'\)/g) || []).length, 0, 'a raw reason read is left');
    for (const fn of ['handleBan', 'handleUnban', 'handleKick', 'handleMute', 'handleUnmute', 'handleWarn',
        'handleClearInfractions', 'handleSlowmode', 'handleLock', 'handleTempRole']) {
        const at = src.indexOf(`export async function ${fn}(`);
        assert.ok(at >= 0, `${fn} exists`);
        const body = src.slice(at).split(/\nexport async function /)[0];
        assert.ok(/await reasonOption\(interaction\)/.test(body), `${fn} reads its reason through reasonOption`);
    }
    // !mute @member gh: the word taken as a length becomes the reason, and that reason is expanded too.
    assert.ok(/if \(durationStr\) reason = await expandReason\(/.test(src), 'the mute reason built from the first word is expanded');
    // /ban keeps its own expansion.
    assert.ok(/expandModReason\(interaction\.guildId, reason\)/.test(read('commands/admin/ban.js')), '/ban still expands');
});
