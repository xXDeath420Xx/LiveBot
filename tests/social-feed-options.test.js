import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFeedContent, renderTemplate, cleanList, titlePasses, pingFor } from '../core/feed-message.js';
import { goLivePasses, attachGoLiveFilters } from '../core/stream-alert-filters.js';

/*
 * Per-feed message / ping / filters (core/feed-message.js) and the per-subscription go-live filters
 * (core/stream-alert-filters.js). The rule both share: an option that is empty or missing changes
 * nothing, so rows saved before the options existed post exactly as they did.
 */

test('feed content: nothing set sends what the posters always sent', () => {
    assert.deepEqual(buildFeedContent({ template: null, vars: {}, pingRoleId: null }), { content: undefined, allowedMentions: undefined });
    assert.deepEqual(buildFeedContent({ template: '  ', vars: {}, pingRoleId: '' }), { content: undefined, allowedMentions: undefined });
    assert.equal(buildFeedContent({ template: 'Crispy just posted on X!', vars: { name: 'x' } }).content, 'Crispy just posted on X!');
});

test('feed content: variables, ping in front, only that ping allowed, 2000-character cap', () => {
    assert.equal(renderTemplate('{Title} {title} by {author} {unknown}', { title: 'T', author: 'A' }), 'T T by A {unknown}');
    const r = buildFeedContent({ template: 'New: {title}', vars: { title: 'Hi' }, pingRoleId: '123456789012345678' });
    assert.equal(r.content, '<@&123456789012345678> New: Hi');
    assert.deepEqual(r.allowedMentions, { parse: [], roles: ['123456789012345678'] });
    assert.deepEqual(pingFor('everyone'), { mention: '@everyone', allowedMentions: { parse: ['everyone'] } });
    assert.deepEqual(pingFor('not-a-role'), { mention: null, allowedMentions: null });
    assert.ok(buildFeedContent({ template: '{t}', vars: { t: 'y'.repeat(5000) } }).content.length <= 2000);
});

test('keyword lists and the title filter', () => {
    assert.equal(cleanList(' Foo ,bar,, foo , baz  qux '), 'Foo, bar, baz qux');
    assert.equal(cleanList(''), null);
    assert.ok(titlePasses({}, 'anything'));
    assert.ok(titlePasses({ include: 'gpu, cpu' }, 'Cheap GPU deal'));
    assert.ok(!titlePasses({ include: 'gpu, cpu' }, 'Cheap RAM deal'));
    assert.ok(!titlePasses({ include: 'gpu', exclude: 'expired' }, '[GPU] deal (Expired)'));
});

test('go-live filters: empty passes, category exact (normalised), keywords in title or tags, both must match', () => {
    assert.ok(goLivePasses({}, { game_name: null, title: null }).ok);
    assert.ok(goLivePasses({ filter_categories: '', filter_title_keywords: null }, { game_name: 'Anything' }).ok);
    assert.ok(goLivePasses({ filter_categories: 'Fortnite, Just Chatting' }, { game_name: 'just chatting' }).ok);
    assert.ok(goLivePasses({ filter_categories: 'grand theft auto v' }, { game_name: 'Grand Theft Auto V' }).ok);
    assert.ok(!goLivePasses({ filter_categories: 'Fortnite' }, { game_name: 'Fortnite Festival' }).ok);
    assert.ok(!goLivePasses({ filter_categories: 'Fortnite' }, { game_name: null }).ok);
    assert.ok(goLivePasses({ filter_title_keywords: 'ranked' }, { title: 'RANKED grind' }).ok);
    assert.ok(goLivePasses({ filter_title_keywords: 'english' }, { title: 'chill', tags: ['English'] }).ok);
    assert.ok(!goLivePasses({ filter_categories: 'Fortnite', filter_title_keywords: 'ranked' }, { game_name: 'Fortnite', title: 'casual' }).ok);
});

test('attachGoLiveFilters copies filters by subscription and never throws', async () => {
    const subs = [{ subscription_id: 5 }, { subscription_id: 6 }];
    await attachGoLiveFilters({ query: async () => [[{ subscription_id: 5, filter_categories: 'Fortnite', filter_title_keywords: null }]] }, subs);
    assert.equal(subs[0].filter_categories, 'Fortnite');
    assert.equal(subs[1].filter_categories, undefined);
    const err = Object.assign(new Error("Unknown column 'filter_categories'"), { code: 'ER_BAD_FIELD_ERROR' });
    const untouched = [{ subscription_id: 1 }];
    await attachGoLiveFilters({ query: async () => { throw err; } }, untouched);
    assert.deepEqual(untouched, [{ subscription_id: 1 }]);
});
