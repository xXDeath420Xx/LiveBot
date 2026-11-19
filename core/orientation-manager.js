import { EmbedBuilder, ChannelType, PermissionsBitField } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { themeColor } from './guild-theme.js';

/**
 * Feature detection definitions.
 * Each entry maps a feature name to a query that checks if it's enabled for a guild.
 * The query should return at least one row if the feature is active.
 *
 * `hint` says how to set it up: `slash` is a real slash command path (picked from the / menu), `page` a dashboard
 * page (its title in core/manage-nav.js) where there is no setup command. tests/orientation-commands.test.js checks
 * that every command the guide names exists, as slash or as text, in the form it is named (H-717).
 */
export const FEATURE_CHECKS = [
    {
        name: 'Ticketing System',
        emoji: '\uD83C\uDFAB',
        query: 'SELECT panel_id FROM ticket_panels WHERE guild_id = ? LIMIT 1',
        hint: { slash: '/support ticket setup' }
    },
    {
        name: 'Leveling & Rank Cards',
        emoji: '\uD83D\uDCC8',
        query: 'SELECT guild_id FROM level_config WHERE guild_id = ? LIMIT 1',
        hint: { slash: '/level setup' }
    },
    {
        name: 'Reaction Roles',
        emoji: '\uD83C\uDFAD',
        query: 'SELECT id FROM reaction_role_panels WHERE guild_id = ? LIMIT 1',
        hint: { slash: '/manage roles create-panel' }
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
        hint: { slash: '/socials streamer add' }
    },
    {
        name: 'Self-Promo Tracking',
        emoji: '\uD83D\uDCE3',
        query: 'SELECT guild_id FROM self_promo_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: { slash: '/systems selfpromo setup' }
    },
    {
        name: 'Community Support',
        emoji: '\uD83E\uDD1D',
        query: 'SELECT guild_id FROM community_support_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: { slash: '/systems community setup' }
    },
    {
        name: 'Logging / Audit Trail',
        emoji: '\uD83D\uDCDD',
        query: 'SELECT guild_id FROM logging_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: { slash: '/manage logs-setup apply' }
    },
    {
        name: 'Moderation Tools',
        emoji: '\uD83D\uDEE1\uFE0F',
        query: 'SELECT guild_id FROM moderation_config WHERE guild_id = ? LIMIT 1',
        hint: { page: 'Moderation' }
    },
    {
        name: 'Phishing Protection',
        emoji: '\uD83D\uDEA8',
        query: 'SELECT guild_id FROM phishing_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: { page: 'Phishing links' }
    },
    {
        name: 'Global Ban Network',
        emoji: '\uD83C\uDF10',
        query: 'SELECT guild_id FROM global_ban_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: { slash: '/protection globalban enable' }
    },
    {
        name: 'Anti-Nuke Protection',
        emoji: '\u2622\uFE0F',
        query: 'SELECT guild_id FROM anti_nuke_config WHERE guild_id = ? LIMIT 1',
        hint: { slash: '/protection antinuke enable' }
    },
    {
        name: 'Economy System',
        emoji: '\uD83D\uDCB0',
        query: 'SELECT guild_id FROM economy_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: { page: 'Economy' }
    },
    {
        name: 'Starboard',
        emoji: '\u2B50',
        query: 'SELECT guild_id FROM starboard_config WHERE guild_id = ? LIMIT 1',
        hint: { slash: '/community starboard setup' }
    },
    {
        name: 'Birthday Celebrations',
        emoji: '\uD83C\uDF82',
        query: 'SELECT guild_id FROM birthday_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: { slash: '/engage birthday setup' }
    },
    {
        name: 'Suggestions',
        emoji: '\uD83D\uDCA1',
        query: 'SELECT guild_id FROM suggestion_config WHERE guild_id = ? LIMIT 1',
        hint: { slash: '/engage suggest setup' }
    },
    {
        name: 'Music Playback',
        emoji: '\uD83C\uDFB5',
        query: 'SELECT guild_id FROM music_config WHERE guild_id = ? LIMIT 1',
        hint: { slash: '/music play' }
    },
    {
        name: 'VC Sound Drops',
        emoji: '\uD83D\uDD0A',
        query: 'SELECT guild_id FROM vc_sound_config WHERE guild_id = ? AND enabled = 1 LIMIT 1',
        hint: { slash: '/admin vcsounds enable' }
    },
    {
        name: 'Auto Publisher',
        emoji: '\uD83D\uDCE4',
        query: 'SELECT guild_id FROM auto_publisher_config WHERE guild_id = ? AND is_enabled = 1 LIMIT 1',
        hint: { slash: '/alerts autopublish enable' }
    },
    {
        name: 'Welcome & Goodbye',
        emoji: '\uD83D\uDC4B',
        query: 'SELECT guild_id FROM welcome_settings WHERE guild_id = ? LIMIT 1',
        hint: { slash: '/manage welcome set-welcome' }
    },
    {
        name: 'Confessions',
        emoji: '\uD83E\uDD2B',
        query: 'SELECT guild_id FROM confession_config WHERE guild_id = ? LIMIT 1',
        hint: { page: 'Confessions' }
    }
];

