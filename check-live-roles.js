const { Client, GatewayIntentBits } = require('discord.js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { pool } = require('./utils/db.js');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers
    ]
});

async function checkLiveRoles() {
    try {
        console.log('========================================');
        console.log('CHECKING LIVE ROLE ASSIGNMENTS');
        console.log('========================================\n');

        // Get all live announcements (tracked as currently live)
        const [liveStreams] = await pool.execute(`
            SELECT
                la.guild_id,
                la.platform,
                la.username,
                la.discord_user_id,
                la.stream_started_at
            FROM live_announcements la
            ORDER BY la.stream_started_at DESC
        `);

        console.log(`📊 DATABASE: ${liveStreams.length} streamers tracked as live\n`);

        if (liveStreams.length === 0) {
            console.log('✅ No streamers currently tracked as live in database.');
        } else {
            for (const stream of liveStreams) {
                console.log(`Platform: ${stream.platform.toUpperCase()}`);
                console.log(`Username: ${stream.username}`);
                console.log(`Server: ${stream.guild_id}`);
                console.log(`Discord User: ${stream.discord_user_id || 'Not linked'}`);
                console.log(`Started: ${stream.stream_started_at}`);
                console.log('---');
            }
        }

        // Get all guild settings with live roles configured
        const [guildsWithRoles] = await pool.execute(`
            SELECT guild_id, live_role_id
            FROM guilds
            WHERE live_role_id IS NOT NULL AND live_role_id != ''
        `);

        console.log(`\n📋 CONFIGURED LIVE ROLES: ${guildsWithRoles.length} servers\n`);

        // Log in to Discord
        await client.login(process.env.DISCORD_BOT_TOKEN);
        console.log(`🤖 Logged in as ${client.user.tag}\n`);

        console.log('========================================');
        console.log('DISCORD ROLE VERIFICATION');
        console.log('========================================\n');

        let totalMembersWithRoles = 0;
        const membersWithRoles = [];

        for (const guildData of guildsWithRoles) {
            try {
                const guild = await client.guilds.fetch(guildData.guild_id);
                const role = await guild.roles.fetch(guildData.live_role_id).catch(() => null);

                if (!role) {
                    console.log(`⚠️  Server: ${guildData.guild_id}`);
                    console.log(`   Role ID ${guildData.live_role_id} not found`);
                    console.log('');
                    continue;
                }

                // Fetch all members with this role
                await guild.members.fetch();
                const membersWithRole = guild.members.cache.filter(member => member.roles.cache.has(role.id));

                console.log(`Server: ${guildData.guild_id}`);
                console.log(`Role: ${role.name} (${role.id})`);
                console.log(`Members with role: ${membersWithRole.size}`);

                if (membersWithRole.size > 0) {
                    membersWithRole.forEach(member => {
                        console.log(`   - ${member.user.tag} (${member.id})`);
                        membersWithRoles.push({
                            guildName: guildData.guild_id,
                            guildId: guildData.guild_id,
                            userId: member.id,
                            username: member.user.tag
                        });
                        totalMembersWithRoles++;
                    });
                }
                console.log('');

            } catch (error) {
                console.log(`❌ Error checking ${guildData.guild_id}: ${error.message}\n`);
            }
        }

        console.log('========================================');
        console.log('SUMMARY');
        console.log('========================================');
        console.log(`Database tracked as live: ${liveStreams.length}`);
        console.log(`Discord users with live roles: ${totalMembersWithRoles}`);
        console.log('');

        // Cross-reference
        if (liveStreams.length === 0 && totalMembersWithRoles === 0) {
            console.log('✅ CONSISTENT: No live streams, no live roles assigned');
        } else if (liveStreams.length > 0 && totalMembersWithRoles === 0) {
            console.log('⚠️  WARNING: Streams tracked but no roles assigned');
            console.log('   This could mean streamers are not linked to Discord accounts');
        } else if (liveStreams.length === 0 && totalMembersWithRoles > 0) {
            console.log('❌ INCONSISTENT: No streams tracked but users have live roles!');
            console.log('   Roles should have been removed when streams ended');
        } else {
            console.log('🔍 CHECKING CONSISTENCY...');
            // Check if the users with roles match the live streams
            const linkedLiveStreamers = liveStreams.filter(s => s.discord_user_id);
            console.log(`   Linked streamers in DB: ${linkedLiveStreamers.length}`);
            console.log(`   Users with roles: ${totalMembersWithRoles}`);
        }

        await pool.end();
        client.destroy();
        process.exit(0);

    } catch (error) {
        console.error('❌ Error:', error);
        if (client.isReady()) client.destroy();
        process.exit(1);
    }
}

checkLiveRoles();
