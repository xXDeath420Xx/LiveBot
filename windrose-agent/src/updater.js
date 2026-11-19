// Updates — the GAME build, and separately the container image.
//
// These are two different things and conflating them cost a live outage on
// 2026-08-25. The container image is the Wine/SteamCMD wrapper; the game itself
// lives in the bind mount and is only refreshed by SteamCMD when
// UPDATE_ON_START=true. A panel button that pulled the image reported success,
// changed nothing players could see, and left the server rejecting every
// connection with a DeploymentId mismatch.
//
// So updateGame() below is the one that matters: it flips UPDATE_ON_START on
// for exactly one boot, recreates, waits, and puts the flag back. The flag stays
// false the rest of the time on purpose — an unattended Steam update landing
// mid-restart is how UE4SS/Windrose+ compatibility breaks at 4am.
//
// This is the one place the agent runs an external command, so the reasoning
// matters. Recreating a container with the settings compose applied — the 16G
// mem_limit, the loopback bind on 8780, both 7777 protocols, the volume — means
// either re-implementing all of it against the Docker API and keeping it in
// sync with docker-compose.yml by hand, or asking compose to do it. Duplicating
// that config is how the memory cap silently goes missing after an update.
//
// So we shell out, under strict conditions:
//   - execFile, never exec: no shell, so no metacharacter parsing.
//   - The argv is a hardcoded constant. Nothing from a request reaches it.
//   - cwd is the compose directory from config, not from a request.
//   - There is no parameterised variant. This is one fixed operation, not an
//     "run a docker command" primitive, and it must stay that way.
//
// docker.js still holds the rule that no generic exec exists; this module is
// the deliberate, bounded exception and should remain the only one.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const run = promisify(execFile);

// Fixed argv. Do not make these configurable.
const PULL_ARGV = ['compose', 'pull'];
const UP_ARGV = ['compose', 'up', '-d'];
const RECREATE_ARGV = ['compose', 'up', '-d', '--force-recreate'];

/** Read the game build the server last wrote into ServerDescription.json. */
async function readGameBuild(serverFiles) {
    try {
        const d = JSON.parse(await readFile(path.join(serverFiles, 'R5', 'ServerDescription.json'), 'utf8'));
        return d.DeploymentId || null;
    } catch {
        return null;
    }
}

/** Flip one key in the compose .env, preserving comments and every other line. */
async function setEnvFlag(composeDir, key, value) {
    const envPath = path.join(composeDir, '.env');
    const original = await readFile(envPath, 'utf8');
    const lines = original.split('\n');
    const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    const previous = idx >= 0 ? lines[idx].split('=').slice(1).join('=').trim() : null;
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
    const tmp = `${envPath}.tmp`;
    await writeFile(tmp, lines.join('\n'), { mode: 0o600 });
    await rename(tmp, envPath);
    return previous;
}

export function createUpdater({
    composeDir = config.composeDir,
    serverFiles = config.serverFiles,
    docker,
    exec = run,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
    async function compose(argv, timeoutMs) {
        const { stdout, stderr } = await exec('docker', argv, {
            cwd: composeDir,
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
        });
        return `${stdout || ''}${stderr || ''}`.trim();
    }

    return {
        /** Current image reference and resolved digest, for "what am I running". */
        async current() {
            const info = await docker.inspect();
            const gameBuild = await readGameBuild(serverFiles);
            if (!info) return { image: null, digest: null, gameBuild };
            return {
                image: info.Config?.Image ?? null,
                // The build clients actually check. A mismatch here is what
                // rejects every connection, so it leads.
                gameBuild,
                // The digest is what actually identifies the build; the tag is
                // usually :latest and tells you nothing about drift.
                digest: (info.Image || '').replace(/^sha256:/, '').slice(0, 12) || null,
                startedAt: info.State?.StartedAt ?? null,
            };
        },

        /**
         * Pull the image without touching the running container.
         * Safe at any time — players stay connected; nothing is recreated until
         * apply() is called.
         */
        async check() {
            const before = await this.current();
            const output = await compose(PULL_ARGV, 15 * 60_000);
            const after = await this.current();
            return {
                pulled: true,
                updateAvailable: Boolean(before.digest && after.digest && before.digest !== after.digest)
                    || /downloaded newer image|Pulled/i.test(output),
                digestBefore: before.digest,
                digestAfter: after.digest,
                output: output.split('\n').slice(-20).join('\n'),
            };
        },

        /**
         * Update the GAME itself. This is the one that fixes "clients cannot
         * connect after a Windrose patch".
         *
         * SteamCMD only refreshes the game when UPDATE_ON_START=true, and we
         * keep that false so an unattended restart can never pull a build that
         * breaks UE4SS/Windrose+ at an unwatched hour. So this flips it on for
         * exactly one boot and restores whatever it was afterwards — in a
         * finally block, because leaving the flag on is precisely the unattended
         * behaviour we are avoiding.
         *
         * DISRUPTIVE: everyone is disconnected, and a large download may run.
         * The caller warns players and snapshots first.
         */
        async updateGame({ waitMs = 15 * 60_000, pollMs = 15_000 } = {}) {
            const before = await readGameBuild(serverFiles);
            let previousFlag = null;
            let output = '';

            try {
                previousFlag = await setEnvFlag(composeDir, 'UPDATE_ON_START', 'true');
                // --force-recreate so compose acts even when nothing else in the
                // definition changed; without it the container is reused and the
                // new env never takes effect.
                output = await compose(RECREATE_ARGV, 10 * 60_000);

                // Wait for the server to finish downloading and write its new
                // build. Polling ServerDescription is the only honest signal:
                // the container reports healthy long before the game has booted.
                const deadline = Date.now() + waitMs;
                let after = before;
                while (Date.now() < deadline) {
                    await sleep(pollMs);
                    after = await readGameBuild(serverFiles);
                    if (after && after !== before) break;
                }

                return {
                    updated: Boolean(after && after !== before),
                    buildBefore: before,
                    buildAfter: after,
                    timedOut: !(after && after !== before),
                    note: after && after !== before
                        ? `Game updated to ${after}. Players on that build can connect again.`
                        : 'No build change detected yet. The download may still be running — check again shortly.',
                    output: output.split('\n').slice(-15).join('\n'),
                };
            } finally {
                // Restore the flag no matter what. An aborted update that leaves
                // UPDATE_ON_START=true is a silent trap for the next restart.
                if (previousFlag !== null) {
                    await setEnvFlag(composeDir, 'UPDATE_ON_START', previousFlag).catch(() => {});
                }
            }
        },

        /**
         * Recreate the container on the pulled image.
         *
         * DISRUPTIVE: compose stops and replaces the container, so everyone is
         * disconnected. The caller is responsible for warning players and
         * taking a snapshot first — this function deliberately does neither, so
         * that "update" cannot quietly become "update and hope".
         */
        async apply() {
            const before = await this.current();
            const output = await compose(UP_ARGV, 10 * 60_000);
            const after = await this.current();
            return {
                applied: true,
                digestBefore: before.digest,
                digestAfter: after.digest,
                recreated: before.digest !== after.digest,
                output: output.split('\n').slice(-20).join('\n'),
            };
        },
    };
}
