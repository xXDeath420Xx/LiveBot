/**
 * Migration 438: drop the old CertiFried Tycoon game's tables (every cfx_* table and its one view).
 * PREPARED, NOT RUN. Phase 5 of the game rewrite; the owner confirms before it is ever run
 * (docs/greenhouse-cutover.md, step "Drop the old tables").
 *
 * It refuses to run unless:
 *   1. GREENHOUSE_LIVE=1 is set: the new game is live and the bot no longer starts the old one;
 *   2. the archive backups/cfx-v1-archive/cfx-v1-20261119-0223.sql.gz exists, is not empty and is a valid gzip
 *      file, read to the end (a truncated file or a bad checksum fails);
 *   3. every table and view it would drop is in that archive (CREATE TABLE / VIEW), so nothing created after the
 *      archive was taken can be lost;
 *   4. no table outside the old game has a foreign key into it.
 * Then, on one connection with foreign key checks off (the old tables reference each other): the views first, then
 * the tables, then the old tables' rows in data_retention_policy (the nightly sweeper would only warn about them).
 *
 * The table list is read from information_schema, never written out here. After this runs, /privacy finds no old
 * game tables and skips them (services/cfx/privacy/legacy.js).
 *
 * Run:      npm run migrate -- 438_drop_cfx_v1_tables.js
 * Restore:  down() does not. zcat backups/cfx-v1-archive/cfx-v1-20261119-0223.sql.gz | mysql <database>
 *           (the dump drops and recreates each table, so it also works over a partial drop).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ARCHIVE = path.join(ROOT, 'backups/cfx-v1-archive/cfx-v1-20261119-0223.sql.gz');
export const PREFIX = 'cfx_';
// Tests run the same code on throwaway tables (ghtest_<6 hex>_); nothing else is accepted.
const TEST_PREFIX = /^ghtest_[0-9a-f]{6}_$/;
const SAFE = /^[A-Za-z0-9_]+$/;

function refuse(reason) {
    const err = new Error(`438 refused: ${reason}`);
    err.code = 'DROP_REFUSED';
    return err;
}

/** Names of the tables and views in a gzip'd mysqldump. Reads the whole file, so a damaged file throws. */
export async function archivedObjects(file) {
    const names = new Set();
    const pattern = /(?:CREATE TABLE|VIEW) `([A-Za-z0-9_]+)`/g;
    let carry = '';
    await new Promise((resolve, reject) => {
        const input = fs.createReadStream(file);
        const gunzip = zlib.createGunzip();
        input.on('error', reject);
        gunzip.on('error', reject);
        gunzip.on('data', (chunk) => {
            const text = carry + chunk.toString('utf8');
            for (const m of text.matchAll(pattern)) names.add(m[1]);
            carry = text.slice(-256);
        });
        gunzip.on('end', resolve);
        input.pipe(gunzip);
    });
    return names;
}

/** The tables and views of a prefix: { tables: [...], views: [...] }. */
async function objects(db, prefix) {
    const like = `${prefix.replace(/_/g, '\\_')}%`;
    const [rows] = await db.query(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ? ORDER BY TABLE_NAME`, [like]);
    const safe = rows.filter(r => SAFE.test(r.name));
    return { tables: safe.filter(r => r.type === 'BASE TABLE').map(r => r.name), views: safe.filter(r => r.type === 'VIEW').map(r => r.name) };
}

/**
 * Every check above, without changing anything. Returns { tables, views } that would be dropped.
 * Throws an error with code DROP_REFUSED naming the first check that fails.
 */
export async function checkPreconditions(db, { prefix = PREFIX, archive = ARCHIVE, env = process.env } = {}) {
    if (prefix !== PREFIX && !TEST_PREFIX.test(prefix)) throw refuse(`prefix "${prefix}" is not the old game's`);
    if (String(env.GREENHOUSE_LIVE ?? '').trim() !== '1') throw refuse('GREENHOUSE_LIVE=1 is not set (the new game is not live)');
    let stat;
    try { stat = fs.statSync(archive); } catch { throw refuse(`archive ${archive} does not exist`); }
    if (!stat.isFile()) throw refuse(`archive ${archive} is not a file`);
    if (stat.size === 0) throw refuse(`archive ${archive} is empty`);
    let archived;
    try {
        archived = await archivedObjects(archive);
    } catch (err) {
        throw refuse(`archive ${archive} is not a valid gzip file (${err.code || err.message})`);
    }
    const found = await objects(db, prefix);
    const all = [...found.tables, ...found.views];
    const missing = all.filter(n => !archived.has(n));
    if (missing.length) throw refuse(`not in the archive: ${missing.join(', ')}`);
    const like = `${prefix.replace(/_/g, '\\_')}%`;
    const [outside] = await db.query(
        `SELECT DISTINCT TABLE_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME LIKE ? AND TABLE_NAME NOT LIKE ?`, [like, like]);
    if (outside.length) throw refuse(`other tables have foreign keys into these: ${outside.map(r => r.name).join(', ')}`);
    return found;
}

/** Check, then drop. Returns { tables, views, policies } (names dropped and policy rows removed). */
export async function dropOldGame(db, options = {}) {
    const prefix = options.prefix ?? PREFIX;
    const found = await checkPreconditions(db, options);
    const conn = await db.getConnection();
    try {
        await conn.query('SET FOREIGN_KEY_CHECKS = 0');
        for (const v of found.views) await conn.query(`DROP VIEW IF EXISTS \`${v}\``);
        for (const t of found.tables) await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
        const [p] = await conn.query('DELETE FROM data_retention_policy WHERE table_name LIKE ?', [`${prefix.replace(/_/g, '\\_')}%`]);
        return { tables: found.tables, views: found.views, policies: p.affectedRows };
    } finally {
        try { await conn.query('SET FOREIGN_KEY_CHECKS = 1'); } finally { conn.release(); }
    }
}

export async function up(db) {
    const r = await dropOldGame(db);
    process.stdout.write(`438: dropped ${r.tables.length} table(s) and ${r.views.length} view(s); removed ${r.policies} retention row(s).\n`);
}

export async function down() {
    throw new Error(`438 cannot be undone automatically. Restore with: zcat ${path.relative(ROOT, ARCHIVE)} | mysql <database>`);
}
