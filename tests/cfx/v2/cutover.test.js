// Greenhouse Tycoon (cfx v2), phase 5: the cutover switch GREENHOUSE_LIVE (services/cfx/integrations/cutover.js).
// Off (unset, 0, anything but 1): everything behaves as before. On (1):
//   - the dashboard answers /game, /game/*, /cfx/* and /cfx-api/* itself (301 pages, 410 API), WebSockets 410;
//   - the old game server answers every request that way if it is started anyway;
//   - the bot does not start the old game server, and the old game's jobs refuse to start;
//   - /arcade cfx (removed from the command, H-650; core/retired-commands.js) and !cfx answer once with the new link.
// Also: the dead old dashboard page and its API route are gone. No database tables are created here.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
    isGreenhouseLive, oldGameAnswer, oldGameRoutes, refuseOldGameUpgrade, oldGameMovedMessage, greenhouseUrl, GREENHOUSE_PATH
} from '../../../services/cfx/integrations/cutover.js';
import { cfxProxy, attachCfxUpgrade } from '../../../services/certifried-extension/integration/dashboard-proxy.js';
import { FROZEN_MESSAGE } from '../../../services/certifried-extension/freeze.js';
import { closePool } from './_helpers.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (f) => fs.readFileSync(path.join(repo, f), 'utf8');
const saved = { live: process.env.GREENHOUSE_LIVE, port: process.env.CFX_PORT };

function setLive(value) {
    if (value === undefined) delete process.env.GREENHOUSE_LIVE; else process.env.GREENHOUSE_LIVE = value;
}

after(async () => {
    setLive(saved.live);
    if (saved.port === undefined) delete process.env.CFX_PORT; else process.env.CFX_PORT = saved.port;
    await closePool();
});

/** A port nothing listens on (bound, then closed), so the old proxy's upstream answers "connection refused". */
async function deadPort() {
    const s = net.createServer();
    await new Promise(r => s.listen(0, '127.0.0.1', r));
    const port = s.address().port;
    await new Promise(r => s.close(r));
    return port;
}

