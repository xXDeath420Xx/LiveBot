export async function up(db) {
    // Card-level features
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN is_frozen TINYINT(1) DEFAULT 0`);
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN deliver_at DATETIME DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN view_count INT DEFAULT 0`);
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN profile_link VARCHAR(512) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN credits_text VARCHAR(500) DEFAULT NULL`);

    // Signature-level features
    await db.execute(`ALTER TABLE birthday_card_signatures ADD COLUMN audio_url VARCHAR(512) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_card_signatures ADD COLUMN pin_rank INT DEFAULT NULL`);

    console.log('[Migration 070] Added parity columns: is_frozen, deliver_at, view_count, profile_link, credits_text, audio_url, pin_rank');
}

export async function down(db) {
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN is_frozen`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN deliver_at`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN view_count`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN profile_link`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN credits_text`);
    await db.execute(`ALTER TABLE birthday_card_signatures DROP COLUMN audio_url`);
    await db.execute(`ALTER TABLE birthday_card_signatures DROP COLUMN pin_rank`);
    console.log('[Migration 070] Removed parity columns');
}
