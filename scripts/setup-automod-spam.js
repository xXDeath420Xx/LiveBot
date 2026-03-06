/**
 * Script to check and setup automod spam configuration for a guild
 * Usage: node scripts/setup-automod-spam.js <guild_id>
 *
 * This script will:
 * 1. Check if migration 011 has been applied
 * 2. Check if automod_spam_config exists for the guild
 * 3. Create/enable the config if needed
 * 4. Check if adaptive_spam_config exists for the guild
 * 5. Create/enable it if needed
 */

import pool from '../utils/db.js';

const GUILD_ID = process.argv[2];

if (!GUILD_ID) {
    console.error('Usage: node scripts/setup-automod-spam.js <guild_id>');
    process.exit(1);
}

async function checkMigrations() {
    console.log('\n=== Checking Migration Status ===');

    try {
        const [migrations] = await pool.execute('SELECT name, executed_at FROM migrations ORDER BY executed_at');

        console.log('Executed migrations:');
        for (const m of migrations) {
            console.log(`  - ${m.name} (${m.executed_at})`);
        }

        const has011 = migrations.some(m => m.name === '011_sery_features');
        if (!has011) {
            console.log('\n⚠️  Migration 011_sery_features has NOT been run!');
            console.log('   Run: node migrations/run.js');
            return false;
        }

        console.log('\n✅ Migration 011_sery_features has been applied');
        return true;
    } catch (error) {
        console.error('Error checking migrations:', error.message);
        return false;
    }
}

async function checkTables() {
    console.log('\n=== Checking Required Tables ===');

    const tables = [
        'automod_spam_config',
        'adaptive_spam_config',
        'spam_profiles',
        'cross_channel_spam'
    ];

    for (const table of tables) {
        try {
            await pool.execute(`SELECT 1 FROM ${table} LIMIT 1`);
            console.log(`  ✅ ${table} exists`);
        } catch (error) {
            if (error.message.includes("doesn't exist")) {
                console.log(`  ❌ ${table} does NOT exist`);
            } else {
                console.log(`  ⚠️  ${table} - error: ${error.message}`);
            }
        }
    }
}

async function checkAutomodSpamConfig() {
    console.log('\n=== Checking automod_spam_config ===');

    try {
        const [rows] = await pool.execute(
            'SELECT * FROM automod_spam_config WHERE guild_id = ?',
            [GUILD_ID]
        );

        if (rows.length === 0) {
            console.log(`  ❌ No config found for guild ${GUILD_ID}`);
            return null;
        }

        const config = rows[0];
        console.log(`  Guild ID: ${config.guild_id}`);
        console.log(`  Enabled: ${config.enabled ? '✅ Yes' : '❌ No'}`);
        console.log(`  Time Window: ${config.time_window}s`);
        console.log(`  Max Messages: ${config.max_messages}`);
        console.log(`  Max Mentions: ${config.max_mentions}`);
        console.log(`  Max Emojis: ${config.max_emojis}`);
        console.log(`  Max Repeated Chars: ${config.max_repeated_chars}`);
        console.log(`  Action: ${config.action}`);

        return config;
    } catch (error) {
        console.error('Error checking automod_spam_config:', error.message);
        return null;
    }
}

async function checkAdaptiveSpamConfig() {
    console.log('\n=== Checking adaptive_spam_config ===');

    try {
        const [rows] = await pool.execute(
            'SELECT * FROM adaptive_spam_config WHERE guild_id = ?',
            [GUILD_ID]
        );

        if (rows.length === 0) {
            console.log(`  ❌ No config found for guild ${GUILD_ID}`);
            return null;
        }

        const config = rows[0];
        console.log(`  Guild ID: ${config.guild_id}`);
        console.log(`  Enabled: ${config.enabled ? '✅ Yes' : '❌ No'}`);
        console.log(`  Cross-Channel Threshold: ${config.cross_channel_threshold}`);
        console.log(`  Cross-Channel Timeframe: ${config.cross_channel_timeframe_minutes} min`);
        console.log(`  Deviation Multiplier: ${config.deviation_multiplier}`);
        console.log(`  New Account Multiplier (24h): ${config.new_account_multiplier_24h}`);
        console.log(`  New Account Multiplier (7d): ${config.new_account_multiplier_7d}`);
        console.log(`  Action: ${config.action}`);
        console.log(`  Alert Channel: ${config.alert_channel_id || 'Not set'}`);

        return config;
    } catch (error) {
        console.error('Error checking adaptive_spam_config:', error.message);
        return null;
    }
}

