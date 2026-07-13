export async function up(db) {
    // Make guild_id and user_id nullable so cards can exist without a Discord server
    await db.execute(`ALTER TABLE birthday_cards MODIFY guild_id VARCHAR(20) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_cards MODIFY user_id VARCHAR(20) DEFAULT NULL`);

    // Add occasion type (not just birthdays anymore)
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN occasion VARCHAR(50) DEFAULT 'birthday'`);

    // Recipient name for standalone cards (no Discord user lookup needed)
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN recipient_name VARCHAR(200) DEFAULT NULL`);

    // Creator info (who made the card — may differ from the recipient)
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN creator_user_id VARCHAR(20) DEFAULT NULL`);
    await db.execute(`ALTER TABLE birthday_cards ADD COLUMN creator_username VARCHAR(100) DEFAULT NULL`);

    // Allow duplicate signers on standalone cards (guests may share names)
    // The unique constraint signer_user_id was too strict for guest-heavy cards
    // We keep it but guest IDs are already unique (guest_timestamp_random)

    console.log('[Migration 072] Made guild_id nullable, added occasion, recipient_name, creator fields for standalone cards');
}

export async function down(db) {
    await db.execute(`ALTER TABLE birthday_cards MODIFY guild_id VARCHAR(20) NOT NULL`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN occasion`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN recipient_name`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN creator_user_id`);
    await db.execute(`ALTER TABLE birthday_cards DROP COLUMN creator_username`);
    console.log('[Migration 072] Reverted standalone card changes');
}
