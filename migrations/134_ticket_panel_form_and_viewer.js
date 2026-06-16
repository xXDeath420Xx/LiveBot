/**
 * Migration 134 — per-panel form + extra viewer for ticket panels.
 *
 * - `form_id`: a panel can have its OWN form (so a panel button opens that form's
 *   modal AND uses that panel's category/role config — not the guild fallback).
 * - `extra_viewer_id`: an additional user id granted access to every ticket from
 *   this panel (e.g. the server owner for application-style panels), so a ticket
 *   can be made opener + this-user-only by leaving support_role_id NULL.
 * Both nullable → existing panels (e.g. Support) are unchanged.
 */
export async function up(db) {
  await db.execute('ALTER TABLE ticket_panels ADD COLUMN form_id INT NULL').catch((e) => {
    if (!/duplicate column/i.test(e.message)) throw e;
  });
  await db.execute('ALTER TABLE ticket_panels ADD COLUMN extra_viewer_id VARCHAR(20) NULL').catch((e) => {
    if (!/duplicate column/i.test(e.message)) throw e;
  });
}

export async function down(db) {
  await db.execute('ALTER TABLE ticket_panels DROP COLUMN form_id').catch(() => {});
  await db.execute('ALTER TABLE ticket_panels DROP COLUMN extra_viewer_id').catch(() => {});
}
