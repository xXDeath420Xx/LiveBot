export async function up(db) {
    // AI-generated cover image stored on the card
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN ai_cover_prompt VARCHAR(500) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN ai_cover_url TEXT DEFAULT NULL`);

    // Gift card codes per signature (encrypted, only visible to birthday person after delivery)
    await db.execute(`ALTER TABLE birthday_card_signatures ADD COLUMN gift_code_encrypted TEXT DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_card_signatures ADD COLUMN gift_platform VARCHAR(100) DEFAULT NULL`);

    // Reply-to-all thank you message from birthday person
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN thank_you_message TEXT DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN thank_you_user_id VARCHAR(20) DEFAULT NULL`);

    console.log('[Migration 071] Added ai_cover, gift_code, thank_you columns');
}

export async function down(db) {
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN ai_cover_prompt`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN ai_cover_url`);
    await db.execute(`ALTER TABLE birthday_card_signatures DROP COLUMN gift_code_encrypted`);
    await db.execute(`ALTER TABLE birthday_card_signatures DROP COLUMN gift_platform`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN thank_you_message`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN thank_you_user_id`);
    console.log('[Migration 071] Removed ai_cover, gift_code, thank_you columns');
}
