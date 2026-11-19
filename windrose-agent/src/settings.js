// Server identity settings — the things in /srv/windrose/.env that decide what
// players see and how they connect.
//
// These live in the container's environment, not in a config file the game
// owns, which makes them a different shape from everything in configwriter.js:
// applying them needs the container RECREATED (`docker compose up -d`), not
// just restarted. Docker bakes env into the container at create time, so a
// plain restart silently keeps the old values — the exact class of "the panel
// said it worked and nothing changed" bug this project keeps running into.
//
// Strict allowlist. The .env also holds the RCON password and the agent secret;
// a generic key/value editor over this file would hand the web UI both.

import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const run = promisify(execFile);

export class SettingsError extends Error {}

/**
 * What the panel may change, with validation.
 * `restart: 'recreate'` means the container must be recreated to apply.
 */
export const EDITABLE = {
    SERVER_NAME: {
        label: 'Server name',
        validate: (v) => (v.length >= 1 && v.length <= 64 ? null : 'must be 1–64 characters'),
    },
    SERVER_PASSWORD: {
        label: 'Join password',
        secret: true,
        // Empty is meaningful: it makes the server public. Allowed, but the UI
        // warns, because the DNS record makes the address publicly discoverable.
        validate: (v) => (v.length === 0 || (v.length >= 4 && v.length <= 64) ? null : 'must be empty or 4–64 characters'),
    },
    MAX_PLAYERS: {
        label: 'Max players',
        validate: (v) => (/^\d+$/.test(v) && +v >= 1 && +v <= 10 ? null : 'must be 1–10'),
        note: 'This box is memory-bound: 10 concurrent players sits near the 16GB container cap.',
    },
    INVITE_CODE: {
        label: 'Invite code',
        validate: (v) => (v.length === 0 || /^[0-9a-zA-Z]{6,}$/.test(v) ? null : 'min 6 chars, letters and numbers only'),
        note: 'Only used when direct connection is off.',
    },
    USE_DIRECT_CONNECTION: {
        label: 'Direct connection',
        validate: (v) => (v === 'true' || v === 'false' ? null : 'must be true or false'),
        note: 'true = players connect to the hostname:port. false = invite code via the P2P proxy.',
    },
    SERVER_PORT: {
        label: 'Game port',
        validate: (v) => (/^\d+$/.test(v) && +v > 1024 && +v < 65536 ? null : 'must be 1025–65535'),
        note: 'Changing this also needs the firewall and docker-compose port mapping updated by hand.',
    },
    UPDATE_ON_START: {
        label: 'Update game on every start',
        validate: (v) => (v === 'true' || v === 'false' ? null : 'must be true or false'),
        note: 'Leave false. A Steam update landing mid-restart can break Windrose+ compatibility unannounced.',
    },
};

// Never readable or writable through this surface.
const FORBIDDEN = new Set(['WINDROSE_PLUS_RCON_PASSWORD', 'WINDROSE_AGENT_SECRET', 'PUID', 'PGID']);

function parseEnv(text) {
    const out = {};
    for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
        if (m) out[m[1]] = m[2];
    }
    return out;
}

export function createSettings({ composeDir = config.composeDir, docker, exec = run } = {}) {
    const envPath = path.join(composeDir, '.env');

    async function readEnv() {
        return parseEnv(await readFile(envPath, 'utf8'));
    }

    return {
        EDITABLE,

        /** Current values for the editable keys. Passwords masked, never returned. */
        async read() {
            const env = await readEnv();
            const values = {};
            for (const [key, spec] of Object.entries(EDITABLE)) {
                values[key] = spec.secret
                    ? { set: Boolean(env[key]), value: null }
                    : { value: env[key] ?? '' };
            }
            return {
                values,
                schema: Object.fromEntries(Object.entries(EDITABLE).map(([k, v]) => [k, {
                    label: v.label, note: v.note ?? null, secret: Boolean(v.secret),
                }])),
                connectAddress: config.connectAddress,
            };
        },

        /**
         * Write allowlisted keys back to .env, preserving comments, ordering and
         * every key we do not manage — this file is hand-maintained and full of
         * explanatory comments worth keeping.
         */
        async write(patch) {
            const entries = Object.entries(patch || {});
            if (!entries.length) throw new SettingsError('nothing to change');

            for (const [key, raw] of entries) {
                if (FORBIDDEN.has(key)) throw new SettingsError(`${key} cannot be changed here`);
                const spec = EDITABLE[key];
                if (!spec) throw new SettingsError(`unknown setting ${key}`);

                const value = String(raw ?? '');
                if (/[\r\n]/.test(value)) throw new SettingsError(`${key} may not contain newlines`);
                const problem = spec.validate(value);
                if (problem) throw new SettingsError(`${spec.label}: ${problem}`);
            }

            const original = await readFile(envPath, 'utf8');
            const lines = original.split('\n');
            const applied = {};

            for (const [key, raw] of entries) {
                const value = String(raw ?? '');
                const idx = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
                if (idx >= 0) lines[idx] = `${key}=${value}`;
                else lines.push(`${key}=${value}`);
                applied[key] = EDITABLE[key].secret ? '(set)' : value;
            }

            const tmp = `${envPath}.tmp`;
            await writeFile(tmp, lines.join('\n'), { mode: 0o600 });
            await rename(tmp, envPath);

            return {
                applied,
                pendingRecreate: true,
                note: 'Saved. Docker bakes environment in at container-create time, so these apply only after a recreate.',
            };
        },

        /**
         * Recreate the container so new env takes effect.
         * DISRUPTIVE — everyone is disconnected. Fixed argv, no user input,
         * same reasoning as updater.js.
         */
        async applyRecreate() {
            const before = await docker.state();
            const { stdout, stderr } = await exec('docker', ['compose', 'up', '-d'], {
                cwd: composeDir, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024,
            });
            return {
                recreated: true,
                wasRunning: before.running,
                output: `${stdout || ''}${stderr || ''}`.trim().split('\n').slice(-10).join('\n'),
            };
        },

        _envPath: envPath,
    };
}
