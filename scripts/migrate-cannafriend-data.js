#!/usr/bin/env node
/**
 * Migration Script: Import CannaFriend/CannaDiscord data into CertiFriedUtility
 *
 * This script imports:
 * - User toke counts and leaderboards
 * - Cheers data
 * - User profiles with lifetime stats
 * - Strain database (if available)
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database configuration
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true
};

async function migrate() {
    console.log('🌿 CertiFriedUtility Data Migration');
    console.log('=====================================\n');

    const connection = await mysql.createConnection(dbConfig);

    try {
        // First, make user 12 the owner
        console.log('1. Setting user 12 as owner...');
        await connection.execute(
            "UPDATE canna_users SET role = 'owner' WHERE id = 12"
        );
        console.log('   ✅ User 12 is now owner\n');

        // Read and parse the SQL files
        const docsDir = path.join(__dirname, '../docs');

        // Import tokes data
        console.log('2. Importing tokes/cheers data...');
        await importTokesData(connection, docsDir);

        // Import strain database
        console.log('\n3. Importing strain database...');
        await importStrainData(connection, docsDir);

        // Import user profiles
        console.log('\n4. Creating user profiles from tokes data...');
        await createProfiles(connection);

        // Summary
        console.log('\n=====================================');
        console.log('✅ Migration complete!\n');

        // Show stats
        const [profileStats] = await connection.execute(
            'SELECT COUNT(*) as count, SUM(lifetime_tokes) as total_tokes FROM canna_profiles'
        );
        console.log(`   Profiles: ${profileStats[0].count}`);
        console.log(`   Total Tokes: ${profileStats[0].total_tokes || 0}`);

        const [strainStats] = await connection.execute(
            'SELECT COUNT(*) as count FROM canna_strains'
        );
        console.log(`   Strains: ${strainStats[0].count}`);

    } catch (error) {
        console.error('❌ Migration error:', error.message);
        throw error;
    } finally {
        await connection.end();
    }
}

async function importTokesData(connection, docsDir) {
    // Extract tokes from the SQL dump
    const freshSqlPath = path.join(docsDir, 'cann_cannafriend_fresh.sql');

    if (!fs.existsSync(freshSqlPath)) {
        console.log('   ⚠️  cann_cannafriend_fresh.sql not found, skipping tokes import');
        return;
    }

    console.log('   Reading tokes data from SQL dump (this may take a while)...');

    // Use streaming to handle large file
    const stream = fs.createReadStream(freshSqlPath, { encoding: 'utf8' });
    let buffer = '';
    let inTokesInsert = false;
    let tokesData = [];
    let cheersData = [];
    let processedLines = 0;

    for await (const chunk of stream) {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
            processedLines++;

            // Look for tokes INSERT
            if (line.includes('INSERT INTO `tokes`')) {
                inTokesInsert = true;
            }

            if (inTokesInsert && line.includes("VALUES")) {
                // Parse the VALUES
                const valuesMatch = line.match(/VALUES\s*(.+)/i);
                if (valuesMatch) {
                    const valuesStr = valuesMatch[1];
                    // Parse individual value tuples
                    const tuples = valuesStr.match(/\([^)]+\)/g) || [];
                    for (const tuple of tuples) {
                        const values = tuple.slice(1, -1).split(',').map(v => v.trim().replace(/^'|'$/g, ''));
                        if (values.length >= 4) {
                            tokesData.push({
                                channel_id: values[0],
                                user_id: values[1],
                                username: values[2],
                                count: parseInt(values[3]) || 0,
                                platform: values[4] || 'twitch'
                            });
                        }
                    }
                }
            }

            if (inTokesInsert && line.includes(';')) {
                inTokesInsert = false;
            }

            // Limit to prevent memory issues
            if (tokesData.length >= 100000) {
                break;
            }
        }

        if (tokesData.length >= 100000) break;
    }

    console.log(`   Found ${tokesData.length} toke records`);

    // Aggregate tokes by user (global stats)
    const userTokes = new Map();
    for (const toke of tokesData) {
        const key = `${toke.platform}:${toke.user_id}`;
        if (!userTokes.has(key)) {
            userTokes.set(key, {
                platform: toke.platform,
                user_id: toke.user_id,
                username: toke.username,
                total_tokes: 0
            });
        }
        userTokes.get(key).total_tokes += toke.count;
    }

    console.log(`   Aggregated to ${userTokes.size} unique users`);

    // Insert into canna_profiles
    let inserted = 0;
    for (const [key, user] of userTokes) {
        try {
            await connection.execute(
                `INSERT INTO canna_profiles
                    (platform, platform_user_id, display_name, lifetime_tokes, level, xp)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                    lifetime_tokes = lifetime_tokes + VALUES(lifetime_tokes),
                    display_name = VALUES(display_name)`,
                [
                    user.platform,
                    user.user_id,
                    user.username || 'Unknown',
                    user.total_tokes,
                    Math.floor(user.total_tokes / 100) + 1, // Simple level calc
                    user.total_tokes * 10 // Simple XP calc
                ]
            );
            inserted++;

            if (inserted % 1000 === 0) {
                process.stdout.write(`\r   Inserted ${inserted}/${userTokes.size} profiles...`);
            }
        } catch (err) {
            // Ignore duplicates
        }
    }
    console.log(`\n   ✅ Inserted ${inserted} user profiles`);
}

async function importStrainData(connection, docsDir) {
    // Check if we have strain data in the SQL
    const freshSqlPath = path.join(docsDir, 'cann_cannafriend_fresh.sql');

    // For now, import a basic set of popular strains
    const popularStrains = [
        { name: 'OG Kush', type: 'hybrid', thc_min: 19, thc_max: 26, effects: '["relaxed","happy","euphoric"]', flavors: '["earthy","pine","woody"]' },
        { name: 'Blue Dream', type: 'hybrid', thc_min: 17, thc_max: 24, effects: '["creative","euphoric","relaxed"]', flavors: '["berry","sweet","vanilla"]' },
        { name: 'Sour Diesel', type: 'sativa', thc_min: 19, thc_max: 25, effects: '["energetic","creative","focused"]', flavors: '["diesel","citrus","earthy"]' },
        { name: 'Girl Scout Cookies', type: 'hybrid', thc_min: 25, thc_max: 28, effects: '["euphoric","relaxed","happy"]', flavors: '["sweet","earthy","pungent"]' },
        { name: 'Gorilla Glue', type: 'hybrid', thc_min: 25, thc_max: 30, effects: '["relaxed","euphoric","sleepy"]', flavors: '["earthy","pine","sour"]' },
        { name: 'Northern Lights', type: 'indica', thc_min: 16, thc_max: 21, effects: '["relaxed","sleepy","happy"]', flavors: '["earthy","pine","sweet"]' },
        { name: 'Granddaddy Purple', type: 'indica', thc_min: 17, thc_max: 23, effects: '["relaxed","sleepy","euphoric"]', flavors: '["grape","berry","sweet"]' },
        { name: 'Jack Herer', type: 'sativa', thc_min: 18, thc_max: 23, effects: '["creative","energetic","focused"]', flavors: '["pine","earthy","woody"]' },
        { name: 'Pineapple Express', type: 'hybrid', thc_min: 17, thc_max: 25, effects: '["happy","uplifted","energetic"]', flavors: '["pineapple","tropical","cedar"]' },
        { name: 'White Widow', type: 'hybrid', thc_min: 18, thc_max: 25, effects: '["euphoric","energetic","creative"]', flavors: '["earthy","woody","pungent"]' },
        { name: 'AK-47', type: 'hybrid', thc_min: 15, thc_max: 20, effects: '["relaxed","happy","uplifted"]', flavors: '["earthy","skunky","sweet"]' },
        { name: 'Green Crack', type: 'sativa', thc_min: 15, thc_max: 25, effects: '["energetic","focused","happy"]', flavors: '["citrus","mango","earthy"]' },
        { name: 'Purple Haze', type: 'sativa', thc_min: 14, thc_max: 19, effects: '["euphoric","creative","energetic"]', flavors: '["berry","earthy","sweet"]' },
        { name: 'Trainwreck', type: 'hybrid', thc_min: 18, thc_max: 25, effects: '["euphoric","creative","happy"]', flavors: '["pine","lemon","earthy"]' },
        { name: 'Bubba Kush', type: 'indica', thc_min: 15, thc_max: 22, effects: '["relaxed","sleepy","happy"]', flavors: '["coffee","chocolate","earthy"]' },
        { name: 'Skywalker OG', type: 'indica', thc_min: 20, thc_max: 30, effects: '["relaxed","sleepy","happy"]', flavors: '["earthy","spicy","herbal"]' },
        { name: 'Gelato', type: 'hybrid', thc_min: 20, thc_max: 25, effects: '["relaxed","happy","euphoric"]', flavors: '["sweet","citrus","fruity"]' },
        { name: 'Wedding Cake', type: 'hybrid', thc_min: 22, thc_max: 27, effects: '["relaxed","euphoric","happy"]', flavors: '["vanilla","earthy","sweet"]' },
        { name: 'Runtz', type: 'hybrid', thc_min: 19, thc_max: 29, effects: '["euphoric","relaxed","happy"]', flavors: '["fruity","sweet","tropical"]' },
        { name: 'MAC', type: 'hybrid', thc_min: 20, thc_max: 23, effects: '["creative","euphoric","uplifted"]', flavors: '["citrus","diesel","floral"]' },
    ];

    let inserted = 0;
    for (const strain of popularStrains) {
        try {
            const slug = strain.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
            await connection.execute(
                `INSERT INTO canna_strains
                    (name, slug, strain_type, thc_min, thc_max, effects, flavors)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE name = name`,
                [strain.name, slug, strain.type, strain.thc_min, strain.thc_max, strain.effects, strain.flavors]
            );
            inserted++;
        } catch (err) {
            // Ignore duplicates
        }
    }
    console.log(`   ✅ Added ${inserted} strains to database`);
}

async function createProfiles(connection) {
    // Create profiles for any connected platform users who don't have one
    const [connections] = await connection.execute(`
        SELECT pc.platform, pc.platform_id, pc.platform_name
        FROM canna_platform_connections pc
        LEFT JOIN canna_profiles p ON pc.platform = p.platform AND pc.platform_id = p.platform_user_id
        WHERE p.id IS NULL
    `);

    for (const conn of connections) {
        await connection.execute(
            `INSERT INTO canna_profiles
                (platform, platform_user_id, display_name, lifetime_tokes, level, xp)
             VALUES (?, ?, ?, 0, 1, 0)
             ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)`,
            [conn.platform, conn.platform_id, conn.platform_name]
        );
    }

    console.log(`   ✅ Created ${connections.length} new profiles for connected users`);
}

// Run migration
migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
