/**
 * Classify every empty table by EVIDENCE, not by row count.
 *
 * "0 rows" is not a reason to drop a table. The audit found 415 empty tables,
 * but they are not one thing — they are at least four:
 *
 *   WIRED     A working feature nobody switched on. Live code queries this
 *             table. Dropping it breaks a shipped feature the moment someone
 *             enables it. These get PROMOTED (catalog/wizard), never deleted.
 *
 *   ORPHANED  No code references it at all. Nothing can read or write it.
 *             Genuinely dead — a candidate for removal.
 *
 *   SUPERSEDED  A newer table does the same job and holds the data. The empty
 *             one is a leftover from a rename or redesign. Candidate for
 *             removal, but only once the replacement is confirmed.
 *
 *   RUNTIME   Empty because it is transient by nature — active game sessions,
 *             queues, pending verifications, in-flight state. Empty is its
 *             NORMAL condition. Dropping these breaks the feature immediately.
 *             This is the category a naive "0 rows = dead" pass would destroy.
 *
 * Evidence gathered per table:
 *   - row count (live)
 *   - references in first-party JS (queries, not just the string appearing)
 *   - whether a migration creates it
 *   - membership in the feature registry
 *   - a same-family table WITH data that looks like a replacement
 *
 * OUTPUT ONLY. This script never drops anything. The DROP list is a proposal
 * for a human to approve, because dropping a table is irreversible and the cost
 * of a false positive (a broken feature, silently, later) is far higher than
 * the cost of keeping an empty table.
 *
 * Usage:  node scripts/classify-empty-tables.mjs [--json]
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const AS_JSON = process.argv.includes('--json');

/** Directories holding first-party code that could touch a table. */
const CODE_DIRS = ['commands', 'core', 'events', 'interactions', 'jobs', 'utils', 'dashboard/routes', 'dashboard/views', 'handlers', 'services'];

/**
 * Tables that are SUPPOSED to be empty most of the time.
 *
 * Matched as substrings against the table name. These hold transient state:
 * a row exists only while something is in flight. A "0 rows = drop it" pass
 * would delete active-game and queue tables and break those features instantly,
 * which is the single most dangerous mistake available here.
 */
const RUNTIME_PATTERNS = [
    'active_', '_active', '_session', 'session_', '_queue', 'queue_', 'pending_',
    '_pending', '_cooldown', 'cooldown_', '_lock', 'lockdown', '_cache', 'cache_',
    '_temp', 'temp_', '_draft', 'in_progress', '_state', '_votes', '_entries',
    '_participants', '_submissions', '_invites', '_claims', '_timers', '_reminders',
    '_undelivered', '_orphan', '_seen', '_history', '_log', 'logs',
];

function collectCode(dir, acc = []) {
    const full = path.join(ROOT, dir);
    let entries;
    try { entries = readdirSync(full); } catch { return acc; }
    for (const entry of entries) {
        const p = path.join(full, entry);
        if (statSync(p).isDirectory()) collectCode(path.join(dir, entry), acc);
        else if (/\.(js|mjs|cjs|ejs)$/.test(entry)) acc.push(p);
    }
    return acc;
}

const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

