/*
 * Poll of the Day.
 *
 * The library holds 895 open questions ("what crime would you be alarmingly good
 * at?"). A poll needs the same prompt plus a fixed set of answers, so poll cards
 * are ordinary library rows with `card_type = 'poll'` and an `options` array —
 * they sit in the same themes, the same variant groups and the same 90-day
 * no-repeat machinery as everything else, rather than in a parallel table that
 * would drift out of step with it.
 *
 * `post_format` on the channel decides what a guild gets: questions as before,
 * polls only, or both drawn from one pool.
 */
export async function up(db) {
    const [cols] = await db.execute("SHOW COLUMNS FROM qotd_library LIKE 'options'");
    if (!cols.length) {
        await db.execute(
            "ALTER TABLE qotd_library ADD COLUMN options TEXT NULL AFTER content"
        );
    }

    const [cardCols] = await db.execute("SHOW COLUMNS FROM qotd_cards LIKE 'options'");
    if (!cardCols.length) {
        // Custom decks get the same ability, so a guild can write its own polls.
        await db.execute(
            "ALTER TABLE qotd_cards ADD COLUMN options TEXT NULL AFTER content"
        );
    }

    const [fmt] = await db.execute("SHOW COLUMNS FROM qotd_channels LIKE 'post_format'");
    if (!fmt.length) {
        /* Defaults to 'question': every guild already running this keeps exactly
           what it has until somebody chooses otherwise. */
        await db.execute(
            "ALTER TABLE qotd_channels ADD COLUMN post_format VARCHAR(16) NOT NULL DEFAULT 'question'"
        );
    }

    const [dur] = await db.execute("SHOW COLUMNS FROM qotd_channels LIKE 'poll_duration_hours'");
    if (!dur.length) {
        await db.execute(
            'ALTER TABLE qotd_channels ADD COLUMN poll_duration_hours INT NOT NULL DEFAULT 24'
        );
    }

    const [multi] = await db.execute("SHOW COLUMNS FROM qotd_channels LIKE 'poll_multiselect'");
    if (!multi.length) {
        await db.execute(
            'ALTER TABLE qotd_channels ADD COLUMN poll_multiselect TINYINT(1) NOT NULL DEFAULT 0'
        );
    }
}

export async function down(db) {
    await db.execute('ALTER TABLE qotd_library DROP COLUMN options').catch(() => {});
    await db.execute('ALTER TABLE qotd_cards DROP COLUMN options').catch(() => {});
    await db.execute('ALTER TABLE qotd_channels DROP COLUMN post_format').catch(() => {});
    await db.execute('ALTER TABLE qotd_channels DROP COLUMN poll_duration_hours').catch(() => {});
    await db.execute('ALTER TABLE qotd_channels DROP COLUMN poll_multiselect').catch(() => {});
}
