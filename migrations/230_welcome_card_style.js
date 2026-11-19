/*
 * Light welcome cards.
 *
 * The welcome card has always drawn one way: a black rounded rectangle (or a background
 * image under a 40% black scrim), a centred avatar, and white centred text. That reads
 * well on dark, gamer-leaning servers, which is most of them.
 *
 * It reads badly on a pastel one. A server whose whole identity is cherry blossom and
 * soft blues gets its own artwork dimmed to mud and white text laid over it, and the
 * owner is told the card "doesn't match" without any setting that would make it match.
 *
 * `card_style` is that setting. 'dark' is the existing renderer, unchanged and still the
 * default for all 54 existing rows, so nothing anyone is running today shifts. 'light'
 * drops the scrim, moves the avatar to the left, and sets the text in dark ink.
 */

export async function up(db) {
    const [cols] = await db.execute(
        `SELECT COLUMN_NAME FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = 'welcome_settings'
            AND COLUMN_NAME = 'card_style'`
    );
    if (cols.length) return;

    await db.execute(
        `ALTER TABLE welcome_settings
           ADD COLUMN card_style VARCHAR(16) NOT NULL DEFAULT 'dark' AFTER card_background_url`
    );
}

export async function down(db) {
    await db.execute('ALTER TABLE welcome_settings DROP COLUMN card_style');
}
