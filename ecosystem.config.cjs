/**
 * PM2 process definition for the bot network.
 *
 * Previously the process was started ad-hoc (`pm2 start index.js`) with the
 * heap size passed as an interpreter arg and nothing else configured, so there
 * was no memory ceiling. That matters here more than in a typical Node service:
 * initializeManagers() builds ~30 manager objects per bot client and is called
 * once per custom bot, so at 41 bots the process holds ~1,200 manager instances
 * plus their caches. RSS sits around 2.5GB on a host that is already into swap.
 *
 * max_memory_restart is a backstop, not a fix — the real fix is hoisting shared
 * immutable data (phishing domain set, word banks, card decks) to process-level
 * singletons instead of per-client copies. Until that lands, a bounded restart
 * beats an OOM kill, because an OOM kill takes all 41 bots down at once with no
 * graceful shutdown.
 *
 * Set above the observed steady state (~2.5GB) and below the 4096MB heap cap so
 * PM2 recycles before V8 hits a hard allocation failure.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 reload ecosystem.config.cjs --update-env
 *
 * .cjs because package.json declares "type": "module" and PM2 requires CommonJS.
 */
// CF_NODE: node binary for the apps (deploy/switch scripts set it; default = the pm2 daemon's own node).
// Logs go under PM2_HOME (death's ~/.pm2 before the 2026-11 app-user switch, /var/lib/certifried/.pm2 after).
const PM2_LOGS = `${process.env.PM2_HOME || `${process.env.HOME}/.pm2`}/logs`;
const NODE = process.env.CF_NODE || undefined;

module.exports = {
    apps: [
        {
            name: 'CertiFriedUtility',
            script: 'index.js',
            cwd: '/home/death/CertiFriedUtility',
            interpreter: NODE,
            exec_mode: 'fork',
            instances: 1,

            // Discord.js keeps a lot of live state (guild/member/channel caches
            // across 41 clients). 4GB heap, recycle at 3GB RSS.
            node_args: '--max-old-space-size=4096 --heapsnapshot-signal=SIGUSR2 --diagnostic-dir=/home/death/heapsnaps',
            max_memory_restart: '3000M',

            autorestart: true,
            // Don't let a boot-loop hammer the Discord API and burn the
            // 200/day command-create budget on repeated deploys.
            min_uptime: '60s',
            max_restarts: 10,
            restart_delay: 5000,
            exp_backoff_restart_delay: 1000,

            watch: false,
            kill_timeout: 10000,

            env: {
                NODE_ENV: 'production',
                // getaddrinfo runs on the libuv thread pool (4 threads by default). When the
                // host resolver is slow every lookup holds a thread for seconds, so Discord
                // logins and DB connects queued behind them and timed out (2026-11-14).
                UV_THREADPOOL_SIZE: '32',
            },

            error_file: `${PM2_LOGS}/CertiFriedUtility-error.log`,
            out_file: `${PM2_LOGS}/CertiFriedUtility-out.log`,
            time: true,
        },
        {
            // Greenhouse Tycoon (services/cfx, docs/greenhouse-cutover.md). Its own process so the game keeps
            // running through bot restarts; LiteSpeed sends /gh-api/ here.
            name: 'greenhouse-tycoon',
            script: 'services/cfx/server.js',
            cwd: '/home/death/CertiFriedUtility',
            interpreter: NODE,
            exec_mode: 'fork',
            instances: 1,
            node_args: '--max-old-space-size=512',
            max_memory_restart: '400M',
            autorestart: true,
            min_uptime: '30s',
            max_restarts: 10,
            restart_delay: 5000,
            watch: false,
            kill_timeout: 10000,
            env: { NODE_ENV: 'production', CFX2_PORT: '4021' },
            time: true,
        },
    ],
};
