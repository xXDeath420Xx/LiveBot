/**
 * PM2 definition for windrose-agent.
 *
 * .cjs because package.json declares "type": "module" and PM2 needs CommonJS,
 * same as the main bot's ecosystem file.
 *
 * IMPORTANT — group membership: this process needs the `docker` group to reach
 * /var/run/docker.sock. `death` was added to that group on 2026-08-08, but PM2
 * spawns children with the groups of the shell that started the DAEMON, and
 * this daemon predates the change. Observed directly: the agent booted, served
 * its API, and got EACCES on every Docker call.
 *
 * Hence `script: start-agent.sh`, which re-execs under `sg docker`. The
 * alternative — `pm2 kill` + `pm2 resurrect` — would bounce the 41-bot
 * CertiFriedUtility process and everything else under PM2, which is far too
 * much disruption for one group bit. The wrapper stays correct either way.
 *
 * Memory: this holds no game state, just a small cache and cookie jar. A ceiling
 * this low is a leak detector, not a capacity plan.
 */
module.exports = {
    apps: [
        {
            name: 'windrose-agent',
            script: './start-agent.sh',
            interpreter: 'bash',
            cwd: '/home/death/CertiFriedUtility/windrose-agent',
            exec_mode: 'fork',
            instances: 1,

            autorestart: true,
            max_memory_restart: '256M',

            // Don't let a misconfigured .env boot-loop: config.js throws at
            // startup on missing secrets, and a tight restart cycle would bury
            // that error in log noise.
            min_uptime: '30s',
            max_restarts: 10,
            restart_delay: 5000,

            watch: false,
            kill_timeout: 10000,

            env: { NODE_ENV: 'production' },

            error_file: '/home/death/.pm2/logs/windrose-agent-error.log',
            out_file: '/home/death/.pm2/logs/windrose-agent-out.log',
            time: true,
        },
    ],
};