try {
    // ---- 1. Live row counts (exact, not information_schema estimates) -------
    const [allTables] = await db.execute(
        `SELECT table_name AS name FROM information_schema.tables
          WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
          ORDER BY table_name`
    );

    const rows = new Map();
    for (const { name } of allTables) {
        const [[{ n }]] = await db.query(`SELECT COUNT(*) AS n FROM \`${name}\``);
        rows.set(name, Number(n));
    }

    // ---- 2. Code references ------------------------------------------------
    const files = CODE_DIRS.flatMap((d) => collectCode(d));
    const sources = files.map((f) => ({ f: path.relative(ROOT, f), s: readFileSync(f, 'utf8') }));

    /** Where does this table name appear in a SQL-ish context? */
    function referencesFor(table) {
        // Word-boundaried so `levels` doesn't match `user_levels`.
        const bare = new RegExp(`\\b${table}\\b`);
        const sqlish = new RegExp(
            `(FROM|JOIN|INTO|UPDATE|TABLE|EXISTS)\\s+\`?${table}\`?\\b`, 'i'
        );

        const hits = [];
        for (const { f, s } of sources) {
            if (!bare.test(s)) continue;
            hits.push({ file: f, sql: sqlish.test(s) });
        }
        return hits;
    }

    // ---- 3. Migration provenance -------------------------------------------
    const migrationFiles = collectCode('migrations');
    const migrationSrc = migrationFiles.map((f) => ({ f: path.basename(f), s: readFileSync(f, 'utf8') }));
    function migrationFor(table) {
        const re = new RegExp(`CREATE TABLE[^;]*\\b${table}\\b`, 'i');
        return migrationSrc.filter((m) => re.test(m.s)).map((m) => m.f);
    }

    // ---- 4. Feature registry membership ------------------------------------
    let registry = [];
    try {
        const mod = await import(path.join(ROOT, 'core', 'feature-flags.js'));
        registry = mod.REGISTRY || [];
    } catch { /* registry optional */ }
    const registryDetect = new Set(registry.map((f) => f.detect).filter(Boolean));

    // ---- 5. Classify --------------------------------------------------------
    const isRuntime = (t) => RUNTIME_PATTERNS.some((p) => t.includes(p));

    /** A populated table sharing this one's prefix — a possible replacement. */
    function supersededBy(table) {
        const prefix = table.split('_').slice(0, 2).join('_');
        const siblings = [...rows.entries()]
            .filter(([n, c]) => n !== table && c > 0 && (n.startsWith(prefix) || table.startsWith(n.split('_').slice(0, 2).join('_'))))
            .filter(([n]) => {
                // Only flag when the names are genuinely close — same stem, or
                // one is a plural/singular or prefixed variant of the other.
                const a = table.replace(/s$/, ''), b = n.replace(/s$/, '');
                return b.includes(a) || a.includes(b);
            });
        return siblings.map(([n, c]) => `${n} (${c} rows)`);
    }

    const result = { wired: [], runtime: [], superseded: [], orphaned: [], populated: 0 };

    for (const { name } of allTables) {
        const count = rows.get(name);
        if (count > 0) { result.populated++; continue; }

        const refs = referencesFor(name);
        const sqlRefs = refs.filter((r) => r.sql);
        const migrations = migrationFor(name);
        const dupes = supersededBy(name);

        const record = {
            table: name,
            refs: refs.length,
            sqlRefs: sqlRefs.length,
            files: sqlRefs.slice(0, 3).map((r) => r.file),
            migrations,
            inRegistry: registryDetect.has(name),
            supersededBy: dupes,
        };

        // Order matters: a table can look orphaned AND be runtime-transient.
        // Runtime wins, because dropping it is the most damaging error.
        if (sqlRefs.length > 0) result.wired.push(record);
        else if (isRuntime(name)) result.runtime.push(record);
        else if (dupes.length) result.superseded.push(record);
        else result.orphaned.push(record);
    }

    if (AS_JSON) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        const line = (r) => `  ${r.table.padEnd(38)} refs:${String(r.sqlRefs).padStart(3)}  ${r.migrations.length ? 'mig:' + r.migrations[0].slice(0, 22) : ''}${r.supersededBy.length ? '  dup-> ' + r.supersededBy[0] : ''}`;

        console.log(`\nPopulated tables: ${result.populated}`);
        console.log(`Empty tables:     ${result.wired.length + result.runtime.length + result.superseded.length + result.orphaned.length}\n`);

        console.log(`=== WIRED — empty but live code queries them. PROMOTE, never drop. (${result.wired.length}) ===`);
        result.wired.forEach((r) => console.log(line(r)));

        console.log(`\n=== RUNTIME — empty is their normal state. KEEP. (${result.runtime.length}) ===`);
        result.runtime.forEach((r) => console.log(`  ${r.table}`));

        console.log(`\n=== SUPERSEDED — a populated near-twin exists. REVIEW. (${result.superseded.length}) ===`);
        result.superseded.forEach((r) => console.log(line(r)));

        console.log(`\n=== ORPHANED — no SQL reference anywhere. DROP CANDIDATES. (${result.orphaned.length}) ===`);
        result.orphaned.forEach((r) => console.log(`  ${r.table.padEnd(38)}${r.refs ? ` (${r.refs} non-SQL mention(s))` : ''}${r.migrations.length ? '  mig:' + r.migrations[0] : '  no migration'}`));

        console.log('\nNothing has been dropped. This is a proposal.');
    }
} finally {
    await db.end();
}
