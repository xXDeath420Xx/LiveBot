/**
 * Migration runner (H-637). `npm run migrate` pointed at this file, which did not exist.
 *
 * Deliberately runs ONE named migration at a time. The `migrations` table stopped recording at
 * 321 (2026-10-09); later migrations were applied by hand, so "run everything not recorded" would
 * replay migrations that already ran.
 *
 *   npm run migrate                         list migration files with no row in `migrations` (runs nothing)
 *   npm run migrate -- 437_some_change.js   run that migration's up(pool) and record it
 *   npm run migrate -- 437_some_change.js --force    run it even though it is recorded
 *   npm run migrate -- 437_some_change.js --record-only   record it without running (it was applied by hand)
 *
 * Only .js migrations exporting up(pool) are run; .sql files are listed but must be applied by hand.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import pool from '../utils/db.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const force = args.includes('--force');
const recordOnly = args.includes('--record-only');
const target = args.find((a) => !a.startsWith('--'));

async function recorded() {
    const [rows] = await pool.query('SELECT name FROM migrations');
    return new Set(rows.map((r) => r.name));
}

async function main() {
    const done = await recorded();
    if (!target) {
        const files = fs.readdirSync(dir).filter((f) => /^\d+.*\.(js|sql)$/.test(f) && f !== 'run.js').sort();
        const missing = files.filter((f) => !done.has(f));
        console.log(`${files.length} migration files, ${done.size} recorded, ${missing.length} not recorded.`);
        console.log('Recording stopped at 321 (2026-10-09); most of these were applied by hand. Check before running any.');
        for (const f of missing) console.log(`  ${f}`);
        return;
    }
    const name = path.basename(target);
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) throw new Error(`No such migration: ${name}`);
    if (done.has(name) && !force) throw new Error(`${name} is already recorded; add --force to run it again`);
    if (recordOnly) {
        if (!done.has(name)) await pool.query('INSERT INTO migrations (name) VALUES (?)', [name]);
        console.log(`Recorded ${name} without running it.`);
        return;
    }
    if (!name.endsWith('.js')) throw new Error(`${name} is not a .js migration; apply it by hand, then use --record-only`);
    const mod = await import(pathToFileURL(file).href);
    const up = mod.up || mod.default?.up || (typeof mod.default === 'function' ? mod.default : null);
    if (typeof up !== 'function') throw new Error(`${name} exports no up() function`);
    console.log(`Running ${name}...`);
    await up(pool);
    if (!done.has(name)) await pool.query('INSERT INTO migrations (name) VALUES (?)', [name]);
    console.log(`Done: ${name}`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => { console.error(`Migration failed: ${err.message}`); process.exit(1); });
