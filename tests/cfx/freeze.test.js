// CertiFried Tycoon freeze (H-636): the switch, which requests are refused, and the status answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const { isFrozen, isRefusedWhileFrozen, freezeMiddleware, statusHandler, FROZEN_MESSAGE } =
    await import('../../services/certifried-extension/freeze.js');

function withEnv(value, fn) {
    const saved = process.env.CFX_FROZEN;
    try {
        if (value === undefined) delete process.env.CFX_FROZEN; else process.env.CFX_FROZEN = value;
        return fn();
    } finally {
        if (saved === undefined) delete process.env.CFX_FROZEN; else process.env.CFX_FROZEN = saved;
    }
}

test('frozen unless CFX_FROZEN is exactly 0', () => {
    assert.equal(withEnv(undefined, isFrozen), true);
    for (const v of ['', '1', 'true', 'false', 'off', 'no', '00', '0x']) assert.equal(withEnv(v, isFrozen), true, v);
    assert.equal(withEnv('0', isFrozen), false);
    assert.equal(withEnv(' 0 ', isFrozen), false);
});

test('writes are refused except sign-in and session routes; GETs that tick or write are refused too', () => {
    for (const [m, p] of [['POST', '/shop/buy'], ['PUT', '/settings'], ['PATCH', '/settings'], ['DELETE', '/market/listings/1'],
        ['POST', '/minigames/submit'], ['POST', '/bits/redeem'], ['POST', '/admin/season']]) {
        assert.equal(isRefusedWhileFrozen(m, p), true, `${m} ${p}`);
    }
    for (const [m, p] of [['POST', '/auth/refresh'], ['POST', '/auth/twitch'], ['GET', '/auth/twitch/callback'],
        ['GET', '/auth/kick/callback'], ['OPTIONS', '/shop/buy'], ['GET', '/game/state'], ['GET', '/seasons'],
        ['GET', '/social/leaderboard'], ['GET', '/settings'], ['HEAD', '/seasons']]) {
        assert.equal(isRefusedWhileFrozen(m, p), false, `${m} ${p}`);
    }
    for (const p of ['/game/tick', '/vault', '/vault/', '/raid/status', '/dispensary', '/locations', '/grow/slots',
        '/territories/wars/7', '/reputation/growers', '/workers/logs', '/workers/config', '/stats', '/mutations',
        '/automation', '/extraction', '/bits/products']) {
        assert.equal(isRefusedWhileFrozen('GET', p), true, `GET ${p}`);
    }
});

test('middleware answers 503 FROZEN while frozen, lets everything through with CFX_FROZEN=0', async () => {
    const api = express.Router();
    api.get('/status', statusHandler);
    api.use(freezeMiddleware);
    api.use((req, res) => res.json({ reached: true }));
    const app = express();
    app.use('/api/v1', api);
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const saved = process.env.CFX_FROZEN;
    try {
        delete process.env.CFX_FROZEN;
        let res = await fetch(`${base}/shop/buy`, { method: 'POST' });
        assert.equal(res.status, 503);
        assert.deepEqual(await res.json(), { code: 'FROZEN', message: FROZEN_MESSAGE });
        res = await fetch(`${base}/seasons`);
        assert.equal(res.status, 200);
        res = await fetch(`${base}/auth/refresh`, { method: 'POST' });
        assert.equal(res.status, 200);
        res = await fetch(`${base}/status`);
        assert.deepEqual(await res.json(), { frozen: true, message: FROZEN_MESSAGE });

        process.env.CFX_FROZEN = '0';
        res = await fetch(`${base}/shop/buy`, { method: 'POST' });
        assert.equal(res.status, 200);
        res = await fetch(`${base}/status`);
        assert.deepEqual(await res.json(), { frozen: false, message: null });
    } finally {
        if (saved === undefined) delete process.env.CFX_FROZEN; else process.env.CFX_FROZEN = saved;
        await new Promise(r => server.close(r));
    }
});
