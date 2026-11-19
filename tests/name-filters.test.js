import test from 'node:test';
import assert from 'node:assert/strict';
import {
    validateNameFilter, compileFilter, nameFieldsOf, namesHash, matchNames, generatedUsername, planCleanse, splitForce,
    planAutoPilot, planTemplateSync, nameReason, nameEventAction, exactKey, normaliseNameAction, ORDINARY_NAMES, STORED_TYPE,
} from '../core/name-filter-logic.js';
import { findEmptyAlternative, safeRegexEach } from '../core/automod-patterns.js';
import { TEMPLATE_PACKS, expandPack, serverNameForTemplates, GENERATED_NAME_WORDS } from '../core/name-filter-templates.js';

/*
 * Name filters (core/name-filter-logic.js + core/name-filter-templates.js). What has to stay true:
 *   - a filter that could freeze the bot or hit everyone is refused when it is saved
 *   - one plain filter catches the disguised spellings, in any of the three names
 *   - an Auto-Pilot filter never hits the staff member it protects
 *   - the most severe matching filter decides
 *   - the generated-name check needs BOTH words from the vocabulary
 *   - cleanse / Auto-Pilot / template planning leaves the right people and rows alone
 *   - every curated template entry is valid and hits no ordinary name
 */

const row = (id, type, pattern, action = 'log', extra = {}) => ({ id, pattern_type: STORED_TYPE[type], pattern, action, ...extra });
const filters = (...rows) => rows.map(compileFilter);
const names = (username, globalName = null, nickname = null) => nameFieldsOf({ username, globalName, nickname });
// Regex budgets far above the production 25 ms: these tests are about which patterns are valid and
// what they match, so a loaded machine (the vm timeout counts wall-clock time) must not decide them.
// The timeout behaviour itself is tested with a stub runner below.
const SLOW_OK_MS = 2000;
const slowOk = (jobs) => safeRegexEach(jobs, SLOW_OK_MS);
const validate = (type, value, opts = {}) => validateNameFilter(type, value, { regexTimeoutMs: SLOW_OK_MS, ...opts });
const hit = (fs, n, opts) => matchNames(fs, n, { runner: slowOk, ...opts }).match;

