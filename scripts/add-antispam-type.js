import pool from '../utils/db.js';

async function main() {
    console.log('Adding AntiSpam type to infractions enum...');

    await pool.execute(`
        ALTER TABLE infractions
        MODIFY COLUMN type ENUM(
            'Ban', 'Unban', 'Kick', 'Mute', 'Unmute', 'Warn', 'ClearInfractions',
            'RaidDetection', 'SelfbotDetection', 'AdaptiveSpam', 'AntiSpam'
        ) NOT NULL
    `);

    console.log('✅ AntiSpam type added successfully');
    process.exit(0);
}

main().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
});
