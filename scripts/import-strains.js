#!/usr/bin/env node
/**
 * Import strains from:
 * 1. Existing strains table (if present)
 * 2. Kushy Cannabis Dataset CSV
 * Only imports strains that don't already exist (by slug)
 */

import 'dotenv/config';
import mysql from 'mysql2/promise';
import https from 'https';

const CSV_URL = 'https://raw.githubusercontent.com/kushyapp/cannabis-dataset/master/Dataset/Strains/strains-kushy_api.2017-11-14.csv';

/**
 * Fetch CSV from URL
 */
function fetchCSV(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
            res.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * Parse CSV line handling quoted fields
 */
function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            result.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    result.push(current.trim());
    return result;
}

/**
 * Normalize type to our enum
 */
function normalizeType(type) {
    if (!type) return 'unknown';
    const t = type.toLowerCase().trim();
    if (t.includes('indica')) return 'indica';
    if (t.includes('sativa')) return 'sativa';
    if (t.includes('hybrid')) return 'hybrid';
    return 'unknown';
}

/**
 * Create slug from name
 */
function createSlug(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Parse effects string to JSON array
 */
function parseList(str) {
    if (!str || str === 'NULL') return null;
    const items = str.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    return items.length > 0 ? JSON.stringify(items) : null;
}

/**
 * Clean HTML from description
 */
function cleanDescription(desc) {
    if (!desc || desc === 'NULL') return null;
    return desc.replace(/<[^>]*>/g, '').trim() || null;
}

/**
 * Parse THC/CBD percentage string like "17-24%" to min/max
 */
function parsePercentRange(str) {
    if (!str || str === 'NULL' || str === '<1%') return { min: null, max: null };
    const match = str.match(/(\d+(?:\.\d+)?)\s*-?\s*(\d+(?:\.\d+)?)?%?/);
    if (match) {
        const min = parseFloat(match[1]);
        const max = match[2] ? parseFloat(match[2]) : min;
        return { min: min.toFixed(1), max: max.toFixed(1) };
    }
    return { min: null, max: null };
}

/**
 * Parse raw THC/CBD value from CSV
 */
function parseCannaValue(val) {
    if (!val || val === 'NULL' || val === '0') return null;
    const num = parseFloat(val);
    if (isNaN(num) || num <= 0) return null;
    if (num > 100) return (num / 10).toFixed(1);
    return num.toFixed(1);
}

async function main() {
    console.log('Connecting to database...');

    const pool = await mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        waitForConnections: true,
        connectionLimit: 10
    });

    const seenSlugs = new Set();
    const toInsert = [];

    try {
        // Get existing slugs from canna_strains
        console.log('Checking existing canna_strains...');
        const [existing] = await pool.execute('SELECT slug FROM canna_strains');
        existing.forEach(r => seenSlugs.add(r.slug));
        console.log(`Found ${seenSlugs.size} existing strains in canna_strains`);

        // ============================================================
        // PHASE 1: Import from existing strains table
        // ============================================================
        console.log('\n--- Phase 1: Importing from existing strains table ---');

        try {
            const [oldStrains] = await pool.execute('SELECT * FROM strains');
            console.log(`Found ${oldStrains.length} strains in legacy table`);

            for (const strain of oldStrains) {
                const slug = createSlug(strain.strain_name);
                if (seenSlugs.has(slug)) continue;
                seenSlugs.add(slug);

                const thc = parsePercentRange(strain.thc_level);
                const cbd = parsePercentRange(strain.cbd_level);

                toInsert.push({
                    name: strain.strain_name.substring(0, 200),
                    slug: slug.substring(0, 200),
                    strain_type: 'unknown', // Legacy table doesn't have type
                    thc_min: thc.min,
                    thc_max: thc.max,
                    cbd_min: cbd.min,
                    cbd_max: cbd.max,
                    effects: parseList(strain.effects),
                    flavors: null,
                    description: strain.description
                });
            }

            console.log(`Prepared ${toInsert.length} strains from legacy table`);
        } catch (e) {
            console.log('No legacy strains table found, skipping...');
        }

        // ============================================================
        // PHASE 2: Import from Kushy CSV
        // ============================================================
        console.log('\n--- Phase 2: Importing from Kushy Cannabis Dataset ---');

        console.log('Downloading strain dataset...');
        const csvData = await fetchCSV(CSV_URL);
        const lines = csvData.split('\n').filter(line => line.trim());
        console.log(`Parsed ${lines.length - 1} strains from CSV`);

        let csvSkipped = 0;
        let csvDuplicates = 0;

        for (let i = 1; i < lines.length; i++) {
            const fields = parseCSVLine(lines[i]);
            if (fields.length < 10) continue;

            const name = fields[3]; // name column
            if (!name || name === 'NULL') {
                csvSkipped++;
                continue;
            }

            const slug = createSlug(name);
            if (seenSlugs.has(slug)) {
                csvDuplicates++;
                continue;
            }
            seenSlugs.add(slug);

            toInsert.push({
                name: name.substring(0, 200),
                slug: slug.substring(0, 200),
                strain_type: normalizeType(fields[7]), // type
                thc_min: parseCannaValue(fields[15]), // thc
                thc_max: parseCannaValue(fields[15]),
                cbd_min: parseCannaValue(fields[18]), // cbd
                cbd_max: parseCannaValue(fields[18]),
                effects: parseList(fields[10]), // effects
                flavors: parseList(fields[12]), // flavor
                description: cleanDescription(fields[6]) // description
            });
        }

        console.log(`Added ${toInsert.length} total unique strains`);
        console.log(`Skipped ${csvSkipped} invalid CSV entries`);
        console.log(`Skipped ${csvDuplicates} duplicates from CSV`);

        if (toInsert.length === 0) {
            console.log('\nNo new strains to import!');
            return;
        }

        // ============================================================
        // BATCH INSERT
        // ============================================================
        console.log('\n--- Inserting strains ---');
        const batchSize = 500;
        let inserted = 0;

        for (let i = 0; i < toInsert.length; i += batchSize) {
            const batch = toInsert.slice(i, i + batchSize);

            const values = batch.map(s => [
                s.name, s.slug, s.strain_type,
                s.thc_min, s.thc_max, s.cbd_min, s.cbd_max,
                s.effects, s.flavors, s.description
            ]);

            const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
            const flatValues = values.flat();

            await pool.execute(
                `INSERT INTO canna_strains
                 (name, slug, strain_type, thc_min, thc_max, cbd_min, cbd_max, effects, flavors, description)
                 VALUES ${placeholders}`,
                flatValues
            );

            inserted += batch.length;
            process.stdout.write(`\rInserted ${inserted}/${toInsert.length} strains...`);
        }

        console.log('\n\nImport complete!');

        // Verify
        const [count] = await pool.execute('SELECT COUNT(*) as c FROM canna_strains');
        console.log(`Total strains in canna_strains: ${count[0].c}`);

        // Show breakdown
        const [typeBreakdown] = await pool.execute(
            'SELECT strain_type, COUNT(*) as c FROM canna_strains GROUP BY strain_type'
        );
        console.log('\nBreakdown by type:');
        typeBreakdown.forEach(r => console.log(`  ${r.strain_type}: ${r.c}`));

    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

main();