test('regex validator refuses the dangerous and the too-broad', () => {
    const refused = {
        '(a+)+': 'quantifier', '(a|b)+': '`|`', 'sup|': 'empty', '|sup': 'empty', '(a||b)': 'empty', '(foo|)bar': 'empty',
        '.*': 'empty name', 'a?': 'empty name', 'x{0,3}': 'empty name', '[a-z]': 'ordinary names', '\\w': 'ordinary names',
        '(\\w)\\1': 'backreferences', '(': 'unclosed', 'a{1001}': '1000',
    };
    for (const [pattern, why] of Object.entries(refused)) {
        const r = validate('regex', pattern);
        assert.equal(r.ok, false, pattern);
        assert.match(r.error, new RegExp(why.replace(/[`|]/g, m => `\\${m}`), 'i'), `${pattern}: ${r.error}`);
    }
    assert.equal(validateNameFilter('regex', 'x'.repeat(201)).ok, false);
    for (const ok of ['^mod(erator)?s?$', '(^|\\s)admin\\b', '\\bsupport\\s*team\\b', 'nitro\\s*(gift|drop)']) {
        assert.equal(validate('regex', ok).ok, true, ok);
    }
});

test('findEmptyAlternative: anchors count as content, classes and escapes too', () => {
    assert.equal(findEmptyAlternative('(^|\\s)x'), null);
    assert.equal(findEmptyAlternative('[|]x'), null);
    assert.equal(findEmptyAlternative('a\\|'), null);
    assert.equal(findEmptyAlternative('(?:a|b)c'), null);
    assert.ok(findEmptyAlternative('(?:a|)c'));
    assert.ok(findEmptyAlternative('a||b'));
});

test('phrase and exact validation', () => {
    assert.equal(validateNameFilter('phrase', 'ab').ok, false);
    assert.equal(validateNameFilter('phrase', '!!!').ok, false, 'needs letters');
    assert.equal(validateNameFilter('phrase', 'support team').value, 'support team');
    assert.equal(validateNameFilter('phrase', '  support    team ').value, 'support team');
    assert.equal(validateNameFilter('phrase', 'x'.repeat(101)).ok, false);
    assert.equal(validateNameFilter('exact', 'B').ok, false);
    assert.equal(validateNameFilter('nope', 'x').ok, false);
});

test('one phrase covers its disguises, in any of the three names', () => {
    const fs = filters(row(1, 'phrase', 'support team', 'ban'));
    for (const disguise of ['ѕuррогt tеаm', 'SUPPORT TEAM', '$upp0rt t3am', 'ꜱᴜᴘᴘᴏʀᴛ ᴛᴇᴀᴍ', 's̷u̵p̴p̶o̸r̷t team', 'sup​port team', 'Official Support Team']) {
        assert.ok(hit(fs, names(disguise)), disguise);
        assert.ok(hit(fs, names('bob', disguise)), `display ${disguise}`);
        assert.equal(hit(fs, names('bob', null, disguise)).field, 'nickname');
    }
    assert.equal(hit(fs, names('support')), null);
    for (const u of ['support_team', 'support.team', 'ѕuррогt_tеаm', 'helpdesk-support--team']) assert.ok(hit(fs, names(u)), `username ${u}`);
    assert.equal(hit(fs, names('ѕuррогt tеаm'), { fuzzy: false }), null, 'fuzzy off: lookalikes pass');
    assert.ok(hit(fs, names('Support Team'), { fuzzy: false }), 'fuzzy off: plain case-insensitive still hits');
});

test('collapse catches separators and stretched letters only when on', () => {
    const fs = filters(row(1, 'phrase', 'support'));
    assert.equal(hit(fs, names('s.u.p.p.o.r.t')), null);
    assert.ok(hit(fs, names('s.u.p.p.o.r.t'), { collapse: true }));
    assert.ok(hit(fs, names('suuuupport'), { collapse: true }));
});

test('case-sensitive phrases and regexes', () => {
    const fs = filters(row(1, 'phrase', 'MOD', 'log', { case_sensitive: 1 }), row(2, 'regex', '^Admin$', 'log', { case_sensitive: 1 }));
    assert.ok(hit(fs, names('xMODx')));
    assert.equal(hit(fs, names('xmodx')), null);
    assert.ok(hit(fs, names('Admin')));
    assert.ok(hit(fs, names('Αdmin')), 'lookalikes still folded, case kept');
    assert.equal(hit(fs, names('admin')), null);
});

test('regexes run against the folded forms too', () => {
    const fs = filters(row(5, 'regex', '^mod(erator)?s?$', 'kick'));
    assert.equal(hit(fs, names('M0D')).form, 'leet');
    assert.ok(hit(fs, names('ᴍᴏᴅᴇʀᴀᴛᴏʀ')));
    assert.equal(hit(fs, names('modest')), null);
});

test('exact names: separators and lookalikes ignored; never the protected member', () => {
    const fs = filters(row(9, 'exact', 'CoolStaffBob', 'ban', { auto_user_id: '111', origin: 'auto' }));
    assert.ok(hit(fs, names('coolstaff.bob')));
    assert.ok(hit(fs, names('x', 'C00l Staff B0b')));
    assert.ok(hit(fs, names('x', null, 'Ꮯoolstaffbob')));
    assert.equal(hit(fs, names('coolstaffbob'), { memberId: '111' }), null, 'their own filter');
    assert.ok(hit(fs, names('coolstaffbob'), { memberId: '222' }));
    assert.equal(hit(fs, names('coolstaffbobby')), null, 'exact, not contains');
});

test('the most severe filter decides; all matches are reported', () => {
    const fs = filters(row(1, 'phrase', 'support', 'log'), row(2, 'phrase', 'team', 'kick'), row(3, 'regex', 'supp', 'flag'));
    const r = matchNames(fs, names('support team'), { runner: slowOk });
    assert.equal(r.matches.length, 3);
    assert.equal(r.match.filter.id, 2);
    assert.equal(r.match.filter.action, 'kick');
});

test('a slow regex is found and reported, not hung on', () => {
    const fs = filters(row(1, 'regex', 'abc'), row(2, 'regex', 'def'));
    let calls = 0;
    const runner = (jobs) => {
        calls++;
        if (jobs.length > 1) return { hits: [], timedOut: true };
        return jobs[0][0].source === 'def' ? { hits: [], timedOut: true } : { hits: [{ job: 0, input: 0 }] };
    };
    const r = matchNames(fs, names('abc'), { runner });
    assert.deepEqual(r.timedOut, [2]);
    assert.equal(r.match.filter.id, 1);
    assert.equal(calls, 3);
});

test('safeRegexEach reports the first matching input of each job', () => {
    const out = safeRegexEach([[/b/, ['a', 'b', 'bb']], [/z/, ['a']], [/a/i, ['A']]], SLOW_OK_MS);
    assert.deepEqual(out.hits, [{ job: 0, input: 1 }, { job: 2, input: 0 }]);
    assert.deepEqual(safeRegexEach([]).hits, []);
});

test('nameFieldsOf drops blanks and repeats; the hash follows the names', () => {
    assert.deepEqual(nameFieldsOf({ username: 'bob', globalName: 'bob', nickname: '' }), [{ field: 'username', text: 'bob' }]);
    assert.equal(names('a', 'b', 'c').length, 3);
    assert.equal(namesHash(names('a', 'b')), namesHash(names('a', 'b')));
    assert.notEqual(namesHash(names('a', 'b')), namesHash(names('a', 'c')));
    assert.equal(namesHash(names('a')).length, 16);
});

test('generated usernames need both words in the vocabulary', () => {
    assert.deepEqual(generatedUsername('fluffy_panda_4821'), { first: 'fluffy', second: 'panda', digits: '4821' });
    assert.ok(generatedUsername('brave.otter.123'));
    assert.ok(generatedUsername('sleepy_koala12'), 'the last separator is optional');
    assert.equal(generatedUsername('john_smith_1234'), null);
    assert.equal(generatedUsername('fluffy_john_1234'), null);
    assert.equal(generatedUsername('fluffy_panda'), null, 'needs the number');
    assert.equal(generatedUsername('fluffy_panda.1234'), null, 'mixed separators are not the generator format');
    assert.equal(generatedUsername('fluffypanda1234'), null);
    assert.equal(generatedUsername('Fluffy_Panda_1234'), null, 'usernames are lower case; display names are not checked');
    for (const w of GENERATED_NAME_WORDS) assert.match(w, /^[a-z]{3,12}$/, w);
    for (const n of ORDINARY_NAMES) assert.equal(generatedUsername(n), null, n);
});

test('planCleanse: who is queued and why the rest are left alone', () => {
    const m = { filter: { id: 1, action: 'ban' } };
    const plan = planCleanse([
        { id: 'bot', bot: true, match: m },
        { id: 'clean', match: null },
        { id: 'owner', owner: true, match: m },
        { id: 'mod', staff: true, match: m },
        { id: 'ex', exempt: true, match: m },
        { id: 'safe', safeHash: 'h1', namesHash: 'h1', match: m },
        { id: 'renamed', safeHash: 'h1', namesHash: 'h2', match: m },
        { id: 'scam', match: m },
    ]);
    assert.deepEqual(plan.queue.map(c => c.id), ['renamed', 'scam']);
    assert.deepEqual(plan.skipped, { bots: ['bot'], staff: ['owner', 'mod'], exempt: ['ex'], safe: ['safe'] });
    assert.equal(plan.clean, 1);
    const force = splitForce([{ id: 'a', match: { filter: { action: 'log' } } }, { id: 'b', match: { filter: { action: 'kick' } } },
        { id: 'g', match: { generated: true, action: 'ban' } }, { id: 'h', match: { generated: true, action: 'log' } }]);
    assert.deepEqual(force.review.map(c => c.id), ['a', 'h']);
    assert.deepEqual(force.act.map(c => c.id), ['b', 'g']);
});

test('planAutoPilot: skips short and shared names, retires renamed, never recreates removed', () => {
    const owners = new Map([
        [exactKey('Alexander'), new Set(['s1'])],
        [exactKey('Al'), new Set(['s1'])],
        [exactKey('Sam Mod'), new Set(['s2', 'm9'])],          // a regular member already has it
        [exactKey('Gone Name'), new Set(['s3'])],
        [exactKey('Kept Name'), new Set(['s3', 'imp'])],        // impersonator arrived after the filter existed
    ]);
    const existing = [
        { id: 10, autoUserId: 's1', key: exactKey('Old Name'), removed: false },   // s1 renamed: retire
        { id: 11, autoUserId: 's3', key: exactKey('Gone Name'), removed: true },   // staff deleted it: stays deleted
        { id: 12, autoUserId: 's3', key: exactKey('Kept Name'), removed: false },  // keep despite the impersonator
    ];
    const plan = planAutoPilot({
        protectedMembers: [{ id: 's1', names: ['Alexander', 'Al'] }, { id: 's2', names: ['Sam Mod'] }, { id: 's3', names: ['Gone Name', 'Kept Name'] }],
        owners, existing,
    });
    assert.deepEqual(plan.create.map(c => [c.userId, c.text]), [['s1', 'Alexander']]);
    assert.deepEqual(plan.retire, [10]);
});

test('planTemplateSync: insert new, update changed, delete dropped, keep removed', () => {
    const existing = [
        { id: 1, key: 'a', type: 'phrase', value: 'old a', removed: false },
        { id: 2, key: 'b', type: 'phrase', value: 'b', removed: true },
        { id: 3, key: 'gone', type: 'phrase', value: 'x', removed: false },
        { id: 4, key: 'same', type: 'phrase', value: 'same', removed: false },
    ];
    const plan = planTemplateSync(existing, [
        { key: 'a', type: 'phrase', value: 'new a' }, { key: 'b', type: 'phrase', value: 'b2' },
        { key: 'same', type: 'phrase', value: 'same' }, { key: 'new', type: 'regex', value: 'n+' }]);
    assert.deepEqual(plan.insert.map(e => e.key), ['new']);
    assert.deepEqual(plan.update.map(u => u.id), [1]);
    assert.deepEqual(plan.remove, [3]);
});

test('every template entry is valid and hits no ordinary name', () => {
    const ids = new Set();
    for (const pack of TEMPLATE_PACKS) {
        assert.ok(!ids.has(pack.id), `duplicate pack ${pack.id}`);
        ids.add(pack.id);
        const keys = new Set();
        for (const e of expandPack(pack, { serverName: 'Acme Gaming' })) {
            assert.ok(!keys.has(e.key), `${pack.id}: duplicate key ${e.key}`);
            keys.add(e.key);
            const v = validate(e.type, e.value);
            assert.ok(v.ok, `${pack.id}/${e.key}: ${v.error}`);
            const f = compileFilter(row(1, e.type, v.value));
            for (const n of ORDINARY_NAMES) assert.equal(hit([f], names(n)), null, `${pack.id}/${e.key} hits "${n}"`);
        }
    }
});

test('template server names: filled in, or the entry dropped when too short', () => {
    const pack = TEMPLATE_PACKS.find(p => p.id === 'staff-impersonation');
    assert.ok(expandPack(pack, { serverName: 'Acme Gaming' }).some(e => e.value === 'Acme Gaming support'));
    assert.equal(expandPack(pack, { serverName: 'AB' }).some(e => e.value.includes('support') && e.key === 'server-support'), false);
    assert.equal(serverNameForTemplates('🔥🔥'), null);
    assert.equal(serverNameForTemplates('  The   Den 🔥 '), 'The Den');
    const f = compileFilter(row(1, 'phrase', 'Acme Gaming support'));
    assert.ok(hit([f], names('acme gaming suppоrt')));
});

test('reasons are plain ASCII and name no pattern; actions normalise', () => {
    const r = nameReason({ filter: { id: 7 }, field: 'nickname' }, 'cleanse');
    assert.equal(r, 'Name filter #7 matched their server nickname (cleanse)');
    assert.match(nameReason({ generated: true }), /^[\x20-\x7E]+$/);
    assert.equal(nameEventAction('ban'), 'name_banned');
    assert.equal(nameEventAction('log'), 'name_logged');
    assert.equal(normaliseNameAction('BAN'), 'ban');
    assert.equal(normaliseNameAction('nuke'), 'log');
});
