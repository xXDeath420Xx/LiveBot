// Greenhouse Tycoon (cfx v2): standalone entry point. Runs as its own process (owner decision: its own pm2
// app, not inside the bot), so a game bug cannot stall the bot and the reverse.
//
//   node services/cfx/server.js        (from the repo root, so .env is found)
//
// Importing this file does nothing; start() runs only when it is the entry script.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { loadConfig } from './config/env.js';
import { createStore } from './store/index.js';
import { createAuth } from './http/auth.js';
import { createApp } from './http/app.js';
import { createScheduler } from './jobs/scheduler.js';
import { registerJobs } from './jobs/index.js';
import { createHints } from './realtime/hints.js';
import { createWsHub } from './realtime/ws.js';
import { createGame } from './store/game.js';
import { allowedOrigins } from './http/security.js';

export async function start(env = process.env) {
    const config = loadConfig(env);
    const hints = createHints();
    const store = createStore({
        db: pool,
        prefix: config.tablePrefix,
        logger,
        allowDevPlatform: config.allowDevPlatform,
        onLedgerCommit: (accountId, result) => hints.publish(accountId, result.stateVersion),
        refreshTtlMs: config.refreshTtlSec * 1000
    });
    await store.assertSchema();

    const auth = createAuth({ secret: config.jwtSecret, store, ttlSec: config.sessionTtlSec });
    const game = createGame({ store, logger, onChange: (accountId, version) => hints.publish(accountId, version) });
    const app = createApp({ store, auth, logger, config, game });
    const server = http.createServer(app);
    const ws = createWsHub({
        server, auth, hints, logger,
        origins: allowedOrigins({ publicOrigin: config.publicOrigin, twitchExtClientId: config.twitchExt.clientId })
    });
    server.headersTimeout = 15_000;
    server.requestTimeout = 20_000;
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, resolve);
    });
    logger.info('[cfx2] listening', {
        host: config.host, port: config.port, prefix: config.tablePrefix,
        twitchPanel: !!config.twitchExt.secret, twitchOAuth: !!config.twitchOAuth.clientId, kickOAuth: !!config.kickOAuth.clientId,
        discord: !!config.dashboardSecret
    });

    const scheduler = createScheduler({
        logger,
        envDisabled: config.jobsDisabled,
        isDisabled: name => store.flags.jobDisabled(name),
        lock: store.jobRuns,
        recorder: store.jobRuns
    });
    registerJobs(scheduler, { store, game, logger });
    scheduler.start();

    let stopping = false;
    async function stop(signal) {
        if (stopping) return;
        stopping = true;
        logger.info('[cfx2] stopping', { signal });
        await scheduler.stop({ waitMs: 10_000 });
        await ws.close();
        await new Promise(resolve => server.close(() => resolve()));
        await pool.end().catch(() => {});
        process.exit(0);
    }
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));

    return { server, scheduler, store, hints, ws, game, stop };
}

// Under pm2, argv[1] is pm2's own wrapper (ProcessContainerFork.js); pm2 puts the real script in pm_exec_path.
const entry = process.env.pm_exec_path || process.argv[1];
const isMain = !!entry && import.meta.url === pathToFileURL(entry).href;
if (isMain) {
    start().catch(err => {
        logger.error('[cfx2] failed to start', { error: err.message });
        process.exit(1);
    });
}
