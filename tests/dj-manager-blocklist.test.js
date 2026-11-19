import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

/*
 * The AI DJ honours the server's blocklist and favourites (core/dj-manager.cjs). Needs node_modules —
 * run on the server: node --test tests/dj-manager-blocklist.test.js
 *   - Gemini is told the exclusions, and blocked recommendations never reach the search step
 *   - the fallback prompts carry the exclusions too
 *   - favourites-seeded sessions re-pick their seed for every batch
 *   - with an empty blocklist the request to Gemini is exactly what it was before
 */
const require = createRequire(import.meta.url);
const gemini = require('../utils/gemini-api.cjs');
const DJManager = require('../core/dj-manager.cjs').default;
const lib = require('../core/dj-blocklist.cjs');
test.after(() => setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref());

function manager() {
    const client = { player: { events: new EventEmitter() } };
    return new DJManager(client);
}

test('blocked recommendations are dropped and Gemini is told the exclusions', async () => {
    const dj = manager();
    dj._blocklistCache.set('g1', { at: Date.now(), entries: [lib.entryFromRow({ entry_type: 'artist', artist: 'Nickelback' })] });
    const prompts = [];
    gemini.generatePlaylistRecommendations = async (song, artist, genre, played, prompt) => {
        prompts.push({ song, artist, genre, prompt });
        return [{ title: 'Photograph', artist: 'Nickelback' }, { title: 'Africa', artist: 'Toto' }];
    };
    const queue = { guild: { id: 'g1' }, metadata: {} };
    const recs = await dj.getRecommendationsWithFallback('Rosanna', 'Toto', null, [], null, queue);
    assert.deepEqual(recs.map(r => r.title), ['Africa']);
    assert.match(prompts[0].prompt, /^songs similar to "Rosanna" by Toto\. STRICT EXCLUSIONS.*Nickelback/);
});

test('fallbacks carry the exclusions and are filtered too', async () => {
    const dj = manager();
    dj._blocklistCache.set('g1', { at: Date.now(), entries: [lib.entryFromRow({ entry_type: 'song', title: 'Baby Shark' })] });
    const prompts = [];
    gemini.generatePlaylistRecommendations = async (song, artist, genre, played, prompt) => {
        prompts.push(prompt);
        return prompts.length === 1 ? [] : [{ title: 'Baby Shark', artist: 'Pinkfong' }, { title: 'White & Nerdy', artist: 'Weird Al Yankovic' }];
    };
    const recs = await dj.getRecommendationsWithFallback('Eat It', 'Weird Al', null, [], null, { guild: { id: 'g1' }, metadata: {} });
    assert.deepEqual(recs.map(r => r.title), ['White & Nerdy']);
    assert.match(prompts[1], /comedy, parody.*YouTube\. STRICT EXCLUSIONS.*"Baby Shark"/s);
});

test('no blocklist: the Gemini request is unchanged', async () => {
    const dj = manager();
    dj._blocklistCache.set('g1', { at: Date.now(), entries: [] });
    const calls = [];
    gemini.generatePlaylistRecommendations = async (...args) => { calls.push(args); return [{ title: 'A', artist: 'B' }]; };
    await dj.getRecommendationsWithFallback('Rosanna', 'Toto', 'rock', [], null, { guild: { id: 'g1' }, metadata: {} });
    assert.deepEqual(calls[0], ['Rosanna', 'Toto', 'rock', [], null]);
});

test('favourites-seeded sessions get a fresh seed every batch', async () => {
    const dj = manager();
    dj._blocklistCache.set('g1', { at: Date.now(), entries: [] });
    dj._favoritesCache.set('g1', { at: Date.now(), rows: [{ song_title: 'Africa', artist: 'Toto', priority: 5 }] });
    const prompts = [];
    gemini.generatePlaylistRecommendations = async (s, a, g, p, prompt) => { prompts.push(prompt); return [{ title: 'x', artist: 'y' }]; };
    const queue = { guild: { id: 'g1' }, metadata: { favoritesSeed: true, basePrompt: 'mood: chill' } };
    await dj.getRecommendationsWithFallback(null, null, null, [], 'stale prompt', queue);
    assert.equal(prompts[0], 'mood: chill. Base the mix on this server\'s favourite songs: "Africa" by Toto (similar songs, not only these)');
    assert.equal(queue.metadata.prompt, prompts[0]);
});

test('invalidateDJLibrary drops the cached lists', () => {
    const dj = manager();
    dj._blocklistCache.set('g1', { at: Date.now(), entries: [] });
    dj._favoritesCache.set('g1', { at: Date.now(), rows: [] });
    dj.invalidateDJLibrary('g1');
    assert.equal(dj._blocklistCache.has('g1'), false);
    assert.equal(dj._favoritesCache.has('g1'), false);
});
