// Greenhouse Tycoon (cfx v2): the schema. 27 tables, prefix `gh_` by default.
//
// This file is the one definition of the v2 tables. migrations/437_greenhouse_v2_schema.js calls
// createSchema(db, 'gh_'); the tests call it with a throwaway prefix (ghtest_<random>_) and drop the
// tables afterwards. A later change to a table needs its own idempotent migration AND an update here.
//
// The prefix is distinct from the old game's cfx_* tables (103 of them, several with the same base names:
// cfx_seasons, cfx_notifications, cfx_daily_claims), so v1 and v2 can sit side by side until phase 5.
//
// Conventions:
//   - Game clocks are BIGINT UNSIGNED milliseconds and their columns end in _ms (planted_at_ms). Audit
//     and retention timestamps are DATETIME(3) (created_at), which the retention sweeper understands.
//   - Money and item counts are BIGINT UNSIGNED, so the database refuses a negative balance even if code
//     were wrong; the ledger (store/ledger.js) refuses it first.
//   - Everything a player owns has account_id with ON DELETE CASCADE, so deleting an account (privacy)
//     removes it. Tables that must outlive an account link (identities, identity events, daily claims)
//     are cleaned by privacy/index.js explicitly.
//   - Retention (phase 5): the tables that grow without end are swept nightly by the bot's retention job from
//     data_retention_policy rows (config/retention.js); each swept column has an index.
//   - Static catalogues (base varieties, staff types, upgrade nodes, quests, achievements) live in
//     config/catalog.js, not in tables. Only hybrids bred by players are stored (gh_varieties).

export const DEFAULT_PREFIX = 'gh_';

// Logical names in creation order (parents before children). Drop runs in reverse.
export const TABLES = Object.freeze([
    'accounts', 'identities', 'identity_events', 'link_codes', 'sessions', 'ledger', 'inventory', 'varieties',
    'account_varieties', 'plots', 'breeding', 'account_upgrades', 'account_staff', 'account_quests',
    'account_achievements', 'account_stats', 'market_days', 'orders', 'seasons', 'season_standings',
    'challenges', 'notifications', 'daily_claims', 'config', 'job_runs',
    // phase 4
    'account_cosmetics', 'replants'
]);

// Tables that hold a player's data, keyed by account_id (used by privacy export and delete).
export const ACCOUNT_TABLES = Object.freeze([
    'identities', 'identity_events', 'link_codes', 'sessions', 'ledger', 'inventory', 'account_varieties', 'plots',
    'breeding', 'account_upgrades', 'account_staff', 'account_quests', 'account_achievements',
    'account_stats', 'orders', 'season_standings', 'notifications', 'daily_claims',
    'account_cosmetics', 'replants'
]);

const PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,23}_$/;

export function assertPrefix(prefix) {
    if (typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix)) throw new Error(`invalid table prefix "${prefix}"`);
    if (prefix.startsWith('cfx_')) throw new Error('the cfx_ prefix belongs to the old game');
    return prefix;
}

/** { accounts: 'gh_accounts', ... } for a prefix. */
export function tableNames(prefix = DEFAULT_PREFIX) {
    assertPrefix(prefix);
    return Object.freeze(Object.fromEntries(TABLES.map(name => [name, `${prefix}${name}`])));
}

const ENGINE = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

