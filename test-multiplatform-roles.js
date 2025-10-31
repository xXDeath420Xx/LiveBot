/**
 * Test script to demonstrate multi-platform role flapping issue
 *
 * Scenario:
 * - User "TestUser" has Discord ID "123456789"
 * - Has Twitch account "test_twitch"
 * - Has Kick account "test_kick"
 * - Both subscribed in guild "999"
 *
 * Timeline:
 * T=0: Both live, role added
 * T=60s: Twitch goes offline → offline worker removes role immediately
 * T=90s: Next check sees Kick still live → role re-added
 * Result: 30 second gap where user loses role despite being live on Kick
 */

const { pool } = require('./utils/db');

async function simulateScenario() {
    console.log('\n=== Multi-Platform Role Flapping Test ===\n');

    // Check if we have any multi-platform users
    const [multiPlatformUsers] = await pool.execute(`
        SELECT
            discord_user_id,
            GROUP_CONCAT(CONCAT(platform, ':', username) SEPARATOR ', ') as platforms,
            COUNT(*) as platform_count
        FROM streamers
        WHERE discord_user_id IS NOT NULL
        GROUP BY discord_user_id
        HAVING COUNT(*) > 1
        ORDER BY platform_count DESC
        LIMIT 10
    `);

    console.log('Multi-Platform Users in Database:');
    console.log('='.repeat(80));

    if (multiPlatformUsers.length === 0) {
        console.log('❌ No multi-platform users found in database');
        console.log('\nTo test this scenario, you need users with multiple platforms linked.');
        process.exit(0);
    }

    multiPlatformUsers.forEach((user, i) => {
        console.log(`${i + 1}. Discord ID: ${user.discord_user_id}`);
        console.log(`   Platforms: ${user.platforms}`);
        console.log(`   Total: ${user.platform_count} platforms`);
        console.log();
    });

    console.log('\n=== Potential Race Condition Scenario ===\n');
    console.log('If any of these users are live on multiple platforms:');
    console.log('1. Platform A goes offline');
    console.log('2. offline-worker.ts IMMEDIATELY removes ALL roles (line 83)');
    console.log('3. Does NOT check if user is still live on Platform B');
    console.log('4. Next stream check (~30-60s later) sees Platform B still live');
    console.log('5. Roles re-added');
    console.log('\nResult: User loses role for ~30-60 seconds despite being live!\n');

    // Check current live announcements
    const [liveAnnouncements] = await pool.execute(`
        SELECT
            la.guild_id,
            la.platform,
            la.username,
            s.discord_user_id,
            la.channel_id,
            la.message_id,
            la.stream_started_at
        FROM live_announcements la
        JOIN streamers s ON la.streamer_id = s.streamer_id
        WHERE s.discord_user_id IN (${multiPlatformUsers.map(() => '?').join(',')})
        ORDER BY s.discord_user_id, la.platform
    `, multiPlatformUsers.map(u => u.discord_user_id));

    if (liveAnnouncements.length > 0) {
        console.log('Currently Live Multi-Platform Users:');
        console.log('='.repeat(80));

        const grouped = {};
        liveAnnouncements.forEach(ann => {
            if (!grouped[ann.discord_user_id]) {
                grouped[ann.discord_user_id] = [];
            }
            grouped[ann.discord_user_id].push(ann);
        });

        Object.entries(grouped).forEach(([discordId, announcements]) => {
            console.log(`Discord ID: ${discordId}`);
            announcements.forEach(ann => {
                console.log(`  ├─ ${ann.platform}: ${ann.username} (Guild: ${ann.guild_id})`);
                console.log(`  │  Started: ${ann.stream_started_at}`);
            });
            console.log(`  └─ RISK: If any platform goes offline, ALL roles removed immediately!`);
            console.log();
        });
    } else {
        console.log('✅ No multi-platform users currently live (no immediate risk)');
    }

    process.exit(0);
}

simulateScenario().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
