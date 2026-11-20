import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Log colours are per ACTION (core/log-actions.js). What has to stay true:
 *   - every action key is unique; a category with several actions uses `<category>.<action>` keys
 *   - every category on the Logging page shows pickers or says why it has none
 *   - every log call in a multi-action category names its action, and every action named in code exists
 *     (a typo would silently lose the server's colour) — and every registered action is used somewhere
 *   - saving stores only colours that differ from the default; defaults follow the server theme slot
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lat-'));
process.env.LOG_DIR ||= tmp;
const la = await import('../core/log-actions.js');
const { THEME_SLOTS } = await import('../core/guild-theme.js');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ROOT = path.join(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Top-level arguments of every `name(` call in src (handles nested brackets, strings, template literals). */
function callArgs(src, name) {
    const out = [];
    const re = new RegExp(`\\b${name}\\(`, 'g');
    for (const m of src.matchAll(re)) {
        if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue; // the declaration
        let depth = 0, quote = null, arg = '', args = [];
        for (let i = m.index + m[0].length - 1; i < src.length; i++) {
            const ch = src[i];
            if (quote) {
                arg += ch;
                if (ch === '\\') { arg += src[++i]; continue; }
                if (ch === quote) quote = null;
                continue;
            }
            if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; arg += ch; continue; }
            if ('([{'.includes(ch)) { depth++; if (depth === 1) continue; }
            if (')]}'.includes(ch)) { depth--; if (depth === 0) { args.push(arg.trim()); break; } }
            if (ch === ',' && depth === 1) { args.push(arg.trim()); arg = ''; continue; }
            arg += ch;
        }
        out.push(Object.assign(args, { index: m.index }));
    }
    return out;
}

// One left-to-right pass, so a "/*" inside a // comment (e.g. "/game/*") is part of that line comment and
// cannot open a block that swallows the code after it (H-679).
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, (m, pre) => pre ?? '');

/**
 * log-manager.js keeps several superseded senders that nothing calls (logChannelCreate, logIntegrationUpdate…).
 * Its top-level functions that are live: referenced from another file, or from a live function in it.
 * Returns (index in log-manager.js) -> is the enclosing function live.
 */
function logManagerLiveness(otherSources) {
    const src = read('core/log-manager.js');
    const starts = [...src.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].map(m => ({ name: m[1], at: m.index }));
    // A top-level function ends at its first column-0 '}' (so the trailing `export { … }` list is no one's body).
    const bodies = new Map(starts.map(s => [s.name, stripComments(src.slice(s.at, src.indexOf('\n}', s.at) + 2))]));
    const others = stripComments(otherSources);
    const refs = (text, name) => new RegExp(`\\b${name}\\b`).test(text);
    const live = new Set(starts.map(s => s.name).filter(n => refs(others, n)));
    for (let grew = true; grew;) {
        grew = false;
        for (const name of bodies.keys()) {
            if (live.has(name)) continue;
            if ([...live].some(l => refs(bodies.get(l).replace(/^.*\n/, ''), name))) { live.add(name); grew = true; }
        }
    }
    return (index) => {
        const enclosing = starts.filter(s => s.at <= index).at(-1);
        return !enclosing || live.has(enclosing.name);
    };
}

const CODE_FILES = (() => {
    const files = [];
    // Only the bot's own source: copies kept in backups/, archives/, scratchpad/ and dot-folders (old
    // worktrees, pre-push snapshots) are not run, and a stale copy there must not pass or fail this test.
    const skip = /node_modules|(^|\/)\.|^(docs|scripts|tests|migrations|data|logs|backups|archives|scratchpad|uploads|temp_audio)(\/|$)|^_|^dashboard\/(views|public)/;
    (function walk(dir) {
        for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            const rel = dir ? `${dir}/${e.name}` : e.name;
            if (skip.test(rel)) continue;
            if (e.isDirectory()) walk(rel);
            else if (e.name.endsWith('.js')) files.push(rel);
        }
    })('');
    return files;
})();

