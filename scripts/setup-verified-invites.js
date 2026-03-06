/**
 * Set up verified user invite permissions for server 1452972683867459657
 *
 * - Find the "verified" role
 * - Grant CREATE_INSTANT_INVITE permission to verified role
 * - Update invite_policy with verified_role_id
 * - Ensure invite tracking is working
 */

import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

async function main() {
    console.log('🔒 Setting up verified user invite permissions...\n');

    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    if (!bots.length) {
        console.error('❌ Custom bot not found in database');
        process.exit(1);
    }

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
        // STEP 1: Find the "verified" role
        // ============================================
        console.log('🔍 Looking for verified role...');

        let verifiedRole = null;
        for (const [id, role] of guild.roles.cache) {
            const nameLower = role.name.toLowerCase();
            if (nameLower === 'verified' ||
                nameLower.includes('verified') ||
                nameLower === '✅ verified' ||
                nameLower === '🌱 seedling') { // Common verified role name in grow communities
                verifiedRole = role;
                console.log(`   Found potential verified role: ${role.name} (${role.id})`);
            }
        }

        // List all roles for reference
        console.log('\n📋 All roles in server:');
        const sortedRoles = [...guild.roles.cache.values()].sort((a, b) => b.position - a.position);
        for (const role of sortedRoles) {
            const hasInvitePerm = role.permissions.has(PermissionFlagsBits.CreateInstantInvite);
            console.log(`   ${role.position}. ${role.name} (${role.id}) - Can invite: ${hasInvitePerm ? '✅' : '❌'}`);
        }

        if (!verifiedRole) {
            console.log('\n⚠️  No verified role found automatically.');
            console.log('   Please specify the role ID manually.');
            console.log('   Look at the role list above and update the script with the correct role ID.');
            client.destroy();
            process.exit(1);
        }

        console.log(`\n✅ Using verified role: ${verifiedRole.name} (${verifiedRole.id})`);

        // ============================================
        // STEP 2: Grant CREATE_INSTANT_INVITE to verified role
        // ============================================
        console.log('\n🔑 Granting invite permission to verified role...');

        if (!verifiedRole.permissions.has(PermissionFlagsBits.CreateInstantInvite)) {
            const newPerms = verifiedRole.permissions.add(PermissionFlagsBits.CreateInstantInvite);
            await verifiedRole.setPermissions(newPerms, 'Allowing verified users to create single-use invites');
            console.log(`   ✅ Added CREATE_INSTANT_INVITE permission to ${verifiedRole.name}`);
        } else {
            console.log(`   ✅ ${verifiedRole.name} already has invite permission`);
        }

        // ============================================
        // STEP 3: Update invite_policy with verified_role_id
        // ============================================
        console.log('\n💾 Updating invite policy...');

        await pool.execute(`
            UPDATE invite_policy
            SET verified_role_id = ?,
                staff_only = FALSE,
                single_use_only = TRUE,
                max_age_seconds = 604800
            WHERE guild_id = ?
        `, [verifiedRole.id, GUILD_ID]);

        console.log(`   ✅ Updated invite_policy with verified_role_id: ${verifiedRole.id}`);

        // ============================================
        // STEP 4: Delete any existing non-compliant invites
        // ============================================
        console.log('\n🗑️  Checking existing invites...');

        try {
            const invites = await guild.invites.fetch();
            let deleted = 0;
            let kept = 0;

            for (const [code, invite] of invites) {
                const isNonCompliant =
                    invite.maxUses !== 1 ||
                    invite.maxAge === 0 ||
                    invite.maxAge > 604800;

                if (isNonCompliant) {
                    await invite.delete('Enforcing single-use invite policy');
                    console.log(`   🗑️  Deleted: ${code} (uses: ${invite.maxUses || '∞'}, expires: ${invite.maxAge ? Math.round(invite.maxAge/3600) + 'h' : 'never'})`);
                    deleted++;
                } else {
                    console.log(`   ✅ Kept: ${code} (single-use, expires in ${Math.round(invite.maxAge/3600)}h)`);
                    kept++;
                }
            }

            console.log(`\n   Summary: ${deleted} deleted, ${kept} kept`);
        } catch (e) {
            console.log(`   ⚠️  Could not fetch invites: ${e.message}`);
        }

        // ============================================
        // Summary
        // ============================================
        console.log('\n' + '═'.repeat(60));
        console.log('🎉 VERIFIED USER INVITE SYSTEM SETUP COMPLETE');
        console.log('═'.repeat(60));
        console.log('\n📋 Configuration:');
        console.log(`   • Verified role: ${verifiedRole.name} (${verifiedRole.id})`);
        console.log('   • Verified users CAN create invites');
        console.log('   • All invites must be single-use');
        console.log('   • All invites expire after 7 days max');
        console.log('   • All invite creations are tracked in database');
        console.log('\n📋 How It Works:');
        console.log('   1. User with verified role creates an invite');
        console.log('   2. If invite is NOT single-use, bot deletes and replaces it');
        console.log('   3. All invites are logged in invite_tracking table');
        console.log('   4. New member joins using the invite');
        console.log('   5. Member appears in Discord\'s "Pending" section');
        console.log('   6. Admin approves/denies in Server Settings > Members');
        console.log('');

        client.destroy();
        await pool.end();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
