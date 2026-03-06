/**
 * ReeferRealm Logs - Fixup Script
 *
 * Fixes:
 * 1. Moves logo channels back to their original categories (they aren't log channels)
 * 2. Configures database routing for all event types -> new log channels
 */

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits } from 'discord.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const encryptionModule = await import('../utils/encryption.js');
const encryptionService = encryptionModule.default;

const GUILD_ID = '985116833193553930';
const BOT_ID = '1438889625388060723';

// Channels that were incorrectly moved - need to go back to original categories
const CHANNELS_TO_RESTORE = [
    { id: '1347194826336243712', name: 'reeferrealm-logos™' },  // was in ReeferRealm Team Stuff
    { id: '1408943162352996403', name: 'certifried-logos' }      // was in CertiFried
];

// New log channels (created in previous run)
const CREATED_CHANNELS = {
    'member-logs':     '1467848922083889152',
    'moderation-logs': '1467848923015024711',
    'voice-logs':      '1467848923992297574',
    'message-logs':    '1467848925431074937',
    'server-logs':     '1467848926400086058',
    'role-logs':       '1467848927175905353',
    'command-logs':    '1467848928731861013'
};

// Event type -> channel mapping (camelCase event types matching sendLogEmbed calls)
const EVENT_ROUTING = {
    'member-logs': [
        'memberJoin', 'memberLeave', 'memberKick', 'memberUpdate', 'memberTimeout'
    ],
    'moderation-logs': [
        'ban', 'unban', 'automodAction',
        'automodRuleCreate', 'automodRuleUpdate', 'automodRuleDelete'
    ],
    'voice-logs': [
        'voiceUpdate', 'voiceChannelEffect',
        'stageInstanceCreate', 'stageInstanceDelete', 'stageInstanceUpdate'
    ],
    'message-logs': [
        'messageDelete', 'messageUpdate',
        'reactionAdd', 'reactionRemove', 'reactionRemoveAll', 'reactionRemoveEmoji',
        'pollVoteAdd', 'pollVoteRemove', 'channelPinsUpdate'
    ],
    'server-logs': [
        'channelCreate', 'channelDelete', 'channelUpdate',
        'threadCreate', 'threadDelete', 'threadUpdate', 'threadMembersUpdate',
        'guildUpdate',
        'emojiCreate', 'emojiDelete', 'emojiUpdate',
        'stickerCreate', 'stickerDelete', 'stickerUpdate',
        'inviteCreate', 'inviteDelete',
        'webhookUpdate', 'integrationUpdate', 'integrationsUpdate',
        'soundboardSoundCreate', 'soundboardSoundDelete', 'soundboardSoundUpdate',
        'scheduledEventCreate', 'scheduledEventUpdate', 'scheduledEventDelete',
        'scheduledEventUserAdd', 'scheduledEventUserRemove'
    ],
    'role-logs': [
        'roleCreate', 'roleDelete', 'roleUpdate'
    ],
    'command-logs': [
        'commandUsage'
    ]
};

let pool;
let client;

