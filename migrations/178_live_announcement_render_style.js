/**
 * Remember which style each live announcement was actually rendered with.
 *
 * The refresh pass skips an edit when the stream's title and game haven't moved
 * (core/stream-manager.js — `embedContentChanged`), which is right when the embed is a static
 * card: rewriting it every 5 minutes only burned Discord edits. But it also means changing the
 * render style leaves every currently-live announcement stuck on its old look until the streamer
 * happens to retitle, and it freezes a platform preview at the frame captured when the stream
 * started.
 *
 * With the rendered style on the row, a style change is detectable as "this needs re-rendering",
 * and preview-style announcements can be refreshed on every update pass so the thumbnail moves.
 */
export async function up(db) {
    const [cols] = await db.execute("SHOW COLUMNS FROM live_announcements LIKE 'render_style'");
    if (cols.length === 0) {
        await db.execute("ALTER TABLE live_announcements ADD COLUMN render_style VARCHAR(16) DEFAULT NULL");
    }
}

export async function down(db) {
    const [cols] = await db.execute("SHOW COLUMNS FROM live_announcements LIKE 'render_style'");
    if (cols.length > 0) {
        await db.execute('ALTER TABLE live_announcements DROP COLUMN render_style');
    }
}
