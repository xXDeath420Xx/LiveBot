/**
 * Migration 435 — CertiFried Extension (cfx) launch: season counters and the Discord balance
 * (register H-407, H-408).
 *
 * 1. cfx_players.season_earnings (BIGINT UNSIGNED) and season_sales (INT UNSIGNED, harvests),
 *    next to the existing season_xp. services/certifried-extension/game/season-system.js ranks a
 *    season by season XP, then these two, and resets all three when the next season starts.
 *    engine.awardCash / the player market add to season_earnings and growth-system adds a harvest
 *    to season_sales once the columns exist (the code checks; before this migration only season_xp
 *    is counted).
 *
 * 2. The Discord / Twitch chat commands used to pay daily rewards and quick sales into
 *    cfx_players.currency, a balance the game never shows or spends (it uses `cash`); they pay
 *    into `cash` now. What players earned there (currency above the column default of 1000) is
 *    credited to cash ONCE, logged in cfx_transactions with source 'currency_merge:2026-11-18'.
 *    A player who already has that transaction is skipped, so re-running changes nothing. The
 *    currency column itself is left as it was (no data removed).
 *
 * down() drops the two columns; it does not take the credited cash back.
 */

const MERGE_SOURCE = 'currency_merge:2026-11-18';
const CURRENCY_DEFAULT = 1000;

async function hasColumn(db, table, column) {
    const [rows] = await db.query(
        `SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'cfx_players', 'id'))) return;

    if (!(await hasColumn(db, 'cfx_players', 'season_earnings'))) {
        await db.query('ALTER TABLE cfx_players ADD COLUMN season_earnings BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER season_xp');
    }
    if (!(await hasColumn(db, 'cfx_players', 'season_sales'))) {
        await db.query('ALTER TABLE cfx_players ADD COLUMN season_sales INT UNSIGNED NOT NULL DEFAULT 0 AFTER season_earnings');
    }

    if (!(await hasColumn(db, 'cfx_players', 'currency')) || !(await hasColumn(db, 'cfx_transactions', 'source'))) return;
    const [players] = await db.query(
        `SELECT p.id, p.currency - ? AS earned
         FROM cfx_players p
         WHERE p.currency > ?
           AND NOT EXISTS (SELECT 1 FROM cfx_transactions t WHERE t.player_id = p.id AND t.source = ?)`,
        [CURRENCY_DEFAULT, CURRENCY_DEFAULT, MERGE_SOURCE]
    );
    for (const p of players) {
        const earned = Math.floor(Number(p.earned));
        if (!(earned > 0)) continue;
        await db.query('UPDATE cfx_players SET cash = cash + ? WHERE id = ?', [earned, p.id]);
        await db.query(
            `INSERT INTO cfx_transactions (player_id, type, amount, source, balance_after)
             SELECT id, 'credit', ?, ?, cash FROM cfx_players WHERE id = ?`,
            [earned, MERGE_SOURCE, p.id]
        );
    }
}

export async function down(db) {
    if (await hasColumn(db, 'cfx_players', 'season_sales')) {
        await db.query('ALTER TABLE cfx_players DROP COLUMN season_sales');
    }
    if (await hasColumn(db, 'cfx_players', 'season_earnings')) {
        await db.query('ALTER TABLE cfx_players DROP COLUMN season_earnings');
    }
}
