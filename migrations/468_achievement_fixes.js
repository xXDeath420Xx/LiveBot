/**
 * Migration 468: achievements that could never be earned (register H-808, 2026-11-20).
 *
 *   completionist  "Unlock 50 achievements" when there are 26 achievements, 13 of them never awarded.
 *                  Now 10, which the awarded ones reach (messages, voice, gambling, daily streak,
 *                  night owl). core/achievement-manager.js checkMetaAchievements reads requirement_value.
 *
 * Data only (no schema change). Idempotent: only a row still at the old value is changed.
 */
export async function up(db) {
    const [rows] = await db.execute(
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'achievements'");
    if (!Number(rows[0].n)) return;
    await db.execute(
        "UPDATE achievements SET requirement_value = 10, description = 'Unlock 10 achievements' WHERE achievement_key = 'completionist' AND requirement_value = 50");
}

export async function down(db) {
    await db.execute(
        "UPDATE achievements SET requirement_value = 50, description = 'Unlock 50 achievements' WHERE achievement_key = 'completionist' AND requirement_value = 10");
}
