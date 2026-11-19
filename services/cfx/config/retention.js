// Greenhouse Tycoon (cfx v2), phase 5: how long rows are kept in the tables that would otherwise grow without end.
//
// These become rows of data_retention_policy, the site's one table of retention windows (migration 182). Migration
// 437 inserts them when it creates the gh_ tables; jobs/retention-sweeper.js in the bot deletes rows older than the
// window every night at 04:20, in batches. The game's own jobs (services/cfx/jobs) also sweep notifications, closed
// orders, expired sessions and link codes; the rows below for those are a backstop for when the game's jobs are
// switched off, so the windows here are the ones that apply.
//
// Every v2 table is either listed in RETENTION or in BOUNDED with the reason it stays small;
// tests/cfx/v2/retention.test.js fails if a new table is in neither.
import { DAY_MS } from './game.js';

/**
 * The ledger keeps 180 days. Why that long and not longer:
 *   - Nothing that ranks or pays reads old ledger rows. Seasons rank on season_standings and the all-time board on
 *     account_stats. The season payout and the weekly challenge podium use ledger keys only as a guard while they
 *     run (minutes to hours after a season or week ends; a stuck run is resumed by the next hourly job).
 *   - Replays of a player's request (double clicks, retries) need the row for minutes.
 *   - 180 days is six full 30-day seasons: enough to look into a reward dispute or an exploit from a past season
 *     and the next, which is the only reason to read old detail.
 *   - Lifetime totals players see come from account_stats, which is kept with the save.
 * The one rule that read ledger history forever is the "fresh save" check used when linking a sign-in (a save with
 * nothing but the starter kit may be absorbed). It now also treats any save older than this window as not fresh
 * (store/accounts.js isFresh), so a swept ledger can never make a real save look empty.
 */
export const LEDGER_RETENTION_DAYS = 180;
export const LEDGER_RETENTION_MS = LEDGER_RETENTION_DAYS * DAY_MS;

export const RETENTION = Object.freeze([
    { table: 'ledger', column: 'created_at', days: LEDGER_RETENTION_DAYS,
        notes: 'Greenhouse Tycoon: every cash and item change. Six seasons of detail; totals live in gh_account_stats.' },
    { table: 'notifications', column: 'created_at', days: 30,
        notes: 'Greenhouse Tycoon: in-game notifications. The game also sweeps them every 6 hours.' },
    { table: 'identity_events', column: 'created_at', days: 180,
        notes: 'Greenhouse Tycoon: sign-in link history. The rules read the last 7 days at most.' },
    { table: 'daily_claims', column: 'created_at', days: 180,
        notes: 'Greenhouse Tycoon: daily reward claims. The rules read today and yesterday.' },
    { table: 'account_quests', column: 'created_at', days: 90,
        notes: 'Greenhouse Tycoon: quest and weekly challenge progress. Collectable for one period after it ends.' },
    { table: 'breeding', column: 'claimed_at', days: 180,
        notes: 'Greenhouse Tycoon: collected crosses. Open crosses (claimed_at NULL) are never swept.' },
    { table: 'market_days', column: 'day', days: 400,
        notes: 'Greenhouse Tycoon: daily demand per plant (no player data). The game shows the last 30 days.' },
    { table: 'orders', column: 'offered_at', days: 60,
        notes: 'Greenhouse Tycoon: NPC orders. Backstop; the game deletes closed orders after 30 days.' },
    { table: 'sessions', column: 'expires_at', days: 1,
        notes: 'Greenhouse Tycoon: refresh tokens (hashes). Backstop; the game removes expired ones every 6 hours.' },
    { table: 'link_codes', column: 'expires_at', days: 1,
        notes: 'Greenhouse Tycoon: link codes (hashes, 10 minutes). Backstop; the game removes expired ones hourly.' }
]);

// Tables that stay small by design, and why. Kept until the save is deleted (privacy) or for good.
export const BOUNDED = Object.freeze({
    accounts: 'one row per save',
    identities: 'one row per sign-in',
    inventory: 'one row per item kind, plant and quality a save holds',
    varieties: 'hybrids only, at most one per pair of base plants (66)',
    account_varieties: 'one row per plant a save has discovered',
    plots: 'at most 24 per save',
    account_upgrades: 'one row per upgrade node',
    account_staff: 'one row per staff type',
    account_achievements: 'one row per achievement',
    account_stats: 'one row per save',
    seasons: 'one row per 30-day season',
    season_standings: 'one row per season per player: the season history, kept with the save',
    challenges: 'four per season',
    config: 'a handful of switches',
    job_runs: 'one row per job',
    account_cosmetics: 'one row per decoration or badge',
    replants: 'one row per Replant'
});

/** The data_retention_policy rows for a table prefix: [table_name, timestamp_column, retain_days, enabled, notes]. */
export function retentionPolicyRows(prefix) {
    return RETENTION.map(r => [`${prefix}${r.table}`, r.column, r.days, 1, r.notes]);
}
