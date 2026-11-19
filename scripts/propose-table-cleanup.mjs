/**
 * Turn the empty-table classification into a TIERED, justified proposal.
 *
 * The first pass (classify-empty-tables.mjs) asks "does code query this table".
 * That is necessary but not sufficient, and acting on it alone would delete
 * things that matter. Three examples it got wrong on its own:
 *
 *   translations           — flagged orphaned. It is the documented home for
 *                            per-guild string overrides in the i18n layer that
 *                            shipped this week. Planned-forward, not dead.
 *   log_retention_policy   — flagged orphaned. Deliberately preserved in
 *                            migration 182 as the per-guild retention concept,
 *                            distinct from operational data_retention_policy.
 *   user_consents,
 *   user_privacy_settings  — flagged orphaned. Privacy/consent infrastructure.
 *                            Dropping compliance scaffolding to save 16KB is a
 *                            bad trade in any jurisdiction.
 *
 * So this adds the axis that actually decides it: **is the table's feature
 * family alive?** `owo_ring` has no code today, but OwO is a live feature with
 * populated sibling tables — the empty tables are unimplemented parts of a
 * shipped system, exactly the "could be wired into already running systems"
 * case. Dropping them costs a migration to re-add later; keeping them costs
 * kilobytes.
 *
 * Tiers:
 *   A  SAFE       Family entirely dead, no migration, no code, no reserved role.
 *   B  CONFIRM    Orphaned, but the family is LIVE. Your call.
 *   C  KEEP       Wired / runtime / reserved / privacy. Not proposed for removal.
 *
 * OUTPUT ONLY — this never drops anything.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLASSIFY = process.argv[2];
if (!CLASSIFY) {
    console.error('usage: node scripts/propose-table-cleanup.mjs <classify.clean.json>');
    process.exit(1);
}

/**
 * Tables reserved on purpose. Never proposed for removal regardless of usage.
 * Each needs a reason — "might be useful" is not one.
 */
const RESERVED = new Map([
    ['translations', 'Documented home for per-guild string overrides in the i18n layer (shipped 2026-08-02).'],
    ['log_retention_policy', 'Per-guild retention setting, deliberately kept distinct from data_retention_policy in migration 182.'],
    ['user_consents', 'Privacy/consent infrastructure — compliance scaffolding.'],
    ['user_privacy_settings', 'Privacy/consent infrastructure — compliance scaffolding.'],
    ['user_language_prefs', 'Read by the i18n layer; empty only because nobody has set a personal locale yet.'],
    ['guild_language_prefs', 'Read by the i18n layer; empty only because no guild has set a locale yet.'],
    ['super_admins', 'Access control. Empty because the super-admin list is env-driven today, but this is a security surface.'],
    ['user_tts_preferences', 'Per-user accessibility preference (TTS voice) — an accessibility surface.'],
]);

/** family prefix -> how many populated tables it has. */
function familyOf(table) {
    const parts = table.split('_');
    // Two-segment prefixes for known multi-word families, else first segment.
    const two = parts.slice(0, 2).join('_');
    return { one: parts[0], two };
}

const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
});

try {
    const data = JSON.parse(readFileSync(CLASSIFY, 'utf8'));

    // Live row counts for family-liveness.
    const [tables] = await db.execute(
        `SELECT table_name AS name FROM information_schema.tables
          WHERE table_schema = DATABASE() AND table_type='BASE TABLE'`
    );
    const counts = new Map();
    for (const { name } of tables) {
        const [[{ n }]] = await db.query(`SELECT COUNT(*) AS n FROM \`${name}\``);
        counts.set(name, Number(n));
    }

    /** Populated siblings sharing a prefix — evidence the family is in use. */
    function familyLiveness(table) {
        const { one, two } = familyOf(table);
        const sibs = [...counts.entries()].filter(([n, c]) =>
            n !== table && c > 0 && (n.startsWith(two + '_') || n === two || n.startsWith(one + '_'))
        );
        return { count: sibs.length, examples: sibs.sort((a, b) => b[1] - a[1]).slice(0, 2).map(([n, c]) => `${n}=${c}`) };
    }

    const tierA = [];   // safe
    const tierB = [];   // family live — confirm
    const tierC = [];   // reserved

    for (const rec of data.orphaned) {
        if (RESERVED.has(rec.table)) {
            tierC.push({ ...rec, why: RESERVED.get(rec.table) });
            continue;
        }

        const live = familyLiveness(rec.table);

        if (live.count > 0) {
            tierB.push({ ...rec, live });
        } else {
            tierA.push({ ...rec, live });
        }
    }

    const bytesFor = async (names) => {
        if (!names.length) return 0;
        const [[{ mb }]] = await db.query(
            `SELECT ROUND(SUM(data_length+index_length)/1024/1024, 2) AS mb
               FROM information_schema.tables
              WHERE table_schema=DATABASE() AND table_name IN (${names.map(() => '?').join(',')})`,
            names
        );
        return mb || 0;
    };

    const aMb = await bytesFor(tierA.map((r) => r.table));
    const bMb = await bytesFor(tierB.map((r) => r.table));

    console.log('# Empty-table cleanup proposal\n');
    console.log(`Populated tables kept untouched: ${data.populated}`);
    console.log(`WIRED (live SQL, empty)        : ${data.wired.length}  -> PROMOTE, never drop`);
    console.log(`RUNTIME (empty is normal)      : ${data.runtime.length}  -> KEEP`);
    console.log(`SUPERSEDED (needs review)      : ${data.superseded.length}\n`);

    console.log(`## TIER A — safe to drop (${tierA.length} tables, ${aMb} MB)`);
    console.log('Family entirely dead: no populated sibling, no migration, no SQL reference.\n');
    const byFamA = {};
    for (const r of tierA) { const f = familyOf(r.table).one; (byFamA[f] = byFamA[f] || []).push(r.table); }
    for (const [f, list] of Object.entries(byFamA).sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${(f + '_*').padEnd(22)} ${String(list.length).padStart(2)}  ${list.join(', ')}`);
    }

    console.log(`\n## TIER B — orphaned BUT family is live (${tierB.length} tables, ${bMb} MB)`);
    console.log('These are unimplemented parts of shipped features. Your call.\n');
    const byFamB = {};
    for (const r of tierB) { const f = familyOf(r.table).one; (byFamB[f] = byFamB[f] || []).push(r); }
    for (const [f, list] of Object.entries(byFamB).sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${(f + '_*').padEnd(22)} ${String(list.length).padStart(2)} empty | family live: ${list[0].live.examples.join(', ')}`);
        console.log(`      ${list.map((r) => r.table).join(', ')}`);
    }

    console.log(`\n## TIER C — reserved, not proposed (${tierC.length})`);
    for (const r of tierC) console.log(`  ${r.table.padEnd(24)} ${r.why}`);

    console.log('\nNothing has been dropped. Approve a tier and I will generate the migration.');
} finally {
    await db.end();
}
