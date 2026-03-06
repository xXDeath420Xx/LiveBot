#!/usr/bin/env node
/**
 * Import tokes data from CannaFriend SQL dump into CertiFriedUtility
 * This aggregates toke counts per user across all channels
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
};

async function importTokes() {
    console.log('CertiFriedUtility Tokes Data Import');
    console.log('====================================\n');

    const sqlPath = path.join(__dirname, '../docs/cann_cannafriend_fresh.sql');

    if (!fs.existsSync(sqlPath)) {
        console.error('SQL file not found:', sqlPath);
        process.exit(1);
    }

    console.log('1. Reading tokes data from SQL dump...');

    // Use streaming to handle large file
    const fileStream = fs.createReadStream(sqlPath, { encoding: 'utf8' });
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    // Aggregate tokes by user (across all channels)
    const userTokes = new Map();
    let inTokesInsert = false;
    let tokesBuffer = '';
    let recordCount = 0;

    for await (const line of rl) {
        // Detect start of tokes INSERT
        if (line.startsWith('INSERT INTO `tokes` VALUES')) {
            inTokesInsert = true;
            tokesBuffer = line;
            continue;
        }

        if (inTokesInsert) {
            tokesBuffer += line;

            // Check if INSERT statement is complete (ends with ;)
            if (line.includes(';')) {
                inTokesInsert = false;

                // Parse the VALUES
                const valuesMatch = tokesBuffer.match(/VALUES\s*(.+);?$/s);
                if (valuesMatch) {
                    const valuesStr = valuesMatch[1].replace(/;$/, '');

                    // Extract individual tuples - match ('...','...',...)
                    const tupleRegex = /\(([^)]+)\)/g;
                    let match;

                    while ((match = tupleRegex.exec(valuesStr)) !== null) {
                        const tuple = match[1];
                        // Parse CSV values, handling NULL and quoted strings
                        const values = parseCSV(tuple);

                        if (values.length >= 4) {
                            const channel = values[0];
                            const userId = values[1];
                            const username = values[2] === 'NULL' ? null : values[2];
                            const count = parseInt(values[3]) || 0;
                            const platform = values[4] || 'twitch';

                            // Aggregate by user_id + platform
                            const key = `${platform}:${userId.toLowerCase()}`;
                            if (!userTokes.has(key)) {
                                userTokes.set(key, {
                                    platform,
                                    userId: userId.toLowerCase(),
                                    username: username || userId,
                                    totalTokes: 0
                                });
                            }
                            userTokes.get(key).totalTokes += count;
                            // Update username if we have a better one
                            if (username && username !== 'NULL') {
                                userTokes.get(key).username = username;
                            }
                            recordCount++;
                        }
                    }
                }
                tokesBuffer = '';
            }
        }
    }

    console.log(`   Found ${recordCount} toke records`);
    console.log(`   Aggregated to ${userTokes.size} unique users\n`);

    // Connect to database
    console.log('2. Connecting to database...');
    const connection = await mysql.createConnection(dbConfig);

    try {
        // Import into canna_profiles
        console.log('3. Importing into canna_profiles...');
        let imported = 0;
        let updated = 0;

        for (const [key, user] of userTokes) {
            try {
                const [result] = await connection.execute(
                    `INSERT INTO canna_profiles
                        (platform, platform_user_id, display_name, lifetime_tokes, level, xp)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE
                        lifetime_tokes = lifetime_tokes + VALUES(lifetime_tokes),
                        level = GREATEST(level, VALUES(level)),
                        xp = GREATEST(xp, VALUES(xp))`,
                    [
                        user.platform,
                        user.userId,
                        user.username || 'Unknown',
                        user.totalTokes,
                        Math.floor(user.totalTokes / 100) + 1,
                        user.totalTokes * 10
                    ]
                );

                if (result.affectedRows === 1) {
                    imported++;
                } else if (result.affectedRows === 2) {
                    updated++;
                }

                if ((imported + updated) % 500 === 0) {
                    process.stdout.write(`\r   Processed ${imported + updated}/${userTokes.size}...`);
                }
            } catch (err) {
                // Log but continue
                if (!err.message.includes('Duplicate')) {
                    console.error(`\n   Error for ${key}:`, err.message);
                }
            }
        }

        console.log(`\n   Inserted ${imported} new profiles`);
        console.log(`   Updated ${updated} existing profiles\n`);

        // Get final stats
        const [[stats]] = await connection.execute(`
            SELECT
                COUNT(*) as profile_count,
                SUM(lifetime_tokes) as total_tokes,
                MAX(lifetime_tokes) as max_tokes
            FROM canna_profiles
        `);

        console.log('====================================');
        console.log('Import Complete!');
        console.log(`   Total profiles: ${stats.profile_count}`);
        console.log(`   Total tokes: ${stats.total_tokes?.toLocaleString() || 0}`);
        console.log(`   Highest toke count: ${stats.max_tokes?.toLocaleString() || 0}`);

    } finally {
        await connection.end();
    }
}

// Parse CSV handling quoted strings and NULL
function parseCSV(str) {
    const values = [];
    let current = '';
    let inQuote = false;

    for (let i = 0; i < str.length; i++) {
        const char = str[i];

        if (char === "'" && !inQuote) {
            inQuote = true;
        } else if (char === "'" && inQuote) {
            // Check for escaped quote
            if (str[i + 1] === "'") {
                current += "'";
                i++;
            } else {
                inQuote = false;
            }
        } else if (char === ',' && !inQuote) {
            values.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }

    // Don't forget the last value
    if (current.trim()) {
        values.push(current.trim());
    }

    return values;
}

importTokes().catch(err => {
    console.error('Import failed:', err);
    process.exit(1);
});
