// core/user-display.js: names instead of raw ids on the dashboard, and the shared client/partial wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ejs from 'ejs';
import { userBits, resolveMany, parseIdList, isSnowflake, userLabelOf, MAX_RESOLVE } from '../core/user-display.js';

const ROOT = path.join(import.meta.dirname, '..');
const A = '111111111111111111';
const B = '222222222222222222';
const C = '333333333333333333';

const user = (id, username, globalName = null) => ({ id, username, globalName, displayAvatarURL: () => `https://cdn/u/${id}.png` });
function fakeGuild() {
    const member = { user: user(A, 'alice', 'Alice G'), displayName: 'Ally', displayAvatarURL: () => `https://cdn/m/${A}.png` };
    return {
        members: { cache: new Map([[A, member]]) },
        client: { users: { cache: new Map([[A, member.user], [B, user(B, 'bob')]]) } },
    };
}

test('member cache first: nickname and server avatar, inServer', () => {
    assert.deepEqual(userBits(fakeGuild(), A), { id: A, username: 'alice', displayName: 'Ally', avatar: `https://cdn/m/${A}.png`, inServer: true });
});

test('client user cache for someone not in the server', () => {
    assert.deepEqual(userBits(fakeGuild(), B), { id: B, username: 'bob', displayName: 'bob', avatar: `https://cdn/u/${B}.png`, inServer: false });
});

test('stored name when neither cache knows the id; live data beats the stored name', () => {
    assert.deepEqual(userBits(fakeGuild(), C, { storedName: '  carol  ' }), { id: C, username: 'carol', displayName: 'carol', avatar: null, inServer: false });
    assert.equal(userBits(fakeGuild(), B, { storedName: 'old-bob' }).username, 'bob');
});

test('unknown id: nulls, never throws on a missing or odd guild', () => {
    assert.deepEqual(userBits(fakeGuild(), C), { id: C, username: null, displayName: null, avatar: null, inServer: false });
    assert.deepEqual(userBits(null, C), { id: C, username: null, displayName: null, avatar: null, inServer: false });
    const broken = { members: { cache: new Map([[A, { user: { username: 'x' }, displayName: 'X', displayAvatarURL() { throw new Error('boom'); } }]]) } };
    assert.equal(userBits(broken, A).avatar, null);
});

test('resolveMany: de-duplicates, drops invalid ids, applies stored names', () => {
    const out = resolveMany(fakeGuild(), [A, A, 'nope', '', null, B, C, 12], { [C]: 'carol' });
    assert.deepEqual(Object.keys(out).sort(), [A, B, C]);
    assert.equal(out[C].displayName, 'carol');
});

test('parseIdList: comma lists, repeated params, validation and the cap', () => {
    assert.deepEqual(parseIdList(`${A}, ${B},${A},abc,,`), { ids: [A, B], tooMany: false, invalid: 1 });
    assert.deepEqual(parseIdList([A, `${B},${C}`]).ids, [A, B, C]);
    assert.deepEqual(parseIdList(undefined), { ids: [], tooMany: false, invalid: 0 });
    const many = Array.from({ length: MAX_RESOLVE + 5 }, (_, i) => String(100000000000000000n + BigInt(i)));
    const r = parseIdList(many.join(','));
    assert.equal(r.ids.length, MAX_RESOLVE);
    assert.equal(r.tooMany, true);
    assert.equal(isSnowflake('12345'), false);
    assert.equal(isSnowflake(A), true);
});

test('userLabelOf for confirm texts', () => {
    assert.equal(userLabelOf({ id: A, username: 'alice', displayName: 'Ally' }), 'Ally (@alice)');
    assert.equal(userLabelOf({ id: B, username: 'bob', displayName: 'bob' }), 'bob');
    assert.equal(userLabelOf({ id: C, username: null, displayName: null }), C);
    assert.equal(userLabelOf(null), '');
});

test('_user-cell partial: full cell from bits, placeholder from an id, escapes names', () => {
    const file = path.join(ROOT, 'dashboard/views/partials/manage/_user-cell.ejs');
    const tpl = ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file });
    const full = tpl({ cfUser: { id: A, username: 'alice', displayName: '<Ally>', avatar: 'https://cdn/a.png', inServer: true } });
    assert.match(full, /data-user-cell="111111111111111111"/);
    assert.match(full, /&lt;Ally&gt;/);
    assert.match(full, /@alice/);
    const ph = tpl({ cfUser: null, cfUserId: C, cfUserName: null });
    assert.match(ph, /data-user-id="333333333333333333"/);
    assert.doesNotMatch(ph, /data-user-cell/, 'placeholders are left for cf-user.js to name');
    assert.match(ph, /cf-user-id/);
    assert.match(tpl({ cfUser: null, cfUserId: C, cfUserName: 'carol', cfUserSize: 'sm' }), /data-user-name="carol"[^>]*data-user-size="sm"/);
});

test('the resolve route is mounted behind the guild-admin gate and the client builds DOM safely', () => {
    const index = fs.readFileSync(path.join(ROOT, 'dashboard/routes/api/index.js'), 'utf8');
    const gate = index.indexOf("router.use('/guilds/:guildId', apiCheckGuildAdmin");
    const mount = index.indexOf("router.use('/guilds/:guildId/users', userResolveRoutes)");
    assert.ok(gate > 0 && mount > gate, 'mounted after apiCheckGuildAdmin/botContext');
    const js = fs.readFileSync(path.join(ROOT, 'dashboard/public/js/cf-user.js'), 'utf8');
    assert.ok(!/\.innerHTML\s*=/.test(js), "cf-user.js builds DOM with createElement/textContent");
    assert.match(js, /\/users\/resolve\?ids=/);
    // verification.js uses the shared helper rather than its own copy
    const vf = fs.readFileSync(path.join(ROOT, 'dashboard/routes/api/features/verification.js'), 'utf8');
    assert.match(vf, /import \{ userBits \} from '..\/..\/..\/..\/core\/user-display.js'/);
    assert.doesNotMatch(vf, /function userBits/);
});
