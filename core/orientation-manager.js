import { EmbedBuilder, ChannelType, PermissionsBitField } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * Feature detection definitions.
 * Each entry maps a feature name to a query that checks if it's enabled for a guild.
 * The query should return at least one row if the feature is active.
 */
const FEATURE_CHECKS = [
    {
        name: 'Ticketing System',
        emoji: '\uD83C\uDFAB',
        query: 'SELECT panel_id FROM ticket_panels WHERE guild_id = ? LIMIT 1',
        hint: '/admin tickets'
    },
    {
        name: 'Leveling & Rank Cards',
        emoji: '\uD83D\uDCC8',
        query: 'SELECT guild_id FROM level_config WHERE guild_id = ? LIMIT 1',
        hint: '/admin leveling'
    },
    {
        name: 'Reaction Roles',
        emoji: '\uD83C\uDFAD',
        query: 'SELECT id FROM reaction_role_panels WHERE guild_id = ? LIMIT 1',
        hint: '/reactionroles'
    },
    {
        name: 'Stream Announcements',
        emoji: '\uD83D\uDCE1',
        query: `SELECT 1 FROM (
            SELECT guild_id FROM subscriptions WHERE guild_id = ?
            UNION ALL
            SELECT guild_id FROM self_promo_config WHERE guild_id = ? AND enabled = 1
            UNION ALL
            SELECT guild_id FROM guild_streamer_auto_track WHERE guild_id = ? AND enabled = 1
        ) t LIMIT 1`,
        params: 3,
        hint: '/subscribe'
    },
    {
        name: 'Self-Promo Tracking',
        emoji: '\uD83D\uDCE3',
        query: 'SELECT guild_id FROM self_promo_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: '/admin selfpromo'
    },
    {
        name: 'Community Support',
        emoji: '\uD83E\uDD1D',
        query: 'SELECT guild_id FROM community_support_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: 'Setup script'
    },
    {
        name: 'Logging / Audit Trail',
        emoji: '\uD83D\uDCDD',
        query: 'SELECT guild_id FROM logging_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: '/admin logging'
    },
    {
        name: 'Moderation Tools',
        emoji: '\uD83D\uDEE1\uFE0F',
        query: 'SELECT guild_id FROM moderation_config WHERE guild_id = ? LIMIT 1',
        hint: '/admin moderation'
    },
    {
        name: 'Phishing Protection',
        emoji: '\uD83D\uDEA8',
        query: 'SELECT guild_id FROM phishing_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: '/admin phishing'
    },
    {
        name: 'Global Ban Network',
        emoji: '\uD83C\uDF10',
        query: 'SELECT guild_id FROM global_ban_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: '/globalban'
    },
    {
        name: 'Anti-Nuke Protection',
        emoji: '\u2622\uFE0F',
        query: 'SELECT guild_id FROM anti_nuke_config WHERE guild_id = ? LIMIT 1',
        hint: '/admin antinuke'
    },
    {
        name: 'Economy System',
        emoji: '\uD83D\uDCB0',
        query: 'SELECT guild_id FROM economy_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: '/admin economy'
    },
    {
        name: 'Starboard',
        emoji: '\u2B50',
        query: 'SELECT guild_id FROM starboard_config WHERE guild_id = ? LIMIT 1',
        hint: '/admin starboard'
    },
    {
        name: 'Birthday Celebrations',
        emoji: '\uD83C\uDF82',
        query: 'SELECT guild_id FROM birthday_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: '/admin birthday'
    },
    {
        name: 'Suggestions',
        emoji: '\uD83D\uDCA1',
        query: 'SELECT guild_id FROM suggestion_config WHERE guild_id = ? LIMIT 1',
        hint: '/admin suggestions'
    },
    {
        name: 'Music Playback',
        emoji: '\uD83C\uDFB5',
        query: 'SELECT guild_id FROM music_config WHERE guild_id = ? LIMIT 1',
        hint: '/play'
    },
    {
        name: 'VC Sound Drops',
        emoji: '\uD83D\uDD0A',
        query: 'SELECT guild_id FROM vc_sound_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: '/admin vcsounds'
    },
    {
        name: 'Auto Publisher',
        emoji: '\uD83D\uDCE4',
        query: 'SELECT guild_id FROM auto_publisher_config WHERE guild_id = ? AND is_enabled = 1 LIMIT 1',
        hint: '/alerts autopublish'
    },
    {
        name: 'Welcome & Goodbye',
        emoji: '\uD83D\uDC4B',
        query: 'SELECT guild_id FROM welcome_settings WHERE guild_id = ? LIMIT 1',
        hint: '/admin welcome'
    },
    {
        name: 'Confessions',
        emoji: '\uD83E\uDD2B',
        query: 'SELECT guild_id FROM confession_config WHERE guild_id = ? LIMIT 1',
        hint: '/admin confessions'
    }
];

