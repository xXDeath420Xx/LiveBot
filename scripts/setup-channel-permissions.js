/**
 * Set up channel permissions for Flying Sharks server
 * 1. Lock all channels except #rules to require Member role
 * 2. Hide Moderation category from @everyone except specific roles
 */
import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } from 'discord.js';
import dotenv from 'dotenv';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });

const GUILD_ID = '1307517872301670480';
const RULES_CHANNEL_ID = '1311041107613974548';
const MEMBER_ROLE_ID = '1311043914849058826';
const MODERATION_CATEGORY_ID = '1311040278479507568';

// Roles that CAN see the Moderation category
const MOD_ALLOWED_ROLES = [
    '1311048183304159313',
    '1307521690401640538', 
    '1311039818224519189',
    '1462811773890728068'  // Bot Developer
];

async function getCustomBotToken(botId) {
    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [botId]
    );
    if (bots.length === 0) throw new Error('Bot not found');
    return encryption.decrypt(JSON.parse(bots[0].bot_token));
}

const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

client.once('ready', async () => {
    console.log('═'.repeat(60));
    console.log('CHANNEL PERMISSIONS SETUP');
    console.log('═'.repeat(60));

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
        console.log('ERROR: Bot not in guild');
        process.exit(1);
    }

    await guild.channels.fetch();
    await guild.roles.fetch();

    const everyoneRole = guild.roles.everyone;
    const memberRole = guild.roles.cache.get(MEMBER_ROLE_ID);

    if (!memberRole) {
        console.log('ERROR: Member role not found');
        process.exit(1);
    }

    console.log(`\nGuild: ${guild.name}`);
    console.log(`Everyone Role: ${everyoneRole.id}`);
    console.log(`Member Role: ${memberRole.name} (${memberRole.id})`);

    // ========== STEP 1: Lock all channels except #rules ==========
    console.log('\n[Step 1] Locking channels to require Member role...\n');

    const allChannels = guild.channels.cache.filter(c => 
        c.type === ChannelType.GuildText || 
        c.type === ChannelType.GuildVoice ||
        c.type === ChannelType.GuildAnnouncement ||
        c.type === ChannelType.GuildForum
    );

    let lockedCount = 0;
    for (const [channelId, channel] of allChannels) {
        // Skip #rules channel - it needs to be visible to everyone
        if (channelId === RULES_CHANNEL_ID) {
            console.log(`  ⏭️  Skipping #${channel.name} (rules channel)`);
            continue;
        }

        // Skip channels in the Moderation category (handled separately)
        if (channel.parentId === MODERATION_CATEGORY_ID) {
            console.log(`  ⏭️  Skipping #${channel.name} (moderation category)`);
            continue;
        }

        try {
            // Deny @everyone from viewing, allow Member role to view
            await channel.permissionOverwrites.edit(everyoneRole, {
                ViewChannel: false
            });
            await channel.permissionOverwrites.edit(memberRole, {
                ViewChannel: true
            });
            console.log(`  🔒 Locked #${channel.name}`);
            lockedCount++;
        } catch (e) {
            console.log(`  ❌ Failed to lock #${channel.name}: ${e.message}`);
        }
    }

    console.log(`\n  ✅ Locked ${lockedCount} channels`);

    // ========== STEP 2: Hide Moderation category ==========
    console.log('\n[Step 2] Hiding Moderation category...\n');

    const modCategory = guild.channels.cache.get(MODERATION_CATEGORY_ID);
    if (!modCategory) {
        console.log('  ❌ Moderation category not found');
    } else {
        // First, deny @everyone on the category
        try {
            await modCategory.permissionOverwrites.edit(everyoneRole, {
                ViewChannel: false
            });
            console.log(`  🔒 Denied @everyone on category: ${modCategory.name}`);
        } catch (e) {
            console.log(`  ❌ Failed to deny @everyone on category: ${e.message}`);
        }

        // Allow specific roles
        for (const roleId of MOD_ALLOWED_ROLES) {
            const role = guild.roles.cache.get(roleId);
            if (role) {
                try {
                    await modCategory.permissionOverwrites.edit(role, {
                        ViewChannel: true
                    });
                    console.log(`  ✅ Allowed ${role.name} (${roleId})`);
                } catch (e) {
                    console.log(`  ❌ Failed to allow role ${roleId}: ${e.message}`);
                }
            } else {
                console.log(`  ⚠️  Role ${roleId} not found in guild`);
            }
        }

        // Now apply the same permissions to all channels in the category
        const modChannels = guild.channels.cache.filter(c => c.parentId === MODERATION_CATEGORY_ID);
        console.log(`\n  Syncing ${modChannels.size} channels with category permissions...`);

        for (const [channelId, channel] of modChannels) {
            try {
                await channel.lockPermissions();
                console.log(`    🔄 Synced #${channel.name}`);
            } catch (e) {
                console.log(`    ❌ Failed to sync #${channel.name}: ${e.message}`);
            }
        }
    }

    // ========== STEP 3: Ensure #rules is visible to @everyone ==========
    console.log('\n[Step 3] Ensuring #rules is visible to everyone...\n');

    const rulesChannel = guild.channels.cache.get(RULES_CHANNEL_ID);
    if (rulesChannel) {
        try {
            await rulesChannel.permissionOverwrites.edit(everyoneRole, {
                ViewChannel: true,
                SendMessages: false,  // Can view but not send
                AddReactions: true    // Can react (for verification)
            });
            console.log(`  ✅ #rules is visible to @everyone (read-only with reactions)`);
        } catch (e) {
            console.log(`  ❌ Failed to set #rules permissions: ${e.message}`);
        }
    }

    console.log('\n' + '═'.repeat(60));
    console.log('✅ PERMISSIONS SETUP COMPLETE');
    console.log('═'.repeat(60));
    console.log(`
Summary:
• All channels locked to require Member role (except #rules)
• #rules visible to @everyone (read-only, can react)
• Moderation category hidden from @everyone
• Moderation visible to: Admin, Owner, Moderator, Bot Developer
`);

    await pool.end();
    client.destroy();
    process.exit(0);
});

// Login with custom bot
(async () => {
    const token = await getCustomBotToken('1462813232409612447');
    client.login(token);
})();
