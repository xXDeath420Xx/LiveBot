export async function up(db) {
    // Board-level theming (creator controls)
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN board_bg_color VARCHAR(20) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN board_bg_image_url TEXT DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN title_font VARCHAR(100) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN title_font_size INT DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN title_font_color VARCHAR(20) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN subtitle_text VARCHAR(500) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN subtitle_font VARCHAR(100) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN subtitle_font_color VARCHAR(20) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN header_bg_color VARCHAR(20) DEFAULT '#000000'`);

    // Per-signature card customization (signer controls)
    await db.execute(`ALTER TABLE birthday_card_signatures ADD COLUMN card_bg_color VARCHAR(20) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_card_signatures ADD COLUMN card_border_radius INT DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_card_signatures ADD COLUMN card_border_color VARCHAR(20) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_card_signatures ADD COLUMN card_shadow VARCHAR(50) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_card_signatures ADD COLUMN note_effect VARCHAR(50) DEFAULT NULL`);

    console.log('[Migration 073] Added full card customization columns (board-level + per-signature)');
}

export async function down(db) {
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN board_bg_color`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN board_bg_image_url`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN title_font`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN title_font_size`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN title_font_color`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN subtitle_text`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN subtitle_font`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN subtitle_font_color`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN header_bg_color`);
    await db.execute(`ALTER TABLE birthday_card_signatures DROP COLUMN card_bg_color`);
    await db.execute(`ALTER TABLE birthday_card_signatures DROP COLUMN card_border_radius`);
    await db.execute(`ALTER TABLE birthday_card_signatures DROP COLUMN card_border_color`);
    await db.execute(`ALTER TABLE birthday_card_signatures DROP COLUMN card_shadow`);
    await db.execute(`ALTER TABLE birthday_card_signatures DROP COLUMN note_effect`);
    console.log('[Migration 073] Removed full card customization columns');
}
