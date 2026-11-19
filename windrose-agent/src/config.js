// Environment → typed config, validated once at boot.
//
// The container name is a CONSTANT here and is deliberately not configurable
// from the environment, let alone from a request. This agent holds the Docker
// socket, so "which container do I act on" is the single most dangerous input
// it could ever accept. Pinning it means the HTTP surface on :4091 cannot be
// coerced into stopping the database, the relay, or anything else on this host
// no matter what an attacker gets past the dashboard.
import 'dotenv/config';
import path from 'node:path';

export const CONTAINER_NAME = 'windrose';

function required(name) {
    const v = process.env[name];
    if (!v) {
        // Fail at boot, loudly. A half-configured agent that starts and then
        // 500s on every call is harder to diagnose than one that refuses to run.
        throw new Error(`windrose-agent: missing required env ${name}`);
    }
    return v;
}

function dir(name, fallback) {
    const v = process.env[name] || fallback;
    return path.resolve(v);
}

export const config = {
    containerName: CONTAINER_NAME,

    agentSecret: required('WINDROSE_AGENT_SECRET'),
    agentPort: Number(process.env.WINDROSE_AGENT_PORT || 4091),

    wplusUrl: (process.env.WINDROSE_PLUS_URL || 'http://127.0.0.1:8780').replace(/\/$/, ''),
    rconPassword: required('WINDROSE_PLUS_RCON_PASSWORD'),

    serverFiles: dir('WINDROSE_SERVER_FILES', '/srv/windrose/server-files'),
    backupDir: dir('WINDROSE_BACKUP_DIR', '/srv/windrose/backups'),
    composeDir: dir('WINDROSE_COMPOSE_DIR', '/srv/windrose'),

    connectAddress: process.env.WINDROSE_CONNECT_ADDRESS || 'windrose.certifriedmultitool.com:7777',

    // Windrose+ rate limits POST /api/rcon to 1 req/s per client IP, and this
    // agent is that one IP for every friend using the panel. 1100ms rather than
    // 1000ms so clock jitter can't push two calls into the same second.
    rconMinIntervalMs: 1100,

    // Long enough for slow commands, short enough that a wedged server doesn't
    // pin a queue slot forever. Windrose+ expires its own spool entries at 30s.
    rconTimeoutMs: 25_000,

    statusCacheTtlMs: 2_000,
    commandsCacheTtlMs: 60_000,
};

// Derived path — the Lua RCON module's spool and status files live here. The
// agent reads these to get liveness and console history WITHOUT spending the
// 1 req/s RCON budget. See spec §2b.
export const spoolPaths = {
    root: path.join(config.serverFiles, 'windrose_plus_data'),
    rconStatus: path.join(config.serverFiles, 'windrose_plus_data', 'rcon_status.json'),
    serverStatus: path.join(config.serverFiles, 'windrose_plus_data', 'server_status.json'),
    livemap: path.join(config.serverFiles, 'windrose_plus_data', 'livemap_data.json'),
    consoleHistory: path.join(config.serverFiles, 'windrose_plus_data', 'console_history.json'),
    commands: path.join(config.serverFiles, 'windrose_plus_data', 'commands.json'),
};
