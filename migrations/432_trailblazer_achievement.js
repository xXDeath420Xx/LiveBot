/**
 * Migration 432 — the Trailblazer achievement (register H-313).
 *
 * events/guildMemberAdd.js awards 'trailblazer' to members who join while a server has at most 100
 * members (next to 'early_adopter' for the first 10), but no achievements row had that key, so
 * core/achievement-manager.js logged "Unknown achievement key: trailblazer" and nobody could earn it.
 *
 *   achievements        trailblazer · "Trailblazer" · "Be one of the first 100 members" · special /
 *                       gold · 🧭 · requirement_type 'special' (completes on the join event) · 250 points
 *   achievement_rewards the same two rewards migration 301 gives every achievement: currency by tier
 *                       (gold = 500 coins) and xp = points x 10 (2500)
 *
 * Idempotent: the achievement is INSERT IGNORE on its unique key (an admin's edits to an existing
 * row are kept), and each reward is added only if that achievement has none of that type yet.
 * The achievement manager loads achievements at startup, so it applies after the next restart.
 */

const KEY = 'trailblazer';
const COINS = 500;        // migration 301 TIER_CURRENCY.gold
const XP_PER_POINT = 10;  // migration 301 XP_PER_POINT

async function hasTable(db, table) {
    const [rows] = await db.query(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasTable(db, 'achievements'))) return;

    await db.query(
        `INSERT IGNORE INTO achievements
            (achievement_key, name, description, category, tier, icon_emoji, requirement_type, requirement_value, points, is_hidden, is_repeatable)
         VALUES (?, 'Trailblazer', 'Be one of the first 100 members', 'special', 'gold', '🧭', 'special', 100, 250, 0, 0)`,
        [KEY]);

    if (!(await hasTable(db, 'achievement_rewards'))) return;
    await db.query(
        `INSERT INTO achievement_rewards (achievement_id, reward_type, reward_value, reward_amount)
         SELECT a.id, 'currency', 'coins', ? FROM achievements a
          WHERE a.achievement_key = ?
            AND NOT EXISTS (SELECT 1 FROM achievement_rewards r WHERE r.achievement_id = a.id AND r.reward_type = 'currency')`,
        [COINS, KEY]);
    await db.query(
        `INSERT INTO achievement_rewards (achievement_id, reward_type, reward_value, reward_amount)
         SELECT a.id, 'xp', 'xp', COALESCE(a.points, 0) * ? FROM achievements a
          WHERE a.achievement_key = ? AND COALESCE(a.points, 0) > 0
            AND NOT EXISTS (SELECT 1 FROM achievement_rewards r WHERE r.achievement_id = a.id AND r.reward_type = 'xp')`,
        [XP_PER_POINT, KEY]);
}

export async function down(db) {
    if (!(await hasTable(db, 'achievements'))) return;
    const [[row]] = await db.query('SELECT id FROM achievements WHERE achievement_key = ?', [KEY]);
    if (!row) return;
    // Members who earned it keep nothing that points at a missing achievement.
    if (await hasTable(db, 'user_achievements')) await db.query('DELETE FROM user_achievements WHERE achievement_id = ?', [row.id]);
    if (await hasTable(db, 'achievement_rewards')) await db.query('DELETE FROM achievement_rewards WHERE achievement_id = ?', [row.id]);
    await db.query('DELETE FROM achievements WHERE id = ?', [row.id]);
}