/**
 * The "Always Available" lines. `slash`: picked from the / menu. `typed`: text commands (not registered with
 * Discord since the slash/text split, docs/command-split-2026-11-18.md), typed as a message that starts with /.
 */
export const ALWAYS_AVAILABLE = [
    { emoji: '🎲', title: 'Fun & Games', text: 'jokes, 8ball, memes, Cards Against Humanity and word games', typed: ['/8ball', '/meme', '/cah', '/wordgame'] },
    { emoji: '⚔️', title: 'D&D RPG', text: '5e characters, dice, combat, spells, dungeons, party and PvP', typed: ['/rpg'] },
    { emoji: '💰', title: 'Economy & Arcade', text: 'currency, shop, pets, gambling and arcade games', typed: ['/economy', '/arcade'] },
    { emoji: '🎵', title: 'Music & Voice', text: 'a full music player with an AI DJ, and tools for your own voice channel', slash: ['/music'], typed: ['/voice'] },
    { emoji: '🔧', title: 'Utility', text: 'translate, QR codes, unit and currency converters, colours, AFK and more', typed: ['/tools'] },
    { emoji: '📅', title: 'Info & Schedules', text: 'server and member info, and event schedules', typed: ['/server info', '/user profile info'], slash: ['/schedule'] },
];

const codeList = (list) => {
    const items = list.map(c => `\`${c}\``);
    return items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}` : items[0];
};

/** One "Available to Set Up" line: the setup command, or the dashboard page when there is no command. */
export function hintText(hint) {
    if (hint?.slash) return `\`${hint.slash}\``;
    if (hint?.page) return `dashboard, ${hint.page} page`;
    return 'dashboard';
}

/** One "Always Available" line, saying which commands are picked from the / menu and which are typed. */
export function alwaysAvailableLine(item) {
    const parts = [];
    if (item.slash?.length) parts.push(`pick ${codeList(item.slash)} from the / menu`);
    if (item.typed?.length) parts.push(`type ${codeList(item.typed)} as a message`);
    const how = parts.join('; ');
    return `${item.emoji} **${item.title}**: ${item.text}. ${how.charAt(0).toUpperCase()}${how.slice(1)}.`;
}

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

