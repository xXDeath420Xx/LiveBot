// ============================================================================
// CertiFried Jellyfin — bootstrap event handler
// ----------------------------------------------------------------------------
// Drop this file into ~/CertiFriedUtility/events/ — the main bot's auto-loader
// will register it as a one-shot 'ready' handler. On startup, this:
//   1. Loads cf-jellyfin/.env (token, etc.)
//   2. Creates the JellyfinCommands module
//   3. Attaches its interactionCreate listener
//   4. Registers /jellyfin-enable globally (admin-only, hidden from non-admins)
//   5. Reconciles per-guild /jellyfin command registrations
//   6. Optionally auto-enables for guilds in the AUTO_ENABLE_GUILDS env list
// ============================================================================

import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createJellyfinCommands } from '../cf-jellyfin/cf-jellyfin-commands.js';
import { createAuthAppClient } from '../cf-jellyfin/cf-jellyfin-federation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load cf-jellyfin/.env (does NOT override main bot's existing env vars)
dotenv.config({
    path: join(__dirname, '..', 'cf-jellyfin', '.env'),
    override: false
});

export default {
    name: 'ready',
    once: true,
    execute: async (client) => {
        try {
            const fedToken = process.env.CF_FED_TOKEN;
            if (!fedToken) {
                console.warn('[cf-jellyfin-bootstrap] CF_FED_TOKEN missing — skipping init');
                return;
            }

            const auth = createAuthAppClient({
                authAppUrl: process.env.CF_AUTH_APP_URL || 'https://jellyfin.certifriedmultitool.net',
                sharedToken: fedToken,
                botName: process.env.CF_BOT_NAME || 'certifried-default'
            });

            const cmds = createJellyfinCommands({
                authAppClient: auth,
                dbPath: join(__dirname, '..', 'cf-jellyfin', 'guild-config.db'),
                loginUrl: (process.env.CF_AUTH_APP_URL || 'https://jellyfin.certifriedmultitool.net') + '/account',
                brandName: 'CertiFried Movie Theatre'
            });

            cmds.attach(client);

            // Skip re-registration if Discord already has the jellyfin commands
            // for this bot. Each .create() counts against Discord's 200/day
            // command-write rate limit per application — re-firing on every
            // PM2 restart burns through the budget and gets us 429'd, which
            // then hangs deploys silently.
            try {
                const globalExisting = await client.application.commands.fetch();
                const hasGlobal = globalExisting.some(c => c.name === 'jellyfin-enable');
                if (!hasGlobal) {
                    await cmds.registerGlobalCommands(client);
                    console.log('[cf-jellyfin-bootstrap] /jellyfin-enable created globally');
                } else {
                    console.log('[cf-jellyfin-bootstrap] /jellyfin-enable already registered, skipping');
                }
            } catch (err) {
                console.error('[cf-jellyfin-bootstrap] global register check failed:', err.message);
            }

            // Per-guild reconcile: always re-register so schema updates (new
            // subcommands) propagate. Discord no-ops if the schema is unchanged,
            // and overwrites the registration when it differs.
            try {
                const Database = (await import('better-sqlite3')).default;
                const db = new Database(join(__dirname, '..', 'cf-jellyfin', 'guild-config.db'));
                const opted = db.prepare('SELECT guild_id FROM guild_jellyfin_settings WHERE enabled = 1').all();
                db.close();
                let registered = 0, missing = 0;
                for (const row of opted) {
                    const guild = client.guilds.cache.get(row.guild_id);
                    if (!guild) { missing++; continue; }
                    try {
                        await cmds.enableForGuild(client, row.guild_id, 'auto-reconcile');
                        registered++;
                    } catch (err) {
                        console.error('[cf-jellyfin-bootstrap] guild ' + row.guild_id + ' reconcile failed:', err.message);
                    }
                }
                console.log(`[cf-jellyfin-bootstrap] guild reconcile: ${registered} re-registered, ${missing} not in cache`);
            } catch (err) {
                console.error('[cf-jellyfin-bootstrap] guild reconcile loop failed:', err.message);
            }

            // Optional auto-enable for specific guilds (comma-separated IDs in env)
            const autoEnable = (process.env.CF_AUTO_ENABLE_GUILDS || '').split(',').map(s => s.trim()).filter(Boolean);
            for (const guildId of autoEnable) {
                try {
                    if (!cmds.isEnabledForGuild(guildId)) {
                        if (client.guilds.cache.has(guildId)) {
                            await cmds.enableForGuild(client, guildId, 'auto-bootstrap');
                            console.log('[cf-jellyfin-bootstrap] auto-enabled guild ' + guildId);
                        } else {
                            console.warn('[cf-jellyfin-bootstrap] auto-enable skipped — bot not in guild ' + guildId);
                        }
                    } else {
                        console.log('[cf-jellyfin-bootstrap] guild ' + guildId + ' already enabled');
                    }
                } catch (err) {
                    console.error('[cf-jellyfin-bootstrap] auto-enable failed for ' + guildId + ':', err.message);
                }
            }
        } catch (err) {
            console.error('[cf-jellyfin-bootstrap] init failed:', err.message);
            console.error(err.stack);
        }
    }
};
