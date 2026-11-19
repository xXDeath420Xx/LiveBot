import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

const AFK_PREFIX = '[AFK] ';
const AFK_COLOR = 0xF1C40F;

/** "2h 14m", "3d 1h", "just now" — compact, no seconds past a minute. */
function fmtDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return 'just now';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    if (m && !d) parts.push(`${m}m`);
    return parts.join(' ') || 'just now';
}

class AFKManager {
    constructor(client) {
        this.client = client;
        this.afkCache = new Map();
        this.MAX_AFK_CACHE = 10000;
        this.loadAFKStatuses();
        logger.info('[AFKManager] AFK manager initialized');
    }

    async loadAFKStatuses() {
        try {
            const [statuses] = await pool.execute('SELECT * FROM afk_statuses');
            for (const status of statuses) {
                // DB columns are reason/set_at; the in-memory shape stays message/timestamp.
                this.afkCache.set(status.user_id, {
                    guildId: status.guild_id,
                    message: status.reason,
                    timestamp: status.set_at ? new Date(status.set_at) : new Date(),
                    originalNick: status.original_nick,
                    nickChanged: !!status.nick_changed,
                });
            }
            logger.info(`[AFKManager] Loaded ${statuses.length} AFK statuses`);
        } catch (error) {
            logger.error(`[AFKManager] Failed to load AFK statuses: ${error.message}`);
        }
    }

