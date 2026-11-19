/*
 * Migration 328: CAPTCHA verification, the setup wizard and auto-prune (core/verification.js,
 * core/auto-prune.js; rules in core/verification-logic.js and core/auto-prune-logic.js).
 *
 * Nothing new is created. Three existing tables grow and one dead config is folded into the live one:
 *
 *   verify_config         THE verification config (the "I agree" gate every live server uses). Gains the
 *                         CAPTCHA mode and its rules, an optional custom panel text, and the setup wizard's
 *                         record of every permission it changed (so "undo" can put each one back):
 *                           mode                    'button' (the existing "I agree" click, every existing row)
 *                                                   | 'captcha' (image code + keypad)
 *                           captcha_attempts        wrong answers allowed (3)
 *                           captcha_window_minutes  minutes from joining to finish (5; 0 = no limit)
 *                           fail_action             'none' (log only) | 'timeout' | 'kick' | 'ban'
 *                           fail_timeout_minutes, fail_dm, panel_title, panel_text
 *                           wizard_snapshot         JSON: what the wizard created and every overwrite it changed
 *                           wizard_at
 *                         unverified_kick_days was added at runtime by the old jobs/unverified-reaper.js; it
 *                         is ensured here so the schema no longer depends on a job having started.
 *   join_gate_config      prune_* settings (auto-prune: kick anyone who has no real role N minutes after
 *                         joining). Off for every server. Its verification columns (is_enabled,
 *                         verification_enabled / _role_id / _channel_id) were a SECOND verification config that
 *                         nothing enforced: the Security page and `/admin verification setup` wrote them, no
 *                         join handler read them, and the button that command posted (`verify_member`) had no
 *                         handler. Their rows are copied into verify_config below and the code now reads and
 *                         writes verify_config only. The columns stay (unused) so a rollback still works.
 *   temp_access_members   the queue of members on a deadline. It held temporary-access trials only; it now
 *                         also holds auto-prune and CAPTCHA-window deadlines, told apart by `kind`
 *                         ('trial' = every existing row | 'prune' | 'verify'), so one reaper
 *                         (jobs/temp-access-reaper.js) sweeps them all. `attempts` counts wrong CAPTCHA
 *                         answers (kept in the DB so a restart does not hand out fresh tries); expires_at
 *                         may be NULL (a CAPTCHA with no time limit); the one-row-per-member key becomes
 *                         one row per member per kind; status gains 'failed' / 'expired'; source gains 'join'.
 *   join_gate_events      action enum gains the verification and auto-prune outcomes (stats + recent attempts).
 *
 * Copying the dead join_gate_config rows turns verification "on" in verify_config for the servers whose
 * Security page already showed it as Active. That changes nothing on join for them (no unverified role
 * is set, mode stays 'button', no deadline) — it only makes the dashboard tell the truth and gives the
 * `/admin verification setup` panels a working button.
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

/** The values of an ENUM column, in order ('' when the column is missing). */
async function enumValues(db, table, column) {
    const [rows] = await db.execute(
        'SELECT COLUMN_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    const type = String(rows[0]?.t ?? '');
    return [...type.matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1].replace(/''/g, "'"));
}

export const enumOf = (values) => `ENUM(${values.map(v => `'${v}'`).join(',')})`;

/** Current values first (other waves extend these enums too), then ours, without duplicates. */
export function mergeEnum(current, add) {
    return [...current, ...add.filter(v => !current.includes(v))];
}

