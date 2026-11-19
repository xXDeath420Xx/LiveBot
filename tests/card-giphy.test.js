import './fixtures/test-log-dir.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { createCardGiphyRouter, pickGiphyFields, makeKeyReader } from '../dashboard/routes/card-giphy.js';

/*
 * The birthday card's GIPHY proxy (dashboard/routes/card-giphy.js): the GIF and sticker pickers call
 * /card/:token/giphy/<gifs|stickers>/<trending|search>, the server adds the key, and only the fields the page reads come
 * back. Only for a card that exists and, when it has a password, that this session unlocked. Rate-limited. The page
 * no longer holds a GIPHY key or calls api.giphy.com. GIPHY and the database are fakes.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'test-giphy-key-not-real';
const CARDS = { open1: { id: 1, password_hash: null }, locked2: { id: 2, password_hash: 'x' } };
const pool = { async execute(sql, [slug]) { return [CARDS[slug] ? [CARDS[slug]] : []]; } };
const gif = (n, extra = {}) => ({
    id: `g${n}`, title: `Cake ${n}`, url: `https://giphy.com/gifs/g${n}`, user: { display_name: 'someone' }, analytics: { onload: { url: 'https://giphy-analytics.giphy.com/x' } },
    images: {
        original: { url: `https://media.giphy.com/media/g${n}/giphy.gif`, width: '480', size: '1234' },
        fixed_width: { url: `https://media2.giphy.com/media/g${n}/200w.gif` },
        fixed_width_small: { url: `https://media3.giphy.com/media/g${n}/100w.gif` },
        fixed_width_downsampled: { url: `https://media4.giphy.com/media/g${n}/200w_d.gif` },
        downsized_large: { url: `https://media.giphy.com/media/g${n}/l.gif` },
    }, ...extra,
});

async function serve({ unlocked = [], max = 40, fetchImpl, getKey = () => KEY } = {}) {
    const calls = [];
    const app = express();
    app.use((req, res, next) => { req.session = Object.fromEntries(unlocked.map((id) => [`card_unlocked_${id}`, true])); next(); });
    app.use('/', createCardGiphyRouter({ pool, getKey, limit: { max }, fetchImpl: fetchImpl || (async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ data: [gif(1), gif(2)], pagination: {}, meta: { status: 200 } }) }; }) }));
    const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return { calls, base, get: (p) => fetch(base + p), close: () => new Promise((r) => server.close(r)) };
}

test('only the fields the page uses, and only GIPHY https URLs', () => {
    const out = pickGiphyFields({ data: [gif(1), gif(2, { images: { original: { url: 'http://evil.example/x.gif' } } }), { title: 'no images' }] });
    assert.equal(out.data.length, 1);
    assert.deepEqual(Object.keys(out.data[0]).sort(), ['images', 'title']);
    assert.deepEqual(Object.keys(out.data[0].images).sort(), ['fixed_width', 'fixed_width_downsampled', 'fixed_width_small', 'original']);
    assert.deepEqual(out.data[0].images.original, { url: 'https://media.giphy.com/media/g1/giphy.gif' });
    assert.deepEqual(pickGiphyFields(null), { data: [] });
});

test('trending and search for GIFs and stickers make the same GIPHY calls as the page did, with the key added on the server', async () => {
    const s = await serve();
    try {
        for (const kind of ['gifs', 'stickers']) {
            let r = await s.get(`/card/open1/giphy/${kind}/trending`);
            assert.equal(r.status, 200);
            const body = await r.json();
            assert.equal(body.data.length, 2);
            assert.equal(JSON.stringify(body).includes(KEY), false, 'the key never reaches the browser');
            assert.equal(JSON.stringify(body).includes('analytics'), false);
            r = await s.get(`/card/open1/giphy/${kind}/search?q=${encodeURIComponent('happy birthday')}`);
            assert.equal(r.status, 200);
        }
        const urls = s.calls.map((u) => new URL(u));
        assert.deepEqual(urls.map((u) => u.origin + u.pathname), [
            'https://api.giphy.com/v1/gifs/trending', 'https://api.giphy.com/v1/gifs/search',
            'https://api.giphy.com/v1/stickers/trending', 'https://api.giphy.com/v1/stickers/search']);
        for (const u of urls) {
            assert.equal(u.searchParams.get('api_key'), KEY);
            assert.equal(u.searchParams.get('limit'), '30');
            assert.equal(u.searchParams.get('rating'), 'pg-13');
        }
        assert.equal(urls[1].searchParams.get('q'), 'happy birthday');
        assert.equal(urls[0].searchParams.has('q'), false);
    } finally { await s.close(); }
});

test('refused: unknown kind or mode, empty or long search, unknown card, locked card; GIPHY is not called', async () => {
    const s = await serve();
    try {
        for (const [p, code] of [['/card/open1/giphy/videos/trending', 404], ['/card/open1/giphy/gifs/random', 404], ['/card/open1/giphy/gifs/search', 400],
            [`/card/open1/giphy/gifs/search?q=${'a'.repeat(101)}`, 400], ['/card/nope/giphy/gifs/trending', 404], ['/card/locked2/giphy/gifs/trending', 403]]) {
            assert.equal((await s.get(p)).status, code, p);
        }
        assert.equal(s.calls.length, 0);
    } finally { await s.close(); }
    const unlocked = await serve({ unlocked: [2] });
    try { assert.equal((await unlocked.get('/card/locked2/giphy/gifs/trending')).status, 200, 'after unlocking'); } finally { await unlocked.close(); }
});

test('no key: 503; GIPHY down or refusing: 502, without the key in the answer', async () => {
    let s = await serve({ getKey: () => null });
    try { assert.equal((await s.get('/card/open1/giphy/gifs/trending')).status, 503); } finally { await s.close(); }
    s = await serve({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: 'Invalid key' }) }) });
    try {
        const r = await s.get('/card/open1/giphy/gifs/trending');
        assert.equal(r.status, 502);
        assert.equal((await r.text()).includes(KEY), false);
    } finally { await s.close(); }
    s = await serve({ fetchImpl: async () => { throw new Error(`connect failed api_key=${KEY}`); } });
    try {
        const r = await s.get('/card/open1/giphy/gifs/trending');
        assert.equal(r.status, 502);
        assert.equal((await r.text()).includes(KEY), false);
    } finally { await s.close(); }
});

test('rate-limited per address', async () => {
    const s = await serve({ max: 3 });
    try {
        const codes = [];
        for (let i = 0; i < 5; i++) codes.push((await s.get('/card/open1/giphy/gifs/trending')).status);
        assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    } finally { await s.close(); }
});

test('the key comes from the .env file, re-read when it changes (rotation needs no restart), else from the environment', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'giphy-env-'));
    const file = path.join(dir, '.env');
    try {
        assert.equal(makeKeyReader({ envFile: file, env: { GIPHY_API_KEY: 'from-env' } })(), 'from-env');
        fs.writeFileSync(file, 'OTHER=1\nGIPHY_API_KEY=first\n');
        const read = makeKeyReader({ envFile: file, env: {} });
        assert.equal(read(), 'first');
        fs.writeFileSync(file, 'GIPHY_API_KEY=rotated\n');
        fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
        assert.equal(read(), 'rotated');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the card page holds no GIPHY key and calls only the proxy', () => {
    const page = fs.readFileSync(path.join(ROOT, 'dashboard/views/birthday-card.ejs'), 'utf8');
    for (const re of [/GIPHY_KEY/, /api_key/, /api\.giphy\.com/, /['"][A-Za-z0-9]{32}['"]/]) assert.equal(re.test(page), false, `no ${re}`);
    assert.match(page, /var GIPHY_PROXY = '\/card\/' \+ encodeURIComponent\(/);
    assert.equal((page.match(/GIPHY_PROXY \+/g) || []).length, 3, 'trending, search and the edit picker');
    assert.match(fs.readFileSync(path.join(ROOT, 'dashboard/server.js'), 'utf8'), /import\('\.\/routes\/card-giphy\.js'\)/);
});