async function run() {
    console.log('\n' + '='.repeat(70));
    console.log('  ReeferRealm Logs - Fixup');
    console.log('='.repeat(70) + '\n');

    // Init DB
    pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        charset: 'utf8mb4',
        waitForConnections: true,
        connectionLimit: 5,
        timezone: '+00:00'
    });
    console.log('[DB] Connected');

    // Init Discord
    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]
    );
    const tokenData = typeof bots[0].bot_token === 'string'
        ? JSON.parse(bots[0].bot_token) : bots[0].bot_token;
    const token = encryptionService.decrypt(tokenData);

    client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(token);
    await new Promise(r => { if (client.isReady()) r(); else client.once('ready', r); });
    console.log(`[Discord] Logged in as ${client.user.tag}\n`);

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.channels.fetch();

    // ── Fix 1: Move logo channels back to original categories ────────────
    console.log('[Fix 1] Restoring incorrectly moved channels...\n');

    for (const chInfo of CHANNELS_TO_RESTORE) {
        const channel = guild.channels.cache.get(chInfo.id);
        if (!channel) {
            console.log(`  WARNING: Channel ${chInfo.name} (${chInfo.id}) not found`);
            continue;
        }

        // Find original category by searching for it by name pattern
        let targetCategory = null;
        if (chInfo.name.includes('reeferrealm')) {
            targetCategory = guild.channels.cache.find(
                c => c.type === 4 && c.name.toLowerCase().includes('reeferrealm')
            );
        } else if (chInfo.name.includes('certifried')) {
            targetCategory = guild.channels.cache.find(
                c => c.type === 4 && c.name.toLowerCase().includes('certifried')
            );
        }

        if (targetCategory) {
            await channel.setParent(targetCategory.id, { lockPermissions: false });
            console.log(`  Moved #${chInfo.name} back to ${targetCategory.name}`);
        } else {
            // Remove from category (put at top level)
            console.log(`  WARNING: Could not find original category for #${chInfo.name}, leaving in Logs`);
        }
    }

    // ── Fix 2: Configure database event routing ──────────────────────────
    console.log('\n[Fix 2] Configuring event routing in database...\n');

    const allEventTypes = [];

    for (const [channelName, events] of Object.entries(EVENT_ROUTING)) {
        const channelId = CREATED_CHANNELS[channelName];

        for (const eventType of events) {
            allEventTypes.push(eventType);

            await pool.execute(`
                INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id)
                VALUES (?, ?, 1, ?)
                ON DUPLICATE KEY UPDATE
                    enabled = 1,
                    log_channel_id = VALUES(log_channel_id)
            `, [GUILD_ID, eventType, channelId]);
        }

        console.log(`  #${channelName} (${channelId}) -> ${events.length} events`);
    }

    // Update logging_config
    const defaultChannelId = CREATED_CHANNELS['member-logs'];
    const enabledEventsJson = JSON.stringify(allEventTypes);

    await pool.execute(`
        INSERT INTO logging_config (guild_id, log_channel_id, enabled_events, enabled)
        VALUES (?, ?, ?, 1)
        ON DUPLICATE KEY UPDATE
            log_channel_id = VALUES(log_channel_id),
            enabled_events = VALUES(enabled_events),
            enabled = 1,
            updated_at = CURRENT_TIMESTAMP
    `, [GUILD_ID, defaultChannelId, enabledEventsJson]);

    console.log(`\n  Default fallback channel: #member-logs (${defaultChannelId})`);
    console.log(`  Total event types enabled: ${allEventTypes.length}`);

    // Verify
    console.log('\n[Verify] Reading back config...\n');
    const [configRows] = await pool.execute(
        'SELECT * FROM logging_config WHERE guild_id = ?', [GUILD_ID]
    );
    if (configRows.length > 0) {
        const cfg = configRows[0];
        const events = JSON.parse(cfg.enabled_events || '[]');
        console.log(`  logging_config.enabled = ${cfg.enabled}`);
        console.log(`  logging_config.log_channel_id = ${cfg.log_channel_id}`);
        console.log(`  logging_config.enabled_events = ${events.length} events`);
    }

    const [eventRows] = await pool.execute(
        'SELECT event_type, log_channel_id, enabled FROM log_event_config WHERE guild_id = ? ORDER BY event_type',
        [GUILD_ID]
    );
    console.log(`  log_event_config entries: ${eventRows.length}`);

    // Build reverse lookup for display
    const channelIdToName = {};
    for (const [name, id] of Object.entries(CREATED_CHANNELS)) {
        channelIdToName[id] = name;
    }

    const routeSummary = {};
    for (const row of eventRows) {
        const chName = channelIdToName[row.log_channel_id] || row.log_channel_id;
        if (!routeSummary[chName]) routeSummary[chName] = [];
        routeSummary[chName].push(row.event_type);
    }

    console.log('\n  Routing summary:');
    for (const [chName, events] of Object.entries(routeSummary)) {
        console.log(`    #${chName}: ${events.join(', ')}`);
    }

    console.log('\n' + '='.repeat(70));
    console.log('  FIXUP COMPLETE');
    console.log('='.repeat(70));
    console.log('\n  Restart the bot to apply the new routing.\n');

    client.destroy();
    await pool.end();
}

run().catch(err => {
    console.error('FATAL ERROR:', err);
    if (client) client.destroy();
    if (pool) pool.end();
    process.exit(1);
});
