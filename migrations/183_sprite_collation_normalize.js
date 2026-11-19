// Migration 183 — normalize every epic_sprite_* table to utf8mb4_unicode_ci.
//
// Migration 179 only converted utf8mb3 tables (`table_collation NOT LIKE
// 'utf8mb4%'`). Tables ALREADY on utf8mb4_general_ci — epic_sprite_events,
// epic_sprite_discord_embeds, epic_sprite_discord_links — were skipped, so they
// stayed general_ci while accounts/observed/buyback/schedule/announced moved to
// unicode_ci. That mixed collations on the /sprites/browse JOIN
// (a.account_id = e.account_id) and 500'd the page (2026-08-02). This aligns the
// whole sprite table family so cross-table joins can't hit 'Illegal mix of
// collations'. Idempotent: only touches tables not already at target.
const TARGET = 'utf8mb4_unicode_ci';

export async function up(pool) {
  const [tables] = await pool.execute(
    `SELECT table_name AS t FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
         AND table_name LIKE 'epic_sprite_%' AND table_collation <> ?`,
    [TARGET],
  );
  for (const { t } of tables) {
    await pool.query(`ALTER TABLE \`${t}\` CONVERT TO CHARACTER SET utf8mb4 COLLATE ${TARGET}`);
    console.log(`[Migration 183] ${t} -> ${TARGET}`);
  }
  console.log(`[Migration 183] Normalized ${tables.length} sprite table(s) (0 = already aligned).`);
}

export async function down() { /* collation-only; no rollback needed */ }
