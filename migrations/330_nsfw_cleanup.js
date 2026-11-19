/*
 * Migration 330: NSFW protection (core/nsfw-protection.js, rules in core/nsfw-logic.js, local models via
 * core/nsfw-classifier.js) — avatars and chat images. Every setting and record extends a table that
 * already owns the concept; no new tables:
 *
 *   join_gate_config      nsfw_avatar_* — the avatar side, on the join-protection row beside avatar_*:
 *                           enabled (off), action log | flag | kick | ban (log), act / review thresholds
 *                           (0.900 / 0.600), daily scan cap (1000), dm (on)
 *   phishing_config       nsfw_img_* — the chat-image stage, on the message-threat row beside obf_* / qr_*:
 *                           enabled (off), action alert | delete | timeout (alert), timeout minutes (60),
 *                           act / review thresholds, review_alerts (off: borderline images are only queued),
 *                           daily scan cap (2000)
 *   name_filter_reviews   kind gains 'nsfw_avatar' and 'nsfw_image' (the NSFW review queue); status gains
 *                         'actioned' (the bot acted; staff can overturn) and 'overturned'; new columns
 *                         action_taken (what the bot did: ban / kick / flag / delete / timeout — what an
 *                         overturn undoes) and judge_score (the second model's score; `score` holds the
 *                         first's). avatar_sha holds the picture's key; avatar_thumb stays NULL (no images).
 *   blocked_images        kind gains 'nsfw_safe': pictures staff marked not NSFW or overturned (exact_sha =
 *                         the classifier's picture key), never flagged again in that server
 *   join_gate_events      action enum gains the NSFW avatar outcomes (recent hits, ban log evidence)
 *   server_stats          the per-server per-day row gains the NSFW scan meter: scans, hits, borderline
 *                         reviews and skipped scans (over the daily cap or classifier overloaded), per surface
 *
 * Nothing changes for a server until it switches NSFW protection on. Chat-image detections are
 * phishing_detections rows with source 'nsfw_image' (a varchar: no change needed).
 *
 * Also part of this wave, without schema changes: the setup wizard and the takeover stop writing the dead
 * anti_raid_config table and read / write raid_detection_config instead (anti_raid_config is left as it
 * is, unread, so a rollback still works).
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

async function columnType(db, table, column) {
    const [rows] = await db.execute(
        'SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows[0]?.t ? String(rows[0].t) : null;
}

const enumOf = (values) => `ENUM(${values.map(v => `'${v}'`).join(',')})`;

export const AVATAR_COLUMNS = [
    ['nsfw_avatar_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['nsfw_avatar_action', "ENUM('log','flag','kick','ban') NOT NULL DEFAULT 'log'"],
    ['nsfw_avatar_act_threshold', 'DECIMAL(4,3) NOT NULL DEFAULT 0.900'],
    ['nsfw_avatar_review_threshold', 'DECIMAL(4,3) NOT NULL DEFAULT 0.600'],
    ['nsfw_avatar_daily_cap', 'INT NOT NULL DEFAULT 1000'],
    ['nsfw_avatar_dm', 'TINYINT(1) NOT NULL DEFAULT 1'],
];

export const IMAGE_COLUMNS = [
    ['nsfw_img_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['nsfw_img_action', "ENUM('alert','delete','timeout') NOT NULL DEFAULT 'alert'"],
    ['nsfw_img_timeout_minutes', 'INT NOT NULL DEFAULT 60'],
    ['nsfw_img_act_threshold', 'DECIMAL(4,3) NOT NULL DEFAULT 0.900'],
    ['nsfw_img_review_threshold', 'DECIMAL(4,3) NOT NULL DEFAULT 0.600'],
    ['nsfw_img_review_alerts', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['nsfw_img_daily_cap', 'INT NOT NULL DEFAULT 2000'],
];

export const REVIEW_COLUMNS = [
    ['action_taken', 'VARCHAR(16) DEFAULT NULL'],
    ['judge_score', 'DECIMAL(5,4) DEFAULT NULL'],
];

export const STATS_COLUMNS = [
    'nsfw_avatar_scans', 'nsfw_avatar_hits', 'nsfw_avatar_reviews', 'nsfw_avatar_skipped',
    'nsfw_image_scans', 'nsfw_image_hits', 'nsfw_image_reviews', 'nsfw_image_skipped',
].map(c => [c, 'INT NOT NULL DEFAULT 0']);

const GATE_EVENTS_BEFORE = ['kicked_new', 'kicked_apply', 'allowed_approved', 'allowed_pending', 'failed', 'rejoin_banned', 'rejoin_kicked',
    'rejoin_apply', 'rejoin_observed', 'spammer_banned', 'spammer_kicked', 'spammer_flagged', 'spammer_observed', 'name_banned', 'name_kicked',
    'name_timeout', 'name_flagged', 'name_logged', 'avatar_banned', 'avatar_kicked', 'avatar_timeout', 'avatar_flagged', 'avatar_logged',
    'avatar_queued', 'verify_passed', 'verify_wrong', 'verify_failed', 'verify_expired', 'verify_kicked', 'verify_banned', 'verify_timedout',
    'verify_held', 'prune_kicked', 'prune_logged', 'prune_held'];
const NSFW_EVENTS = ['nsfw_banned', 'nsfw_kicked', 'nsfw_flagged', 'nsfw_logged', 'nsfw_queued', 'nsfw_overturned'];
const REVIEW_STATUS_BEFORE = ['pending', 'banned', 'kicked', 'safe', 'skipped', 'gone', 'failed'];

// [table, column, values before, values after, NOT NULL default]
export const ENUM_CHANGES = [
    ['name_filter_reviews', 'kind', ['name', 'avatar', 'message'], ['name', 'avatar', 'message', 'nsfw_avatar', 'nsfw_image'], "NOT NULL DEFAULT 'name'"],
    ['name_filter_reviews', 'status', REVIEW_STATUS_BEFORE, [...REVIEW_STATUS_BEFORE, 'actioned', 'overturned'], "NOT NULL DEFAULT 'pending'"],
    ['blocked_images', 'kind', ['message', 'avatar', 'scam_avatar'], ['message', 'avatar', 'scam_avatar', 'nsfw_safe'], "NOT NULL DEFAULT 'message'"],
    ['join_gate_events', 'action', GATE_EVENTS_BEFORE, [...GATE_EVENTS_BEFORE, ...NSFW_EVENTS], 'NOT NULL'],
];

const ADD_COLUMNS = [
    ['join_gate_config', AVATAR_COLUMNS],
    ['phishing_config', IMAGE_COLUMNS],
    ['name_filter_reviews', REVIEW_COLUMNS],
    ['server_stats', STATS_COLUMNS],
];

export async function up(db) {
    for (const [table, columns] of ADD_COLUMNS) {
        if (!(await hasTable(db, table))) throw new Error(`${table} is missing`);
        for (const [name, def] of columns) {
            if (!(await hasColumn(db, table, name))) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
        }
    }
    for (const [table, column, , after, tail] of ENUM_CHANGES) {
        if (!(await hasTable(db, table))) continue;
        const type = await columnType(db, table, column);
        if (!type) continue;
        if (after.every(v => type.includes(`'${v}'`))) continue;
        // Only ever widen: refuse if the live enum holds a value this list does not know (it would be lost).
        const live = [...type.matchAll(/'([^']*)'/g)].map(m => m[1]);
        const unknown = live.filter(v => !after.includes(v));
        if (unknown.length) throw new Error(`${table}.${column} has values this migration does not know: ${unknown.join(', ')}`);
        await db.execute(`ALTER TABLE ${table} MODIFY ${column} ${enumOf(after)} ${tail}`);
    }
}

export async function down(db) {
    // Rows only the new enum values can hold go first, or the MODIFY back would fail.
    if (await hasTable(db, 'name_filter_reviews')) {
        await db.execute("DELETE FROM name_filter_reviews WHERE kind IN ('nsfw_avatar','nsfw_image')");
        await db.execute("UPDATE name_filter_reviews SET status = 'gone' WHERE status IN ('actioned','overturned')");
    }
    if (await hasTable(db, 'blocked_images')) await db.execute("DELETE FROM blocked_images WHERE kind = 'nsfw_safe'");
    if (await hasTable(db, 'join_gate_events')) await db.execute(`DELETE FROM join_gate_events WHERE action IN (${NSFW_EVENTS.map(() => '?').join(',')})`, NSFW_EVENTS);
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
