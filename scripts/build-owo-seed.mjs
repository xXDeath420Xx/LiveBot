#!/usr/bin/env node
/**
 * Generates migrations/090_owo_seed_data.js from upstream's
 * secret/OWO-TABLE-DATA.sql. Seed INSERTs for the five global catalog tables:
 *   - animals, animals_rank, weapon, weapon_passive, gem
 * Table names are rewritten with `owo_` prefix. All other user-data INSERTs
 * in the dump (if any) are intentionally ignored — we seed only the catalogs.
 *
 * Run: `node scripts/build-owo-seed.mjs`
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SRC = path.join(REPO, 'docs/Discord-OwO-Bot-master/secret/OWO-TABLE-DATA.sql');
const OUT = path.join(REPO, 'migrations/090_owo_seed_data.js');

const SEED_TABLES = ['animals_rank', 'animals', 'weapon', 'weapon_passive', 'gem'];

const sql = fs.readFileSync(SRC, 'utf8');

function extractInsert(table) {
    const re = new RegExp(`INSERT INTO \`${table}\` VALUES\\s+([\\s\\S]+?);\\s*\\n`, 'i');
    const m = sql.match(re);
    if (!m) return null;
    // Rewrite the INSERT to use the owo_ prefix.
    return `INSERT IGNORE INTO \`owo_${table}\` VALUES ${m[1]};`;
}

const inserts = [];
const summary = [];
for (const t of SEED_TABLES) {
    const stmt = extractInsert(t);
    if (stmt) {
        const rowCount = (stmt.match(/\),\(/g)?.length || 0) + 1;
        inserts.push(stmt);
        summary.push(`${t}: ${rowCount} rows`);
    } else {
        summary.push(`${t}: (no seed data found — table empty)`);
    }
}

const header = `/**
 * Migration 090: OwO catalog seed data.
 *
 * Seeds the 5 global catalog tables from upstream's public data dump:
 *   ${summary.join('\n *   ')}
 *
 * INSERT IGNORE so re-runs are safe. Only populates global catalogs — never
 * touches per-guild user state.
 *
 * See LICENSE-OWO-NOTICE.md.
 */

const STATEMENTS = ${JSON.stringify(inserts, null, 2)};

export async function up(db) {
    for (const stmt of STATEMENTS) {
        await db.execute(stmt);
    }
}

export async function down(db) {
    // Safe: only deletes catalog rows. User zoo data in owo_animal lives
    // in a different table and is unaffected.
    await db.execute('DELETE FROM \`owo_animals\`');
    await db.execute('DELETE FROM \`owo_animals_rank\`');
    await db.execute('DELETE FROM \`owo_weapon_passive\`');
    await db.execute('DELETE FROM \`owo_weapon\`');
    await db.execute('DELETE FROM \`owo_gem\`');
}
`;

fs.writeFileSync(OUT, header);
console.log(`Wrote ${OUT}`);
summary.forEach(s => console.log('  ' + s));
