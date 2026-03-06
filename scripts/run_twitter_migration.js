import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

async function runMigration() {
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    console.log('Connected to database');

    const queries = [
        "ALTER TABLE twitter_feeds ADD COLUMN filter_retweets TINYINT(1) DEFAULT 1",
        "ALTER TABLE twitter_feeds ADD COLUMN filter_replies TINYINT(1) DEFAULT 1",
        "ALTER TABLE twitter_feeds ADD COLUMN filter_media_only TINYINT(1) DEFAULT 0",
        "ALTER TABLE twitter_feeds ADD COLUMN include_images TINYINT(1) DEFAULT 1",
        "ALTER TABLE twitter_feeds ADD COLUMN custom_message TEXT",
        "ALTER TABLE twitter_feeds ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"
    ];

    for (const query of queries) {
        try {
            await connection.execute(query);
            console.log('✅', query.substring(0, 60) + '...');
        } catch (err) {
            if (err.code === 'ER_DUP_FIELDNAME') {
                console.log('⏭️ Column already exists:', query.substring(0, 60) + '...');
            } else {
                console.log('❌', err.message);
            }
        }
    }

    await connection.end();
    console.log('Migration complete!');
}

runMigration().catch(console.error);
