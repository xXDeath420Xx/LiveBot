/**
 * Spoodercord Server Setup Script — ProBot Replacement
 *
 * Target Server: 879457883333464114 (Spoodercord)
 * Bot Instance:  1473253511100895283 (Spoodercord Utility)
 *
 * This script:
 * 1. Reuses existing log channels in "Server Logs" category (926690998808109067)
 * 2. Creates additional log channels for events ProBot didn't cover
 * 3. Configures log_event_config DB routing for each event -> channel
 * 4. Creates a Streamer reaction-role panel in #roles
 * 5. Re-creates the server rules embed in #rules
 */

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const encryptionModule = await import('../utils/encryption.js');
const encryptionService = encryptionModule.default;

const GUILD_ID = '879457883333464114';
const BOT_ID = '1473253511100895283';
const LOGS_CATEGORY_ID = '926690998808109067';

// ─── Existing Channel Mappings ──────────────────────────────────────────────
// Map existing ProBot log channels to our event types
const EXISTING_CHANNEL_MAPPINGS = {
    '926691062016266261': { // #channel-log
        name: 'channel-log',
        events: ['channelCreate', 'channelDelete', 'channelUpdate']
    },
    '926691089501544518': { // #join-leave-log
        name: 'join-leave-log',
        events: ['memberJoin', 'memberLeave', 'memberKick']
    },
    '926691118169608212': { // #member-log
        name: 'member-log',
        events: ['memberUpdate', 'memberTimeout']
    },
    '926691134003089498': { // #message-log
        name: 'message-log',
        events: [
            'messageDelete', 'messageUpdate',
            'reactionAdd', 'reactionRemove', 'reactionRemoveAll', 'reactionRemoveEmoji',
            'pollVoteAdd', 'pollVoteRemove', 'channelPinsUpdate'
        ]
    },
    '914212114078523522': { // #mod-log
        name: 'mod-log',
        events: ['moderation', 'ban', 'unban']
    },
    '926691189430812732': { // #role-log
        name: 'role-log',
        events: ['roleCreate', 'roleDelete', 'roleUpdate']
    },
    '926691292119957504': { // #voice-log
        name: 'voice-log',
        events: [
            'voiceUpdate', 'voiceChannelEffect',
            'stageInstanceCreate', 'stageInstanceDelete', 'stageInstanceUpdate'
        ]
    },
    '926691725265756181': { // #invite-log
        name: 'invite-log',
        events: ['inviteCreate', 'inviteDelete']
    }
};

// ─── Additional Channels to Create ──────────────────────────────────────────
// Events not covered by the existing ProBot channels
const NEW_CHANNEL_DEFS = {
    'automod-logs': {
        topic: 'AutoMod actions and rule changes',
        events: [
            'automodAction',
            'automodRuleCreate', 'automodRuleUpdate', 'automodRuleDelete'
        ]
    },
    'thread-logs': {
        topic: 'Thread create, delete, update, and member changes',
        events: [
            'threadCreate', 'threadDelete', 'threadUpdate', 'threadMembersUpdate'
        ]
    },
    'emoji-sticker-logs': {
        topic: 'Emoji and sticker create, delete, and update events',
        events: [
            'emojiCreate', 'emojiDelete', 'emojiUpdate',
            'stickerCreate', 'stickerDelete', 'stickerUpdate'
        ]
    },
    'server-logs': {
        topic: 'Server settings, scheduled events, and soundboard changes',
        events: [
            'guildUpdate',
            'scheduledEventCreate', 'scheduledEventUpdate', 'scheduledEventDelete',
            'scheduledEventUserAdd', 'scheduledEventUserRemove',
            'soundboardSoundCreate', 'soundboardSoundDelete', 'soundboardSoundUpdate'
        ]
    },
    'webhook-logs': {
        topic: 'Webhook and integration changes',
        events: [
            'webhookUpdate', 'integrationUpdate', 'integrationsUpdate'
        ]
    },
    'command-logs': {
        topic: 'Bot command usage tracking',
        events: [
            'commandUsage'
        ]
    }
};