/**
 * Detect which features are enabled for a guild
 * @returns {{ enabled: Array, available: Array }}
 */
async function detectFeatures(guildId) {
    const enabled = [];
    const available = [];

    await Promise.all(FEATURE_CHECKS.map(async (feature) => {
        try {
            const paramCount = feature.params || 1;
            const params = Array(paramCount).fill(guildId);
            const [rows] = await pool.execute(feature.query, params);
            if (rows.length > 0) {
                enabled.push(feature);
            } else {
                available.push(feature);
            }
        } catch {
            // Table might not exist yet — treat as not enabled
            available.push(feature);
        }
    }));

    return { enabled, available };
}

/**
 * Build the orientation embed for a guild
 */
// Discord embed field values cap at 1024 chars — truncate on a line boundary so the embed never fails to build.
function capValue(s) {
    if (!s) return s;
    if (s.length <= 1024) return s;
    const cut = s.lastIndexOf('\n', 1000);
    return s.slice(0, cut > 0 ? cut : 1000) + '\n… use `/help` for the rest';
}

export async function buildOrientationEmbed(client, guildId) {
    const guild = client.guilds.cache.get(guildId);
    const botName = client.user.displayName || client.user.username;
    const { enabled, available } = await detectFeatures(guildId);

    const embed = new EmbedBuilder()
        .setAuthor({
            name: `${botName} — Server Guide`,
            iconURL: client.user.displayAvatarURL()
        })
        .setColor(0x5865F2)
        .setThumbnail(guild?.iconURL({ size: 128 }) || null)
        .setDescription(
            `Hey${guild ? ` **${guild.name}**` : ''}! Here's what I'm set up to do in this server.\n` +
            `Use \`/help\` to explore all commands.`
        )
        .setFooter({ text: `Use /help for the full command list • Last updated` })
        .setTimestamp();

    // Enabled features
    if (enabled.length > 0) {
        const lines = enabled.map(f => `${f.emoji} **${f.name}**`);
        embed.addFields({
            name: '\u2705 Active Features',
            value: capValue(lines.join('\n')),
            inline: false
        });
    }

    // Available but not configured
    if (available.length > 0) {
        const lines = available.map(f => `${f.emoji} ${f.name} — \`${f.hint}\``);
        embed.addFields({
            name: '\u2699\uFE0F Available to Set Up',
            value: capValue(lines.join('\n')),
            inline: false
        });
    }

    // Always-available features
    embed.addFields({
        name: '\uD83C\uDF1F Always Available',
        value: [
            '🎲 **Fun & Games** — trivia, 8ball, memes, hangman, Cards Against Humanity (`/cah`), word games (`/wordgame`)',
            '⚔️ **D&D RPG** — full 5e characters, dice, combat, spells, dungeons, party & PvP (`/rpg`)',
            '💰 **Economy & Arcade** — currency, shop, pets, gambling, counting & more (`/economy`, `/arcade`)',
            '🎵 **Music & Voice** — full player + AI DJ, VC sound drops (`/music`, `/voice`)',
            '🔧 **Utility** — reminders, polls, giveaways, tags, notes, weather, translate, QR & more (`/tools`)',
            '📅 **Info & Schedules** — server/user/avatar/role info + timed announcements (`/info`, `/schedule`)'
        ].join('\n'),
        inline: false
    });

    const dashboardUrl = process.env.DASHBOARD_URL || 'https://certifriedmultitool.com/';

    // Against_The_Tide stream team invite — any CertiFried user is welcome to apply.
    embed.addFields({
        name: '🌊 Join the Against_The_Tide Stream Team',
        value:
            'Stream on **Twitch, Kick, or YouTube?** Any CertiFried user is welcome to apply to our stream team, ' +
            `**Against_The_Tide**. Open a quick private application on the [dashboard](${dashboardUrl}stream-team) ` +
            '(no Discord login required) or in a server\'s stream-team-signup channel.\n' +
            '🔗 [twitch.tv/team/against_the_tide](https://www.twitch.tv/team/against_the_tide)',
        inline: false
    });

    // Dashboard link
    embed.addFields({
        name: '\uD83C\uDF10 Dashboard',
        value: `[Manage your server settings online](${dashboardUrl}manage/${guildId})`,
        inline: false
    });

    return embed;
}

