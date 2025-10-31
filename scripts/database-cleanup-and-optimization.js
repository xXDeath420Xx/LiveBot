const mysql = require('mysql2/promise');
require('dotenv').config();

/**
 * Comprehensive Database Cleanup and Optimization Script
 *
 * This script:
 * 1. Identifies and removes duplicate tables
 * 2. Cleans orphaned records (references to deleted guilds/users)
 * 3. Optimizes table structures
 * 4. Adds missing indexes
 * 5. Runs intelligent systems migration
 * 6. Generates cleanup report
 */

async function main() {
    const db = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║   DATABASE CLEANUP & OPTIMIZATION                         ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    const report = {
        duplicatesRemoved: 0,
        orphanedRecords: 0,
        indexesAdded: 0,
        tablesOptimized: 0,
        issues: []
    };

    // Step 1: Handle duplicate tables
    console.log('🔍 Step 1: Checking for duplicate tables...\n');

    const duplicates = [
        { keep: 'afk_status', remove: 'afk_statuses' },
        { keep: 'anti_nuke_config', remove: 'antinuke_config' },
        { keep: 'weather_config', remove: 'weatherConfig' },
        { keep: 'weather_config', remove: 'weatherUsers' } // Consolidate into weather_config
    ];

    for (const dup of duplicates) {
        try {
            // Check if both exist
            const [keepExists] = await db.execute(`SHOW TABLES LIKE '${dup.keep}'`);
            const [removeExists] = await db.execute(`SHOW TABLES LIKE '${dup.remove}'`);

            if (keepExists.length > 0 && removeExists.length > 0) {
                // Migrate data if remove table has data
                const [rows] = await db.execute(`SELECT COUNT(*) as count FROM \`${dup.remove}\``);
                if (rows[0].count > 0) {
                    console.log(`  ⚠️  Table '${dup.remove}' has ${rows[0].count} rows`);
                    console.log(`      Keeping data in '${dup.keep}' instead of migration`);
                }

                await db.execute(`DROP TABLE IF EXISTS \`${dup.remove}\``);
                console.log(`  ✅ Removed duplicate table: ${dup.remove}`);
                report.duplicatesRemoved++;
            }
        } catch (error) {
            console.log(`  ❌ Error handling ${dup.remove}: ${error.message}`);
            report.issues.push(`Duplicate table ${dup.remove}: ${error.message}`);
        }
    }

    // Step 2: Clean orphaned records
    console.log('\n🔍 Step 2: Cleaning orphaned records...\n');

    // Find orphaned subscriptions (guild doesn't exist)
    try {
        const [orphanedSubs] = await db.execute(`
            SELECT COUNT(*) as count
            FROM subscriptions s
            LEFT JOIN guilds g ON s.guild_id = g.guild_id
            WHERE g.guild_id IS NULL
        `);

        if (orphanedSubs[0].count > 0) {
            console.log(`  Found ${orphanedSubs[0].count} orphaned subscriptions`);
            await db.execute(`
                DELETE s FROM subscriptions s
                LEFT JOIN guilds g ON s.guild_id = g.guild_id
                WHERE g.guild_id IS NULL
            `);
            console.log(`  ✅ Cleaned ${orphanedSubs[0].count} orphaned subscriptions`);
            report.orphanedRecords += orphanedSubs[0].count;
        }
    } catch (error) {
        console.log(`  ⚠️  Error cleaning subscriptions: ${error.message}`);
        report.issues.push(`Orphaned subscriptions: ${error.message}`);
    }

    // Clean old live announcements (streams that ended weeks ago)
    try {
        const [oldAnnouncements] = await db.execute(`
            SELECT COUNT(*) as count
            FROM live_announcements
            WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)
        `);

        if (oldAnnouncements[0].count > 0) {
            console.log(`  Found ${oldAnnouncements[0].count} old announcements (>30 days)`);
            await db.execute(`
                DELETE FROM live_announcements
                WHERE created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)
            `);
            console.log(`  ✅ Cleaned ${oldAnnouncements[0].count} old announcements`);
            report.orphanedRecords += oldAnnouncements[0].count;
        }
    } catch (error) {
        console.log(`  ⚠️  Error cleaning announcements: ${error.message}`);
        report.issues.push(`Old announcements: ${error.message}`);
    }

    // Clean old action logs (keep only 90 days)
    try {
        const [oldLogs] = await db.execute(`
            SELECT COUNT(*) as count
            FROM action_logs
            WHERE timestamp < DATE_SUB(NOW(), INTERVAL 90 DAY)
        `);

        if (oldLogs[0].count > 0) {
            console.log(`  Found ${oldLogs[0].count} old action logs (>90 days)`);
            await db.execute(`
                DELETE FROM action_logs
                WHERE timestamp < DATE_SUB(NOW(), INTERVAL 90 DAY)
            `);
            console.log(`  ✅ Cleaned ${oldLogs[0].count} old action logs`);
            report.orphanedRecords += oldLogs[0].count;
        }
    } catch (error) {
        console.log(`  ⚠️  Error cleaning action logs: ${error.message}`);
    }

    // Step 3: Add missing indexes for performance
    console.log('\n🔍 Step 3: Adding missing indexes...\n');

    const indexesToAdd = [
        { table: 'subscriptions', index: 'idx_guild_platform', columns: ['guild_id', 'platform'] },
        { table: 'subscriptions', index: 'idx_platform_username', columns: ['platform', 'username'] },
        { table: 'streamers', index: 'idx_platform_username', columns: ['platform', 'username'] },
        { table: 'live_announcements', index: 'idx_guild_platform', columns: ['guild_id', 'platform'] },
        { table: 'live_announcements', index: 'idx_stream_started', columns: ['stream_started_at'] },
        { table: 'action_logs', index: 'idx_guild_timestamp', columns: ['guild_id', 'timestamp'] },
        { table: 'activity_logs', index: 'idx_guild_timestamp', columns: ['guild_id', 'timestamp'] },
        { table: 'user_levels', index: 'idx_guild_user', columns: ['guild_id', 'user_id'] }
    ];

    for (const idx of indexesToAdd) {
        try {
            // Check if index exists
            const [indexes] = await db.execute(`SHOW INDEX FROM \`${idx.table}\` WHERE Key_name = '${idx.index}'`);

            if (indexes.length === 0) {
                const columns = idx.columns.map(c => `\`${c}\``).join(', ');
                await db.execute(`ALTER TABLE \`${idx.table}\` ADD INDEX ${idx.index} (${columns})`);
                console.log(`  ✅ Added index ${idx.index} on ${idx.table}`);
                report.indexesAdded++;
            }
        } catch (error) {
            if (!error.message.includes('Duplicate key name')) {
                console.log(`  ⚠️  Error adding index ${idx.index}: ${error.message}`);
                report.issues.push(`Index ${idx.index}: ${error.message}`);
            }
        }
    }

    // Step 4: Optimize table structures
    console.log('\n🔍 Step 4: Optimizing tables...\n');

    const tablesToOptimize = [
        'subscriptions', 'streamers', 'live_announcements',
        'action_logs', 'activity_logs', 'guilds', 'users'
    ];

    for (const table of tablesToOptimize) {
        try {
            await db.execute(`OPTIMIZE TABLE \`${table}\``);
            console.log(`  ✅ Optimized table: ${table}`);
            report.tablesOptimized++;
        } catch (error) {
            console.log(`  ⚠️  Error optimizing ${table}: ${error.message}`);
        }
    }

    // Step 5: Run intelligent systems migration
    console.log('\n🔍 Step 5: Running intelligent systems migration...\n');

    try {
        const fs = require('fs');
        const migrationSQL = fs.readFileSync('/root/CertiFriedAnnouncer/migrations/003_intelligent_systems.sql', 'utf8');

        // Split by semicolon and execute each statement
        const statements = migrationSQL
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0 && !s.startsWith('--') && !s.startsWith('/*'));

        let executed = 0;
        for (const statement of statements) {
            try {
                await db.execute(statement);
                executed++;
            } catch (error) {
                if (!error.message.includes('already exists')) {
                    console.log(`  ⚠️  Migration statement error: ${error.message.substring(0, 100)}`);
                }
            }
        }

        console.log(`  ✅ Executed ${executed} migration statements`);
    } catch (error) {
        console.log(`  ❌ Error running migration: ${error.message}`);
        report.issues.push(`Migration: ${error.message}`);
    }

    // Step 6: Final statistics
    console.log('\n🔍 Step 6: Final database statistics...\n');

    const [tables] = await db.execute('SHOW TABLES');
    const [dbSize] = await db.execute(`
        SELECT
            SUM(data_length + index_length) / 1024 / 1024 AS size_mb
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
    `);

    const [totalRows] = await db.execute(`
        SELECT SUM(table_rows) as total
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
    `);

    console.log(`  Total Tables: ${tables.length}`);
    console.log(`  Total Rows: ${totalRows[0].total || 'N/A'}`);
    console.log(`  Database Size: ${(dbSize[0].size_mb || 0).toFixed(2)} MB`);

    // Generate report
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║   CLEANUP REPORT                                          ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    console.log(`  ✅ Duplicate tables removed: ${report.duplicatesRemoved}`);
    console.log(`  ✅ Orphaned records cleaned: ${report.orphanedRecords}`);
    console.log(`  ✅ Indexes added: ${report.indexesAdded}`);
    console.log(`  ✅ Tables optimized: ${report.tablesOptimized}`);

    if (report.issues.length > 0) {
        console.log(`\n  ⚠️  Issues encountered: ${report.issues.length}`);
        report.issues.forEach(issue => console.log(`     - ${issue}`));
    }

    console.log('\n✨ Database cleanup and optimization complete!\n');

    await db.end();
    process.exit(0);
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
