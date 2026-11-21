import test from 'node:test';
import assert from 'node:assert/strict';
import { domainToASCII } from 'node:url';
import L from '../core/link-intel-logic.js';

/*
 * core/link-intel-logic.js — judged on the NAME only (no member URL is ever fetched):
 *   - lookalikes, homoglyph / punycode brands, brand-as-subdomain, userinfo tricks, IP loggers, shorteners
 *   - real brand domains and ordinary links raise nothing
 *   - "i said no.thats it" is not a link
 */

const sig = (t) => L.linkSignals(t).signals.map(s => s.id);

test('lookalike and disguised brand domains are flagged', () => {
    assert.ok(sig('free nitro https://dlscord.gg/abc').includes('link_lookalike_homoglyph'));
    assert.ok(sig('steamcommunlty.com/tradeoffer/new').some(s => s.startsWith('link_lookalike')));
    assert.ok(sig('discordnitrogift.xyz/claim').includes('link_lookalike'));
    assert.ok(sig('https://discord-nitro-gift.com').includes('link_lookalike'));
    assert.ok(sig(`https://${domainToASCII('dіscord.com')}/gift`).includes('link_lookalike_homoglyph'), 'punycode homoglyph');
    assert.ok(sig('https://dіscord.com/gift').includes('link_lookalike_homoglyph'), 'written in Unicode');
    assert.ok(sig('https://xn--80ak6aa92e.com').includes('link_lookalike_homoglyph'), 'all-Cyrillic apple');
    assert.ok(sig('go to discord.gifts/abc').includes('link_brand_other_tld'));
    assert.ok(sig('https://discord.com.nitro-claim.ru/x').includes('link_brand_in_subdomain'));
    assert.ok(sig('https://discord.com@evil.ru/login').includes('link_userinfo'));
    assert.ok(sig('grabify.link/X1').includes('link_ip_logger'));
    assert.ok(sig('see bit.ly/abc').includes('link_shortener'));
    assert.ok(sig('http://45.12.3.4/login').includes('link_ip_host'));
});

test('real platforms and ordinary text raise nothing', () => {
    for (const t of ['discord.gg/abc', 'https://discord.com/channels/1/2', 'steamcommunity.com/id/me', 'youtube.com/watch?v=1', 'https://www.twitch.tv/someone',
        'i said no.thats it', 'version 1.2.3 is out', 'e.g. this', 'my site is example.com', 'paypal.me/someone']) {
        assert.deepEqual(sig(t), [], t);
    }
});

test('edit distance is Damerau-Levenshtein and capped', () => {
    assert.equal(L.editDistance('discord', 'dicsord'), 1);
    assert.equal(L.editDistance('discord', 'discrod'), 1);
    assert.equal(L.editDistance('steam', 'steeam'), 1);
    assert.equal(L.editDistance('a', 'abcdefgh', 2), 3);
});

test('domain age points', () => {
    assert.equal(L.domainAgeSignal('x.com', 2).id, 'link_new_domain_week');
    assert.equal(L.domainAgeSignal('x.com', 20).id, 'link_new_domain_month');
    assert.equal(L.domainAgeSignal('x.com', 400), null);
    assert.equal(L.domainAgeSignal('x.com', null), null);
});

test('links are read in every form, counted once', () => {
    const best = (t) => { const n = { plain: t, forms: [t.toLowerCase().replace(/0/g, 'o').replace(/3/g, 'e').replace(/1/g, 'i').replace(/4/g, 'a'), t.replace(/(\w)\1{2,}/g, '$1')] }; return L.linkSignalsBest([n.plain, ...n.forms]).signals.map(s => s.id); };
    assert.ok(best('ch3ck gr4b1fy.l1nk/AB').includes('link_ip_logger'));
    assert.ok(best('https://discoooord-nitro-gift.com').includes('link_lookalike'));
    assert.equal(best('https://dlscord.gg/x').filter(s => s.startsWith('link_lookalike')).length, 1, 'one link, one signal');
});

test('invites: codes extracted, lure names, confirmed scam servers', () => {
    assert.ok(L.inviteSignals('camgirls', null).some(s => s.id === 'invite_lure_code' && s.category === 'sexual'));
    assert.ok(L.inviteSignals('nitro-gift', null).some(s => s.id === 'invite_lure_code' && s.category === 'scam'));
    assert.ok(!L.inviteSignals('hcQ4R7mP6x', null).some(s => s.id === 'invite_lure_code'));
    assert.deepEqual(L.extractInviteCodes('join discord.gg/abc and https://discord.com/invite/xyz-1'), ['abc', 'xyz-1']);
    const ids = (info, blocked) => L.inviteSignals('c', info, blocked).map(s => s.id);
    assert.deepEqual(ids(null), ['invite_unresolved']);
    assert.ok(ids({ guildId: '1', name: 'Discord Support | Appeals', createdDays: 2 }).includes('invite_lure_name'));
    assert.ok(ids({ guildId: '1', name: 'Discord Support', createdDays: 2 }).includes('invite_new_server'));
    assert.ok(ids({ guildId: '9', name: 'Cozy Cafe', createdDays: 900 }, new Set(['9'])).includes('signature_invite'));
    assert.deepEqual(ids({ guildId: '2', name: 'Cozy Cafe', createdDays: 900 }), []);
});
