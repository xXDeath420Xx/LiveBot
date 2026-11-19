#!/usr/bin/env node
/*
 * Loads data/qotd-library/*.json into the qotd_library table.
 *
 * Idempotent: upserts on `slug`, so re-running after editing a question's wording keeps
 * its identity — and therefore its posting history — intact. Never touches times_used or
 * last_used_at.
 *
 *   node scripts/seed-qotd-library.mjs            # add + update
 *   node scripts/seed-qotd-library.mjs --prune    # also deactivate slugs no longer in the files
 *   node scripts/seed-qotd-library.mjs --dry-run
 *
 * Uses its own connection rather than the shared pool: one-off scripts hang on the pool.
 */
import dotenv from 'dotenv'; dotenv.config();
import mysql from 'mysql2/promise';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const libraryDir = path.join(here, '..', 'data', 'qotd-library');
const prune = process.argv.includes('--prune');
const dryRun = process.argv.includes('--dry-run');

const files = (await fs.readdir(libraryDir)).filter(f => f.endsWith('.json')).sort();
const questions = [];
const seenSlugs = new Set();

for (const file of files) {
    const raw = JSON.parse(await fs.readFile(path.join(libraryDir, file), 'utf8'));
    if (!raw.theme || !Array.isArray(raw.questions)) {
        throw new Error(`${file}: expected { theme, label, questions[] }`);
    }
    for (const q of raw.questions) {
        if (!q.slug || !q.text) throw new Error(`${file}: every question needs slug + text`);
        if (seenSlugs.has(q.slug)) throw new Error(`duplicate slug across files: ${q.slug}`);
        seenSlugs.add(q.slug);
        questions.push({
            slug: q.slug,
            content: q.text,
            theme: raw.theme,
            variant_group: q.group || q.slug,
            card_type: q.type || 'question',
            weight: q.weight ?? 100,
        });
    }
}

console.log(`Parsed ${questions.length} questions across ${files.length} themes.`);
const groups = new Set(questions.map(q => q.variant_group));
console.log(`${groups.size} distinct variant groups — that is the real no-repeat runway.`);

if (dryRun) {
    const byTheme = {};
    for (const q of questions) byTheme[q.theme] = (byTheme[q.theme] || 0) + 1;
    console.table(byTheme);
    process.exit(0);
}

const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
});

try {
    let inserted = 0, updated = 0;
    for (const q of questions) {
        const [[existing]] = await db.execute(
            'SELECT library_id, content, theme, variant_group, active FROM qotd_library WHERE slug = ?',
            [q.slug]
        );
        if (!existing) {
            await db.execute(
                `INSERT INTO qotd_library (slug, content, theme, variant_group, card_type, weight)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [q.slug, q.content, q.theme, q.variant_group, q.card_type, q.weight]
            );
            inserted++;
        } else if (existing.content !== q.content || existing.theme !== q.theme ||
                   existing.variant_group !== q.variant_group || !existing.active) {
            await db.execute(
                `UPDATE qotd_library
                 SET content = ?, theme = ?, variant_group = ?, card_type = ?, weight = ?, active = 1
                 WHERE slug = ?`,
                [q.content, q.theme, q.variant_group, q.card_type, q.weight, q.slug]
            );
            updated++;
        }
    }

    let pruned = 0;
    if (prune) {
        const [rows] = await db.execute('SELECT slug FROM qotd_library WHERE active = 1');
        const orphans = rows.map(r => r.slug).filter(s => !seenSlugs.has(s));
        for (const slug of orphans) {
            await db.execute('UPDATE qotd_library SET active = 0 WHERE slug = ?', [slug]);
            pruned++;
        }
    }

    const [[total]] = await db.execute(
        'SELECT COUNT(*) AS n, COUNT(DISTINCT variant_group) AS g FROM qotd_library WHERE active = 1'
    );
    console.log(`inserted ${inserted}, updated ${updated}${prune ? `, deactivated ${pruned}` : ''}`);
    console.log(`library now holds ${total.n} active questions in ${total.g} groups`);
} finally {
    await db.end();
}