export const VERIFY_COLUMNS = [
    ['mode', "VARCHAR(10) NOT NULL DEFAULT 'button'"],
    ['captcha_attempts', 'INT NOT NULL DEFAULT 3'],
    ['captcha_window_minutes', 'INT NOT NULL DEFAULT 5'],
    ['fail_action', "VARCHAR(10) NOT NULL DEFAULT 'kick'"],
    ['fail_timeout_minutes', 'INT NOT NULL DEFAULT 60'],
    ['fail_dm', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['panel_title', 'VARCHAR(100) NULL'],
    ['panel_text', 'VARCHAR(1000) NULL'],
    ['wizard_snapshot', 'MEDIUMTEXT NULL'],
    ['wizard_at', 'DATETIME NULL'],
    ['unverified_kick_days', 'INT NOT NULL DEFAULT 0'],
];

export const PRUNE_COLUMNS = [
    ['prune_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['prune_minutes', 'INT NOT NULL DEFAULT 240'],
    ['prune_action', "VARCHAR(10) NOT NULL DEFAULT 'kick'"],
    ['prune_dm', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['prune_bypass_roles', 'TEXT NULL'],
    ['prune_enabled_at', 'DATETIME NULL'],
];

export const EVENT_ACTIONS_ADDED = [
    'verify_passed', 'verify_wrong', 'verify_failed', 'verify_expired',
    'verify_kicked', 'verify_banned', 'verify_timedout', 'verify_held',
    'prune_kicked', 'prune_logged', 'prune_held',
];
export const STATUS_ADDED = ['failed', 'expired'];
export const SOURCE_ADDED = ['join'];

export async function up(db) {
    // ── verify_config ──
    for (const [name, def] of VERIFY_COLUMNS) {
        if (!(await hasColumn(db, 'verify_config', name))) {
            await db.execute(`ALTER TABLE verify_config ADD COLUMN ${name} ${def}`);
        }
    }

    // ── join_gate_config: auto-prune settings ──
    for (const [name, def] of PRUNE_COLUMNS) {
        if (!(await hasColumn(db, 'join_gate_config', name))) {
            await db.execute(`ALTER TABLE join_gate_config ADD COLUMN ${name} ${def}`);
        }
    }

    // ── fold the dead join_gate_config verification into verify_config ──
    // Only rows with a role can be copied (verified_role_id is NOT NULL); an existing verify_config row
    // always wins, it is the one that has been enforced. Collations differ between the two tables'
    // generations, hence the explicit COLLATE on the join.
    if (await hasColumn(db, 'join_gate_config', 'verification_role_id')) {
        await db.execute(
            `INSERT IGNORE INTO verify_config (guild_id, verified_role_id, gate_channel_id, enabled)
             SELECT j.guild_id, j.verification_role_id, j.verification_channel_id, 1
               FROM join_gate_config j
              WHERE (j.is_enabled = 1 OR j.verification_enabled = 1)
                AND j.verification_role_id IS NOT NULL AND j.verification_role_id <> ''
                AND CHAR_LENGTH(j.guild_id) <= 20 AND CHAR_LENGTH(j.verification_role_id) <= 20
                AND (j.verification_channel_id IS NULL OR CHAR_LENGTH(j.verification_channel_id) <= 20)`);
        await db.execute(
            `UPDATE verify_config v
               JOIN join_gate_config j ON j.guild_id COLLATE utf8mb4_unicode_ci = v.guild_id COLLATE utf8mb4_unicode_ci
                SET v.gate_channel_id = j.verification_channel_id
              WHERE v.gate_channel_id IS NULL AND j.verification_channel_id IS NOT NULL
                AND CHAR_LENGTH(j.verification_channel_id) <= 20`);
    }

    // ── temp_access_members: the deadline queue ──
    if (await hasTable(db, 'temp_access_members')) {
        if (!(await hasColumn(db, 'temp_access_members', 'kind'))) {
            await db.execute(
                "ALTER TABLE temp_access_members ADD COLUMN kind ENUM('trial','prune','verify') NOT NULL DEFAULT 'trial' AFTER user_id");
        }
        if (!(await hasColumn(db, 'temp_access_members', 'attempts'))) {
            await db.execute('ALTER TABLE temp_access_members ADD COLUMN attempts INT NOT NULL DEFAULT 0');
        }
        // NULL = no deadline (a CAPTCHA without a time limit). The reaper's `expires_at <= NOW()` skips it.
        await db.execute('ALTER TABLE temp_access_members MODIFY expires_at TIMESTAMP NULL DEFAULT NULL');
        const status = await enumValues(db, 'temp_access_members', 'status');
        await db.execute(`ALTER TABLE temp_access_members MODIFY status ${enumOf(mergeEnum(status, STATUS_ADDED))} NOT NULL DEFAULT 'pending'`);
        const source = await enumValues(db, 'temp_access_members', 'source');
        await db.execute(`ALTER TABLE temp_access_members MODIFY source ${enumOf(mergeEnum(source, SOURCE_ADDED))} NOT NULL DEFAULT 'invite'`);
        // One live row per member PER KIND: a guest on trial can also be on the auto-prune clock.
        if (!(await hasIndex(db, 'temp_access_members', 'uniq_guild_user_kind'))) {
            const drop = (await hasIndex(db, 'temp_access_members', 'uniq_guild_user')) ? 'DROP INDEX uniq_guild_user, ' : '';
            await db.execute(`ALTER TABLE temp_access_members ${drop}ADD UNIQUE KEY uniq_guild_user_kind (guild_id, user_id, kind)`);
        }
        if (!(await hasIndex(db, 'temp_access_members', 'idx_guild_kind_status'))) {
            await db.execute('ALTER TABLE temp_access_members ADD INDEX idx_guild_kind_status (guild_id, kind, status)');
        }
    }

    // ── join_gate_events ──
    const actions = await enumValues(db, 'join_gate_events', 'action');
    if (actions.length) {
        await db.execute(`ALTER TABLE join_gate_events MODIFY action ${enumOf(mergeEnum(actions, EVENT_ACTIONS_ADDED))} NOT NULL`);
    }
}

export async function down(db) {
    await db.execute("DELETE FROM join_gate_events WHERE action LIKE 'verify\\_%' OR action LIKE 'prune\\_%'");
    const actions = await enumValues(db, 'join_gate_events', 'action');
    if (actions.length) {
        await db.execute(`ALTER TABLE join_gate_events MODIFY action ${enumOf(actions.filter(a => !EVENT_ACTIONS_ADDED.includes(a)))} NOT NULL`);
    }

    if (await hasTable(db, 'temp_access_members')) {
        if (await hasColumn(db, 'temp_access_members', 'kind')) {
            await db.execute("DELETE FROM temp_access_members WHERE kind <> 'trial'");
            if (await hasIndex(db, 'temp_access_members', 'idx_guild_kind_status')) {
                await db.execute('ALTER TABLE temp_access_members DROP INDEX idx_guild_kind_status');
            }
            if (await hasIndex(db, 'temp_access_members', 'uniq_guild_user_kind')) {
                await db.execute('ALTER TABLE temp_access_members DROP INDEX uniq_guild_user_kind, ADD UNIQUE KEY uniq_guild_user (guild_id, user_id)');
            }
            await db.execute('ALTER TABLE temp_access_members DROP COLUMN kind');
        }
        if (await hasColumn(db, 'temp_access_members', 'attempts')) {
            await db.execute('ALTER TABLE temp_access_members DROP COLUMN attempts');
        }
        await db.execute("UPDATE temp_access_members SET status = 'cancelled' WHERE status IN ('failed','expired')");
        const status = await enumValues(db, 'temp_access_members', 'status');
        await db.execute(`ALTER TABLE temp_access_members MODIFY status ${enumOf(status.filter(s => !STATUS_ADDED.includes(s)))} NOT NULL DEFAULT 'pending'`);
        await db.execute("UPDATE temp_access_members SET source = 'manual' WHERE source = 'join'");
        const source = await enumValues(db, 'temp_access_members', 'source');
        await db.execute(`ALTER TABLE temp_access_members MODIFY source ${enumOf(source.filter(s => !SOURCE_ADDED.includes(s)))} NOT NULL DEFAULT 'invite'`);
        await db.execute('UPDATE temp_access_members SET expires_at = COALESCE(expires_at, started_at)');
        await db.execute('ALTER TABLE temp_access_members MODIFY expires_at TIMESTAMP NOT NULL');
    }

    for (const [name] of PRUNE_COLUMNS) {
        if (await hasColumn(db, 'join_gate_config', name)) await db.execute(`ALTER TABLE join_gate_config DROP COLUMN ${name}`);
    }
    // unverified_kick_days predates this migration (runtime-added); it stays.
    for (const [name] of VERIFY_COLUMNS) {
        if (name === 'unverified_kick_days') continue;
        if (await hasColumn(db, 'verify_config', name)) await db.execute(`ALTER TABLE verify_config DROP COLUMN ${name}`);
    }
    // The rows copied from join_gate_config into verify_config are left: they are indistinguishable from
    // rows made since, and harmless to the old code (it reads verify_config the same way).
}

export default { up, down };
