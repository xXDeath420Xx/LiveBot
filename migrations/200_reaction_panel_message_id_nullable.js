/*
 * `reaction_role_panels.message_id` has to be nullable.
 *
 * Two code paths already treat NULL as "this panel isn't posted right now" — the Repost button
 * (`POST /manage/:guildId/repost-rr-panel`) and moving a posted panel to another channel
 * (`PUT /api/.../panels/:panelId`). Both run `SET message_id = NULL`, and both have been dying
 * on `ER_BAD_NULL_ERROR: Column 'message_id' cannot be null` since the column shipped NOT NULL.
 * Repost deleted the live message BEFORE that UPDATE, so every click left the panel invisible
 * in Discord while the row still pointed at the message it had just deleted.
 *
 * The column also carries a UNIQUE index, which is why the 'PENDING' sentinel can only ever
 * exist on one row at a time — a second unposted panel collides. MySQL allows unlimited NULLs
 * under a UNIQUE index, so switching the sentinel to NULL fixes that too.
 *
 * Existing 'PENDING' rows are converted. Readers already accept both spellings, and the
 * "posted panel" counters (`WHERE message_id <> 'PENDING'` in takeover-manager and the
 * initialize API) keep excluding them, since `NULL <> 'PENDING'` is NULL, not true.
 */
export async function up(db) {
    await db.execute(
        `ALTER TABLE reaction_role_panels MODIFY message_id VARCHAR(255) NULL DEFAULT NULL`
    );
    await db.execute(
        `UPDATE reaction_role_panels SET message_id = NULL WHERE message_id = 'PENDING' OR message_id = ''`
    );
}

export async function down(db) {
    // NOT NULL cannot come back while unposted panels exist, so re-seed the sentinel first.
    // Only the first such row can keep it — the UNIQUE index is exactly the reason this
    // migration exists — so the rest are dropped rather than left to fail the ALTER.
    await db.execute(
        `DELETE FROM reaction_role_panels
          WHERE message_id IS NULL
            AND id NOT IN (SELECT keep FROM (SELECT MIN(id) AS keep FROM reaction_role_panels WHERE message_id IS NULL) t)`
    );
    await db.execute(`UPDATE reaction_role_panels SET message_id = 'PENDING' WHERE message_id IS NULL`);
    await db.execute(`ALTER TABLE reaction_role_panels MODIFY message_id VARCHAR(255) NOT NULL`);
}
