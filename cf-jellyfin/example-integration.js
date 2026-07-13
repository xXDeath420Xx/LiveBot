// ============================================================================
// Minimal example: wiring CertiFried federation + slash commands into a
// discord.js v14 bot.
//
// Adapt the imports/client setup to match your existing bot. The two pieces
// you must wire in are:
//   1. createFederationRouter        — HTTP endpoints the auth-app calls
//   2. attachMemberEventHandlers     — notifies auth-app on join/leave
//   3. createJellyfinCommands.attach — slash commands for users
// ============================================================================

import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import {
    createFederationRouter,
    attachMemberEventHandlers,
    createAuthAppClient,
    pingAuthApp
} from './cf-jellyfin-federation.js';
import { createJellyfinCommands } from './cf-jellyfin-commands.js';
import { createWebhookHandler } from './cf-jellyfin-webhook.js';

// 1) Discord client. Required intents: Guilds + GuildMembers (privileged).
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.GuildMember]
});

// 2) Auth-app HTTP client (used by both federation events and slash commands)
const auth = createAuthAppClient({
    authAppUrl:  process.env.CF_AUTH_APP_URL,
    sharedToken: process.env.CF_FED_TOKEN,
    botName:     process.env.CF_BOT_NAME
});

// 3) Slash commands (per-guild opt-in)
const jellyfinCommands = createJellyfinCommands({
    authAppClient: auth,
    dbPath:        process.env.CF_GUILD_CONFIG_DB || './guild-config.db',
    loginUrl:      process.env.CF_AUTH_APP_URL + '/account',
    brandName:     'CertiFried Movie Theatre'
});
jellyfinCommands.attach(client);

// 4) Discord member events → auth-app federation
attachMemberEventHandlers(client, {
    authAppUrl:  process.env.CF_AUTH_APP_URL,
    sharedToken: process.env.CF_FED_TOKEN,
    botName:     process.env.CF_BOT_NAME
});

client.once('ready', async () => {
    console.log('Logged in as ' + client.user.tag + ' (' + client.guilds.cache.size + ' guilds)');

    // Warm member cache so /api/shares-guild returns accurate data
    for (const [, guild] of client.guilds.cache) {
        try { await guild.members.fetch(); }
        catch (err) { console.warn('  cache warm failed for ' + guild.id + ':', err.message); }
    }

    // Register the global /jellyfin-enable command (admin-only, hidden from non-admins)
    await jellyfinCommands.registerGlobalCommands(client);

    // Re-register per-guild Jellyfin commands for any guild already opted in
    await jellyfinCommands.reconcileAllGuilds(client);

    // Sanity-check the federation HMAC handshake
    try {
        const pong = await pingAuthApp({
            authAppUrl:  process.env.CF_AUTH_APP_URL,
            sharedToken: process.env.CF_FED_TOKEN,
            botName:     process.env.CF_BOT_NAME
        });
        console.log('[cf-federation] auth-app handshake ok:', pong);
    } catch (err) {
        console.error('[cf-federation] auth-app handshake FAILED:', err.message);
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);

// 5) Express server with the federation HTTP endpoints
const app = express();
const port = parseInt(process.env.FEDERATION_PORT || '8080', 10);

app.use(createFederationRouter({
    sharedToken: process.env.CF_FED_TOKEN,
    botName:     process.env.CF_BOT_NAME,
    getClient:   () => client
}));

// 6) Jellyfin Webhook ingest → per-guild channel router
//    Configure Jellyfin's Webhook plugin to POST to: <bot-public-url>/webhook/jellyfin
//    with header `X-Webhook-Secret: <CF_WEBHOOK_SECRET>`
const webhook = createWebhookHandler({
    commandsModule: jellyfinCommands,
    getClient:      () => client,
    webhookSecret:  process.env.CF_WEBHOOK_SECRET,
    jellyfinUrl:    process.env.CF_JELLYFIN_URL || 'https://jellyfin.certifriedmultitool.net',
    brandName:      'CertiFried Movie Theatre',
    debugLog:       process.env.CF_WEBHOOK_DEBUG === '1'
});
app.use(webhook.router);

app.get('/health', (req, res) => res.json({ ok: client.isReady(), guilds: client.guilds.cache.size }));

app.listen(port, () => {
    console.log('Federation HTTP server listening on :' + port);
});
