/*
 * Migration 326: avatar protection (core/avatar-protection.js, rules in core/avatar-match-logic.js).
 *
 * Avatars become one more target of the existing image system rather than a second one:
 *
 *   blocked_images        already holds fingerprinted images per server (guild '0' = every server) for
 *                         the scam-image blocklist. Protected avatars and known scam avatars are rows
 *                         here too, told apart by `kind`:
 *                           kind          'message' (every existing row: images deleted from chat)
 *                                         | 'avatar' (a protected image: staff avatar, server icon, upload)
 *                                         | 'scam_avatar' (matched EXACTLY on its canonical pixels)
 *                           exact_sha     canonical-pixel SHA-256 ('' for message rows, so the unique key
 *                                         below still means "one row per image" for them)
 *                           avatar_fp     the avatar fingerprint variants (core/image-fingerprint.js)
 *                           source_type   'upload' | 'member' | 'role' | 'server_icon' | 'autopilot' | 'learned'
 *                           protected_user_id  whose avatar it is (never matched against them)
 *                           avatar_key    'global:<hash>' / 'server:<hash>' / 'icon:<hash>' (Auto-Pilot follows changes)
 *                           thumb         96px WebP data URI for the dashboard
 *                           suppress      JSON list of avatars staff said are "not a match" for this image
 *                           removed_at    an Auto-Pilot image staff deleted: kept so it is not recreated
 *                           hits, last_hit_at
 *                         The unique key becomes (guild_id, kind, dhash, exact_sha): the old (guild_id, dhash)
 *                         would have refused the solid-black and transparent entries (both hash to 0) and a
 *                         staff avatar that happened to share a hash with a scam screenshot.
 *                         The message blocklist reads only kind 'message' (core/image-blocklist.js).
 *   name_filter_reviews   the wave-2 review queue, generalised with `kind` ('name' | 'avatar') — the
 *                         primary key gains `kind` so one member can be queued for both — plus the avatar
 *                         columns (matched image, score, avatar URL / fingerprint / canonical hash / thumb).
 *                         Status 'safe' on an avatar row is "Not a match".
 *   join_gate_config      avatar_* settings — the sixth feature on the join-protection row. Everything off
 *                         until a server switches avatar protection on; the action defaults to log-only.
 *                         Auto-Pilot's on/off and coverage stay the name_autopilot_* columns (one Auto-Pilot);
 *                         avatar_autopilot only says whether it also protects avatars.
 *   join_gate_events      action enum gains the avatar outcomes (the "recent hits" list).
 *
 * Nothing changes for a server until it switches avatar protection on. The scam-image blocklist keeps
 * working exactly as before (its rows all become kind 'message').
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

async function primaryKeyColumns(db, table) {
    const [rows] = await db.execute(
        `SELECT COLUMN_NAME AS c FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX`, [table]);
    return rows.map(r => r.c);
}

const enumOf = (values) => `ENUM(${values.map(v => `'${v}'`).join(',')})`;

const IMAGE_COLUMNS = [
    ['kind', "ENUM('message','avatar','scam_avatar') NOT NULL DEFAULT 'message'"],
    ['exact_sha', "CHAR(64) NOT NULL DEFAULT ''"],
    ['avatar_fp', 'TEXT DEFAULT NULL'],
    ['source_type', 'VARCHAR(16) DEFAULT NULL'],
    ['protected_user_id', 'VARCHAR(20) DEFAULT NULL'],
    ['avatar_key', 'VARCHAR(100) DEFAULT NULL'],
    ['thumb', 'TEXT DEFAULT NULL'],
    ['suppress', 'MEDIUMTEXT DEFAULT NULL'],
    ['removed_at', 'DATETIME DEFAULT NULL'],
    ['hits', 'INT UNSIGNED NOT NULL DEFAULT 0'],
    ['last_hit_at', 'DATETIME DEFAULT NULL'],
];

const REVIEW_COLUMNS = [
    ['kind', "ENUM('name','avatar') NOT NULL DEFAULT 'name'"],
    ['image_id', 'INT DEFAULT NULL'],
    ['score', 'DECIMAL(5,4) DEFAULT NULL'],
    ['avatar_url', 'VARCHAR(300) DEFAULT NULL'],
    ['avatar_fp', 'VARCHAR(200) DEFAULT NULL'],
    ['avatar_sha', 'CHAR(64) DEFAULT NULL'],
    ['avatar_thumb', 'TEXT DEFAULT NULL'],
];

const OLD_EVENT_ACTIONS = ['kicked_new', 'kicked_apply', 'allowed_approved', 'allowed_pending', 'failed',
    'rejoin_banned', 'rejoin_kicked', 'rejoin_apply', 'rejoin_observed',
    'spammer_banned', 'spammer_kicked', 'spammer_flagged', 'spammer_observed',
    'name_banned', 'name_kicked', 'name_timeout', 'name_flagged', 'name_logged'];
const EVENT_ACTIONS = [...OLD_EVENT_ACTIONS,
    'avatar_banned', 'avatar_kicked', 'avatar_timeout', 'avatar_flagged', 'avatar_logged', 'avatar_queued'];

const CONFIG_COLUMNS = [
    ['avatar_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],                 // check avatars on join and on every change
    ['avatar_auto_threshold', 'DECIMAL(3,2) NOT NULL DEFAULT 0.90'],     // act at or above
    ['avatar_review_threshold', 'DECIMAL(3,2) NOT NULL DEFAULT 0.75'],   // queue for review at or above
    ['avatar_action', "VARCHAR(10) NOT NULL DEFAULT 'log'"],
    ['avatar_flag_role_id', 'VARCHAR(20) DEFAULT NULL'],
    ['avatar_timeout_minutes', 'INT NOT NULL DEFAULT 60'],
    ['avatar_dm', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['avatar_scam_enabled', 'TINYINT(1) NOT NULL DEFAULT 1'],            // exact scam avatars (on once protection is on)
    ['avatar_scam_action', "VARCHAR(10) NOT NULL DEFAULT 'log'"],
    ['avatar_autopilot', 'TINYINT(1) NOT NULL DEFAULT 1'],               // Auto-Pilot also protects avatars
];

export async function up(db) {
    // ── blocked_images ──
    for (const [name, def] of IMAGE_COLUMNS) {
        if (!(await hasColumn(db, 'blocked_images', name))) {
            await db.execute(`ALTER TABLE blocked_images ADD COLUMN ${name} ${def}`);
        }
    }
    if (!(await hasIndex(db, 'blocked_images', 'uniq_guild_kind_hash'))) {
        await db.execute('ALTER TABLE blocked_images ADD UNIQUE KEY uniq_guild_kind_hash (guild_id, kind, dhash, exact_sha)');
    }
    if (await hasIndex(db, 'blocked_images', 'uniq_guild_hash')) {
        await db.execute('ALTER TABLE blocked_images DROP INDEX uniq_guild_hash');
    }
    if (!(await hasIndex(db, 'blocked_images', 'idx_guild_kind'))) {
        await db.execute('ALTER TABLE blocked_images ADD INDEX idx_guild_kind (guild_id, kind, removed_at)');
    }

    // ── name_filter_reviews ──
    if (await hasTable(db, 'name_filter_reviews')) {
        for (const [name, def] of REVIEW_COLUMNS) {
            if (!(await hasColumn(db, 'name_filter_reviews', name))) {
                await db.execute(`ALTER TABLE name_filter_reviews ADD COLUMN ${name} ${def}`);
            }
        }
        const pk = await primaryKeyColumns(db, 'name_filter_reviews');
        if (!pk.includes('kind')) {
            await db.execute('ALTER TABLE name_filter_reviews DROP PRIMARY KEY, ADD PRIMARY KEY (guild_id, user_id, kind)');
        }
        if (!(await hasIndex(db, 'name_filter_reviews', 'idx_guild_kind_status'))) {
            await db.execute('ALTER TABLE name_filter_reviews ADD INDEX idx_guild_kind_status (guild_id, kind, status, found_at)');
        }
    }

    // ── join_gate_config / join_gate_events ──
    for (const [name, def] of CONFIG_COLUMNS) {
        if (!(await hasColumn(db, 'join_gate_config', name))) {
            await db.execute(`ALTER TABLE join_gate_config ADD COLUMN ${name} ${def}`);
        }
    }
    await db.execute(`ALTER TABLE join_gate_events MODIFY action ${enumOf(EVENT_ACTIONS)} NOT NULL`);
}

export async function down(db) {
    await db.execute("DELETE FROM join_gate_events WHERE action LIKE 'avatar\\_%'");
    await db.execute(`ALTER TABLE join_gate_events MODIFY action ${enumOf(OLD_EVENT_ACTIONS)} NOT NULL`);
    for (const [name] of CONFIG_COLUMNS) {
        if (await hasColumn(db, 'join_gate_config', name)) await db.execute(`ALTER TABLE join_gate_config DROP COLUMN ${name}`);
    }

    if (await hasTable(db, 'name_filter_reviews')) {
        if (await hasColumn(db, 'name_filter_reviews', 'kind')) {
            await db.execute("DELETE FROM name_filter_reviews WHERE kind <> 'name'");
            if (await hasIndex(db, 'name_filter_reviews', 'idx_guild_kind_status')) {
                await db.execute('ALTER TABLE name_filter_reviews DROP INDEX idx_guild_kind_status');
            }
            await db.execute('ALTER TABLE name_filter_reviews DROP PRIMARY KEY, ADD PRIMARY KEY (guild_id, user_id)');
        }
        for (const [name] of REVIEW_COLUMNS) {
            if (await hasColumn(db, 'name_filter_reviews', name)) await db.execute(`ALTER TABLE name_filter_reviews DROP COLUMN ${name}`);
        }
    }

    if (await hasColumn(db, 'blocked_images', 'kind')) {
        await db.execute("DELETE FROM blocked_images WHERE kind <> 'message'");
    }
    if (!(await hasIndex(db, 'blocked_images', 'uniq_guild_hash'))) {
        await db.execute('ALTER TABLE blocked_images ADD UNIQUE KEY uniq_guild_hash (guild_id, dhash)');
    }
    for (const idx of ['uniq_guild_kind_hash', 'idx_guild_kind']) {
        if (await hasIndex(db, 'blocked_images', idx)) await db.execute(`ALTER TABLE blocked_images DROP INDEX ${idx}`);
    }
    for (const [name] of IMAGE_COLUMNS) {
        if (await hasColumn(db, 'blocked_images', name)) await db.execute(`ALTER TABLE blocked_images DROP COLUMN ${name}`);
    }
}