test('registry: unique keys, category-prefixed when a category has several actions, valid colours', () => {
    const seen = new Set();
    for (const [category, actions] of Object.entries(la.LOG_ACTIONS)) {
        assert.ok(actions.length > 0, category);
        for (const a of actions) {
            assert.ok(!seen.has(a.key), `duplicate action ${a.key}`);
            seen.add(a.key);
            if (actions.length === 1) assert.equal(a.key, category, 'a one-action category uses its own key');
            else assert.ok(a.key.startsWith(`${category}.`), `${a.key} should start with ${category}.`);
            assert.ok(a.color.hex ? la.normalizeHex(a.color.hex) : THEME_SLOTS.includes(a.color.slot), `${a.key} colour`);
        }
        assert.ok(!(category in la.NOT_POSTED), `${category} is both posted and not posted`);
    }
});

test('every Logging-page category shows colour pickers or why it has none', () => {
    const page = read('dashboard/views/partials/manage/logging.ejs');
    const block = page.slice(page.indexOf('const logCategories = ['), page.indexOf('];', page.indexOf('const logCategories = [')));
    const keys = [...block.matchAll(/\{ key: '([^']+)'/g)].map(m => m[1]);
    assert.ok(keys.length > 40, 'page categories parsed');
    for (const key of keys) assert.ok(key in la.LOG_ACTIONS || key in la.NOT_POSTED, `page category ${key} has no colour row`);
    const rows = la.actionColorRows('g1', {}, () => '#000000');
    for (const key of keys) assert.ok(rows[key], key);
});

test('every log call in a multi-action category names a known action; every action is used', () => {
    const multi = new Set(Object.entries(la.LOG_ACTIONS).filter(([, a]) => a.length > 1).map(([c]) => c));
    const used = new Set();
    const isLive = logManagerLiveness(CODE_FILES.filter(f => f !== 'core/log-manager.js').map(read).join('\n'));
    for (const file of CODE_FILES) {
        const src = read(file);
        if (!src.includes('sendLogEmbed(')) continue;
        for (const args of callArgs(src, 'sendLogEmbed')) {
            const category = (args[1] || '').match(/^['"]([^'"]+)['"]$/)?.[1];
            if (!category || !multi.has(category)) continue;
            if (file === 'core/log-manager.js' && !isLive(args.index)) continue; // dead code proves nothing is logged
            assert.ok(args[3], `${file}: sendLogEmbed(…, '${category}', …) must pass its action`);
            if (/^[A-Za-z_]\w*$/.test(args[3])) continue; // passed through (owo API auditLog), checked below
            const template = args[3].match(/^`([A-Za-z-]+)\.\$\{/);
            if (template) { assert.equal(template[1], category, `${file}: template action prefix`); continue; }
            // Action keys are the '<category>.<x>' literals; other literals in a ternary ('APPROVED') are not.
            const keys = (args[3].match(/'([^']+)'/g) || []).map(s => s.slice(1, -1)).filter(s => s.startsWith(`${category}.`));
            assert.ok(keys.length > 0, `${file}: sendLogEmbed(…, '${category}', …) passes no '${category}.*' action: ${args[3]}`);
            for (const key of keys) {
                assert.ok(la.isLogAction(key), `${file}: unknown action '${key}'`);
                used.add(key);
            }
        }
    }
    // Feature logs: logFeatureEvent(guild, '<action>' | cond ? '<a>' : '<b>', {…}) — the action is always literal.
    for (const file of CODE_FILES) {
        if (file === 'core/feature-log.js') continue;
        const src = stripComments(read(file));
        if (!src.includes('logFeatureEvent(')) continue;
        for (const args of callArgs(src, 'logFeatureEvent')) {
            const literals = (args[1]?.match(/'([^']+)'/g) || []).map(s => s.slice(1, -1));
            // Action keys among the literals: registered keys, or '<known category>.<x>' (a typo must fail).
            // Other literals in a ternary condition ('staff', 'APPROVED') are not keys.
            const keys = literals.filter(s => la.isLogAction(s) || (s.includes('.') && s.split('.')[0] in la.LOG_ACTIONS));
            assert.ok(keys.length > 0, `${file}: logFeatureEvent action must be a literal key: ${args[1]}`);
            for (const key of keys) {
                assert.ok(la.isLogAction(key), `${file}: unknown action '${key}'`);
                used.add(key);
            }
            assert.ok(args[2], `${file}: logFeatureEvent(…, '${keys[0]}') has no details`);
            // Lazy form, so building the entry can never throw into the feature (core/feature-log.js).
            assert.ok(/^\(\)\s*=>/.test(args[0]), `${file}: logFeatureEvent guild must be () => …, got: ${args[0].slice(0, 60)}`);
            assert.ok(/^'[^']+'$/.test(args[1]) || /^\(\)\s*=>/.test(args[1]), `${file}: computed action must be () => …: ${args[1].slice(0, 60)}`);
            assert.ok(/^\(\)\s*=>/.test(args[2]), `${file}: logFeatureEvent details must be () => ({ … }) (${keys[0]})`);
        }
    }
    // Critters rare catch: `owoRareCatch.${tier}` for each auditable tier (handlers/critters-actions.js).
    const ranks = read('handlers/critters-actions.js').match(/AUDITABLE_RANKS = new Set\(\[([^\]]+)\]/)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
    for (const rank of ranks) { assert.ok(la.isLogAction(`owoRareCatch.${rank}`), `rank ${rank}`); used.add(`owoRareCatch.${rank}`); }
    // Critters admin API: every auditLog(req, …) call passes an owoAdminAction.* action.
    const owoApi = read('dashboard/routes/api/features/critters.js');
    for (const args of callArgs(owoApi, 'auditLog')) {
        assert.ok(args[2], 'auditLog call passes its action');
        for (const key of args[2].match(/'([^']+)'/g).map(s => s.slice(1, -1))) { assert.ok(la.isLogAction(key), key); used.add(key); }
    }
    for (const [category, actions] of Object.entries(la.LOG_ACTIONS)) {
        if (actions.length < 2) continue;
        for (const a of actions) assert.ok(used.has(a.key), `${a.key} is never logged`);
    }
});

test('liveness: superseded log-manager senders are recognised as dead, aliased ones as live', () => {
    const isLive = logManagerLiveness(CODE_FILES.filter(f => f !== 'core/log-manager.js').map(read).join('\n'));
    const src = read('core/log-manager.js');
    const at = (name) => src.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, 'm')) + 1;
    assert.equal(isLive(at('logChannelCreate')), false, 'replaced by events/channelCreate.js');
    assert.equal(isLive(at('logIntegrationUpdate')), false, 'never called');
    assert.equal(isLive(at('logGuildMemberRemove')), true, 'reached through logMemberLeave');
    assert.equal(isLive(at('logVoiceJoin')), true);
});

test('opt-in categories post only when ticked AND the page was saved since they were wired', () => {
    const saved = new Date('2026-10-06T12:00:00Z');
    assert.equal(la.optInAllowed('voiceUpdate', [], null), true, 'ordinary categories are not gated');
    assert.equal(la.optInAllowed('xp', ['xp'], null), false, 'ticked by an old save only');
    assert.equal(la.optInAllowed('xp', [], saved), false, 'saved, not ticked (an empty list means "all" for ordinary events, never for opt-in)');
    assert.equal(la.optInAllowed('xp', ['xp', 'ban'], saved), true);
    for (const c of la.OPT_IN_CATEGORIES) assert.ok(c in la.LOG_ACTIONS || c in la.NOT_POSTED, `${c} is on the page`);
});

test('saving stores only colours that differ from the default', () => {
    const defaults = { 'voiceUpdate.join': '#57F287', 'voiceUpdate.leave': '#ED4245', 'voiceUpdate.move': '#5865F2', messageUpdate: '#FEE75C' };
    const plan = la.planActionColorChanges({
        'voiceUpdate.join': '#57f287',      // the default, lower case -> nothing to store
        'voiceUpdate.leave': 'aa00ff',      // changed, no '#' -> stored normalised
        'voiceUpdate.move': 'not-a-colour', // invalid -> back to default
    }, defaults);
    assert.deepEqual(plan.upsert, [['voiceUpdate.leave', '#AA00FF']]);
    assert.deepEqual(plan.remove.sort(), ['messageUpdate', 'voiceUpdate.join', 'voiceUpdate.move']);
});

test('defaults: fixed hex, or the server theme slot; page rows mark custom colours', () => {
    const theme = (guildId, slot) => ({ danger: '#123456', success: '#00FF00', primary: '#0000FF' })[slot];
    assert.equal(la.defaultActionColor('g1', 'voiceUpdate.join', theme), '#57F287');
    assert.equal(la.defaultActionColor('g1', 'voiceUpdate.leave', theme), '#123456');
    assert.equal(la.defaultActionColor('g1', 'nope', theme), null);
    const rows = la.actionColorRows('g1', { 'voiceUpdate.move': '#ff0000', 'voiceUpdate.join': '#57F287' }, theme);
    assert.deepEqual(rows.voiceUpdate.actions.map(a => [a.label, a.value, a.custom]),
        [['Join', '#57F287', false], ['Leave', '#123456', false], ['Move', '#FF0000', true]]);
    assert.equal(rows.voiceUpdate.actions[2].fallback, '#5865F2');
    // Categories turned off everywhere explain why. (This used to check emojiCreate by name; emoji, sticker
    // and soundboard logs graduated from NOT_POSTED to real actions on 2026-10-14.)
    for (const [category, why] of Object.entries(la.NOT_POSTED)) assert.equal(rows[category].notPosted, why, category);
    // …and a log-manager sender switched off at the source (its body starts with a bare `return`) must be
    // listed in NOT_POSTED, or the Logging page offers colour pickers for a log that never posts.
    const lm = read('core/log-manager.js');
    for (const m of lm.matchAll(/^(?:export )?async function (\w+)\([^)]*\) \{\s*(?:\/\/[^\n]*\n\s*)*return;/gm)) {
        const body = lm.slice(m.index, lm.indexOf('\n}', m.index));
        for (const args of callArgs(body, 'sendLogEmbed')) {
            const category = (args[1] || '').match(/^['"]([^'"]+)['"]$/)?.[1];
            if (category) assert.ok(rows[category]?.notPosted, `${m[1]} never posts '${category}', but the Logging page offers it`);
        }
    }
    assert.ok(rows.moderation.actions.length > 10, 'moderation is wired');
    assert.equal(la.normalizeHex(0x57F287), '#57F287');
    assert.equal(la.normalizeHex('#abc'), null);
});

// ── Per-action switches (log_action_disabled, migration 413) ──

test('only categories with several actions get per-action switches', () => {
    assert.equal(la.isSwitchableCategory('voiceUpdate'), true);
    assert.equal(la.isSwitchableCategory('messageDelete'), false);
    assert.equal(la.isSwitchableCategory('no-such-category'), false);
    const rows = la.actionColorRows('g1', {}, () => '#000000');
    assert.equal(rows.voiceUpdate.switchable, true);
    assert.equal(rows.messageDelete.switchable, false);
});

test('unticked switchable actions are stored as off; one-action categories never are', () => {
    const all = Object.entries(la.LOG_ACTIONS).filter(([c]) => la.isSwitchableCategory(c)).flatMap(([, a]) => a.map(x => x.key));
    const off = la.planDisabledActions(all.filter(k => k !== 'voiceUpdate.leave'));
    assert.deepEqual(off, ['voiceUpdate.leave']);
    assert.ok(!la.planDisabledActions([]).includes('messageDelete'));
    assert.equal(la.planDisabledActions(undefined).length, all.length);
});

test('a lone value or a qs index-keyed object parses like an array', () => {
    const all = Object.entries(la.LOG_ACTIONS).filter(([c]) => la.isSwitchableCategory(c)).flatMap(([, a]) => a.map(x => x.key));
    assert.ok(!la.planDisabledActions('voiceUpdate.join').includes('voiceUpdate.join'));
    const asObject = Object.fromEntries(all.map((k, i) => [String(i), k]));
    assert.deepEqual(la.planDisabledActions(asObject), []);
});

test('rows mark switched-off actions, but never an action of a one-action category', () => {
    const rows = la.actionColorRows('g1', {}, () => '#000000', new Set(['voiceUpdate.leave', 'messageDelete']));
    assert.equal(rows.voiceUpdate.actions.find(a => a.key === 'voiceUpdate.leave').on, false);
    assert.equal(rows.voiceUpdate.actions.find(a => a.key === 'voiceUpdate.join').on, true);
    assert.equal(rows.messageDelete.actions[0].on, true);
});