    /** Can the bot rename this member? Owner and anyone at/above the bot's top role cannot be. */
    canRename(member) {
        const me = member?.guild?.members?.me;
        if (!me || !member) return false;
        if (member.id === member.guild.ownerId) return false;
        if (!me.permissions.has(PermissionFlagsBits.ManageNicknames)) return false;
        if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) return false;
        return true;
    }

    /**
     * Prefix the member's nickname with [AFK]. Returns { changed, originalNick }. `originalNick` is the
     * exact value to restore later — null means "they had no nickname," which restores to their username.
     */
    async applyAfkNick(member) {
        if (!this.canRename(member)) return { changed: false, originalNick: null };
        const original = member.nickname; // null when they use their plain username
        const base = member.displayName || member.user.username;
        // Discord caps nicknames at 32 chars; leave room for the prefix.
        const nick = (AFK_PREFIX + base).slice(0, 32);
        if (member.nickname === nick) return { changed: false, originalNick: original };
        try {
            await member.setNickname(nick, 'AFK status set');
            return { changed: true, originalNick: original };
        } catch (e) {
            logger.warn(`[AFKManager] could not set AFK nick for ${member.id}: ${e.message}`);
            return { changed: false, originalNick: null };
        }
    }

    async restoreNick(member, originalNick) {
        if (!member || !this.canRename(member)) return;
        // Only touch it if it still looks like ours, so we don't clobber a nick they changed while away.
        if (!member.nickname?.startsWith(AFK_PREFIX)) return;
        try { await member.setNickname(originalNick ?? null, 'AFK status cleared'); }
        catch (e) { logger.warn(`[AFKManager] could not restore nick for ${member.id}: ${e.message}`); }
    }

    async setAFK(userId, guildId, message = 'AFK', member = null) {
        try {
            let originalNick = null, nickChanged = false;
            // "Add [AFK] to their nickname" on the dashboard (feature-config `colorroles`.afk_rename).
            let rename = true;
            try {
                const { getConfig } = await import('./feature-config.js');
                const cfg = await getConfig('colorroles', guildId);
                rename = !(cfg.afk_rename === false || cfg.afk_rename === 0 || cfg.afk_rename === '0');
            } catch { /* default: rename */ }
            if (member && rename) {
                const r = await this.applyAfkNick(member);
                nickChanged = r.changed;
                originalNick = r.originalNick;
            }
            await pool.execute(
                `INSERT INTO afk_statuses (user_id, guild_id, reason, original_nick, nick_changed, set_at)
                 VALUES (?, ?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE reason = VALUES(reason), original_nick = VALUES(original_nick),
                   nick_changed = VALUES(nick_changed), set_at = NOW()`,
                [userId, guildId, message, originalNick, nickChanged ? 1 : 0]
            );
            if (this.afkCache.size >= this.MAX_AFK_CACHE && !this.afkCache.has(userId)) {
                this.afkCache.delete(this.afkCache.keys().next().value);
            }
            this.afkCache.set(userId, { guildId, message, timestamp: new Date(), originalNick, nickChanged });
            logger.info(`[AFKManager] User ${userId} set AFK in guild ${guildId} (nick ${nickChanged ? 'changed' : 'unchanged'})`);
            return { ok: true, nickChanged };
        } catch (error) {
            logger.error(`[AFKManager] Failed to set AFK for user ${userId}: ${error.message}`);
            return { ok: false, nickChanged: false };
        }
    }

    async removeAFK(userId, guildId, member = null) {
        try {
            const cached = this.afkCache.get(userId);
            if (member && cached?.nickChanged) {
                await this.restoreNick(member, cached.originalNick);
            }
            await pool.execute('DELETE FROM afk_statuses WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
            this.afkCache.delete(userId);
            logger.info(`[AFKManager] User ${userId} is no longer AFK in guild ${guildId}`);
            return true;
        } catch (error) {
            logger.error(`[AFKManager] Failed to remove AFK for user ${userId}: ${error.message}`);
            return false;
        }
    }

    isAFK(userId) { return this.afkCache.has(userId); }
    getAFK(userId) { return this.afkCache.get(userId) || null; }

    /** Everyone currently AFK in a guild, newest first. */
    listAFK(guildId) {
        const out = [];
        for (const [userId, a] of this.afkCache) {
            if (a.guildId === guildId) out.push({ userId, message: a.message, timestamp: a.timestamp });
        }
        return out.sort((x, y) => y.timestamp - x.timestamp);
    }

    async handleMessage(message) {
        try {
            if (!message.guild || message.author.bot) return;
            const userId = message.author.id;
            const guildId = message.guild.id;

            // The author is back — clear their AFK and confirm briefly.
            if (this.isAFK(userId)) {
                const afk = this.getAFK(userId);
                if (afk && afk.guildId === guildId) {
                    await this.removeAFK(userId, guildId, message.member);
                    const away = fmtDuration(Date.now() - afk.timestamp.getTime());
                    const reply = await message.reply({
                        content: `👋 Welcome back — you were away for **${away}**. Your AFK is cleared.`,
                        allowedMentions: { repliedUser: false },
                    }).catch(() => null);
                    if (reply) setTimeout(() => reply.delete().catch(() => {}), 6000);
                }
            }

            // Someone pinged AFK members — tell them, once, in a compact embed.
            if (message.mentions.users.size > 0) {
                const fields = [];
                for (const [mentionedId, user] of message.mentions.users) {
                    if (mentionedId === userId) continue;
                    const afk = this.isAFK(mentionedId) ? this.getAFK(mentionedId) : null;
                    if (afk && afk.guildId === guildId) {
                        fields.push({
                            name: user.displayName || user.username,
                            value: `💤 ${afk.message}\n*away for ${fmtDuration(Date.now() - afk.timestamp.getTime())}*`,
                        });
                    }
                }
                if (fields.length) {
                    const embed = new EmbedBuilder().setColor(AFK_COLOR);
                    if (fields.length === 1) {
                        const only = message.mentions.users.find(u => this.isAFK(u.id));
                        embed.setAuthor({ name: `${fields[0].name} is AFK`, iconURL: only?.displayAvatarURL?.() })
                            .setDescription(fields[0].value);
                    } else {
                        embed.setTitle(`${fields.length} people you pinged are AFK`).addFields(fields.slice(0, 10));
                    }
                    await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } }).catch(() => {});
                }
            }
        } catch (error) {
            logger.error(`[AFKManager] Message handling error: ${error.message}`);
        }
    }
}

export default AFKManager;