/** CREATE TABLE IF NOT EXISTS statements, in creation order. */
export function createStatements(prefix = DEFAULT_PREFIX) {
    const t = tableNames(prefix);
    const fk = (name) => `${prefix}fk_${name}`;
    const acc = (name) => `CONSTRAINT ${fk(name)} FOREIGN KEY (account_id) REFERENCES ${t.accounts} (id) ON DELETE CASCADE`;
    return [
        // One save. cash and xp only change through the ledger. state_version is bumped by every ledger
        // write so clients can poll with ?v= and get 304 when nothing changed. prestige counts Replants
        // (phase 4); review = 1 marks the shared Twitch review save (never ranked, no linking, reset nightly).
        `CREATE TABLE IF NOT EXISTS ${t.accounts} (
            id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            display_name    VARCHAR(64)     NOT NULL,
            name_changed_at DATETIME(3)     NULL,
            status          ENUM('active','suspended') NOT NULL DEFAULT 'active',
            cash            BIGINT UNSIGNED NOT NULL DEFAULT 0,
            xp              BIGINT UNSIGNED NOT NULL DEFAULT 0,
            level           SMALLINT UNSIGNED NOT NULL DEFAULT 1,
            prestige        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
            review          TINYINT(1)      NOT NULL DEFAULT 0,
            state_version   BIGINT UNSIGNED NOT NULL DEFAULT 0,
            tutorial_step   TINYINT UNSIGNED NOT NULL DEFAULT 0,
            settings        JSON NULL,
            created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
            last_seen_at    DATETIME(3) NULL,
            PRIMARY KEY (id),
            KEY idx_status (status),
            KEY idx_review_seen (review, last_seen_at),
            CONSTRAINT ${prefix}ck_acc_cash CHECK (cash <= 9000000000000000),
            CONSTRAINT ${prefix}ck_acc_level CHECK (level BETWEEN 1 AND 100)
        ) ${ENGINE}`,

        // A sign-in (Twitch, Twitch panel opaque id, Kick, Discord) attached to at most one account.
        // account_id is NULL after an unlink; the row (and its id) is kept so the abuse guards follow the
        // person, not the account: the starter kit is once per identity, the daily is once per identity.
        `CREATE TABLE IF NOT EXISTS ${t.identities} (
            id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            account_id          BIGINT UNSIGNED NULL,
            platform            ENUM('twitch','twitch_opaque','kick','discord','dev','review') NOT NULL,
            platform_user_id    VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            display_name        VARCHAR(64) NULL,
            created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            linked_at           DATETIME(3) NULL,
            unlinked_at         DATETIME(3) NULL,
            last_used_at        DATETIME(3) NULL,
            starter_granted_at  DATETIME(3) NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_platform_user (platform, platform_user_id),
            UNIQUE KEY uq_account_platform (account_id, platform),
            CONSTRAINT ${fk('ident_acc')} FOREIGN KEY (account_id) REFERENCES ${t.accounts} (id) ON DELETE SET NULL
        ) ${ENGINE}`,

        // Link history, used for the relink cooldown and the failed-code limit. No foreign keys: it must
        // survive unlinks. Removed with the account by privacy/index.js.
        `CREATE TABLE IF NOT EXISTS ${t.identity_events} (
            id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            identity_id  BIGINT UNSIGNED NOT NULL,
            account_id   BIGINT UNSIGNED NULL,
            event        ENUM('created','linked','unlinked','account_removed','code_created','code_failed') NOT NULL,
            detail       JSON NULL,
            created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (id),
            KEY idx_identity_time (identity_id, event, created_at),
            KEY idx_account (account_id),
            KEY idx_created (created_at)
        ) ${ENGINE}`,

        // One-time codes for linking a second sign-in to this account. Only a SHA-256 of the code is stored.
        `CREATE TABLE IF NOT EXISTS ${t.link_codes} (
            id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            account_id           BIGINT UNSIGNED NOT NULL,
            code_hash            CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            created_by_identity  BIGINT UNSIGNED NOT NULL,
            created_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            expires_at           DATETIME(3) NOT NULL,
            used_at              DATETIME(3) NULL,
            used_by_identity     BIGINT UNSIGNED NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_code (code_hash),
            KEY idx_account_active (account_id, used_at, expires_at),
            KEY idx_expires (expires_at),
            ${acc('linkcode_acc')}
        ) ${ENGINE}`,

        // Refresh tokens (phase 2). Only a SHA-256 of the token is stored. A refresh marks the row used and
        // issues the next token in the same family; presenting a used token again revokes the family.
        `CREATE TABLE IF NOT EXISTS ${t.sessions} (
            id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            account_id   BIGINT UNSIGNED NOT NULL,
            identity_id  BIGINT UNSIGNED NOT NULL,
            family       CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            token_hash   CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            created_at   DATETIME(3) NOT NULL,
            expires_at   DATETIME(3) NOT NULL,
            used_at      DATETIME(3) NULL,
            revoked_at   DATETIME(3) NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_token (token_hash),
            KEY idx_family (family),
            KEY idx_identity (identity_id),
            KEY idx_expires (expires_at),
            ${acc('session_acc')}
        ) ${ENGINE}`,

        // Every cash and item change. UNIQUE (account_id, idempotency_key) makes a retried request a
        // no-op; request_hash detects a key reused for a different change.
        `CREATE TABLE IF NOT EXISTS ${t.ledger} (
            id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            account_id       BIGINT UNSIGNED NOT NULL,
            idempotency_key  VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            reason           VARCHAR(32) NOT NULL,
            ref              VARCHAR(64) NULL,
            cash_delta       BIGINT NOT NULL DEFAULT 0,
            cash_after       BIGINT UNSIGNED NOT NULL,
            item_lines       JSON NULL,
            request_hash     CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (id),
            UNIQUE KEY uq_account_key (account_id, idempotency_key),
            KEY idx_account_time (account_id, created_at),
            KEY idx_reason_time (reason, created_at),
            KEY idx_created (created_at),
            ${acc('ledger_acc')}
        ) ${ENGINE}`,

        // Items: seeds and produce of a variety (item_id = variety id) and boosts. quality 0..3 (produce).
        `CREATE TABLE IF NOT EXISTS ${t.inventory} (
            account_id  BIGINT UNSIGNED NOT NULL,
            kind        ENUM('seed','produce','boost') NOT NULL,
            item_id     INT UNSIGNED NOT NULL,
            quality     TINYINT UNSIGNED NOT NULL DEFAULT 0,
            quantity    BIGINT UNSIGNED NOT NULL,
            updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
            PRIMARY KEY (account_id, kind, item_id, quality),
            CONSTRAINT ${prefix}ck_inv_quality CHECK (quality <= 3),
            CONSTRAINT ${prefix}ck_inv_qty CHECK (quantity <= 1000000000000),
            ${acc('inv_acc')}
        ) ${ENGINE}`,

        // Hybrids bred by players. Base varieties (ids 1..999) are in config/catalog.js; hybrids start at
        // 1000. A pair of parents always makes the same hybrid (domain/breeding.js), stored once.
        `CREATE TABLE IF NOT EXISTS ${t.varieties} (
            id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
            parent_a            INT UNSIGNED NOT NULL,
            parent_b            INT UNSIGNED NOT NULL,
            name                VARCHAR(120) NOT NULL,
            rarity              TINYINT UNSIGNED NOT NULL,
            grow_ms             INT UNSIGNED NOT NULL,
            base_yield          SMALLINT UNSIGNED NOT NULL,
            base_price          INT UNSIGNED NOT NULL,
            first_bred_by       BIGINT UNSIGNED NULL,
            created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (id),
            UNIQUE KEY uq_parents (parent_a, parent_b),
            CONSTRAINT ${prefix}ck_var_order CHECK (parent_a < parent_b),
            CONSTRAINT ${fk('var_acc')} FOREIGN KEY (first_bred_by) REFERENCES ${t.accounts} (id) ON DELETE SET NULL
        ) ${ENGINE} AUTO_INCREMENT=1000`,

        // Which varieties an account has discovered (the collection).
        `CREATE TABLE IF NOT EXISTS ${t.account_varieties} (
            account_id     BIGINT UNSIGNED NOT NULL,
            variety_id     INT UNSIGNED NOT NULL,
            discovered_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            harvested      BIGINT UNSIGNED NOT NULL DEFAULT 0,
            PRIMARY KEY (account_id, variety_id),
            ${acc('accvar_acc')}
        ) ${ENGINE}`,

        // Grow plots. Growth is computed from planted_at_ms/ready_at_ms when read (domain/growth.js).
        // plant_seq counts plantings in this slot; harvest keys use it (harvest:<slot>:<seq>).
        // watered_at_ms belongs to the planting (cleared when the plot is planted or cleared), so watering
        // has no cooldown that could get stuck.
        `CREATE TABLE IF NOT EXISTS ${t.plots} (
            account_id     BIGINT UNSIGNED NOT NULL,
            slot           TINYINT UNSIGNED NOT NULL,
            variety_id     INT UNSIGNED NULL,
            planted_at_ms  BIGINT UNSIGNED NULL,
            ready_at_ms    BIGINT UNSIGNED NULL,
            quality_roll   SMALLINT UNSIGNED NULL,
            watered_at_ms  BIGINT UNSIGNED NULL,
            plant_seq      INT UNSIGNED NOT NULL DEFAULT 0,
            PRIMARY KEY (account_id, slot),
            CONSTRAINT ${prefix}ck_plot_slot CHECK (slot BETWEEN 1 AND 24),
            ${acc('plot_acc')}
        ) ${ENGINE}`,

        `CREATE TABLE IF NOT EXISTS ${t.breeding} (
            id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            account_id         BIGINT UNSIGNED NOT NULL,
            parent_a           INT UNSIGNED NOT NULL,
            parent_b           INT UNSIGNED NOT NULL,
            started_at_ms      BIGINT UNSIGNED NOT NULL,
            ready_at_ms        BIGINT UNSIGNED NOT NULL,
            result_variety_id  INT UNSIGNED NULL,
            status             ENUM('active','claimed','cancelled') NOT NULL DEFAULT 'active',
            claimed_at         DATETIME(3) NULL,
            created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (id),
            KEY idx_account_status (account_id, status),
            KEY idx_claimed (claimed_at),
            ${acc('breed_acc')}
        ) ${ENGINE}`,

        // Levels owned in the one upgrade tree (node codes from config/catalog.js).
        `CREATE TABLE IF NOT EXISTS ${t.account_upgrades} (
            account_id  BIGINT UNSIGNED NOT NULL,
            node_code   VARCHAR(32) NOT NULL,
            level       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
            updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
            PRIMARY KEY (account_id, node_code),
            ${acc('upg_acc')}
        ) ${ENGINE}`,

        // Hired staff per type; last_claim_at_ms is the offline clock (domain/staff.js, 12 h cap).
        `CREATE TABLE IF NOT EXISTS ${t.account_staff} (
            account_id        BIGINT UNSIGNED NOT NULL,
            staff_code        VARCHAR(32) NOT NULL,
            count             SMALLINT UNSIGNED NOT NULL DEFAULT 0,
            last_claim_at_ms  BIGINT UNSIGNED NOT NULL,
            hired_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (account_id, staff_code),
            ${acc('staff_acc')}
        ) ${ENGINE}`,

        // Quest progress per period: period_key d2026-11-18 (daily), w2026-47 (weekly), c<challenge id>.
        // Target and reward are fixed when the period's quests are made (domain/meta.js questsFor).
        // created_at (phase 5) is what the retention sweep reads (config/retention.js, 90 days).
        `CREATE TABLE IF NOT EXISTS ${t.account_quests} (
            account_id    BIGINT UNSIGNED NOT NULL,
            quest_code    VARCHAR(32) NOT NULL,
            period_key    VARCHAR(16) NOT NULL,
            progress      INT UNSIGNED NOT NULL DEFAULT 0,
            target        INT UNSIGNED NOT NULL,
            reward_cash   INT UNSIGNED NOT NULL DEFAULT 0,
            reward_xp     INT UNSIGNED NOT NULL DEFAULT 0,
            completed_at  DATETIME(3) NULL,
            claimed_at    DATETIME(3) NULL,
            created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (account_id, quest_code, period_key),
            KEY idx_period (period_key),
            KEY idx_created (created_at),
            ${acc('quest_acc')}
        ) ${ENGINE}`,

        `CREATE TABLE IF NOT EXISTS ${t.account_achievements} (
            account_id        BIGINT UNSIGNED NOT NULL,
            achievement_code  VARCHAR(32) NOT NULL,
            unlocked_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            claimed_at        DATETIME(3) NULL,
            PRIMARY KEY (account_id, achievement_code),
            ${acc('ach_acc')}
        ) ${ENGINE}`,

        // Lifetime counters (achievements, profile, the all-time leaderboard on xp_earned). A Replant does not
        // reset them. Season scores are in season_standings.
        `CREATE TABLE IF NOT EXISTS ${t.account_stats} (
            account_id      BIGINT UNSIGNED NOT NULL,
            harvests        BIGINT UNSIGNED NOT NULL DEFAULT 0,
            units_sold      BIGINT UNSIGNED NOT NULL DEFAULT 0,
            cash_earned     BIGINT UNSIGNED NOT NULL DEFAULT 0,
            orders_filled   INT UNSIGNED NOT NULL DEFAULT 0,
            hybrids_bred    INT UNSIGNED NOT NULL DEFAULT 0,
            staff_claims    INT UNSIGNED NOT NULL DEFAULT 0,
            xp_earned       BIGINT UNSIGNED NOT NULL DEFAULT 0,
            best_level      SMALLINT UNSIGNED NOT NULL DEFAULT 1,
            best_streak     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
            quests_claimed  INT UNSIGNED NOT NULL DEFAULT 0,
            challenges_completed INT UNSIGNED NOT NULL DEFAULT 0,
            PRIMARY KEY (account_id),
            KEY idx_xp_earned (xp_earned),
            ${acc('stats_acc')}
        ) ${ENGINE}`,

        // NPC demand per variety per day (one row a day, not every 5 minutes).
        `CREATE TABLE IF NOT EXISTS ${t.market_days} (
            variety_id  INT UNSIGNED NOT NULL,
            day         DATE NOT NULL,
            demand_pct  SMALLINT UNSIGNED NOT NULL DEFAULT 100,
            units_sold  BIGINT UNSIGNED NOT NULL DEFAULT 0,
            PRIMARY KEY (variety_id, day),
            KEY idx_day (day)
        ) ${ENGINE}`,

        // NPC orders ("deliver 12 Fine Frostbell by Friday"). No player-to-player market in v1.
        `CREATE TABLE IF NOT EXISTS ${t.orders} (
            id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            account_id     BIGINT UNSIGNED NOT NULL,
            variety_id     INT UNSIGNED NOT NULL,
            min_quality    TINYINT UNSIGNED NOT NULL DEFAULT 0,
            quantity       INT UNSIGNED NOT NULL,
            reward_cash    INT UNSIGNED NOT NULL,
            reward_xp      INT UNSIGNED NOT NULL DEFAULT 0,
            status         ENUM('open','filled','expired','declined') NOT NULL DEFAULT 'open',
            offered_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            expires_at_ms  BIGINT UNSIGNED NOT NULL,
            filled_at      DATETIME(3) NULL,
            PRIMARY KEY (id),
            KEY idx_account_status (account_id, status),
            KEY idx_offered (offered_at),
            CONSTRAINT ${prefix}ck_order_qty CHECK (quantity >= 1),
            ${acc('order_acc')}
        ) ${ENGINE}`,

        // 30-day seasons; rewards are cosmetic or badge-weighted (reward_config). 'closing' = ranked, rewards
        // being paid (store/meta.js rollover, resumable); ranked = how many standings got a rank.
        `CREATE TABLE IF NOT EXISTS ${t.seasons} (
            id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
            number         INT UNSIGNED NOT NULL,
            starts_at      DATETIME(3) NOT NULL,
            ends_at        DATETIME(3) NOT NULL,
            status         ENUM('upcoming','active','closing','closed') NOT NULL DEFAULT 'upcoming',
            ranked         INT UNSIGNED NULL,
            reward_config  JSON NULL,
            closed_at      DATETIME(3) NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_number (number),
            KEY idx_status (status)
        ) ${ENGINE}`,

        // Season score, capped per day (domain/season-score.js).
        `CREATE TABLE IF NOT EXISTS ${t.season_standings} (
            season_id          INT UNSIGNED NOT NULL,
            account_id         BIGINT UNSIGNED NOT NULL,
            score              BIGINT UNSIGNED NOT NULL DEFAULT 0,
            score_day          DATE NULL,
            score_today        INT UNSIGNED NOT NULL DEFAULT 0,
            final_rank         INT UNSIGNED NULL,
            reward_claimed_at  DATETIME(3) NULL,
            PRIMARY KEY (season_id, account_id),
            KEY idx_season_score (season_id, score),
            CONSTRAINT ${fk('stand_season')} FOREIGN KEY (season_id) REFERENCES ${t.seasons} (id) ON DELETE CASCADE,
            ${acc('stand_acc')}
        ) ${ENGINE}`,

        // Weekly challenges inside a season (replace tournaments); skipped below min_active_players (counted
        // when the week starts, stored in active_players). Progress is kept in account_quests with period_key
        // c<id>; finishing pays at once, the first three finishers get a bonus when the week closes.
        `CREATE TABLE IF NOT EXISTS ${t.challenges} (
            id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
            season_id           INT UNSIGNED NOT NULL,
            week                TINYINT UNSIGNED NOT NULL,
            quest_code          VARCHAR(32) NOT NULL,
            starts_at           DATETIME(3) NOT NULL,
            ends_at             DATETIME(3) NOT NULL,
            min_active_players  SMALLINT UNSIGNED NOT NULL DEFAULT 3,
            active_players      INT UNSIGNED NULL,
            target              INT UNSIGNED NOT NULL DEFAULT 1,
            status              ENUM('scheduled','active','skipped','closed') NOT NULL DEFAULT 'scheduled',
            podium_paid_at      DATETIME(3) NULL,
            PRIMARY KEY (id),
            UNIQUE KEY uq_season_week (season_id, week),
            CONSTRAINT ${fk('chal_season')} FOREIGN KEY (season_id) REFERENCES ${t.seasons} (id) ON DELETE CASCADE
        ) ${ENGINE}`,

        `CREATE TABLE IF NOT EXISTS ${t.notifications} (
            id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            account_id  BIGINT UNSIGNED NOT NULL,
            kind        VARCHAR(32) NOT NULL,
            payload     JSON NULL,
            created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            read_at     DATETIME(3) NULL,
            PRIMARY KEY (id),
            KEY idx_account_unread (account_id, read_at),
            KEY idx_created (created_at),
            ${acc('notif_acc')}
        ) ${ENGINE}`,

        // One daily reward per account per day AND per identity per day, shared by web, panel and Discord.
        // identity_id has no foreign key on purpose: it must keep blocking a second claim after a relink.
        `CREATE TABLE IF NOT EXISTS ${t.daily_claims} (
            account_id   BIGINT UNSIGNED NOT NULL,
            day          DATE NOT NULL,
            identity_id  BIGINT UNSIGNED NOT NULL,
            streak       SMALLINT UNSIGNED NOT NULL DEFAULT 1,
            ledger_id    BIGINT UNSIGNED NULL,
            created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (account_id, day),
            UNIQUE KEY uq_identity_day (identity_id, day),
            KEY idx_created (created_at),
            ${acc('daily_acc')}
        ) ${ENGINE}`,

        // Cosmetics an account owns (phase 4): decorations (bought with cash, or season rewards) and badges
        // (season tiers, some achievements). A Replant keeps them. placed = shown in the greenhouse.
        `CREATE TABLE IF NOT EXISTS ${t.account_cosmetics} (
            account_id   BIGINT UNSIGNED NOT NULL,
            kind         ENUM('decoration','badge') NOT NULL,
            code         VARCHAR(48) NOT NULL,
            source       VARCHAR(32) NOT NULL,
            placed       TINYINT(1) NOT NULL DEFAULT 0,
            acquired_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (account_id, kind, code),
            ${acc('cosm_acc')}
        ) ${ENGINE}`,

        // Replant history (phase 4): one row per Replant, what the save looked like before it.
        `CREATE TABLE IF NOT EXISTS ${t.replants} (
            account_id     BIGINT UNSIGNED NOT NULL,
            number         SMALLINT UNSIGNED NOT NULL,
            level_before   SMALLINT UNSIGNED NOT NULL,
            xp_before      BIGINT UNSIGNED NOT NULL,
            cash_before    BIGINT UNSIGNED NOT NULL,
            upgrade_levels SMALLINT UNSIGNED NOT NULL,
            created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (account_id, number),
            ${acc('replant_acc')}
        ) ${ENGINE}`,

        // Runtime switches read without a restart, e.g. name='jobs.disabled' value=true or ["job-name"].
        `CREATE TABLE IF NOT EXISTS ${t.config} (
            name        VARCHAR(64) NOT NULL,
            value       JSON NULL,
            updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
            updated_by  VARCHAR(64) NULL,
            PRIMARY KEY (name)
        ) ${ENGINE}`,

        // Last run of each scheduled job (jobs/scheduler.js).
        `CREATE TABLE IF NOT EXISTS ${t.job_runs} (
            name              VARCHAR(64) NOT NULL,
            last_started_at   DATETIME(3) NULL,
            last_finished_at  DATETIME(3) NULL,
            last_status       ENUM('ok','error','timeout','skipped') NULL,
            last_duration_ms  INT UNSIGNED NULL,
            last_error        VARCHAR(255) NULL,
            runs              BIGINT UNSIGNED NOT NULL DEFAULT 0,
            failures          BIGINT UNSIGNED NOT NULL DEFAULT 0,
            skips             BIGINT UNSIGNED NOT NULL DEFAULT 0,
            PRIMARY KEY (name)
        ) ${ENGINE}`
    ];
}

/** Create every table (idempotent). `db` is a mysql2 pool or connection. */
export async function createSchema(db, prefix = DEFAULT_PREFIX) {
    for (const sql of createStatements(prefix)) await db.query(sql);
}

/** Drop every table for a prefix, children first. */
export async function dropSchema(db, prefix = DEFAULT_PREFIX) {
    const t = tableNames(prefix);
    for (const name of [...TABLES].reverse()) await db.query(`DROP TABLE IF EXISTS ${t[name]}`);
}

/** Names of the tables that exist for a prefix (for checks and cleanup). */
export async function existingTables(db, prefix = DEFAULT_PREFIX) {
    assertPrefix(prefix);
    const like = prefix.replace(/_/g, '\\_') + '%';
    const [rows] = await db.query(
        'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE ?',
        [like]);
    return rows.map(r => r.name).sort();
}
