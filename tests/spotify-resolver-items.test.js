import './fixtures/test-log-dir.js';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

/*
 * core/spotify-resolver.js after Spotify's February 2026 Web API change (H-753): playlists are read from
 * GET /playlists/{id}/items (entries carry `item`), with GET /playlists/{id}/tracks (entries carry `track`) only
 * when /items is refused; artist links fall back to search when /artists/{id}/top-tracks is refused. Spotify is a
 * mocked axios: nothing leaves the machine.
 */

process.env.SPOTIFY_CLIENT_ID ||= 'test-client';
process.env.SPOTIFY_CLIENT_SECRET ||= 'test-secret';
const { resolveSpotify } = await import('../core/spotify-resolver.js');

const API = 'https://api.spotify.com/v1';
const T = (n, extra = {}) => ({ id: `t${n}`, name: `Song ${n}`, duration_ms: 1000 * n, explicit: n % 2 === 0, artists: [{ id: 'a1', name: 'Artist One' }], external_urls: { spotify: `https://open.spotify.com/track/t${n}` }, album: { images: [{ url: `https://i.scdn.co/${n}` }] }, ...extra });
const httpError = (status) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data: { error: { status, message: 'nope' } } } });

/** routes: [[test(url) → bool, reply(url) → data | throws]]; records every GET url. */
function fakeSpotify(routes) {
    const calls = [];
    mock.method(axios, 'post', async () => ({ data: { access_token: 'tok', expires_in: 3600 } }));
    mock.method(axios, 'get', async (url) => {
        calls.push(url);
        for (const [match, reply] of routes) if (match(url)) return { data: reply(url) };
        throw httpError(404);
    });
    return calls;
}

test.afterEach(() => mock.restoreAll());

test('a playlist is read from /items, every page, with the `item` wrapper', async () => {
    const calls = fakeSpotify([
        [(u) => u.startsWith(`${API}/playlists/P1?fields=name`), () => ({ name: 'Mix' })],
        [(u) => u.includes('offset=100'), () => ({ items: [{ item: T(3) }], next: null })],
        [(u) => u.startsWith(`${API}/playlists/P1/items`), () => ({ items: [{ item: T(1) }, { item: T(2), track: T(99) }], next: `${API}/playlists/P1/items?offset=100&limit=100` })],
    ]);
    const r = await resolveSpotify('https://open.spotify.com/playlist/P1');
    assert.equal(r.name, 'Mix');
    assert.deepEqual(r.tracks.map((t) => t.title), ['Song 1', 'Song 2', 'Song 3']);
    assert.equal(r.tracks[1].explicit, true);
    assert.equal(r.tracks[0].thumbnail, 'https://i.scdn.co/1');
    assert.ok(calls.some((u) => /\/playlists\/P1\/items\?limit=100&fields=items\(item\(/.test(u)), 'asks /items for item fields');
    assert.equal(calls.some((u) => u.includes('/tracks')), false, '/tracks is not called while /items works');
});

test('when /items is refused, the playlist is read from /tracks', async () => {
    for (const status of [403, 404, 410]) {
        const calls = fakeSpotify([
            [(u) => u.includes('?fields=name'), () => ({ name: 'Old app' })],
            [(u) => u.includes('/items'), () => { throw httpError(status); }],
            [(u) => u.includes('/playlists/P2/tracks'), () => ({ items: [{ track: T(4) }, { track: null }], next: null })],
        ]);
        const r = await resolveSpotify('https://open.spotify.com/playlist/P2');
        assert.deepEqual(r.tracks.map((t) => t.title), ['Song 4'], `fallback after ${status}`);
        assert.ok(calls.some((u) => /\/playlists\/P2\/tracks\?limit=100&fields=items\(track\(/.test(u)));
        mock.restoreAll();
    }
});

test('a server error on /items is not mistaken for a renamed endpoint', async () => {
    const calls = fakeSpotify([
        [(u) => u.includes('?fields=name'), () => ({ name: 'X' })],
        [(u) => u.includes('/items'), () => { throw httpError(500); }],
        [(u) => u.includes('/tracks'), () => ({ items: [{ track: T(5) }], next: null })],
    ]);
    assert.equal(await resolveSpotify('https://open.spotify.com/playlist/P3'), null);
    assert.equal(calls.some((u) => u.includes('/tracks')), false);
});

test('a playlist whose items Spotify withholds (not the app user\'s own) resolves to nothing, not an error', async () => {
    fakeSpotify([
        [(u) => u.includes('?fields=name'), () => ({ name: 'Someone else' })],
        [(u) => u.includes('/items'), () => ({ next: null })],
    ]);
    assert.equal(await resolveSpotify('https://open.spotify.com/playlist/P4'), null);
});

test('artist links: top tracks when Spotify has them, otherwise the artist\'s tracks from search', async () => {
    fakeSpotify([
        [(u) => u.endsWith('/artists/A1'), () => ({ name: 'Artist One' })],
        [(u) => u.includes('/artists/A1/top-tracks'), () => ({ tracks: [T(6), T(7)] })],
    ]);
    let r = await resolveSpotify('https://open.spotify.com/artist/A1');
    assert.equal(r.name, 'Artist One — Top Tracks');
    assert.deepEqual(r.tracks.map((t) => t.title), ['Song 6', 'Song 7']);
    mock.restoreAll();

    const calls = fakeSpotify([
        [(u) => u.endsWith('/artists/a1'), () => ({ name: 'Artist "One"' })],
        [(u) => u.includes('/top-tracks'), () => { throw httpError(403); }],
        [(u) => u.includes('/search?'), () => ({ tracks: { items: [T(8), T(9, { artists: [{ id: 'other', name: 'Someone' }] }), T(10)] } })],
    ]);
    r = await resolveSpotify('https://open.spotify.com/artist/a1');
    assert.deepEqual(r.tracks.map((t) => t.title), ['Song 8', 'Song 10'], 'only tracks the artist is credited on');
    const search = calls.find((u) => u.includes('/search?'));
    assert.match(search, /type=track&limit=10$/);
    assert.equal(decodeURIComponent(search).includes('artist:"Artist One"'), true);
});