export async function buildOrientationEmbed(client, guildId, { detect = detectFeatures } = {}) {
    const guild = client.guilds.cache.get(guildId);
    const botName = client.user.displayName || client.user.username;
    const { enabled, available } = await detect(guildId);

    const embed = new EmbedBuilder()
        .setAuthor({
            name: `${botName} — Server Guide`,
            iconURL: client.user.displayAvatarURL()
        })
        .setColor(themeColor(guildId, 'primary'))
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
        const lines = available.map(f => `${f.emoji} ${f.name}: ${hintText(f.hint)}`);
        embed.addFields({
            name: '\u2699\uFE0F Available to Set Up',
            value: capValue(lines.join('\n')),
            inline: false
        });
    }

    // Always-available features
    embed.addFields({
        name: '\uD83C\uDF1F Always Available',
        value: capValue(ALWAYS_AVAILABLE.map(alwaysAvailableLine).join('\n')),
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
export async function postOrientationMessage(client, guildId, channelId, { fresh = false } = {}) {
    const embed = await buildOrientationEmbed(client, guildId);
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return null;

    // Cache misses are normal for channels nobody has spoken in since the last
    // restart. Falling straight to null here reported "failed to post" for a
    // channel that was perfectly fine.
    const channel = guild.channels.cache.get(channelId)
        || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased?.()) return null;

    // Check for existing message
    const [existing] = await pool.execute(
        'SELECT message_id, channel_id FROM orientation_config WHERE guild_id = ?',
        [guildId]
    );

    const oldChannelId = existing[0]?.channel_id;
    const oldMessageId = existing[0]?.message_id;

    if (oldMessageId) {
        const oldChannel = oldChannelId === channelId
            ? channel
            : (guild.channels.cache.get(oldChannelId) || await guild.channels.fetch(oldChannelId).catch(() => null));

        // A different target channel is an explicit "put it HERE". Editing the
        // old copy in its old channel and then recording the new channel id was
        // the worst of both: the message never moved, and the config lied about
        // where it lived.
        const moving = oldChannelId !== channelId;

        if (fresh || moving) {
            // The old copy has to go — otherwise the guild ends up with two
            // orientation embeds.
            if (oldChannel) {
                await oldChannel.messages.delete(oldMessageId).catch(() => {
                    // Already gone, or we lost access. Either way, post the new one.
                });
            }
        } else {
            // Editing in place is the right default: it keeps the message at
            // its pinned/linked position and avoids spamming the channel every
            // time a feature is toggled.
            try {
                if (oldChannel) {
                    const oldMsg = await oldChannel.messages.fetch(oldMessageId);
                    if (oldMsg) {
                        await oldMsg.edit({ embeds: [embed] });
                        return { message: oldMsg, action: 'edited' };
                    }
                }
            } catch {
                // Message was deleted or channel inaccessible — send a new one
            }
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

    return { message: msg, action: 'posted' };
}

/**
 * The dashboard's Orientation page saved a different guide channel (orientation_config.channel_id is
 * already written by then). Deletes the guide from where it was and posts it in the new channel, or
 * removes the config when the channel was cleared. Without this the row named the new channel while
 * the message stayed in the old one, so /systems orientation update could no longer find it.
 * @returns {Promise<{ action: 'posted'|'failed'|'removed'|'unavailable', channelId?: string }>}
 */
export async function moveOrientationMessage(client, guildId, { fromChannelId = null, messageId = null, toChannelId = null } = {},
    { db = pool, post = postOrientationMessage } = {}) {
    const guild = client?.guilds?.cache?.get(guildId);
    if (!guild) return { action: 'unavailable' };
    if (fromChannelId && messageId) {
        const old = guild.channels.cache.get(fromChannelId) || await guild.channels.fetch(fromChannelId).catch(() => null);
        if (old?.messages) await old.messages.delete(messageId).catch(() => {});
    }
    if (!toChannelId) {
        await db.execute('DELETE FROM orientation_config WHERE guild_id = ?', [guildId]);
        return { action: 'removed' };
    }
    await db.execute('UPDATE orientation_config SET message_id = NULL WHERE guild_id = ?', [guildId]);
    const result = await post(client, guildId, toChannelId).catch(() => null);
    return { action: result ? 'posted' : 'failed', channelId: toChannelId };
}

/** The save message for moveOrientationMessage's result. */
export function describeOrientationMove(result) {
    switch (result?.action) {
        case 'posted': return ' The guide was posted in the new channel.';
        case 'failed': return ' The guide could not be posted there. Check that the bot can see and send messages in that channel, then save again.';
        case 'removed': return ' The guide message was removed.';
        case 'unavailable': return ' The bot is not available right now, so the guide was not moved. Use /systems orientation post to post it.';
        default: return '';
    }
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
