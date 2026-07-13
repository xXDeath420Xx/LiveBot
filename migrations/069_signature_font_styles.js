export async function up(db) {
    await db.execute(`ALTER TABLE birthday_card_signatures ADD COLUMN font_color VARCHAR(20) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_card_signatures ADD COLUMN font_family VARCHAR(100) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_card_signatures ADD COLUMN font_size INT DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_card_signatures ADD COLUMN rotation FLOAT DEFAULT NULL`);
    console.log('[Migration 069] Added font_color, font_family, font_size, rotation to birthday_card_signatures');
}

export async function down(db) {
    await db.execute(`ALTER TABLE birthday_card_signatures DROP COLUMN font_color`);
    await db.execute(`ALTER TABLE birthday_card_signatures DROP COLUMN font_family`);
    await db.execute(`ALTER TABLE birthday_card_signatures DROP COLUMN font_size`);
    await db.execute(`ALTER TABLE birthday_card_signatures DROP COLUMN rotation`);
    console.log('[Migration 069] Removed font style columns from birthday_card_signatures');
}
