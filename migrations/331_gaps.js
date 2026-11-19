/*
 * Migration 331: the "gaps" wave — AI second opinion, domain reports / disputes (name-filter and avatar
 * export / import and the "manual action needed" alerts need no schema). Every column extends a table that
 * already owns the concept; no new tables:
 *
 *   phishing_config       ai_* — the AI second opinion (core/ai-judge.js), one block per server on the
 *                         message-threat row: avatar impersonation mode off | advise | act (off) + act
 *                         confidence (0.850), scam-text mode (off) + confidence (0.850), NSFW third opinion
 *                         (advise only, off), daily cap of AI checks (100)
 *   name_filter_reviews   ai_verdict / ai_confidence / ai_reason / ai_at — the verdict on the review row it is
 *                         about (avatar, message and NSFW queues). judge_score stays the local NSFW model's.
 *   server_stats          the per-server per-day row gains the AI meter: calls per surface (avatar, text,
 *                         nsfw), answered from cache, skipped (cap / rate limit), failed (no verdict)
 *   scam_reports          the existing reports table (/engage report, which keeps to its own report types)
 *                         holds domain reports and disputes too (core/domain-reports.js): report_type gains
 *                         'phishing_url' and 'domain_dispute', status gains 'blocked' | 'resolved' |
 *                         'rejected', new columns domain, history (JSON) and notified, and an index for the
 *                         review queue. It had no domain column and no history; nothing else stores reports.
 *
 * The overrides an approved report / dispute adds use what the phishing pipeline already reads:
 * phishing_domains source 'manual' (block) and link_policy_domains guild_id '0' kind 'allow' (global allow).
 * Nothing changes for a server until it switches the AI on; nobody's report exists until they file one.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

async function hasIndex(db, table, index) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
        [table, index]);
    return rows.length > 0;
}

async function columnType(db, table, column) {
    const [rows] = await db.execute(
        'SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows[0]?.t ? String(rows[0].t) : null;
}

const enumOf = (values) => `ENUM(${values.map(v => `'${v}'`).join(',')})`;

export const AI_COLUMNS = [
    ['ai_avatar_mode', "ENUM('off','advise','act') NOT NULL DEFAULT 'off'"],
    ['ai_avatar_confidence', 'DECIMAL(4,3) NOT NULL DEFAULT 0.850'],
    ['ai_text_mode', "ENUM('off','advise','act') NOT NULL DEFAULT 'off'"],
    ['ai_text_confidence', 'DECIMAL(4,3) NOT NULL DEFAULT 0.850'],
    ['ai_nsfw_advise', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['ai_daily_cap', 'INT NOT NULL DEFAULT 100'],
];

export const REVIEW_COLUMNS = [
    ['ai_verdict', 'VARCHAR(12) DEFAULT NULL'],
    ['ai_confidence', 'DECIMAL(4,3) DEFAULT NULL'],
    ['ai_reason', 'VARCHAR(200) DEFAULT NULL'],
    ['ai_at', 'DATETIME DEFAULT NULL'],
];

export const STATS_COLUMNS = ['ai_avatar_calls', 'ai_text_calls', 'ai_nsfw_calls', 'ai_cached', 'ai_skipped', 'ai_failed']
    .map(c => [c, 'INT NOT NULL DEFAULT 0']);

export const REPORT_COLUMNS = [
    ['domain', 'VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL'],
    ['history', 'MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci DEFAULT NULL'],
    ['notified', 'TINYINT(1) NOT NULL DEFAULT 0'],
];

const TYPES_BEFORE = ['user', 'seedbank', 'website', 'other'];
const STATUS_BEFORE = ['pending', 'investigating', 'confirmed', 'dismissed'];
export const NEW_TYPES = ['phishing_url', 'domain_dispute'];
export const NEW_STATUSES = ['blocked', 'resolved', 'rejected'];

// [table, column, values before, values after, tail]
export const ENUM_CHANGES = [
    ['scam_reports', 'report_type', TYPES_BEFORE, [...TYPES_BEFORE, ...NEW_TYPES], 'NOT NULL'],
    ['scam_reports', 'status', STATUS_BEFORE, [...STATUS_BEFORE, ...NEW_STATUSES], "DEFAULT 'pending'"],
];

const ADD_COLUMNS = [
    ['phishing_config', AI_COLUMNS],
    ['name_filter_reviews', REVIEW_COLUMNS],
    ['server_stats', STATS_COLUMNS],
    ['scam_reports', REPORT_COLUMNS],
];

export const REPORT_INDEX = ['idx_type_domain', 'ALTER TABLE scam_reports ADD INDEX idx_type_domain (report_type, domain, status)'];

export async function up(db) {
    for (const [table, columns] of ADD_COLUMNS) {
        if (!(await hasTable(db, table))) throw new Error(`${table} is missing`);
        for (const [name, def] of columns) {
            if (!(await hasColumn(db, table, name))) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
        }
    }
    for (const [table, column, , after, tail] of ENUM_CHANGES) {
        const type = await columnType(db, table, column);
        if (!type) throw new Error(`${table}.${column} is missing`);
        if (after.every(v => type.includes(`'${v}'`))) continue;
        // Only ever widen: refuse if the live enum holds a value this list does not know (it would be lost).
        const live = [...type.matchAll(/'([^']*)'/g)].map(m => m[1]);
        const unknown = live.filter(v => !after.includes(v));
        if (unknown.length) throw new Error(`${table}.${column} has values this migration does not know: ${unknown.join(', ')}`);
        await db.execute(`ALTER TABLE ${table} MODIFY ${column} ${enumOf(after)} ${tail}`);
    }
    if (!(await hasIndex(db, 'scam_reports', REPORT_INDEX[0]))) await db.execute(REPORT_INDEX[1]);
}

export async function down(db) {
    // Rows only the new enum values can hold go first, or the MODIFY back would fail.
    if (await hasTable(db, 'scam_reports')) {
        await db.execute(`DELETE FROM scam_reports WHERE report_type IN (${NEW_TYPES.map(() => '?').join(',')})`, NEW_TYPES);
        await db.execute(`UPDATE scam_reports SET status = 'dismissed' WHERE status IN (${NEW_STATUSES.map(() => '?').join(',')})`, NEW_STATUSES);
        if (await hasIndex(db, 'scam_reports', REPORT_INDEX[0])) await db.execute(`ALTER TABLE scam_reports DROP INDEX ${REPORT_INDEX[0]}`);
    }
    for (const [table, column, before, , tail] of ENUM_CHANGES) {
        if (!(await hasTable(db, table)) || !(await columnType(db, table, column))) continue;
        await db.execute(`ALTER TABLE ${table} MODIFY ${column} ${enumOf(before)} ${tail}`);
    }
    for (const [table, columns] of ADD_COLUMNS) {
        if (!(await hasTable(db, table))) continue;
        for (const [name] of columns) {
            if (await hasColumn(db, table, name)) await db.execute(`ALTER TABLE ${table} DROP COLUMN ${name}`);
        }
    }
}

export default { up, down };
