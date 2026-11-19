/*
 * Self-updating 4:20 world clock panels (/cannabis clock post).
 *
 * One panel per channel. bot_user_id is the bot that POSTED the message — only
 * that bot can edit it, and in custom-bot guilds it is not the main bot.
 */
export async function up(db) {
    await db.execute(`CREATE TABLE IF NOT EXISTS fourtwenty_panels (
        id INT AUTO_INCREMENT PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        channel_id VARCHAR(20) NOT NULL,
        message_id VARCHAR(20) NOT NULL,
        bot_user_id VARCHAR(20) NOT NULL,
        created_by VARCHAR(20) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_channel (guild_id, channel_id)
    )`);
}
