/**
 * ReeferRealm Logs Reorganization Script
 *
 * Target Server: 985116833193553930
 * Bot Instance: 1438889625388060723 (ReeferRealm Utility#3683)
 *
 * This script:
 * 1. Creates a "Logs" category with restricted permissions
 * 2. Creates separate log channels organized by function
 * 3. Sets permissions so only mod/admin roles can view
 * 4. Configures log_event_config to route events to proper channels
 * 5. Moves existing log channels into the new category
 * 6. Stops spamming channel 1290805808879108167 with all logs
 */

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } from 'discord.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const encryptionModule = await import('../utils/encryption.js');
const encryptionService = encryptionModule.default;

const GUILD_ID = '985116833193553930';
const BOT_ID = '1438889625388060723';

// ─── Log Channel Definitions ────────────────────────────────────────────────
// Each channel maps to specific sendLogEmbed event type strings (camelCase)
const LOG_CHANNEL_DEFS = {
    'member-logs': {
        topic: 'Member join, leave, kick, updates, and timeouts',
        events: [
            'memberJoin', 'memberLeave', 'memberKick', 'memberUpdate', 'memberTimeout'
        ]
    },
    'moderation-logs': {
        topic: 'Bans, unbans, and automod actions',
        events: [
            'ban', 'unban', 'automodAction',
            'automodRuleCreate', 'automodRuleUpdate', 'automodRuleDelete'
        ]
    },
    'voice-logs': {
        topic: 'Voice channel join, leave, move, and stage events',
        events: [
            'voiceUpdate', 'voiceChannelEffect',
            'stageInstanceCreate', 'stageInstanceDelete', 'stageInstanceUpdate'
        ]
    },
    'message-logs': {
        topic: 'Message deletes, edits, reactions, and polls',
        events: [
            'messageDelete', 'messageUpdate',
            'reactionAdd', 'reactionRemove', 'reactionRemoveAll', 'reactionRemoveEmoji',
            'pollVoteAdd', 'pollVoteRemove', 'channelPinsUpdate'
        ]
    },
    'server-logs': {
        topic: 'Channel, thread, guild, emoji, sticker, invite, webhook, and integration changes',
        events: [
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
        ]
    },
    'role-logs': {
        topic: 'Role create, delete, and update events',
        events: [
            'roleCreate', 'roleDelete', 'roleUpdate'
        ]
    },
    'command-logs': {
        topic: 'Bot command usage tracking',
        events: [
            'commandUsage'
        ]
    }
};

let pool;
let client;

// ─── Database ────────────────────────────────────────────────────────────────

async function initDatabase() {
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
    console.log('[DB] Connected to database');
}

// ─── Discord Client ──────────────────────────────────────────────────────────

async function initDiscordClient() {
    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    if (!bots.length) {
        throw new Error(`Custom bot ${BOT_ID} not found in database`);
    }

    const tokenData = typeof bots[0].bot_token === 'string'
        ? JSON.parse(bots[0].bot_token)
        : bots[0].bot_token;
    const token = encryptionService.decrypt(tokenData);

    client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers
        ]
    });

    await client.login(token);
    console.log(`[Discord] Logged in as ${client.user.tag}`);

    await new Promise((resolve) => {
        if (client.isReady()) resolve();
        else client.once('ready', resolve);
    });
}

// ─── Find Mod/Admin Roles ────────────────────────────────────────────────────

function findModAdminRoles(guild) {
    const modPerms = [
        PermissionFlagsBits.Administrator,
        PermissionFlagsBits.ModerateMembers,
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.KickMembers,
        PermissionFlagsBits.ManageGuild
    ];

    const modRoles = guild.roles.cache.filter(role => {
        if (role.id === guild.id) return false; // skip @everyone
        if (role.managed) return false; // skip bot-managed roles
        return modPerms.some(perm => role.permissions.has(perm));
    });

    return modRoles;
}

// ─── Find Existing Log Channels ─────────────────────────────────────────────