// ─── Key Channel IDs ────────────────────────────────────────────────────────
const ROLES_CHANNEL_ID = '879562874115194902';
const RULES_CHANNEL_ID = '879562332160798743';

// ─── Role IDs ───────────────────────────────────────────────────────────────
const STREAMER_ROLE_ID = '917129973343617114'; // Streamer role (#ad1457, 46 members, hoisted)

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

    return guild.roles.cache.filter(role => {
        if (role.id === guild.id) return false;
        if (role.managed) return false;
        return modPerms.some(perm => role.permissions.has(perm));
    });
}

// ─── Main Setup ──────────────────────────────────────────────────────────────

async function setup() {
    console.log('\n' + '='.repeat(70));
    console.log('  Spoodercord — ProBot Replacement Setup');
    console.log('  Guild: ' + GUILD_ID);
    console.log('  Bot:   ' + BOT_ID);
    console.log('='.repeat(70) + '\n');

    await initDatabase();
    await initDiscordClient();

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.channels.fetch();
    await guild.roles.fetch();

    // ── Step 1: Verify existing log channels ─────────────────────────────
    console.log('[Step 1] Verifying existing log channels in category ' + LOGS_CATEGORY_ID + '...\n');

    const logsCategory = guild.channels.cache.get(LOGS_CATEGORY_ID);
    if (!logsCategory) {
        throw new Error('Server Logs category not found!');
    }
    console.log(`  Found category: ${logsCategory.name} (${logsCategory.id})`);

    for (const [channelId, mapping] of Object.entries(EXISTING_CHANNEL_MAPPINGS)) {
        const channel = guild.channels.cache.get(channelId);
        if (channel) {
            console.log(`  ✓ #${channel.name} (${channelId}) -> ${mapping.events.length} event(s)`);
        } else {
            console.log(`  ✗ Missing: #${mapping.name} (${channelId}) - will create`);
        }
    }

    // ── Step 2: Find mod/admin roles ─────────────────────────────────────
    console.log('\n[Step 2] Finding moderation & administration roles...\n');
    const modRoles = findModAdminRoles(guild);

    modRoles.forEach(role => {
        const perms = [];
        if (role.permissions.has(PermissionFlagsBits.Administrator)) perms.push('ADMIN');
        if (role.permissions.has(PermissionFlagsBits.ModerateMembers)) perms.push('MOD');
        if (role.permissions.has(PermissionFlagsBits.BanMembers)) perms.push('BAN');
        if (role.permissions.has(PermissionFlagsBits.KickMembers)) perms.push('KICK');
        if (role.permissions.has(PermissionFlagsBits.ManageGuild)) perms.push('MANAGE');
        console.log(`  @${role.name} (${role.id}) - ${perms.join(', ')}`);
    });

    // ── Step 3: Create additional log channels ───────────────────────────
    console.log('\n[Step 3] Creating additional log channels...\n');

    const createdChannels = {};

    for (const [channelName, def] of Object.entries(NEW_CHANNEL_DEFS)) {
        // Check if a channel with this name already exists in the category
        const existing = guild.channels.cache.find(
            ch => ch.parentId === LOGS_CATEGORY_ID && ch.name === channelName
        );

        if (existing) {
            createdChannels[channelName] = existing;
            console.log(`  Existing #${channelName} (${existing.id}) - reusing`);
        } else {
            const channel = await guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: LOGS_CATEGORY_ID,
                topic: def.topic
            });
            createdChannels[channelName] = channel;
            console.log(`  Created #${channelName} (${channel.id}) - ${def.events.length} event(s)`);
        }
    }

    // ── Step 4: Ensure DB tables exist ───────────────────────────────────
    console.log('\n[Step 4] Ensuring database tables exist...\n');

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

    try {
        await pool.execute(`
            ALTER TABLE logging_config ADD COLUMN IF NOT EXISTS enabled TINYINT DEFAULT 1
        `);
        console.log('  logging_config.enabled column ensured.');
    } catch (err) {
        if (!err.message.includes('Duplicate column')) {
            console.log(`  Note: ${err.message}`);
        }
    }

    // ── Step 5: Configure event routing ──────────────────────────────────
    console.log('\n[Step 5] Configuring event routing in database...\n');

    const allEventTypes = [];

    // Route existing channels
    for (const [channelId, mapping] of Object.entries(EXISTING_CHANNEL_MAPPINGS)) {
        const channel = guild.channels.cache.get(channelId);
        if (!channel) continue;

        for (const eventType of mapping.events) {
            allEventTypes.push(eventType);
            await pool.execute(`
                INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id)
                VALUES (?, ?, 1, ?)
                ON DUPLICATE KEY UPDATE
                    enabled = 1,
                    log_channel_id = VALUES(log_channel_id)
            `, [GUILD_ID, eventType, channelId]);
        }
        console.log(`  #${channel.name} -> ${mapping.events.length} event(s) routed`);
    }

    // Route new channels
    for (const [channelName, def] of Object.entries(NEW_CHANNEL_DEFS)) {
        const channel = createdChannels[channelName];
        if (!channel) continue;

        for (const eventType of def.events) {
            allEventTypes.push(eventType);
            await pool.execute(`
                INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id)
                VALUES (?, ?, 1, ?)
                ON DUPLICATE KEY UPDATE
                    enabled = 1,
                    log_channel_id = VALUES(log_channel_id)
            `, [GUILD_ID, eventType, channel.id]);
        }
        console.log(`  #${channelName} -> ${def.events.length} event(s) routed`);
    }

    // Update logging_config master record
    const defaultChannelId = '926691118169608212'; // #member-log as default
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
    console.log(`\n  Default log channel: #member-log (${defaultChannelId})`);
    console.log(`  Enabled ${allEventTypes.length} event types total`);

    // ── Step 6: Create Streamer reaction-role panel ──────────────────────
    console.log('\n[Step 6] Creating Streamer reaction-role panel in #roles...\n');

    const rolesChannel = guild.channels.cache.get(ROLES_CHANNEL_ID);
    if (!rolesChannel) {
        console.log('  WARNING: #roles channel not found, skipping panel creation');
    } else {
        // Check if we already created a panel
        const [existingPanels] = await pool.execute(
            'SELECT * FROM reaction_role_panels WHERE guild_id = ? AND channel_id = ?',
            [GUILD_ID, ROLES_CHANNEL_ID]
        );

        if (existingPanels.length > 0) {
            console.log(`  Panel already exists (ID: ${existingPanels[0].id}), skipping`);
        } else {
            const streamerEmbed = new EmbedBuilder()
                .setColor('#AD1457')
                .setTitle('Streamer Role')
                .setDescription(
                    'Are you a Streamer? Click the button below to get the **Streamer** role!\n\n' +
                    'This role gives you access to stream-related channels and notifications.'
                )
                .setFooter({ text: 'Click the button to toggle the role' });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`rr_${STREAMER_ROLE_ID}`)
                    .setLabel('Streamer')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('📺')
            );

            const panelMsg = await rolesChannel.send({ embeds: [streamerEmbed], components: [row] });
            console.log(`  Sent Streamer panel: ${panelMsg.id}`);

            // Save to DB — matches actual schema:
            // reaction_role_panels: id, guild_id, channel_id, message_id, panel_name, description,
            //   embed_color, thumbnail_url, image_url, panel_mode, interaction_type, max_selections, placeholder_text
            const [panelResult] = await pool.execute(
                `INSERT INTO reaction_role_panels
                (guild_id, channel_id, message_id, panel_name, description, embed_color, panel_mode, interaction_type)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [GUILD_ID, ROLES_CHANNEL_ID, panelMsg.id, 'Streamer Role', 'Toggle your Streamer role', '#AD1457', 'toggle', 'button']
            );

            const panelId = panelResult.insertId;

            // reaction_role_mappings: id, panel_id, emoji_id, role_id
            await pool.execute(
                `INSERT INTO reaction_role_mappings (panel_id, emoji_id, role_id)
                VALUES (?, ?, ?)`,
                [panelId, '📺', STREAMER_ROLE_ID]
            );

            console.log(`  Panel saved to DB: panel_id=${panelId}, message_id=${panelMsg.id}`);
        }
    }

    // ── Step 7: Create rules embed ───────────────────────────────────────
    console.log('\n[Step 7] Creating rules embed in #rules...\n');

    const rulesChannel = guild.channels.cache.get(RULES_CHANNEL_ID);
    if (!rulesChannel) {
        console.log('  WARNING: #rules channel not found, skipping');
    } else {
        const rulesEmbed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('Spoodercord Community Rules')
            .setDescription(
                '**Welcome to Spoodercord!** Please read and follow these rules to keep our community safe and fun for everyone.\n\n' +
                'By being in this server, you agree to abide by these rules and Discord\'s [Terms of Service](https://discord.com/terms) and [Community Guidelines](https://discord.com/guidelines).'
            )
            .addFields(
                {
                    name: '1. No Racism, Hate Speech, or Harassment',
                    value: 'Racism, hate speech, or harassment will **not** be tolerated at any level and will result in an **immediate ban** and report to Discord administration.',
                    inline: false
                },
                {
                    name: '2. Respect All Members',
                    value: 'Respect your fellow members and the administration of this server. Failure to show respect may result in your removal from the community.',
                    inline: false
                },
                {
                    name: '3. No NSFW in General Channels',
                    value: 'Keep NSFW content in designated NSFW channels only. Posting explicit content outside of these channels will result in action.',
                    inline: false
                },
                {
                    name: '4. No Spam or Self-Promotion',
                    value: 'Do not spam messages, links, or unsolicited self-promotion. Use the appropriate channels for sharing content.',
                    inline: false
                },
                {
                    name: '5. Listen to Staff',
                    value: 'Moderators and admins have the final say. If you disagree with a decision, reach out respectfully in DMs.',
                    inline: false
                },
                {
                    name: '6. No Doxxing or Personal Information',
                    value: 'Do not share anyone\'s personal information without their explicit consent. This includes real names, addresses, phone numbers, etc.',
                    inline: false
                }
            )
            .setFooter({ text: 'Rules are subject to change. Last updated: February 2026' })
            .setTimestamp();

        const rulesMsg = await rulesChannel.send({ embeds: [rulesEmbed] });
        console.log(`  Rules embed sent: ${rulesMsg.id}`);
    }

    // ── Summary ──────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(70));
    console.log('  SETUP COMPLETE');
    console.log('='.repeat(70));

    console.log('\n  EXISTING LOG CHANNELS CONFIGURED:');
    for (const [channelId, mapping] of Object.entries(EXISTING_CHANNEL_MAPPINGS)) {
        const ch = guild.channels.cache.get(channelId);
        if (ch) {
            console.log(`    #${ch.name} (${channelId}) -> ${mapping.events.join(', ')}`);
        }
    }

    console.log('\n  NEW LOG CHANNELS CREATED:');
    for (const [name, ch] of Object.entries(createdChannels)) {
        const def = NEW_CHANNEL_DEFS[name];
        console.log(`    #${name} (${ch.id}) -> ${def.events.join(', ')}`);
    }

    console.log(`\n  TOTAL EVENT TYPES: ${allEventTypes.length}`);
    console.log(`  DEFAULT LOG CHANNEL: #member-log (${defaultChannelId})`);

    console.log('\n  NEXT STEPS:');
    console.log('    1. Restart the bot: pm2 restart CertiFriedUtility');
    console.log('    2. Delete old ProBot messages from #roles and #rules');
    console.log('    3. Remove ProBot from the server when ready');
    console.log('    4. Test logging by editing/deleting a message');
    console.log('    5. Test the Streamer role button in #roles');
    console.log('\n');

    client.destroy();
    await pool.end();
}

setup().catch(err => {
    console.error('FATAL ERROR:', err);
    if (client) client.destroy();
    if (pool) pool.end();
    process.exit(1);
});
