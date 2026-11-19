/*
 * Guild-global defaults for what happens to a live announcement when the stream ends.
 *
 * Until now the only place that answer lived was `subscriptions.edit_on_end` /
 * `subscriptions.delete_on_end`, one row per streamer, with the column defaults
 * (delete=1, edit=0) as the silent fallback for every one of the ~15 code paths
 * that create a subscription. A guild that wants "always edit to Stream Ended"
 * had to flip a toggle for every streamer, forever, including every streamer
 * added later by auto-track, team sync, cross-pollination or `/streamer add`.
 *
 * These two columns are that answer at the guild level. They live on `guilds`
 * rather than `guild_config` because `guilds` is already where the rest of the
 * guild-wide streaming settings sit (announcement_channel_id, live_role_id,
 * announcement_message, use_webhook_persona) — `guild_config` holds prefix,
 * language and appearance.
 *
 * Semantics match the runtime precedence in core/stream-manager.js, where
 * edit_on_end is checked BEFORE delete_on_end:
 *   default_edit_on_end = 1                          -> edit to "stream ended"
 *   default_edit_on_end = 0, default_delete_on_end=1 -> delete the message
 *   default_edit_on_end = 0, default_delete_on_end=0 -> keep the message as-is
 *
 * The column defaults reproduce today's behaviour exactly (delete), so existing
 * guilds see no change until someone touches the toggles.
 */
export async function up(db) {
    const [cols] = await db.execute(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'guilds'
           AND column_name IN ('default_edit_on_end', 'default_delete_on_end')`,
    );
    const have = new Set(cols.map(c => c.column_name || c.COLUMN_NAME));

    if (!have.has('default_edit_on_end')) {
        await db.execute(
            `ALTER TABLE guilds
             ADD COLUMN default_edit_on_end TINYINT(1) NOT NULL DEFAULT 0
             COMMENT 'Guild default: edit live announcements to "stream ended" instead of deleting'`,
        );
    }

    if (!have.has('default_delete_on_end')) {
        await db.execute(
            `ALTER TABLE guilds
             ADD COLUMN default_delete_on_end TINYINT(1) NOT NULL DEFAULT 1
             COMMENT 'Guild default: delete live announcements when the stream ends (0 = keep on end)'`,
        );
    }
}

export async function down(db) {
    for (const col of ['default_edit_on_end', 'default_delete_on_end']) {
        const [cols] = await db.execute(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = DATABASE() AND table_name = 'guilds' AND column_name = ?`,
            [col],
        );
        if (cols.length) await db.execute(`ALTER TABLE guilds DROP COLUMN ${col}`);
    }
}
