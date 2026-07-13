// Watches the configured #stream-signup channel: when a user pastes a stream URL,
// check their level against stream_signup_config.level_gate and either
// auto-subscribe (✅ react) or delete the message + DM them the requirement.
// Non-link messages are also deleted — the channel is link-only.
import { ChannelType } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { resolveStreamerIdentity, upsertStreamerByIdentity } from '../utils/platforms/resolve-identity.js';

const PATTERNS = [
    { platform: 'twitch',   re: /(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([A-Za-z0-9_]{3,25})/i },
    { platform: 'kick',     re: /(?:https?:\/\/)?(?:www\.)?kick\.com\/([A-Za-z0-9_-]{3,25})/i },
    { platform: 'youtube',  re: /(?:https?:\/\/)?(?:www\.)?youtube\.com\/(?:@|c\/|channel\/|user\/)([A-Za-z0-9_.-]{3,})/i },
    { platform: 'tiktok',   re: /(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([A-Za-z0-9_.-]{2,24})/i },
    { platform: 'trovo',    re: /(?:https?:\/\/)?(?:www\.)?trovo\.live\/([A-Za-z0-9_]{3,25})/i },
    { platform: 'facebook', re: /(?:https?:\/\/)?(?:www\.)?facebook\.com\/([A-Za-z0-9_.-]{3,})/i },
];

function parseStream(content) {
    for (const { platform, re } of PATTERNS) {
        const m = content.match(re);
        if (m) return { platform, username: m[1] };
    }
    return null;
}

export default {
    name: 'messageCreate',
    async execute(message) {
        if (message.author.bot || !message.guild) return;
        if (message.channel.type !== ChannelType.GuildText) return;

        const [cfgRows] = await pool.execute(
            'SELECT stream_announcement_channel_id, stream_signup_message_id, level_gate FROM stream_signup_config WHERE guild_id = ? AND stream_signup_channel_id = ?',
            [message.guild.id, message.channel.id]
        );
        if (!cfgRows.length) return;
        const { stream_announcement_channel_id, stream_signup_message_id, level_gate } = cfgRows[0];

        // Never touch the pinned instructional message.
        if (stream_signup_message_id && message.id === stream_signup_message_id) return;

        const parsed = parseStream(message.content || '');
        if (!parsed) {
            await message.delete().catch(() => {});
            await message.author.send(`In <#${message.channel.id}> please post only a supported stream URL (Twitch, Kick, YouTube, TikTok, Trovo, Facebook).`).catch(() => {});
            return;
        }

        // Level gate check
        const [lvlRows] = await pool.execute(
            'SELECT level FROM user_levels WHERE guild_id = ? AND user_id = ?',
            [message.guild.id, message.author.id]
        );
        const userLevel = lvlRows[0]?.level ?? 0;
        if (userLevel < level_gate) {
            await message.delete().catch(() => {});
            await message.author.send(
                `To sign up for auto-shoutouts you need to reach **level ${level_gate}** in ${message.guild.name}. You're currently level **${userLevel}**. Chat around and earn XP, then post your link again.`
            ).catch(() => {});
            return;
        }

        // Resolve the real platform identity before persisting — never create temp_ rows.
        const identity = await resolveStreamerIdentity(parsed.platform, parsed.username);
        if (!identity) {
            await message.delete().catch(() => {});
            await message.author.send(
                `I couldn't find **${parsed.platform}:${parsed.username}** on ${parsed.platform}. Double-check the URL and try again.`
            ).catch(() => {});
            return;
        }
        const streamerId = await upsertStreamerByIdentity(pool, parsed.platform, identity, message.author.id);

        // Upsert subscription pointed at the announce channel
        const [subs] = await pool.execute(
            'SELECT subscription_id, paused FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
            [message.guild.id, streamerId]
        );
        if (subs.length) {
            await pool.execute(
                'UPDATE subscriptions SET paused = 0, announcement_channel_id = ? WHERE subscription_id = ?',
                [stream_announcement_channel_id, subs[0].subscription_id]
            );
        } else {
            await pool.execute(
                'INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, paused) VALUES (?, ?, ?, 0)',
                [message.guild.id, streamerId, stream_announcement_channel_id]
            );
        }

        await message.react('✅').catch(() => {});
        logger.info(`[stream_signup] auto-subscribed ${parsed.platform}:${parsed.username} for ${message.author.tag} in guild ${message.guild.id}`);
    }
};
