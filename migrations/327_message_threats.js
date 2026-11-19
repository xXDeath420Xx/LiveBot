/*
 * Migration 327: message threats (core/message-threats.js, rules in core/message-threat-logic.js and
 * core/obfuscated-url.js). Every new setting extends a table that already owns the concept; no new tables.
 *
 *   phishing_config       the message-link threat row gains the settings of the new stages, all OFF:
 *                           obf_*        obfuscated-URL "fake support" scam (action ban | timeout | delete |
 *                                        flag | log, timeout minutes, review alerts for weaker hits)
 *                           everyone_*   anti-everyone (timeout minutes, strict mode, allowed roles, webhooks)
 *                           qr_*         QR codes in images (decode + link check, strict "any QR", action)
 *                           ocr_*        per-guild rules for text read out of images
 *                           esc_*        Discord AutoMod escalation (action ban | flag, review alerts, the
 *                                        rules enforced, the rule we installed)
 *                           threat_channel_id   where evidence / review cards go (falls back to alert_channel_id)
 *                           breaker_tripped_at  circuit breaker: set when > 25 bans in 10 minutes paused the
 *                                               automatic bans; cleared by a reset
 *   phishing_detections   the detection log gains message_id, content (the evidence), evidence (JSON: signals,
 *                         techniques, decoded QR links, matched rule) and score, so the dashboard's "recent
 *                         detections" can show what was caught and why. Index on (guild_id, source, created_at).
 *   automod_patterns      target gains 'image_text': OCR keyword / regex rules are pattern rows like the message
 *                         and name filters (advanced automod and name filters read their own target only).
 *   protection_allowlist  kind gains 'channel' and 'category': the message protections' ignore list (a category
 *                         covers channels created in it later, e.g. tickets). Read by core/protection-exempt.js.
 *   name_filter_reviews   kind gains 'message': the review queue for flagged message threats (Ban / Dismiss).
 *
 * Nothing changes for a server until it switches one of these on.
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

export const CONFIG_COLUMNS = [
    ['obf_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['obf_action', "ENUM('ban','timeout','delete','flag','log') NOT NULL DEFAULT 'ban'"],
    ['obf_timeout_minutes', 'INT NOT NULL DEFAULT 1440'],
    ['obf_review_alerts', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['everyone_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['everyone_timeout_minutes', 'INT NOT NULL DEFAULT 60'],
    ['everyone_strict', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['everyone_allowed_roles', 'TEXT DEFAULT NULL'],
    ['everyone_webhooks', "ENUM('ignore','log','delete') NOT NULL DEFAULT 'log'"],
    ['qr_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['qr_strict', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['qr_action', "ENUM('delete','timeout','ban','flag','log') NOT NULL DEFAULT 'delete'"],
    ['qr_timeout_minutes', 'INT NOT NULL DEFAULT 1440'],
    ['ocr_rules_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['ocr_timeout_minutes', 'INT NOT NULL DEFAULT 1440'],
    ['esc_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['esc_action', "ENUM('ban','flag') NOT NULL DEFAULT 'ban'"],
    ['esc_review_alerts', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['esc_rule_ids', 'TEXT DEFAULT NULL'],
    ['esc_installed_rule_id', 'VARCHAR(20) DEFAULT NULL'],
    ['threat_channel_id', 'VARCHAR(20) DEFAULT NULL'],
    ['breaker_tripped_at', 'DATETIME DEFAULT NULL'],
];

export const DETECTION_COLUMNS = [
    ['message_id', 'VARCHAR(20) DEFAULT NULL'],
    ['content', 'TEXT DEFAULT NULL'],
    ['evidence', 'MEDIUMTEXT DEFAULT NULL'],
    ['score', 'SMALLINT DEFAULT NULL'],
];

// [table, column, values before, values after, NOT NULL default]
export const ENUM_CHANGES = [
    ['automod_patterns', 'target', ['message', 'name'], ['message', 'name', 'image_text'], "NOT NULL DEFAULT 'message'"],
    ['protection_allowlist', 'kind', ['user', 'role', 'held', 'manager'], ['user', 'role', 'held', 'manager', 'channel', 'category'], 'NOT NULL'],
    ['name_filter_reviews', 'kind', ['name', 'avatar'], ['name', 'avatar', 'message'], "NOT NULL DEFAULT 'name'"],
];

export async function up(db) {
    if (!(await hasTable(db, 'phishing_config'))) throw new Error('phishing_config is missing');
    for (const [name, def] of CONFIG_COLUMNS) {
        if (!(await hasColumn(db, 'phishing_config', name))) await db.execute(`ALTER TABLE phishing_config ADD COLUMN ${name} ${def}`);
    }
    if (await hasTable(db, 'phishing_detections')) {
        for (const [name, def] of DETECTION_COLUMNS) {
            if (!(await hasColumn(db, 'phishing_detections', name))) await db.execute(`ALTER TABLE phishing_detections ADD COLUMN ${name} ${def}`);
        }
        if (!(await hasIndex(db, 'phishing_detections', 'idx_guild_source'))) {
            await db.execute('ALTER TABLE phishing_detections ADD INDEX idx_guild_source (guild_id, source, created_at)');
        }
    }
    for (const [table, column, , after, tail] of ENUM_CHANGES) {
        if (!(await hasTable(db, table))) continue;
        const type = await columnType(db, table, column);
        if (!type) continue;
        if (after.every(v => type.includes(`'${v}'`))) continue;
        await db.execute(`ALTER TABLE ${table} MODIFY ${column} ${enumOf(after)} ${tail}`);
    }
}

export async function down(db) {
    // Rows that only the new enum values can hold go first, or the MODIFY back would fail.
    if (await hasTable(db, 'automod_patterns')) await db.execute("DELETE FROM automod_patterns WHERE target = 'image_text'");
    if (await hasTable(db, 'protection_allowlist')) await db.execute("DELETE FROM protection_allowlist WHERE kind IN ('channel','category')");
    if (await hasTable(db, 'name_filter_reviews')) await db.execute("DELETE FROM name_filter_reviews WHERE kind = 'message'");
    for (const [table, column, before, , tail] of ENUM_CHANGES) {
        if (!(await hasTable(db, table)) || !(await columnType(db, table, column))) continue;
        await db.execute(`ALTER TABLE ${table} MODIFY ${column} ${enumOf(before)} ${tail}`);
    }
    if (await hasTable(db, 'phishing_detections')) {
        if (await hasIndex(db, 'phishing_detections', 'idx_guild_source')) await db.execute('ALTER TABLE phishing_detections DROP INDEX idx_guild_source');
        for (const [name] of DETECTION_COLUMNS) {
            if (await hasColumn(db, 'phishing_detections', name)) await db.execute(`ALTER TABLE phishing_detections DROP COLUMN ${name}`);
        }
    }
    for (const [name] of CONFIG_COLUMNS) {
        if (await hasColumn(db, 'phishing_config', name)) await db.execute(`ALTER TABLE phishing_config DROP COLUMN ${name}`);
    }
}

export default { up, down };
