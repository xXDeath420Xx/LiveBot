/**
 * Discovery script for guild 961514092848382043 (YYZ Studio bot).
 * Connects via the bot and dumps channels, roles, Mee6 artifacts, and server settings.
 *
 * Usage: node scripts/discover-guild-setup.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const BOT_ID = '1345684217438273577';
const GUILD_ID = '961514092848382043';
const MEE6_USER_ID = '159985870458322944';

const CHANNEL_TYPE_NAMES = {
    [ChannelType.GuildText]: 'Text',
    [ChannelType.GuildVoice]: 'Voice',
    [ChannelType.GuildCategory]: 'Category',
    [ChannelType.GuildAnnouncement]: 'Announcement',
    [ChannelType.GuildStageVoice]: 'Stage',
    [ChannelType.GuildForum]: 'Forum',
    [ChannelType.GuildMedia]: 'Media',
};

async function discover() {
    // Get bot token from DB
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    if (!bots.length) { console.error('Bot not found'); process.exit(1); }
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildWebhooks,
        ]
    });

    await client.login(token);
    await new Promise(r => client.once('ready', r));
    console.log(`Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) { console.error('Guild not found'); process.exit(1); }

    console.log(`\nGuild: ${guild.name} (${guild.id})`);
    console.log(`Members: ${guild.memberCount}`);

    // ========== CHANNELS ==========
    console.log('\n' + '='.repeat(60));
    console.log('CHANNELS');
    console.log('='.repeat(60));

    const channels = guild.channels.cache
        .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));

    // Group by category
    const categories = channels.filter(c => c.type === ChannelType.GuildCategory);
    const uncategorized = channels.filter(c => !c.parentId && c.type !== ChannelType.GuildCategory);

    // Print uncategorized first
    if (uncategorized.size > 0) {
        console.log('\n[No Category]');
        for (const [, ch] of uncategorized) {
            const type = CHANNEL_TYPE_NAMES[ch.type] || ch.type;
            const topic = ch.topic ? ` — "${ch.topic.substring(0, 80)}"` : '';
            console.log(`  ${type.padEnd(14)} #${ch.name.padEnd(30)} ${ch.id}${topic}`);
        }
    }

    for (const [, cat] of categories) {
        console.log(`\n[${cat.name}] (${cat.id})`);
        const children = channels.filter(c => c.parentId === cat.id)
            .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
        for (const [, ch] of children) {
            const type = CHANNEL_TYPE_NAMES[ch.type] || ch.type;
            const topic = ch.topic ? ` — "${ch.topic.substring(0, 80)}"` : '';
            console.log(`  ${type.padEnd(14)} #${ch.name.padEnd(30)} ${ch.id}${topic}`);
        }
    }

    // ========== ROLES ==========
    console.log('\n' + '='.repeat(60));
    console.log('ROLES');
    console.log('='.repeat(60));

    // Fetch all members to get accurate member counts
    try { await guild.members.fetch(); } catch { console.log('(Could not fetch all members)'); }

    const roles = guild.roles.cache
        .sort((a, b) => b.position - a.position);

    console.log(`\n${'Name'.padEnd(30)} ${'Position'.padEnd(10)} ${'Color'.padEnd(10)} ${'Members'.padEnd(10)} ID`);
    console.log('-'.repeat(90));
    for (const [, role] of roles) {
        const color = role.hexColor !== '#000000' ? role.hexColor : '—';
        const members = role.members.size;
        console.log(`${role.name.padEnd(30)} ${String(role.position).padEnd(10)} ${color.padEnd(10)} ${String(members).padEnd(10)} ${role.id}`);
    }

    // ========== MEE6 ARTIFACTS ==========
    console.log('\n' + '='.repeat(60));
    console.log('MEE6 ARTIFACTS');
    console.log('='.repeat(60));

    // Check for Mee6 bot in members
    try {
        const mee6Member = await guild.members.fetch(MEE6_USER_ID).catch(() => null);
        if (mee6Member) {
            console.log(`\nMee6 bot IS present in the server`);
            console.log(`  Roles: ${mee6Member.roles.cache.map(r => r.name).join(', ')}`);
        } else {
            console.log('\nMee6 bot is NOT in the server');
        }
    } catch {
        console.log('\nCould not check for Mee6 bot');
    }

    // Check for Mee6 webhooks in text channels
    console.log('\nChecking for Mee6 webhooks...');
    const textChannels = channels.filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement);
    let webhookCount = 0;
    for (const [, ch] of textChannels) {
        try {
            const webhooks = await ch.fetchWebhooks();
            const mee6Hooks = webhooks.filter(w =>
                w.name?.toLowerCase().includes('mee6') ||
                w.owner?.id === MEE6_USER_ID
            );
            if (mee6Hooks.size > 0) {
                for (const [, hook] of mee6Hooks) {
                    console.log(`  Mee6 webhook in #${ch.name}: "${hook.name}" (${hook.id})`);
                    webhookCount++;
                }
            }
        } catch {
            // Bot may lack Manage Webhooks in some channels, skip silently
        }
    }
    if (webhookCount === 0) console.log('  No Mee6 webhooks found');

    // Look for level-reward-style roles (Mee6 typically creates roles like "Level 5", "Level 10")
    console.log('\nPotential level-reward roles:');
    const levelRoles = guild.roles.cache.filter(r =>
        /level\s*\d+/i.test(r.name) ||
        /lvl\s*\d+/i.test(r.name) ||
        /rank\s*\d+/i.test(r.name)
    );
    if (levelRoles.size > 0) {
        for (const [, role] of levelRoles) {
            console.log(`  ${role.name} (${role.id}) — ${role.members.size} members — color: ${role.hexColor}`);
        }
    } else {
        console.log('  None found (no "Level X" / "Lvl X" / "Rank X" role names)');
    }

    // ========== NOTABLE CHANNELS ==========
    console.log('\n' + '='.repeat(60));
    console.log('NOTABLE CHANNEL CANDIDATES');
    console.log('='.repeat(60));

    const patterns = {
        welcome: /welcome|greet|hello|intro/i,
        rules: /rules|guidelines|info/i,
        modLog: /mod-?log|audit|bot-?log|server-?log/i,
        general: /general|chat|lounge/i,
        announcements: /announce|news|update/i,
        levelUp: /level|rank|xp/i,
        selfRoles: /role|self-?role|reaction-?role/i,
        music: /music|jukebox|dj/i,
        bot: /bot|command|spam/i,
    };

    for (const [label, regex] of Object.entries(patterns)) {
        const matches = textChannels.filter(c => regex.test(c.name) || (c.topic && regex.test(c.topic)));
        if (matches.size > 0) {
            const list = matches.map(c => `#${c.name} (${c.id})`).join(', ');
            console.log(`  ${label.padEnd(16)} ${list}`);
        }
    }

    // ========== SERVER SETTINGS ==========
    console.log('\n' + '='.repeat(60));
    console.log('SERVER SETTINGS');
    console.log('='.repeat(60));

    console.log(`Verification Level: ${guild.verificationLevel}`);
    console.log(`Default Notifications: ${guild.defaultMessageNotifications === 0 ? 'All Messages' : 'Only @mentions'}`);
    console.log(`System Channel: ${guild.systemChannel ? `#${guild.systemChannel.name} (${guild.systemChannelId})` : 'None'}`);
    console.log(`Rules Channel: ${guild.rulesChannel ? `#${guild.rulesChannel.name} (${guild.rulesChannelId})` : 'None'}`);
    console.log(`Public Updates Channel: ${guild.publicUpdatesChannel ? `#${guild.publicUpdatesChannel.name} (${guild.publicUpdatesChannelId})` : 'None'}`);
    console.log(`AFK Channel: ${guild.afkChannel ? `#${guild.afkChannel.name} (${guild.afkChannelId})` : 'None'}`);
    console.log(`AFK Timeout: ${guild.afkTimeout}s`);
    console.log(`2FA Required for Moderation: ${guild.mfaLevel === 1 ? 'Yes' : 'No'}`);
    console.log(`Explicit Content Filter: ${guild.explicitContentFilter}`);
    console.log(`Boost Level: ${guild.premiumTier} (${guild.premiumSubscriptionCount} boosts)`);

    // ========== EXISTING CONFIG IN DB ==========
    console.log('\n' + '='.repeat(60));
    console.log('EXISTING DB CONFIG');
    console.log('='.repeat(60));

    const tables = [
        'welcome_settings', 'level_config', 'level_rewards',
        'automod_rules', 'adaptive_spam_config', 'raid_config',
        'anti_nuke_config', 'selfbot_detection_config',
        'logging_config', 'escalation_rules',
        'reaction_role_panels'
    ];

    for (const table of tables) {
        try {
            const [rows] = await pool.execute(`SELECT * FROM ${table} WHERE guild_id = ?`, [GUILD_ID]);
            console.log(`  ${table.padEnd(30)} ${rows.length > 0 ? `${rows.length} row(s)` : '(empty)'}`);
        } catch {
            console.log(`  ${table.padEnd(30)} (table not found)`);
        }
    }

    console.log('\n========================================');
    console.log('DISCOVERY COMPLETE');
    console.log('========================================');

    client.destroy();
    await pool.end();
    process.exit(0);
}

discover().catch(err => {
    console.error('Discovery failed:', err);
    process.exit(1);
});
