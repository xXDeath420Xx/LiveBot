import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import encryption from '../../utils/encryption.js';
import { resolveStreamerIdentity, upsertStreamerByIdentity } from '../../utils/platforms/resolve-identity.js';
import * as rumbleApi from '../../utils/platforms/rumble.js';

const SUPPORTED_PLATFORMS = new Set(['twitch', 'kick', 'youtube', 'tiktok', 'trovo', 'facebook', 'rumble']);

export async function handleStreamSignupSubmit(interaction) {
    try {
        await interaction.deferReply({ ephemeral: true });
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;

        const platformRaw = interaction.fields.getTextInputValue('platform').trim().toLowerCase();
        const usernameRaw = interaction.fields.getTextInputValue('username').trim();
        const username = usernameRaw.replace(/^@/, '').replace(/https?:\/\/[^/]+\//i, '').split(/[/?#]/)[0];

        if (!SUPPORTED_PLATFORMS.has(platformRaw)) {
            return interaction.editReply(`Unsupported platform \`${platformRaw}\`. Try: ${Array.from(SUPPORTED_PLATFORMS).join(', ')}.`);
        }
        if (!username || username.length < 2) {
            return interaction.editReply('That username looks invalid. Please try again.');
        }

        const [configRows] = await pool.execute(
            'SELECT stream_announcement_channel_id FROM stream_signup_config WHERE guild_id = ?',
            [guildId]
        );
        if (!configRows.length) {
            return interaction.editReply('Stream signup is not configured.');
        }
        const announceChannelId = configRows[0].stream_announcement_channel_id;

        // Re-check the level gate at submit time (defence in depth against stale button state).
        const [levelRows] = await pool.execute(
            'SELECT level FROM user_levels WHERE guild_id = ? AND user_id = ?',
            [guildId, userId]
        );
        if ((levelRows[0]?.level ?? 0) < 3) {
            return interaction.editReply('You no longer meet the level requirement.');
        }

        // Rumble can't be resolved from a username (Cloudflare-blocked) — it needs the
        // streamer's Live Stream API key, collected in the modal's optional field.
        if (platformRaw === 'rumble') {
            const apiKey = (interaction.fields.getTextInputValue('api_key') || '').trim();
            if (!apiKey) {
                return interaction.editReply('Rumble sign-ups need your **Live Stream API key** in the last field of the form (get it at <https://rumble.com/account/livestream-api>). Re-open the form and paste it in.');
            }
            const v = await rumbleApi.validateKey(apiKey);
            if (!v.ok) {
                return interaction.editReply(`That Rumble API key didn't work: **${v.reason}**. Grab a fresh one from <https://rumble.com/account/livestream-api>.`);
            }
            await pool.execute(`CREATE TABLE IF NOT EXISTS rumble_stream_keys (
                rumble_username VARCHAR(255) NOT NULL PRIMARY KEY, api_key TEXT NOT NULL,
                discord_user_id VARCHAR(20) NULL, added_by VARCHAR(20) NULL, guild_id VARCHAR(20) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
            await pool.execute(
                `INSERT INTO rumble_stream_keys (rumble_username, api_key, discord_user_id, added_by, guild_id)
                 VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE api_key=VALUES(api_key), discord_user_id=VALUES(discord_user_id), guild_id=VALUES(guild_id)`,
                [username, JSON.stringify(encryption.encrypt(apiKey)), userId, userId, guildId]
            );
            const [ex] = await pool.execute('SELECT streamer_id FROM streamers WHERE platform=? AND username=?', ['rumble', username]);
            let rStreamerId;
            if (ex.length) {
                rStreamerId = ex[0].streamer_id;
            } else {
                const [ins] = await pool.execute(
                    'INSERT INTO streamers (platform, platform_user_id, username, discord_user_id, normalized_username) VALUES (?,?,?,?,?)',
                    ['rumble', String(v.channelId || username), username, userId, username.toLowerCase()]);
                rStreamerId = ins.insertId;
            }
            const [rSubs] = await pool.execute('SELECT subscription_id FROM subscriptions WHERE guild_id=? AND streamer_id=?', [guildId, rStreamerId]);
            if (rSubs.length) {
                await pool.execute('UPDATE subscriptions SET paused=0, announcement_channel_id=? WHERE subscription_id=?', [announceChannelId, rSubs[0].subscription_id]);
            } else {
                await pool.execute('INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, paused) VALUES (?,?,?,0)', [guildId, rStreamerId, announceChannelId]);
            }
            logger.info(`[stream_signup] ${interaction.user.tag} (${userId}) signed up rumble:${username} in guild ${guildId}`);
            return interaction.editReply(`✅ You're now in the shoutout rotation for **rumble:${username}** — go live and the bot will announce it in <#${announceChannelId}>.`);
        }

        // Resolve the real platform identity up front — never insert temp_ placeholders.
        const identity = await resolveStreamerIdentity(platformRaw, username);
        if (!identity) {
            return interaction.editReply(`Couldn't find **${platformRaw}:${username}** on ${platformRaw}. Check the username and try again.`);
        }
        const streamerId = await upsertStreamerByIdentity(pool, platformRaw, identity, userId);

        // Upsert the subscription for this guild.
        const [existingSubs] = await pool.execute(
            'SELECT subscription_id, paused FROM subscriptions WHERE guild_id = ? AND streamer_id = ?',
            [guildId, streamerId]
        );
        if (existingSubs.length) {
            await pool.execute(
                'UPDATE subscriptions SET paused = 0, announcement_channel_id = ? WHERE subscription_id = ?',
                [announceChannelId, existingSubs[0].subscription_id]
            );
        } else {
            await pool.execute(
                'INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, paused) VALUES (?, ?, ?, 0)',
                [guildId, streamerId, announceChannelId]
            );
        }

        logger.info(`[stream_signup] ${interaction.user.tag} (${userId}) signed up ${platformRaw}:${username} in guild ${guildId}`);
        await interaction.editReply(`✅ You're now in the shoutout rotation for **${platformRaw}:${username}** — go live and the bot will announce it in <#${announceChannelId}>.`);
    } catch (err) {
        logger.error('[stream_signup_submit] error', { err: err.message, stack: err.stack });
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'Sign-up failed. Ping a mod.', ephemeral: true }).catch(() => {});
        } else {
            await interaction.editReply('Sign-up failed. Ping a mod.').catch(() => {});
        }
    }
}

export default handleStreamSignupSubmit;