async function createAutomodSpamConfig() {
    console.log('\n=== Creating automod_spam_config ===');

    try {
        await pool.execute(
            `INSERT INTO automod_spam_config
             (guild_id, time_window, max_messages, max_mentions, max_emojis, max_repeated_chars, action, enabled)
             VALUES (?, 5, 5, 5, 10, 15, 'mute', TRUE)
             ON DUPLICATE KEY UPDATE enabled = TRUE`,
            [GUILD_ID]
        );

        console.log('  ✅ automod_spam_config created/enabled with defaults:');
        console.log('     - time_window: 5 seconds');
        console.log('     - max_messages: 5');
        console.log('     - max_mentions: 5');
        console.log('     - max_emojis: 10');
        console.log('     - max_repeated_chars: 15');
        console.log('     - action: mute');

        return true;
    } catch (error) {
        console.error('Error creating automod_spam_config:', error.message);
        return false;
    }
}

async function createAdaptiveSpamConfig() {
    console.log('\n=== Creating adaptive_spam_config ===');

    try {
        await pool.execute(
            `INSERT INTO adaptive_spam_config
             (guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes,
              deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h, action)
             VALUES (?, TRUE, 3, 5, 2.0, 1.5, 2.0, 'mute')
             ON DUPLICATE KEY UPDATE enabled = TRUE`,
            [GUILD_ID]
        );

        console.log('  ✅ adaptive_spam_config created/enabled with defaults:');
        console.log('     - cross_channel_threshold: 3 channels');
        console.log('     - cross_channel_timeframe: 5 minutes');
        console.log('     - deviation_multiplier: 2.0');
        console.log('     - new_account_multiplier_24h: 2.0');
        console.log('     - new_account_multiplier_7d: 1.5');
        console.log('     - action: mute');

        return true;
    } catch (error) {
        console.error('Error creating adaptive_spam_config:', error.message);
        return false;
    }
}

async function main() {
    console.log(`\n🔍 Checking automod spam setup for guild: ${GUILD_ID}\n`);
    console.log('='.repeat(50));

    // Check migrations
    const migrationsOk = await checkMigrations();

    // Check tables
    await checkTables();

    // Check automod_spam_config
    const automodConfig = await checkAutomodSpamConfig();

    // Check adaptive_spam_config
    const adaptiveConfig = await checkAdaptiveSpamConfig();

    // Summary and actions
    console.log('\n=== Summary ===');

    if (!automodConfig) {
        console.log('\n📝 Creating automod_spam_config...');
        await createAutomodSpamConfig();
    } else if (!automodConfig.enabled) {
        console.log('\n📝 Enabling automod_spam_config...');
        await pool.execute(
            'UPDATE automod_spam_config SET enabled = TRUE WHERE guild_id = ?',
            [GUILD_ID]
        );
        console.log('  ✅ Enabled');
    }

    if (!adaptiveConfig) {
        console.log('\n📝 Creating adaptive_spam_config...');
        await createAdaptiveSpamConfig();
    } else if (!adaptiveConfig.enabled) {
        console.log('\n📝 Enabling adaptive_spam_config...');
        await pool.execute(
            'UPDATE adaptive_spam_config SET enabled = TRUE WHERE guild_id = ?',
            [GUILD_ID]
        );
        console.log('  ✅ Enabled');
    }

    console.log('\n✅ Setup complete!\n');

    // Final verification
    console.log('=== Final Verification ===');
    await checkAutomodSpamConfig();
    await checkAdaptiveSpamConfig();

    process.exit(0);
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
