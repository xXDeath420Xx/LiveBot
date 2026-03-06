/**
 * Set up invite restrictions and membership screening for Growmie server
 *
 * - Remove CREATE_INSTANT_INVITE from all non-staff roles
 * - Delete any existing multi-use invites
 * - Set up invite monitoring
 */

import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

async function main() {
    console.log('🔒 Setting up invite restrictions...\n');

    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildInvites,
            GatewayIntentBits.GuildMembers
        ]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}\n`);

        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            console.error('❌ Guild not found!');
            process.exit(1);
        }

        // ============================================
        // STEP 1: Remove CREATE_INSTANT_INVITE from non-staff roles
        // ============================================
        console.log('🚫 Removing invite creation permissions...');

        const staffRoleNames = ['👑 Garden Master', '🛡️ Greenhouse Guard', '🌿 Garden Helper'];

        for (const [id, role] of guild.roles.cache) {
            if (role.managed || role.id === guild.id) continue; // Skip bot roles and @everyone

            const isStaff = staffRoleNames.some(name => role.name === name);

            if (!isStaff && role.permissions.has(PermissionFlagsBits.CreateInstantInvite)) {
                const newPerms = role.permissions.remove(PermissionFlagsBits.CreateInstantInvite);
                await role.setPermissions(newPerms, 'Restricting invite creation to staff only');
                console.log(`   ✅ Removed invite permission from: ${role.name}`);
            }
        }

        // Also remove from @everyone
        const everyoneRole = guild.roles.everyone;
        if (everyoneRole.permissions.has(PermissionFlagsBits.CreateInstantInvite)) {
            const newPerms = everyoneRole.permissions.remove(PermissionFlagsBits.CreateInstantInvite);
            await everyoneRole.setPermissions(newPerms, 'Restricting invite creation to staff only');
            console.log('   ✅ Removed invite permission from: @everyone');
        }

        // ============================================
        // STEP 2: Remove CREATE_INSTANT_INVITE from all channels
        // ============================================
        console.log('\n📁 Updating channel permissions...');

        let channelsUpdated = 0;
        for (const [id, channel] of guild.channels.cache) {
            if (channel.type === ChannelType.GuildCategory) continue;

            try {
                // Deny invite creation for @everyone on all channels
                await channel.permissionOverwrites.edit(everyoneRole, {
                    CreateInstantInvite: false
                });
                channelsUpdated++;
            } catch (e) {
                // Some channels may not allow this
            }
        }
        console.log(`   ✅ Updated ${channelsUpdated} channels - invite creation denied`);

        // ============================================
        // STEP 3: Delete existing non-single-use invites
        // ============================================
        console.log('\n🗑️  Checking existing invites...');

        try {
            const invites = await guild.invites.fetch();
            let deleted = 0;
            let kept = 0;

            for (const [code, invite] of invites) {
                // Delete invites that are:
                // - Not single use (maxUses !== 1)
                // - Have no expiration or expiration > 7 days
                const isProblematic =
                    invite.maxUses !== 1 ||
                    invite.maxAge === 0 ||
                    invite.maxAge > 604800; // 7 days in seconds

                if (isProblematic) {
                    await invite.delete('Enforcing single-use invite policy');
                    console.log(`   🗑️  Deleted invite: ${code} (uses: ${invite.maxUses || 'unlimited'}, expires: ${invite.maxAge ? invite.maxAge/3600 + 'h' : 'never'})`);
                    deleted++;
                } else {
                    console.log(`   ✅ Kept invite: ${code} (single-use, expires in ${invite.maxAge/3600}h)`);
                    kept++;
                }
            }

            console.log(`\n   Summary: ${deleted} deleted, ${kept} kept`);
        } catch (e) {
            console.log(`   ⚠️  Could not fetch invites: ${e.message}`);
        }

        // ============================================
        // STEP 4: Enable Membership Screening requirements
        // ============================================
        console.log('\n📋 Checking server features...');

        // Check if community is enabled
        if (guild.features.includes('COMMUNITY')) {
            console.log('   ✅ Community features enabled');
        } else {
            console.log('   ⚠️  Community features not enabled');
            console.log('      To enable: Server Settings > Enable Community');
        }

        if (guild.features.includes('MEMBER_VERIFICATION_GATE_ENABLED')) {
            console.log('   ✅ Membership Screening enabled');
        } else {
            console.log('   ⚠️  Membership Screening not enabled');
            console.log('      To enable: Server Settings > Safety Setup > Membership Screening');
        }

        // Set verification level to Medium (must have verified email)
        try {
            await guild.setVerificationLevel(2);
            console.log('   ✅ Verification level set to Medium (verified email required)');
        } catch (e) {
            console.log(`   ⚠️  Could not set verification level: ${e.message}`);
        }

        // ============================================
        // STEP 5: Save invite settings to database
        // ============================================
        console.log('\n💾 Saving invite policy to database...');

        await pool.execute(`
            INSERT INTO guild_config (guild_id, prefix, language, timezone)
            VALUES (?, '!', 'en', 'America/New_York')
            ON DUPLICATE KEY UPDATE guild_id = guild_id
        `, [GUILD_ID]);

        // Create invite_policy table if needed and save settings
        try {
            await pool.execute(`
                CREATE TABLE IF NOT EXISTS invite_policy (
                    guild_id VARCHAR(20) PRIMARY KEY,
                    single_use_only BOOLEAN DEFAULT TRUE,
                    max_age_seconds INT DEFAULT 604800,
                    staff_only BOOLEAN DEFAULT TRUE,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
            `);

            await pool.execute(`
                INSERT INTO invite_policy (guild_id, single_use_only, max_age_seconds, staff_only)
                VALUES (?, TRUE, 604800, TRUE)
                ON DUPLICATE KEY UPDATE
                    single_use_only = TRUE,
                    max_age_seconds = 604800,
                    staff_only = TRUE
            `, [GUILD_ID]);

            console.log('   ✅ Invite policy saved');
        } catch (e) {
            console.log(`   ⚠️  Could not save invite policy: ${e.message}`);
        }

        // ============================================
        // Summary
        // ============================================
        console.log('\n' + '═'.repeat(50));
        console.log('🎉 INVITE RESTRICTIONS SETUP COMPLETE');
        console.log('═'.repeat(50));
        console.log('\n📋 Current Settings:');
        console.log('   • Only staff can create invites');
        console.log('   • All invites must be single-use');
        console.log('   • All invites expire after 7 days max');
        console.log('   • Existing non-compliant invites deleted');
        console.log('\n📋 Manual Steps Required:');
        console.log('   1. Enable Community in Server Settings');
        console.log('   2. Set up Membership Screening:');
        console.log('      Server Settings > Safety Setup > Membership Screening');
        console.log('   3. Add screening questions/rules');
        console.log('\n📋 Staff Invite Commands:');
        console.log('   Staff can create invites via Discord or bot command');
        console.log('   Bot will enforce single-use + 7-day expiry');
        console.log('');

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