/** The dashboard's order: oldGameRoutes(), then the old proxy, then everything else. */
async function dashboardApp() {
    const app = express();
    app.use(oldGameRoutes());
    app.use(cfxProxy());
    app.get('/game/session/discord', (req, res) => res.json({ old: true }));
    app.get('/greenhouse', (req, res) => res.send('new game'));
    app.get('/games', (req, res) => res.send('games page'));
    app.use((req, res) => res.status(404).send('dashboard 404'));
    const server = http.createServer(app);
    attachCfxUpgrade(server);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function get(base, url, method = 'GET') {
    const res = await fetch(base + url, { method, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, location: res.headers.get('location'), cache: res.headers.get('cache-control'), json, text };
}

/** Raw WebSocket handshake; resolves with the first status line. */
function upgrade(base, url) {
    const { port } = new URL(base);
    return new Promise((resolve) => {
        const sock = net.connect(Number(port), '127.0.0.1', () => {
            sock.write(`GET ${url} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
        });
        let buf = '';
        sock.on('data', (d) => { buf += d.toString(); });
        sock.on('close', () => resolve(buf.split('\r\n')[0]));
        sock.on('error', () => resolve(buf.split('\r\n')[0] || 'error'));
        setTimeout(() => { sock.destroy(); }, 3000);
    });
}

describe('the flag', () => {
    test('only exactly "1" is on', () => {
        assert.equal(isGreenhouseLive({}), false);
        for (const v of ['', '0', 'true', 'yes', '01', 'on']) assert.equal(isGreenhouseLive({ GREENHOUSE_LIVE: v }), false, v);
        assert.equal(isGreenhouseLive({ GREENHOUSE_LIVE: '1' }), true);
        assert.equal(isGreenhouseLive({ GREENHOUSE_LIVE: ' 1 ' }), true);
    });

    test('the moved message names the new game and its address, in neutral words', () => {
        assert.equal(greenhouseUrl({}), 'https://certifriedmultitool.com/greenhouse');
        assert.equal(greenhouseUrl({ CFX2_PUBLIC_URL: 'https://example.test/' }), 'https://example.test/greenhouse');
        const m = oldGameMovedMessage({});
        assert.match(m, /Greenhouse Tycoon/);
        assert.ok(m.endsWith('https://certifriedmultitool.com/greenhouse'));
    });

    test('which old address gets a 301 and which a 410', () => {
        const cases = [
            ['GET', '/game', 301], ['GET', '/game/', 301], ['GET', '/game?signin=discord', 301], ['GET', '/game/session/discord', 301],
            ['HEAD', '/game', 301], ['GET', '/cfx', 301], ['GET', '/cfx/', 301], ['GET', '/cfx/panel.html', 301],
            ['GET', '/cfx-api/game', 301], ['GET', '/cfx-api/', 301],
            ['GET', '/cfx/api/v1/status', 410], ['POST', '/cfx/api/v1/grow/plant', 410], ['GET', '/cfx-api/api/v1/game/state', 410],
            ['GET', '/cfx/dist/app.js', 410], ['GET', '/cfx/health', 410], ['GET', '/cfx-api/ws', 410], ['POST', '/game', 410]
        ];
        for (const [m, u, s] of cases) assert.equal(oldGameAnswer(m, u)?.status, s, `${m} ${u}`);
        for (const u of ['/', '/greenhouse', '/games', '/gamer', '/cfxx', '/gh-api/api/v2/health', '/privacy']) {
            assert.equal(oldGameAnswer('GET', u), null, `${u} is not the old game`);
        }
        // the old game server: everything is the old game
        assert.equal(oldGameAnswer('GET', '/', { scope: 'all' }).status, 301);
        assert.equal(oldGameAnswer('GET', '/api/v1/status', { scope: 'all' }).status, 410);
        assert.equal(oldGameAnswer('GET', '/dist/app.js', { scope: 'all' }).status, 410);
        assert.equal(oldGameAnswer('GET', '/health', { scope: 'all' }).status, 410);
    });
});

describe('dashboard routes', () => {
    test('flag off: /game still goes to the old game server (here not running: 502), nothing else changes', async () => {
        process.env.CFX_PORT = String(await deadPort());
        setLive(undefined);
        const { server, base } = await dashboardApp();
        try {
            const g = await get(base, '/game');
            assert.equal(g.status, 502);
            assert.equal(g.json.code, 'GAME_OFFLINE');
            assert.equal((await get(base, '/cfx/')).status, 302, 'the old /cfx -> /game redirect');
            assert.equal((await get(base, '/game/session/discord')).json.old, true);
            assert.equal((await get(base, '/greenhouse')).text, 'new game');
            assert.equal((await get(base, '/games')).text, 'games page');
            setLive('0');
            assert.equal((await get(base, '/game')).status, 502);
        } finally {
            server.close();
            setLive(undefined);
        }
    });

    test('flag on: pages 301 to /greenhouse (cached a day), API and files 410 with the new address', async () => {
        process.env.CFX_PORT = String(await deadPort());
        setLive('1');
        const { server, base } = await dashboardApp();
        try {
            for (const u of ['/game', '/game/', '/game/session/discord', '/cfx', '/cfx/', '/cfx-api/game']) {
                const r = await get(base, u);
                assert.equal(r.status, 301, u);
                assert.equal(r.location, GREENHOUSE_PATH, u);
                assert.equal(r.cache, 'public, max-age=86400', u);
            }
            for (const [m, u] of [['GET', '/cfx/api/v1/status'], ['POST', '/cfx/api/v1/grow/plant'], ['GET', '/cfx-api/api/v1/game/state'], ['GET', '/cfx/dist/app.js'], ['DELETE', '/game']]) {
                const r = await get(base, u, m);
                assert.equal(r.status, 410, `${m} ${u}`);
                assert.equal(r.json.error.code, 'MOVED');
                assert.equal(r.json.error.url, 'https://certifriedmultitool.com/greenhouse');
                assert.equal(r.cache, 'no-store');
            }
            assert.equal((await get(base, '/greenhouse')).text, 'new game');
            assert.equal((await get(base, '/games')).text, 'games page');
            assert.equal((await get(base, '/nothing-here')).text, 'dashboard 404');
        } finally {
            server.close();
            setLive(undefined);
        }
    });

    test('WebSockets: flag off they are still forwarded to the old game (here refused upstream), flag on 410', async () => {
        process.env.CFX_PORT = String(await deadPort());
        const { server, base } = await dashboardApp();
        try {
            setLive(undefined);
            assert.match(await upgrade(base, '/cfx/ws'), /502/);
            setLive('1');
            assert.match(await upgrade(base, '/cfx/ws'), /410/);
            assert.match(await upgrade(base, '/cfx-api/ws'), /410/);
        } finally {
            server.close();
            setLive(undefined);
        }
    });

    test('the dashboard mounts oldGameRoutes() before the old proxy', () => {
        const src = read('dashboard/server.js');
        const a = src.indexOf('app.use(oldGameRoutes());');
        const b = src.indexOf('app.use(cfxProxy());');
        assert.ok(a > 0 && b > a, 'oldGameRoutes() first');
        assert.ok(src.indexOf("import { oldGameRoutes } from '../services/cfx/integrations/cutover.js';") > 0);
        assert.match(read('services/certifried-extension/integration/dashboard-proxy.js'), /if \(refuseOldGameUpgrade\(req, socket\)\) return;/);
    });
});

describe('the old game server, if it runs anyway', () => {
    test('scope "all": every page 301, everything else 410, upgrades 410; flag off: untouched', async () => {
        const app = express();
        app.use(oldGameRoutes({ scope: 'all' }));
        app.use((req, res) => res.send('old page'));
        const server = http.createServer(app);
        server.on('upgrade', (req, socket) => {
            if (refuseOldGameUpgrade(req, socket, { scope: 'all' })) return;
            socket.end('HTTP/1.1 101 Switching Protocols\r\n\r\n');
        });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            setLive(undefined);
            assert.equal((await get(base, '/game')).text, 'old page');
            assert.equal((await get(base, '/api/v1/status')).text, 'old page');
            assert.match(await upgrade(base, '/ws'), /101/);
            setLive('1');
            for (const u of ['/', '/game', '/cfx/', '/cfx-api/game']) assert.equal((await get(base, u)).status, 301, u);
            for (const u of ['/api/v1/status', '/cfx-api/api/v1/game/state', '/dist/app.js', '/health', '/cfx/standalone.js']) assert.equal((await get(base, u)).status, 410, u);
            assert.match(await upgrade(base, '/ws'), /410/);
            assert.match(await upgrade(base, '/cfx-api/ws'), /410/);
        } finally {
            server.close();
            setLive(undefined);
        }
    });

    test('server.js mounts it first and refuses upgrades; the boot-time data fix-up is skipped when live', () => {
        const src = read('services/certifried-extension/server.js');
        const mount = src.indexOf("app.use(oldGameRoutes({ scope: 'all' }));");
        assert.ok(mount > 0);
        assert.ok(mount < src.indexOf('app.use(helmet('), 'before every other middleware');
        assert.ok(mount < src.indexOf("app.use('/cfx', express.static("), 'before the old static files');
        assert.match(src, /if \(refuseOldGameUpgrade\(req, socket, \{ scope: 'all' \}\)\) return;/);
        assert.match(src, /if \(isFrozen\(\) \|\| isGreenhouseLive\(\)\) \{/);
    });

    test('the old game\'s jobs refuse to start when live', async () => {
        setLive('1');
        try {
            const jobs = await import('../../../services/certifried-extension/jobs/index.js');
            assert.equal(await jobs.startJobs(), undefined);
            const src = read('services/certifried-extension/jobs/index.js');
            assert.ok(src.indexOf('if (isGreenhouseLive()) {') < src.indexOf('if (isFrozen()) {'), 'checked before anything else');
        } finally {
            setLive(undefined);
        }
    });

    test('the bot does not start the old game server when live (index.js)', () => {
        const src = read('index.js');
        const guard = src.indexOf('if (isGreenhouseLive()) {');
        const start = src.indexOf('await certiFriedExtension.start();');
        const elseAt = src.indexOf('} else {', guard);
        assert.ok(guard > 0 && elseAt > guard && start > elseAt, 'the start call is in the else branch of the flag check');
        assert.equal(src.split('certiFriedExtension.start()').length - 1, 1, 'started from one place only');
    });
});

describe('Discord and chat commands', () => {
    function fakeInteraction() {
        const calls = [];
        return {
            calls,
            deferred: false,
            replied: false,
            user: { id: '000000000000000551', username: 'tester', displayAvatarURL: () => null },
            guild: null,
            options: { getString: () => null, getInteger: () => null },
            reply: async (m) => { calls.push(['reply', m]); },
            editReply: async (m) => { calls.push(['editReply', m]); },
            deferReply: async () => { calls.push(['deferReply']); }
        };
    }

    test('/arcade cfx: removed from /arcade (H-650); every old subcommand answers once with the new link, or the frozen message with the flag off', async () => {
        const arcade = (await import('../../../commands/games/arcade.js')).default;
        const groups = arcade.data.toJSON().options.filter(o => o.type === 2).map(o => o.name);
        assert.ok(!groups.includes('cfx'), 'no cfx group any more');
        assert.ok(groups.includes('greenhouse'), 'the greenhouse group stays');
        assert.equal(fs.existsSync(path.join(repo, 'commands/games/arcade-cfx-handler.js')), false);

        const { retiredMessage, replyRetired } = await import('../../../core/retired-commands.js');
        for (const sub of ['stats', 'daily', 'leaderboard', 'market', 'sell', 'play']) {
            setLive('1');
            assert.equal(retiredMessage(`/arcade cfx ${sub}`), oldGameMovedMessage(), `${sub}: typed as text`);
            const live = fakeInteraction();
            await replyRetired(live, `arcade cfx ${sub}`);
            assert.equal(live.calls.length, 1, `${sub}: one answer`);
            assert.equal(live.calls[0][0], 'reply');
            assert.equal(live.calls[0][1].content, oldGameMovedMessage());
            setLive(undefined);
            assert.equal(retiredMessage(['arcade', 'cfx', sub]), FROZEN_MESSAGE, `${sub}: frozen with the flag off`);
        }
    });

    test('!cfx chat commands: the same line when live, the frozen message otherwise', async () => {
        const chat = await import('../../../services/certifried-bot/commands/cfx.js');
        for (const name of ['cfxCommand', 'cfxDailyCommand', 'cfxMarketCommand', 'cfxLeaderboardCommand', 'cfxSellCommand']) {
            const said = [];
            setLive('1');
            await chat[name]({ username: 'u', userId: '1', reply: async (m) => said.push(m), profile: null, args: [] });
            setLive(undefined);
            await chat[name]({ username: 'u', userId: '1', reply: async (m) => said.push(m), profile: null, args: [] });
            assert.deepEqual(said, [oldGameMovedMessage(), FROZEN_MESSAGE], name);
        }
    });
});

describe('dead old dashboard surfaces are gone', () => {
    test('the old page partial and its API route are removed; ?page=cfx still opens the Greenhouse page', async () => {
        assert.equal(fs.existsSync(path.join(repo, 'dashboard/views/partials/manage/cfx.ejs')), false);
        assert.equal(fs.existsSync(path.join(repo, 'dashboard/routes/api/features/cfx.js')), false);
        const api = read('dashboard/routes/api/index.js');
        assert.ok(!api.includes("features/cfx.js"));
        assert.ok(!api.includes("'/guilds/:guildId/cfx'"));
        assert.ok(api.includes("'/guilds/:guildId/greenhouse'"));
        const { PAGE_ALIASES } = await import('../../../core/manage-nav.js');
        assert.equal(PAGE_ALIASES.cfx, 'greenhouse');
        assert.match(read('dashboard/views/manage-tailwind.ejs'), /'cfx': \{ partial: 'greenhouse'/);
    });
});
