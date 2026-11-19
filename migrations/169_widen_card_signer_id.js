export async function up(db) {
    // Migration 072 introduced guest signers with IDs shaped `guest_<timestamp>_<random>`
    // (26 chars) but left signer_user_id at the Discord-snowflake width of VARCHAR(20),
    // so every guest signature died on "Data too long for column 'signer_user_id'".
    await db.execute(`ALTER TABLE birthday_card_signatures MODIFY signer_user_id VARCHAR(64) NOT NULL`);

    console.log('[Migration 169] Widened birthday_card_signatures.signer_user_id to VARCHAR(64) for guest signers');
}

export async function down(db) {
    await db.execute(`ALTER TABLE birthday_card_signatures MODIFY signer_user_id VARCHAR(20) NOT NULL`);
    console.log('[Migration 169] Reverted signer_user_id to VARCHAR(20)');
}
