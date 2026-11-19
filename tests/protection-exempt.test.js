import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    decideExempt, isManagerRoles, pauseState, parseDuration, formatDuration, pastTense, holdDecision,
    allowUserRemoval, canEditManagers, canConfigure, whyText, MAX_PAUSE_MS,
} from '../core/protection-exempt-logic.js';

const lists = {
    users: new Set(['u-allowed']),
    roles: new Set(['r-trusted']),
    managers: new Set(['r-manager']),
    seen: new Map([['u-former', 'r-trusted'], ['u-stale', 'r-gone']]),
};

test('bots and the owner are always exempt', () => {
    assert.deepEqual(decideExempt({ id: 'b', bot: true }, lists).why, 'bot');
    assert.equal(decideExempt({ id: 'o', owner: true }, lists).why, 'owner');
    assert.equal(decideExempt({ id: 'o', owner: true }, {}).exempt, true, 'no lists needed');
});

test('bots can be kept in scope (anti-nuke)', () => {
    const d = decideExempt({ id: 'b', bot: true }, lists, { exemptBots: false });
    assert.equal(d.exempt, false);
    const viaRole = decideExempt({ id: 'b', bot: true, roleIds: ['r-trusted'] }, lists, { exemptBots: false });
    assert.equal(viaRole.why, 'allowlist-role', 'other reasons still apply');
});

test('allowlisted user, allowlisted role, manager role', () => {
    assert.equal(decideExempt({ id: 'u-allowed' }, lists).why, 'allowlist-user');
    const r = decideExempt({ id: 'someone', roleIds: ['x', 'r-trusted'] }, lists);
    assert.equal(r.why, 'allowlist-role');
    assert.equal(r.roleId, 'r-trusted');
    const m = decideExempt({ id: 'someone', roleIds: ['r-manager'] }, lists);
    assert.equal(m.why, 'manager');
    assert.equal(m.record, null, 'managers are not recorded as once-held');
});

test('ordinary members are not exempt', () => {
    const d = decideExempt({ id: 'nobody', roleIds: ['x'] }, lists);
    assert.deepEqual(d, { exempt: false, why: null, roleId: null, record: null });
    assert.equal(decideExempt(null, lists).exempt, false);
    assert.equal(decideExempt({}, lists).exempt, false);
});

test('once held an allowlisted role: recorded when seen, exempt after the role is gone', () => {
    // First sighting with the role: exempt and asks to be recorded.
    const first = decideExempt({ id: 'u-new', roleIds: ['r-trusted'] }, lists);
    assert.equal(first.record, 'r-trusted');
    // Already recorded: no second record.
    assert.equal(decideExempt({ id: 'u-former', roleIds: ['r-trusted'] }, lists).record, null);
    // Role taken off them: still exempt through the record.
    const later = decideExempt({ id: 'u-former', roleIds: [] }, lists);
    assert.equal(later.exempt, true);
    assert.equal(later.why, 'once-held-role');
    assert.equal(later.roleId, 'r-trusted');
    // The role itself is no longer allowlisted: the record no longer counts.
    assert.equal(decideExempt({ id: 'u-stale' }, lists).exempt, false);
});

test('accepts plain arrays and objects for the lists', () => {
    const plain = { users: ['a'], roles: ['r'], managers: [], seen: { b: 'r' } };
    assert.equal(decideExempt({ id: 'a' }, plain).exempt, true);
    assert.equal(decideExempt({ id: 'b' }, plain).why, 'once-held-role');
    assert.equal(isManagerRoles(['m'], ['m']), true);
    assert.equal(isManagerRoles([], ['m']), false);
});

test('pause state and expiry', () => {
    const now = Date.parse('2026-10-12T12:00:00Z');
    assert.deepEqual(pauseState(null, now), { paused: false, until: null, expired: false });
    assert.deepEqual(pauseState({ enforcement_paused: 0 }, now), { paused: false, until: null, expired: false });
    assert.deepEqual(pauseState({ enforcement_paused: 1 }, now), { paused: true, until: null, expired: false });
    const later = pauseState({ enforcement_paused: 1, paused_until: '2026-10-12T13:00:00Z' }, now);
    assert.equal(later.paused, true);
    assert.equal(later.until.toISOString(), '2026-10-12T13:00:00.000Z');
    const past = pauseState({ enforcement_paused: 1, paused_until: new Date(now - 1) }, now);
    assert.equal(past.paused, false);
    assert.equal(past.expired, true);
    assert.equal(pauseState({ enforcement_paused: 1, paused_until: new Date(now) }, now).expired, true, 'the end time itself is resumed');
    assert.equal(pauseState({ enforcement_paused: '1', paused_until: 'garbage' }, now).paused, true, 'unreadable end = no end');
});