function findExistingLogChannels(guild) {
    const logKeywords = ['log', 'audit', 'mod-log', 'automod'];
    return guild.channels.cache.filter(ch => {
        if (ch.type !== ChannelType.GuildText) return false;
        const name = ch.name.toLowerCase();
        return logKeywords.some(kw => name.includes(kw));
    });
}

// ─── Main Setup ──────────────────────────────────────────────────────────────

async function setup() {
    console.log('\n' + '='.repeat(70));
    console.log('  ReeferRealm Logs Reorganization');
    console.log('  Guild: ' + GUILD_ID);
    console.log('  Bot:   ' + BOT_ID);
    console.log('='.repeat(70) + '\n');

    await initDatabase();
    await initDiscordClient();

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.channels.fetch();
    await guild.roles.fetch();

    // ── Step 1: Find mod/admin roles ─────────────────────────────────────
    console.log('[Step 1] Finding moderation & administration roles...\n');
    const modRoles = findModAdminRoles(guild);

    if (modRoles.size === 0) {
        console.log('  WARNING: No mod/admin roles found! Channels will only be visible to users with Administrator permission.');
    } else {
        modRoles.forEach(role => {
            const perms = [];
            if (role.permissions.has(PermissionFlagsBits.Administrator)) perms.push('ADMINISTRATOR');
            if (role.permissions.has(PermissionFlagsBits.ModerateMembers)) perms.push('MODERATE_MEMBERS');
            if (role.permissions.has(PermissionFlagsBits.BanMembers)) perms.push('BAN_MEMBERS');
            if (role.permissions.has(PermissionFlagsBits.KickMembers)) perms.push('KICK_MEMBERS');
            if (role.permissions.has(PermissionFlagsBits.ManageGuild)) perms.push('MANAGE_GUILD');
            console.log(`  @${role.name} (${role.id}) - ${perms.join(', ')}`);
        });
    }

    // ── Step 2: Find existing log channels ───────────────────────────────
    console.log('\n[Step 2] Finding existing log channels...\n');
    const existingLogChannels = findExistingLogChannels(guild);

    if (existingLogChannels.size > 0) {
        existingLogChannels.forEach(ch => {
            const parent = ch.parent ? ch.parent.name : 'No category';
            console.log(`  #${ch.name} (${ch.id}) - Category: ${parent}`);
        });
    } else {
        console.log('  No existing log channels found.');
    }

    // ── Step 3: Create "Logs" category ───────────────────────────────────
    console.log('\n[Step 3] Creating "Logs" category...\n');

    // Build permission overwrites for the category
    const categoryPermissions = [
        // Deny @everyone from viewing
        {
            id: guild.id, // @everyone role ID = guild ID
            type: 0, // Role
            deny: [PermissionFlagsBits.ViewChannel]
        },
        // Allow the bot to view and send
        {
            id: BOT_ID,
            type: 1, // Member
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.UseExternalEmojis,
                PermissionFlagsBits.ManageWebhooks
            ]
        }
    ];

    // Allow each mod/admin role to view
    modRoles.forEach(role => {
        categoryPermissions.push({
            id: role.id,
            type: 0, // Role
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory
            ]
        });
    });

    const logsCategory = await guild.channels.create({
        name: 'Logs',
        type: ChannelType.GuildCategory,
        permissionOverwrites: categoryPermissions
    });
    console.log(`  Created category: ${logsCategory.name} (${logsCategory.id})`);

    // ── Step 4: Create log channels ──────────────────────────────────────
    console.log('\n[Step 4] Creating log channels...\n');

    const createdChannels = {};

    for (const [channelName, def] of Object.entries(LOG_CHANNEL_DEFS)) {
        const channel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: logsCategory.id,
            topic: def.topic
        });
        // Channels inherit permissions from the category
        createdChannels[channelName] = channel;
        console.log(`  Created #${channel.name} (${channel.id}) - ${def.events.length} event types`);
    }

    // ── Step 5: Move existing log channels into category ─────────────────
    console.log('\n[Step 5] Moving existing log channels into Logs category...\n');

    for (const [, ch] of existingLogChannels) {
        try {
            await ch.setParent(logsCategory.id, { lockPermissions: true });
            console.log(`  Moved #${ch.name} (${ch.id}) -> Logs category`);
        } catch (err) {
            console.log(`  WARNING: Could not move #${ch.name}: ${err.message}`);
        }
    }

    // ── Step 6: Ensure log_event_config table exists ─────────────────────
    console.log('\n[Step 6] Ensuring database tables exist...\n');

    await pool.execute(`
        CREATE TABLE IF NOT EXISTS log_event_config (
            guild_id VARCHAR(20) NOT NULL,
            event_type VARCHAR(50) NOT NULL,
            enabled TINYINT DEFAULT 1,
            log_channel_id VARCHAR(20),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, event_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('  log_event_config table ensured.');

    // Ensure logging_config has enabled column
    try {
        await pool.execute(`
            ALTER TABLE logging_config ADD COLUMN IF NOT EXISTS enabled TINYINT DEFAULT 1
        `);
        console.log('  logging_config.enabled column ensured.');
    } catch (err) {
        // Column might already exist
        if (!err.message.includes('Duplicate column')) {
            console.log(`  Note: ${err.message}`);
        }
    }

    // ── Step 7: Configure database routing ───────────────────────────────
    console.log('\n[Step 7] Configuring event routing in database...\n');

    // Collect all event types for enabled_events array
    const allEventTypes = [];

    // Insert/update log_event_config for each event -> channel mapping
    for (const [channelName, def] of Object.entries(LOG_CHANNEL_DEFS)) {
        const channelId = createdChannels[channelName].id;

        for (const eventType of def.events) {
            allEventTypes.push(eventType);

            await pool.execute(`
                INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id)
                VALUES (?, ?, 1, ?)
                ON DUPLICATE KEY UPDATE
                    enabled = 1,
                    log_channel_id = VALUES(log_channel_id),
                    updated_at = CURRENT_TIMESTAMP
            `, [GUILD_ID, eventType, channelId]);
        }

        console.log(`  #${channelName} -> ${def.events.length} events routed`);
    }

    // Update logging_config with default channel (use member-logs as default fallback)
    // and populate enabled_events with all event types
    const defaultChannelId = createdChannels['member-logs'].id;
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
    console.log(`\n  Default log channel: #member-logs (${defaultChannelId})`);
    console.log(`  Enabled ${allEventTypes.length} event types`);

    // ── Summary ──────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(70));
    console.log('  SETUP COMPLETE');
    console.log('='.repeat(70));

    console.log('\n  LOG CHANNELS CREATED:');
    for (const [name, ch] of Object.entries(createdChannels)) {
        const def = LOG_CHANNEL_DEFS[name];
        console.log(`    #${name} (${ch.id})`);
        console.log(`      Events: ${def.events.join(', ')}`);
    }

    console.log('\n  CATEGORY:');
    console.log(`    ${logsCategory.name} (${logsCategory.id})`);

    console.log('\n  PERMISSIONS:');
    console.log('    @everyone: DENIED ViewChannel');
    modRoles.forEach(role => {
        console.log(`    @${role.name}: ALLOWED ViewChannel, ReadMessageHistory`);
    });
    console.log(`    Bot (${BOT_ID}): ALLOWED ViewChannel, SendMessages, EmbedLinks`);

    console.log('\n  EXISTING CHANNELS MOVED:');
    existingLogChannels.forEach(ch => {
        console.log(`    #${ch.name} (${ch.id})`);
    });

    console.log('\n  NEXT STEPS:');
    console.log('    1. Restart the bot to pick up the new channel routing');
    console.log('    2. Verify logs appear in the correct channels');
    console.log('    3. Old log channel 1290805808879108167 will stop receiving new logs');
    console.log('    4. Optionally clean up or archive the old log channel');
    console.log('\n');

    // Cleanup
    client.destroy();
    await pool.end();
}

setup().catch(err => {
    console.error('FATAL ERROR:', err);
    if (client) client.destroy();
    if (pool) pool.end();
    process.exit(1);
});
