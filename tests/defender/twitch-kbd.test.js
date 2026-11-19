// node --test --test-force-exit tests/defender/twitch-kbd.test.js
// (--test-force-exit: importing the module opens the DB pool, which otherwise keeps the run alive)
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, isSpam, isExempt } from '../../core/twitch-kbd-defender.js';

test('banlist wins over everything else', () => {
    const d = decide({ login: 'someone', text: 'hi', onBanlist: true, phishingDomain: 'evil.example' });
    assert.equal(d.action, 'ban');
    assert.equal(d.kind, 'banlist');
});

test('KBD bot-name pattern bans', () => {
    assert.equal(decide({ login: 'shrumzz_12345', text: 'hello', onBanlist: false })?.kind, 'name_pattern');
    assert.equal(decide({ login: 'sweatguy123', text: 'hello', onBanlist: false })?.kind, 'name_pattern');
    assert.equal(decide({ login: 'regular_viewer', text: 'hello', onBanlist: false }), null);
});

test('follower-selling spam template is detected, normal chat is not', () => {
    assert.equal(isSpam('Wanna become famous? Upgrade your stream on example dot com'), true);
    assert.equal(isSpam('buy primes, followers and viewers on somesite'), true);
    assert.equal(isSpam('great stream, you should upgrade your keyboard'), false);
    assert.equal(isSpam('gg'), false);
});

test('phishing link deletes (ban escalation is decided by the caller)', () => {
    const d = decide({ login: 'x', text: 'see https://evil.example/login', onBanlist: false, phishingDomain: 'evil.example' });
    assert.equal(d.action, 'delete');
    assert.equal(d.domain, 'evil.example');
});

test('exemptions: broadcaster, mods, VIPs, subs, service bots', () => {
    const base = { broadcaster_user_id: '1', chatter_user_id: '2', chatter_user_login: 'viewer', badges: [] };
    assert.equal(isExempt(base), false);
    assert.equal(isExempt({ ...base, chatter_user_id: '1' }), true);
    for (const set_id of ['moderator', 'vip', 'subscriber', 'founder', 'broadcaster']) {
        assert.equal(isExempt({ ...base, badges: [{ set_id }] }), true, set_id);
    }
    assert.equal(isExempt({ ...base, chatter_user_login: 'streamelements' }), true);
    assert.equal(isExempt({ ...base, chatter_user_login: 'nightbot' }), true);
});