test('durations', () => {
    assert.deepEqual(parseDuration(''), { ok: true, ms: null });
    assert.deepEqual(parseDuration(null), { ok: true, ms: null });
    assert.equal(parseDuration('30m').ms, 30 * 60_000);
    assert.equal(parseDuration('2h').ms, 7_200_000);
    assert.equal(parseDuration('1d').ms, 86_400_000);
    assert.equal(parseDuration('1w').ms, 604_800_000);
    assert.equal(parseDuration('1h30m').ms, 5_400_000);
    assert.equal(parseDuration('1h 30m').ms, 5_400_000);
    assert.equal(parseDuration('90').ms, 5_400_000, 'bare number = minutes');
    assert.equal(parseDuration('2 hours').ms, 7_200_000);
    assert.equal(parseDuration('30d').ms, MAX_PAUSE_MS);
    assert.equal(parseDuration('31d').ok, false);
    assert.equal(parseDuration('0m').ok, false);
    assert.equal(parseDuration('soon').ok, false);
    assert.equal(parseDuration('1h and some').ok, false);
    assert.equal(formatDuration(5_400_000), '1h 30m');
    assert.equal(formatDuration(90_000_000), '1d 1h');
    assert.equal(formatDuration(0), '0m');
});

test('hold decision: exempt wins, then paused, else act', () => {
    assert.equal(holdDecision({ exempt: { exempt: false }, paused: false, action: 'ban', source: 'Raid' }), null);
    const ex = holdDecision({ exempt: { exempt: true, why: 'allowlist-role' }, paused: true, action: 'ban', source: 'Raid' });
    assert.equal(ex.why, 'exempt');
    assert.match(ex.text, /Raid: skipped \(holds an allowlisted role\) — would have banned them/);
    const p = holdDecision({ paused: true, action: 'timeout', source: 'Automod' });
    assert.equal(p.why, 'paused');
    assert.match(p.text, /paused — would have timed them out/);
    assert.equal(pastTense('delete'), 'deleted the message');
    assert.equal(pastTense('mystery'), "done 'mystery'");
    assert.equal(whyText('nope'), 'exempt');
});

test('an allowlisted user holding an allowlisted role cannot be removed', () => {
    assert.deepEqual(allowUserRemoval(['r-trusted', 'x'], lists.roles), { ok: false, roleId: 'r-trusted' });
    assert.deepEqual(allowUserRemoval(['x'], lists.roles), { ok: true, roleId: null });
    assert.deepEqual(allowUserRemoval([], lists.roles), { ok: true, roleId: null });
});

test('only the owner or an Administrator edits manager roles; managers may configure', () => {
    assert.equal(canEditManagers({ isOwner: true }), true);
    assert.equal(canEditManagers({ isAdmin: true }), true);
    assert.equal(canEditManagers({ isSuperAdmin: true }), true);
    assert.equal(canEditManagers({}), false, 'Manage Server alone is not enough');
    assert.equal(canConfigure({ hasManageGuild: true }), true);
    assert.equal(canConfigure({ roleIds: ['r-manager'], managers: lists.managers }), true);
    assert.equal(canConfigure({ roleIds: ['x'], managers: lists.managers }), false);
    assert.equal(canConfigure(), false);
});

test('every automated punishment path asks protectionHold first', () => {
    const wired = [
        'core/spammer-guard.js', 'core/join-gate.js', 'core/raid-detection-manager.js', 'core/global-ban-manager.js',
        'core/phishing-detection-manager.js', 'core/selfbot-detection-manager.js', 'core/anti-nuke-manager.js',
        'core/automod.js', 'core/advanced-automod-manager.js', 'core/adaptive-spam-manager.js',
        'core/commission-spam-filter.js', 'core/link-filter.js', 'core/image-blocklist.js', 'core/escalation-manager.js',
        'events/inviteLinkFilter.js', 'core/name-filters.js', 'core/raid-lockdown.js', 'core/avatar-protection.js',
        'core/message-threats.js',
    ];
    for (const f of wired) {
        const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
        assert.match(src, /await protectionHold\(/, `${f} must call protectionHold before acting`);
    }
    const nuke = fs.readFileSync(new URL('../core/anti-nuke-manager.js', import.meta.url), 'utf8');
    assert.match(nuke, /pauseOnly: true/, 'anti-nuke honours only the pause');
});
