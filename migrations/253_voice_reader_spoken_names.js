/*
 * Voice reader quality pass.
 *
 * voice_reader_user_voices.spoken_name  how a member's name is SAID ("Kay-oss" for "xX_Kha0s_Xx").
 *                                       Global like the voice, so a row may now hold a name and no
 *                                       voice — hence voice becomes nullable.
 * voice_reader_config.max_length        default 250 → 600. At 250 most jokes lost their punchline;
 *                                       rows still on the old default move with it. Messages are now
 *                                       cut at sentence ends, never mid-word.
 */
export async function up(db) {
    const [cols] = await db.execute("SHOW COLUMNS FROM voice_reader_user_voices LIKE 'spoken_name'");
    if (!cols.length) {
        await db.execute(`ALTER TABLE voice_reader_user_voices
            ADD COLUMN spoken_name VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL AFTER voice`);
    }
    await db.execute('ALTER TABLE voice_reader_user_voices MODIFY voice VARCHAR(64) NULL');
    await db.execute('ALTER TABLE voice_reader_config ALTER max_length SET DEFAULT 600');
    await db.execute('UPDATE voice_reader_config SET max_length = 600 WHERE max_length = 250');
}
