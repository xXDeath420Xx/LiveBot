/*
 * Caption display modes, filler filtering, reader reactions and per-member reader voices.
 *
 * caption_style  'webhook' posts each phrase under the speaker's own name and avatar (one message
 *                per phrase, the Scriptly look); 'compact' is the bot batching "Name: text" lines.
 * skip_filler    live captions drop phrases that are only "mm-hmm" / "yeah" / "okay". They still
 *                go in the transcript — the filter is about channel noise, not the record.
 * reactions      the reader reacts 🗣 when it starts speaking a message and 🙊 when it finishes.
 * voice_reader_user_voices  a member's own reader voice, used in every server.
 */
export async function up(db) {
    const addColumn = async (table, column, ddl) => {
        const [cols] = await db.execute(`SHOW COLUMNS FROM ${table} LIKE '${column}'`);
        if (!cols.length) await db.execute(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    };

    await addColumn('voice_transcription_config', 'caption_style',
        "caption_style VARCHAR(16) NOT NULL DEFAULT 'webhook' AFTER live_captions");
    await addColumn('voice_transcription_config', 'skip_filler',
        'skip_filler TINYINT(1) NOT NULL DEFAULT 1 AFTER caption_style');
    await addColumn('voice_reader_config', 'reactions',
        'reactions TINYINT(1) NOT NULL DEFAULT 1 AFTER skip_links');

    await db.execute(`
        CREATE TABLE IF NOT EXISTS voice_reader_user_voices (
            user_id VARCHAR(20) NOT NULL PRIMARY KEY,
            voice VARCHAR(64) NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
}
