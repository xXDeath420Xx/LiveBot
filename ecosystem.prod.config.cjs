/**
 * Production pm2 definitions for ALL CertiFried apps, run by the dedicated user `certifried`
 * (PM2_HOME=/var/lib/certifried/.pm2, node 22, pm2-certifried.service). Since 2026-11-21.
 *
 *   sudo -n -u certifried /usr/local/bin/cf-pm2 start /home/death/CertiFriedUtility/ecosystem.prod.config.cjs
 *   sudo -n -u certifried /usr/local/bin/cf-pm2 save
 *
 * Mirrors what death's pm2 ran until then (same scripts, args, limits). Changes go through scripts/deploy.sh.
 * Not in here (they stay in death's pm2): windrose-agent, havendock-cp, havendock-tunnel, oregon-trail-activity.
 * ecosystem.config.cjs (bot + greenhouse) is reused so the two can never drift apart.
 */
const H = '/home/death';
const CF = `${H}/CertiFriedUtility`;
const APP_HOME = '/var/lib/certifried';
const NODE = process.env.CF_NODE || '/opt/nvm/versions/node/v22.23.5/bin/node';
process.env.CF_NODE = NODE;
const base = require('./ecosystem.config.cjs').apps;   // CertiFriedUtility, greenhouse-tycoon

module.exports = {
    apps: [
        ...base,
        {
            name: 'certifried-stream',
            script: 'src/server.js',
            cwd: `${CF}/stream-relay`,
            exec_mode: 'cluster',
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '500M',
            env: { NODE_ENV: 'production' },
        },
        {
            name: 'cf-jellyfin-fed',
            script: 'standalone-rest.js',
            cwd: `${CF}/cf-jellyfin`,
            interpreter: NODE,
            autorestart: true,
        },
        {
            name: 'bgutil-provider',
            script: `${H}/bgutil-provider/server/build/main.js`,
            cwd: CF,
            interpreter: NODE,
            autorestart: true,
        },
        {
            name: 'whisper-fast',
            script: `${H}/whisper.cpp/build/bin/whisper-server`,
            cwd: `${H}/whisper.cpp`,
            interpreter: 'none',
            args: ['-m', `${H}/whisper.cpp/models/ggml-base.en.bin`, '--host', '127.0.0.1', '--port', '8178', '-t', '4', '-l', 'en', '-nt'],
            max_memory_restart: '1500M',
            autorestart: true,
        },
        {
            name: 'whisper-accurate',
            script: `${H}/whisper.cpp/build/bin/whisper-server`,
            cwd: `${H}/whisper.cpp`,
            interpreter: 'none',
            args: ['-m', `${H}/whisper.cpp/models/ggml-small.en.bin`, '--host', '127.0.0.1', '--port', '8179', '-t', '4', '-l', 'en', '-nt'],
            max_memory_restart: '1500M',
            autorestart: true,
        },
        {
            name: 'spotify-owner',
            script: `${H}/go-librespot/bin/go-librespot`,
            cwd: `${H}/go-librespot`,
            interpreter: 'none',
            args: ['--config_dir', `${H}/go-librespot/accounts/owner`],
            autorestart: true,
            time: true,
        },
        {
            name: 'spotify-owner-watchdog',
            script: `${CF}/scripts/spotify-owner-watchdog.sh`,
            cwd: APP_HOME,
            interpreter: 'bash',
            autorestart: true,
        },
        {
            name: 'gemini-collab-server',
            script: `${H}/claude-gemini-mcp/start-collab-server.sh`,
            cwd: CF,
            interpreter: 'bash',
            autorestart: true,
        },
        {
            name: 'music-resolver-tunnel-fwd',
            script: `${CF}/scripts/music-resolver-tunnel.sh`,
            cwd: APP_HOME,
            interpreter: 'bash',
            autorestart: true,
        },
        // the own-voice sidecar; its socket dir (certifried-data/voice/run) must belong to the bot's user
        ...require('./services/voice-sidecar/ecosystem.config.cjs').apps,
    ],
};
