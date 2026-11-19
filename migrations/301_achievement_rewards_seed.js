/*
 * Migration 301: seed achievement_rewards.
 *
 * core/achievement-manager.js pays every achievement_rewards row when a member completes an
 * achievement, but the table was empty, so achievements never paid anything. This gives every
 * achievement two rewards, derived from the achievements table itself (tier and points are columns):
 *
 *   currency  by tier: bronze 100, silver 250, gold 500, platinum 1000, diamond 2500
 *             (reward_value 'coins'; paid into user_economy only in servers whose economy is
 *             switched on — economy_config.enabled = 1)
 *   xp        points x 10 (reward_value 'xp'; paid through the leveling manager only in servers
 *             with leveling switched on)
 *
 * Achievement rewards are global (achievement_rewards has no guild column); the per-server
 * on/off rules live in the payout code. Rewards apply to completions from now on — the ~6,400
 * achievements completed before this are not back-paid.
 *
 * Idempotent: each row is inserted only if that achievement has no reward of that type yet (the
 * table has no unique key to make INSERT IGNORE work), so an admin's own edits are never duplicated
 * or overwritten. Achievements of an unknown tier get no currency row.
 *
 * Apply directly: import { up } and call up(pool) (migrations/run.js is unreliable).
 */
export const TIER_CURRENCY = { bronze: 100, silver: 250, gold: 500, platinum: 1000, diamond: 2500 };
export const XP_PER_POINT = 10;

export async function up(db) {
    const tierCase = Object.entries(TIER_CURRENCY)
        .map(([tier, amount]) => `WHEN '${tier}' THEN ${Number(amount)}`).join(' ');

    await db.execute(
        `INSERT INTO achievement_rewards (achievement_id, reward_type, reward_value, reward_amount)
         SELECT a.id, 'currency', 'coins', CASE LOWER(a.tier) ${tierCase} END
           FROM achievements a
          WHERE LOWER(a.tier) IN (${Object.keys(TIER_CURRENCY).map(() => '?').join(',')})
            AND NOT EXISTS (SELECT 1 FROM achievement_rewards r
                             WHERE r.achievement_id = a.id AND r.reward_type = 'currency')`,
        Object.keys(TIER_CURRENCY)
    );

    await db.execute(
        `INSERT INTO achievement_rewards (achievement_id, reward_type, reward_value, reward_amount)
         SELECT a.id, 'xp', 'xp', COALESCE(a.points, 0) * ?
           FROM achievements a
          WHERE COALESCE(a.points, 0) > 0
            AND NOT EXISTS (SELECT 1 FROM achievement_rewards r
                             WHERE r.achievement_id = a.id AND r.reward_type = 'xp')`,
        [XP_PER_POINT]
    );
}

export async function down(db) {
    // Removes only rows matching what this seed writes (an admin-edited amount is left alone).
    const tierCase = Object.entries(TIER_CURRENCY)
        .map(([tier, amount]) => `WHEN '${tier}' THEN ${Number(amount)}`).join(' ');
    await db.execute(
        `DELETE r FROM achievement_rewards r JOIN achievements a ON a.id = r.achievement_id
          WHERE r.reward_type = 'currency' AND r.reward_value = 'coins'
            AND r.reward_amount = CASE LOWER(a.tier) ${tierCase} ELSE -1 END`
    );
    await db.execute(
        `DELETE r FROM achievement_rewards r JOIN achievements a ON a.id = r.achievement_id
          WHERE r.reward_type = 'xp' AND r.reward_value = 'xp' AND r.reward_amount = COALESCE(a.points, 0) * ?`,
        [XP_PER_POINT]
    );
}