/**
 * Post or update the orientation message in a channel.
 * Upserts the orientation_config record.
 */
export async function postOrientationMessage(client, guildId, channelId) {
    const embed = await buildOrientationEmbed(client, guildId);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return null;

    const channel = guild.channels.cache.get(channelId);
    if (!channel) return null;

    // Check for existing message
    const [existing] = await pool.execute(
        'SELECT message_id, channel_id FROM orientation_config WHERE guild_id = ?',
        [guildId]
    );

    // Try to edit existing message first
    if (existing.length > 0 && existing[0].message_id) {
        try {
            const oldChannel = guild.channels.cache.get(existing[0].channel_id);
            if (oldChannel) {
                const oldMsg = await oldChannel.messages.fetch(existing[0].message_id);
                if (oldMsg) {
                    await oldMsg.edit({ embeds: [embed] });
                    // Update channel if it changed
                    if (existing[0].channel_id !== channelId) {
                        await pool.execute(
                            'UPDATE orientation_config SET channel_id = ? WHERE guild_id = ?',
                            [channelId, guildId]
                        );
                    }
                    return oldMsg;
                }
            }
        } catch {
            // Message was deleted or channel inaccessible — send a new one
        }
    }

    // Send new message
    const msg = await channel.send({ embeds: [embed] });

    await pool.execute(`
        INSERT INTO orientation_config (guild_id, channel_id, message_id)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE
            channel_id = VALUES(channel_id),
            message_id = VALUES(message_id)
    `, [guildId, channelId, msg.id]);

    return msg;
}

/**
 * Update an existing orientation message in-place with fresh feature data.
 * Returns true if updated, false if no existing message found.
 */
export async function updateOrientationMessage(client, guildId) {
    const [rows] = await pool.execute(
        'SELECT channel_id, message_id FROM orientation_config WHERE guild_id = ?',
        [guildId]
    );

    if (rows.length === 0 || !rows[0].message_id) return false;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return false;

    const channel = guild.channels.cache.get(rows[0].channel_id);
    if (!channel) return false;

    try {
        const msg = await channel.messages.fetch(rows[0].message_id);
        const embed = await buildOrientationEmbed(client, guildId);
        await msg.edit({ embeds: [embed] });
        return true;
    } catch {
        logger.warn(`[Orientation] Could not update message for guild ${guildId} — message may have been deleted`);
        return false;
    }
}

/**
 * Remove the orientation message and clear config for a guild.
 */
export async function removeOrientationMessage(client, guildId) {
    const [rows] = await pool.execute(
        'SELECT channel_id, message_id FROM orientation_config WHERE guild_id = ?',
        [guildId]
    );

    if (rows.length > 0 && rows[0].message_id) {
        const guild = client.guilds.cache.get(guildId);
        if (guild) {
            try {
                const channel = guild.channels.cache.get(rows[0].channel_id);
                if (channel) {
                    const msg = await channel.messages.fetch(rows[0].message_id);
                    await msg.delete();
                }
            } catch {
                // Already deleted — that's fine
            }
        }
    }

    await pool.execute('DELETE FROM orientation_config WHERE guild_id = ?', [guildId]);
}

/**
 * Find a suitable channel to post the orientation message in a guild.
 * Only targets dedicated bot/staff/admin channels — never public channels.
 * Returns null if no suitable channel found (admin can manually /orientation post #channel).
 */
export function findSuitableChannel(guild) {
    const canSend = (ch) =>
        ch.type === ChannelType.GuildText &&
        ch.permissionsFor(guild.members.me)?.has(PermissionsBitField.Flags.SendMessages);

    // Only post to dedicated bot/staff/admin channels (checked in priority order)
    const preferredKeywords = [
        'orientation',
        'bot-orientation',
        'bot-info',
        'bot-commands',
        'bot-spam',
        'dev-test',
        'admin',
        'moderator-only',
        'mod-chat',
        'commands',
    ];

    for (const keyword of preferredKeywords) {
        const match = guild.channels.cache.find(
            ch => canSend(ch) && ch.name.toLowerCase().includes(keyword)
        );
        if (match) return match;
    }

    // No suitable channel — skip this guild
    return null;
}
