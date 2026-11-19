// windrose-agent entry point.
//
// Wires the modules together and starts the localhost control API. Everything
// interesting lives in the modules; this file is deliberately just assembly, so
// that the dependency graph is visible in one place.

import { config } from './config.js';
import { createWplusClient } from './wplus-client.js';
import { createQueue } from './queue.js';
import { createCache } from './cache.js';
import { createSpool } from './spool.js';
import { createDocker } from './docker.js';
import { createBackups } from './backups.js';
import { createConfigWriter } from './configwriter.js';
import { createFiles, createMods } from './files.js';
import { createScheduler } from './scheduler.js';
import { createUpdater } from './updater.js';
import { createSaves } from './saves.js';
import { createPlayers } from './players.js';
import { createSettings } from './settings.js';
import { createIniFiles } from './inifiles.js';
import { createAutoUpdate } from './autoupdate.js';
import { createControlApi } from './control-api.js';

const log = {
    info: (m) => console.log(`[windrose-agent] ${m}`),
    warn: (m) => console.warn(`[windrose-agent] WARN ${m}`),
    error: (m) => console.error(`[windrose-agent] ERROR ${m}`),
};

const client = createWplusClient({
    baseUrl: config.wplusUrl,
    password: config.rconPassword,
    rconTimeoutMs: config.rconTimeoutMs,
});
const queue = createQueue({ minIntervalMs: config.rconMinIntervalMs, timeoutMs: config.rconTimeoutMs });
const cache = createCache();
const spool = createSpool();
const docker = createDocker();
const backups = createBackups({ docker, logger: log });
const configWriter = createConfigWriter({ docker });
const files = createFiles();
const mods = createMods({ files });

const scheduler = createScheduler({
    docker,
    backups,
    // Warnings go out over RCON through the same queue as everything else, so
    // a restart notice cannot jump the rate limit ahead of a player's command.
    broadcast: (message) => queue.push(() => client.rcon(`wp.say ${message}`)),
    logger: log,
});

const updater = createUpdater({ docker });
const settings = createSettings({ docker });
const ini = createIniFiles({ docker });
const autoUpdate = createAutoUpdate({ updater, docker, spool, backups, logger: log });
const saves = createSaves({ docker });
// Moderation shares the RCON queue so a ban cannot jump the 1 req/s budget.
const players = createPlayers({ spool, rcon: (cmd) => queue.push(() => client.rcon(cmd)) });

const api = createControlApi({
    docker, backups, configWriter, files, mods, spool, client, queue, cache, scheduler, updater, saves, players, settings, ini, autoUpdate, logger: log,
});

const { port } = await api.listen();
log.info(`control API listening on 127.0.0.1:${port} (${api._routes.length} routes)`);

// Report what we're managing at boot, but never fail to start because the game
// is down — the panel's main job in that situation is to say so and offer a
// start button.
try {
    const state = await docker.state();
    log.info(`container ${config.containerName}: ${state.status}${state.running ? '' : ' (not running)'}`);
} catch (err) {
    log.warn(`could not inspect container: ${err.message}`);
}
try {
    const health = await client.health();
    log.info(`windrose+ ${health.version} reachable at ${config.wplusUrl}`);
} catch (err) {
    log.warn(`windrose+ not reachable yet: ${err.message}`);
}

// Start the watcher if the owner has enabled it. Disabled by default: an
// unattended update of a modded server is a real risk and should be an explicit
// choice, not a surprise.
const auto = autoUpdate.start();
log.info(`auto-update: ${autoUpdate.enabled ? `on, every ${auto.intervalMinutes}m` : 'off'}`);

async function shutdown(signal) {
    log.info(`${signal} received, shutting down`);
    scheduler.cancel();
    autoUpdate.stop();
    await api.close().catch(() => {});
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
