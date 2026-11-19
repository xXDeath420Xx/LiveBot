/**
 * Second-opinion check on the Tier A "safe to drop" list.
 *
 * The family-liveness test in propose-table-cleanup.mjs matches on a `prefix_`
 * boundary, which misses plural/singular pairs: `poll_options` was classified as
 * a dead family because `polls` does not start with `poll_`. But `polls` has
 * rows in 6 guilds — so `poll_options` is an unimplemented part of a LIVE
 * feature, exactly the category the user asked to protect.
 *
 * A false positive here means silently deleting the schema of a working feature,
 * so Tier A gets checked a second way before anything is proposed:
 *
 *   1. STEM MATCH      — singular/plural and shared-root relatives with rows.
 *   2. NAME TWIN       — a populated table whose name is a near-synonym
 *                        (verification_config vs verify_config,
 *                         warnings vs infractions, soundboard_sounds vs
 *                         vc_sound_files). These are supersessions, which is a
 *                         *different* reason to drop than "dead" — and the
 *                         distinction matters, because a supersession should be
 *                         confirmed against the replacement, not assumed.
 *   3. REGISTRY        — named as a feature's detect table.
 *
 * Anything that trips a check is demoted out of "safe".
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { readFileSync } from 'node:fs';

const listPath = process.argv[2];
if (!listPath) {
    console.error('usage: node scripts/verify-tier-a.mjs <tier-a-names.txt>');
    process.exit(1);
}

/**
 * Hand-declared supersessions. Derived by reading the schema, not guessed:
 * each pair was checked to confirm the replacement holds the live data.
 */
const KNOWN_TWINS = {
    verification_config: 'verify_config',
    warnings: 'infractions',
    mod_actions: 'audit_logs / infractions',
    soundboard_sounds: 'vc_sound_files',
    soundboard_usage_stats: 'vc_sound_log',
    forms: 'ticket_forms',
    form_questions: 'ticket_forms',
    form_responses: 'ticket_form_responses',
    teams: 'twitch_teams',
    poll_options: 'polls (JSON column)',
    saved_embeds: 'custom_embeds',
    statroles_config: 'stat_roles / stat_display_channels',
    statrole_configs: 'stat_roles / stat_display_channels',
    statdocks_config: 'stat_display_channels',
    invites: 'invite_tracking',
    announcements: 'scheduled_announcements / custom_embeds',
    record_config: 'log_event_config',
    tts_config: 'user_tts_preferences (reserved)',
};

const names = readFileSync(listPath, 'utf8').split(/\s+/).map((s) => s.trim()).filter(Boolean);

const db = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

try {
    const [tables] = await db.execute(
        `SELECT table_name AS name FROM information_schema.tables
          WHERE table_schema=DATABASE() AND table_type='BASE TABLE'`
    );
    const counts = new Map();
    for (const { name } of tables) {
        const [[{ n }]] = await db.query(`SELECT COUNT(*) AS n FROM \`${name}\``);
        counts.set(name, Number(n));
    }

    let registryDetect = new Set();
    try {
        const mod = await import('../core/feature-flags.js');
        registryDetect = new Set((mod.REGISTRY || []).map((f) => f.detect).filter(Boolean));
    } catch { /* optional */ }

    /** Shared-root relatives with rows, tolerant of plural/singular. */
    function stemRelatives(table) {
        const stem = table.replace(/s$/, '').split('_')[0];
        return [...counts.entries()]
            .filter(([n, c]) => n !== table && c > 0)
            .filter(([n]) => n.replace(/s$/, '').split('_')[0] === stem)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([n, c]) => `${n}=${c}`);
    }

    const safe = [];
    const demoted = [];

    for (const table of names) {
        const reasons = [];

        if (registryDetect.has(table)) reasons.push('named as a feature registry detect table');

        const twin = KNOWN_TWINS[table];
        if (twin) {
            const twinName = twin.split(' ')[0];
            const twinRows = counts.get(twinName);
            reasons.push(
                twinRows > 0
                    ? `SUPERSEDED by ${twin} (${twinRows} rows) — drop for that reason, not "dead"`
                    : `claimed twin ${twin} is ALSO empty — verify before dropping either`
            );
        }

        const rel = stemRelatives(table);
        if (rel.length && !twin) reasons.push(`live stem relatives: ${rel.join(', ')}`);

        if (reasons.length) demoted.push({ table, reasons });
        else safe.push(table);
    }

    console.log(`# Tier A second opinion — ${names.length} candidates\n`);

    console.log(`## STILL SAFE (${safe.length}) — no live relative, no twin, no registry role`);
    console.log(safe.map((t) => '  ' + t).join('\n') || '  (none)');

    console.log(`\n## DEMOTED (${demoted.length}) — needs a decision, not an automatic drop`);
    for (const d of demoted) {
        console.log(`  ${d.table}`);
        d.reasons.forEach((r) => console.log(`      ${r}`));
    }
} finally {
    await db.end();
}
