export async function up(db) {
    // Video links pasted into the sign form were silently downgraded to a still
    // thumbnail because gif_url is rendered as an <img>. Keep the thumbnail there
    // for older renderers and store the real link alongside it so the card can embed a player.
    await db.execute(`ALTER TABLE birthday_card_signatures ADD COLUMN video_url VARCHAR(512) DEFAULT NULL`);

    // Backfill: signatures whose gif_url is a YouTube thumbnail were video links all along.
    await db.execute(`
        UPDATE birthday_card_signatures
        SET video_url = CONCAT('https://www.youtube.com/watch?v=', SUBSTRING_INDEX(SUBSTRING_INDEX(gif_url, '/vi/', -1), '/', 1))
        WHERE video_url IS NULL AND gif_url LIKE '%img.youtube.com/vi/%'
    `);

    console.log('[Migration 170] Added birthday_card_signatures.video_url and backfilled YouTube thumbnails');
}

export async function down(db) {
    await db.execute(`ALTER TABLE birthday_card_signatures DROP COLUMN video_url`);
    console.log('[Migration 170] Dropped video_url');
}
