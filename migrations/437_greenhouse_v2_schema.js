/**
 * Migration 437 — Greenhouse Tycoon (cfx v2) schema, phase 1 of the game rewrite
 * (docs/cfx-overhaul-audit.md B2, B8 row 1, owner decisions in B12).
 *
 * Creates the 27 v2 tables with the prefix gh_ (the old game keeps its 103 cfx_* tables untouched until
 * phase 5 archives them; several old and new tables would otherwise share names, e.g. cfx_seasons):
 *
 *   gh_accounts, gh_identities, gh_identity_events, gh_link_codes, gh_sessions, gh_ledger, gh_inventory,
 *   gh_varieties, gh_account_varieties, gh_plots, gh_breeding, gh_account_upgrades, gh_account_staff,
 *   gh_account_quests, gh_account_achievements, gh_account_stats, gh_market_days, gh_orders,
 *   gh_seasons, gh_season_standings, gh_challenges, gh_notifications, gh_daily_claims, gh_config,
 *   gh_job_runs, gh_account_cosmetics, gh_replants
 *
 * The definitions live in services/cfx/store/schema.js (the service and its tests use the same file).
 * No rows are inserted: static catalogues are in services/cfx/config/catalog.js and every account starts
 * fresh (owner decision 2026-11-18: no converter from the old game).
 *
 * Retention (phase 5): up() also inserts the gh_ rows of data_retention_policy from
 * services/cfx/config/retention.js (ledger 180 days, notifications 30, link history and daily claims 180, quest
 * progress 90, collected crosses 180, market days 400, and backstops for orders, sessions and link codes);
 * jobs/retention-sweeper.js enforces them nightly. gh_account_quests.created_at was added for this, before the
 * migration was ever applied.
 *
 * Phase 2 (still before this migration was ever applied) added gh_sessions (refresh tokens) and
 * gh_plots.watered_at_ms. If an earlier copy of this migration was applied anywhere, those two need an
 * ALTER first; it has not been applied to production.
 *
 * Phase 4 (also before this migration was ever applied) added gh_account_cosmetics, gh_replants,
 * gh_accounts.review (+ index on review, last_seen_at), gh_identities.platform 'review', gh_account_stats
 * xp_earned/best_level/best_streak/quests_claimed/challenges_completed (+ index on xp_earned),
 * gh_account_quests reward_cash/reward_xp, gh_seasons status 'closing' and ranked, gh_challenges
 * active_players/target/podium_paid_at. Production had no gh_ table when this was written (checked 2026-11-18).
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS. down() drops the 27 tables (and their data).
 */
import { createSchema, dropSchema } from '../services/cfx/store/schema.js';
import { RETENTION, retentionPolicyRows } from '../services/cfx/config/retention.js';

const PREFIX = 'gh_';

export async function up(db) {
    await createSchema(db, PREFIX);
    await db.query(
        'INSERT IGNORE INTO data_retention_policy (table_name, timestamp_column, retain_days, enabled, notes) VALUES ?',
        [retentionPolicyRows(PREFIX)]);
}

export async function down(db) {
    await db.query('DELETE FROM data_retention_policy WHERE table_name IN (?)', [RETENTION.map(r => `${PREFIX}${r.table}`)]);
    await dropSchema(db, PREFIX);
}
