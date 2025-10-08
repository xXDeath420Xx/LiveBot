const db = require('../utils/db');

// In-memory cache to reduce DB lookups on every message
const afkCache = new Map();

async function checkAfkStatus(message) {
    if (message.author.bot || !message.guild) return;

    const guildId = message.guild.id;
    const authorId = message.author.id;

    // Check if AFK system is enabled for this guild
    const [[guildSettings]] = await db.execute('SELECT afk_enabled FROM guilds WHERE guild_id = ?', [guildId]);
    if (guildSettings && !guildSettings.afk_enabled) {
        return; // AFK system is disabled for this guild
    }

    // First, check if the message author is returning from AFK
    let authorAfk = afkCache.get(`${guildId}:${authorId}`);
    if (!authorAfk) {
        const [[dbAfk]] = await db.execute('SELECT * FROM afk_statuses WHERE guild_id = ? AND user_id = ?', [guildId, authorId]);
        if (dbAfk) {
            authorAfk = dbAfk;
            afkCache.set(`${guildId}:${authorId}`, dbAfk);
        }
    }

    if (authorAfk) {
        await db.execute('DELETE FROM afk_statuses WHERE guild_id = ? AND user_id = ?', [guildId, authorId]);
        afkCache.delete(`${guildId}:${authorId}`);
        const sentTimestamp = new Date(authorAfk.timestamp).getTime();
        const duration = `<t:${Math.floor(sentTimestamp / 1000)}:R>`;
        message.reply(`Welcome back ${message.author}, I've removed your AFK status. You were away ${duration}.`).then(msg => {
            setTimeout(() => msg.delete().catch(() => {}), 10000); // Delete the welcome back message after 10 seconds
        });
    }

    // Next, check if the message mentions any AFK users
    const mentionedUsers = message.mentions.users;
    if (mentionedUsers.size === 0) return;

    for (const [userId, user] of mentionedUsers) {
        let mentionedAfk = afkCache.get(`${guildId}:${userId}`);
        if (!mentionedAfk) {
            const [[dbAfk]] = await db.execute('SELECT * FROM afk_statuses WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
            if (dbAfk) {
                mentionedAfk = dbAfk;
                afkCache.set(`${guildId}:${userId}`, dbAfk);
            }
        }

        if (mentionedAfk) {
            const afkTimestamp = new Date(mentionedAfk.timestamp).getTime();
            const duration = `<t:${Math.floor(afkTimestamp / 1000)}:R>`;
            message.reply(`**${user.username}** is currently AFK: *${mentionedAfk.message}* (${duration})`);
        }
    }
}

module.exports = { checkAfkStatus };
