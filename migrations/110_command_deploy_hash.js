/**
 * Migration 110: track last-deployed command hash per bot per guild.
 *
 * Discord rate-limits command CREATE at ~200 per application per guild per day.
 * We were burning the budget on every PM2 restart by blindly re-PUTting the
 * same 49 commands to every custom bot × every guild. The deployment then
 * hangs forever waiting on 429s.
 *
 * Schema: store the hash of the commands array we last successfully deployed.
 * If the current hash matches, the bot-manager skips the PUT entirely.
 */
async function tableExists(db, name) {
    const allow = new Set(['cah_games', 'cah_decks', 'cah_white_cards', 'cah_black_cards', 'cah_game_players', 'cah_game_decks', 'cah_game_submissions', 'cah_guild_config', 'command_deploy_hashes']);
    if (!allow.has(name)) throw new Error('refusing to inspect ' + name);
    const [r] = await db.execute(`SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='${name}'`);
    return r[0].n > 0;
}

export async function up(db) {
    if (!(await tableExists(db, 'command_deploy_hashes'))) {
        await db.execute(`
            CREATE TABLE command_deploy_hashes (
                bot_id              VARCHAR(20) NOT NULL,
                guild_id            VARCHAR(20) NOT NULL DEFAULT '',
                hash                CHAR(64) NOT NULL,
                deployed_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                blocked_until       TIMESTAMP NULL,
                last_block_reason   VARCHAR(255) NULL,
                PRIMARY KEY (bot_id, guild_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
    }
}

export async function down(db) {
    await db.execute('DROP TABLE IF EXISTS command_deploy_hashes');
}
