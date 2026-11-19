/**
 * Migration 446 — one event per slug across every server (register H-671).
 *
 * The public page /schedule/<slug> (dashboard/routes/public-schedule.js) finds an event by slug
 * alone, but the bot and the server dashboard only checked that a slug was free in the same server
 * (unique_guild_slug), so two servers could take one slug and one of them got the other's page.
 * Personal schedules (dashboard/routes/user-schedule.js) already treated slugs as global.
 *
 * Any slug already shared is kept by the oldest event; the others get "-<id>" added, so every
 * address stays unique. Then a unique key on slug stops it happening again.
 *
 * Idempotent: duplicates are renamed only while they exist, the key is added only when missing.
 */
export async function up(db) {
    const [dups] = await db.query(
        `SELECT e.id, e.slug FROM schedule_events e
           JOIN (SELECT slug, MIN(id) AS keep_id FROM schedule_events GROUP BY slug HAVING COUNT(*) > 1) d
             ON d.slug = e.slug AND e.id <> d.keep_id`);
    for (const row of dups) {
        const renamed = `${String(row.slug).slice(0, 100 - String(row.id).length - 1)}-${row.id}`;
        await db.query('UPDATE schedule_events SET slug = ? WHERE id = ?', [renamed, row.id]);
    }

    const [idx] = await db.query(
        `SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schedule_events' AND INDEX_NAME = 'uniq_slug' LIMIT 1`);
    if (!idx.length) await db.query('ALTER TABLE schedule_events ADD UNIQUE KEY uniq_slug (slug)');
}

export async function down(db) {
    const [idx] = await db.query(
        `SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schedule_events' AND INDEX_NAME = 'uniq_slug' LIMIT 1`);
    if (idx.length) await db.query('ALTER TABLE schedule_events DROP KEY uniq_slug');
}
