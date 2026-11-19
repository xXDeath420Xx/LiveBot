/**
 * Migration 428 — lifetime counters for RPG achievements (H-104).
 *
 * dnd_characters (core/rpg-leaderboard-manager.js REQUIREMENT_STAT_COLUMN / INCREMENTABLE_STATS)
 *     gold_earned     INT UNSIGNED NOT NULL DEFAULT 0  gold gained from any source (Coin Collector, Wealthy)
 *     dragons_slain   INT UNSIGNED NOT NULL DEFAULT 0  dragons killed in /rpg combat and dungeons (Dragonslayer)
 *     spells_cast     INT UNSIGNED NOT NULL DEFAULT 0  successful /rpg spell cast (Spellslinger)
 *     parties_joined  INT UNSIGNED NOT NULL DEFAULT 0  parties founded or joined (Party Animal)
 *
 * The other three requirement types need no storage: deathless_level comes from level + deaths,
 * unique_items from dnd_inventory, zones_visited from dnd_zone_discoveries.
 *
 * Backfill (only when a column is created): gold_earned starts at the character's current gold
 * (they earned at least that much); parties_joined is 1 for characters in a party right now.
 * There is no history for dragons or spells, so those start at 0.
 *
 * The bumps are fire-and-forget (RPGLeaderboardManager.trackStat), so before this runs they log
 * an error and gameplay carries on.
 *
 * Idempotent: every step checks information_schema first.
 */

async function hasTable(db, table) {
    const [rows] = await db.query(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

async function hasColumn(db, table, column) {
    const [rows] = await db.query(
        'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]);
    return rows.length > 0;
}

const COUNTERS = ['gold_earned', 'dragons_slain', 'spells_cast', 'parties_joined'];

export async function up(db) {
    if (!(await hasTable(db, 'dnd_characters'))) return;

    if (!(await hasColumn(db, 'dnd_characters', 'gold_earned'))) {
        await db.query('ALTER TABLE dnd_characters ADD COLUMN gold_earned INT UNSIGNED NOT NULL DEFAULT 0');
        await db.query('UPDATE dnd_characters SET gold_earned = GREATEST(COALESCE(gold, 0), 0)');
    }
    if (!(await hasColumn(db, 'dnd_characters', 'dragons_slain'))) {
        await db.query('ALTER TABLE dnd_characters ADD COLUMN dragons_slain INT UNSIGNED NOT NULL DEFAULT 0');
    }
    if (!(await hasColumn(db, 'dnd_characters', 'spells_cast'))) {
        await db.query('ALTER TABLE dnd_characters ADD COLUMN spells_cast INT UNSIGNED NOT NULL DEFAULT 0');
    }
    if (!(await hasColumn(db, 'dnd_characters', 'parties_joined'))) {
        await db.query('ALTER TABLE dnd_characters ADD COLUMN parties_joined INT UNSIGNED NOT NULL DEFAULT 0');
        if (await hasTable(db, 'dnd_party_members')) {
            await db.query(
                `UPDATE dnd_characters c
                    SET c.parties_joined = 1
                  WHERE EXISTS (SELECT 1 FROM dnd_party_members pm WHERE pm.character_id = c.character_id)`);
        }
    }
}

export async function down(db) {
    if (!(await hasTable(db, 'dnd_characters'))) return;
    for (const column of COUNTERS) {
        if (await hasColumn(db, 'dnd_characters', column)) {
            await db.query(`ALTER TABLE dnd_characters DROP COLUMN ${column}`);
        }
    }
}
