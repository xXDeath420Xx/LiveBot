import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { displayNameFor } from '../../utils/display-name.js';
import { themeColor } from '../../core/guild-theme.js';
import { getConfig as getFeatureConfig } from '../../core/feature-config.js';

/** Statuses a post can be acted on in: 'full' still lets members leave and the host close it. */
const LIVE_STATUSES = ['open', 'full'];
const DEFAULT_EXPIRE_HOURS = 12;

/** The LFG & Music Quiz page's auto-close setting, clamped to the page's 1-168 hours. Pure. */
export function lfgExpireHours(cfg) {
    const n = Math.trunc(Number(cfg?.lfg_expire_hours));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 168) : DEFAULT_EXPIRE_HOURS;
}

/** True when the bot can post an LFG card (embed + buttons) in this channel. */
function canPostIn(channel) {
    if (!channel?.isTextBased?.() || !channel.guild) return false;
    const me = channel.guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    return !!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]);
}

/**
 * Where a new post goes: the page's LFG channel when it is set and usable, else the channel the command
 * was used in. Returns { channel, configuredButUnusable }.
 */
function resolveLfgChannel(interaction, cfg) {
    const id = cfg?.lfg_channel_id ? String(cfg.lfg_channel_id) : null;
    if (!id) return { channel: interaction.channel, configuredButUnusable: false };
    const configured = interaction.guild.channels.cache.get(id) || null;
    if (canPostIn(configured)) return { channel: configured, configuredButUnusable: false };
    return { channel: interaction.channel, configuredButUnusable: true };
}

/**
 * Show a post as closed: status field, red, buttons disabled. Used by the Close button, /arcade lfg close
 * and the auto-close sweep (jobs/lfg-expiry.js). Never throws; false when the message is gone.
 */
export async function markLfgMessageClosed(client, post, label = 'Closed') {
    try {
        const channel = await client?.channels?.fetch(post.channel_id).catch(() => null);
        const msg = channel?.messages ? await channel.messages.fetch(post.message_id).catch(() => null) : null;
        if (!msg?.embeds?.[0]) return false;
        const embed = EmbedBuilder.from(msg.embeds[0]).setColor(themeColor(post.guild_id, 'danger'));
        if (embed.data.fields?.[1]) embed.data.fields[1].value = label;
        const rows = msg.components.map(r => {
            const row = ActionRowBuilder.from(r);
            row.components.forEach(c => c.setDisabled?.(true));
            return row;
        });
        await msg.edit({ embeds: [embed], components: rows });
        return true;
    } catch (err) {
        logger.warn('[LFG] Could not mark a post closed', { postId: post.id, error: err.message });
        return false;
    }
}

export async function handleCreate(interaction) {
    const game = interaction.options.getString('game');
    const activity = interaction.options.getString('activity');
    const maxPlayers = interaction.options.getInteger('players');
    const description = interaction.options.getString('description') || 'No additional details';
    const timeStr = interaction.options.getString('time');

    // LFG & Music Quiz page: LFG channel, ping role, auto-close hours.
    const cfg = await getFeatureConfig('arcade', interaction.guildId);
    const { channel: target, configuredButUnusable } = resolveLfgChannel(interaction, cfg);
    const pingRoleId = cfg.lfg_ping_role_id && interaction.guild.roles.cache.has(String(cfg.lfg_ping_role_id))
        ? String(cfg.lfg_ping_role_id) : null;
    const hours = lfgExpireHours(cfg);
    // A ping only notifies on a new message, never on the edit of a deferred reply, and a post in another
    // channel is a new message anyway: both are sent with channel.send and the member gets a private link.
    const postSeparately = target.id !== interaction.channelId || !!pingRoleId;

    await interaction.deferReply({ ephemeral: postSeparately });

    try {
        const closesAt = Math.floor(Date.now() / 1000) + hours * 3600;
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setTitle(`🎮 LFG: ${game}`)
            .setDescription(`**Activity:** ${activity.charAt(0).toUpperCase() + activity.slice(1)}\n**Description:** ${description}`)
            .addFields(
                { name: '👥 Players', value: `1/${maxPlayers}`, inline: true },
                { name: '🎯 Status', value: 'Open', inline: true }
            )
            .setAuthor({
                name: displayNameFor(interaction.user, interaction.guild),
                iconURL: interaction.user.displayAvatarURL()
            })
            .setFooter({ text: 'Click Join to participate!' })
            .setTimestamp();

        if (timeStr) {
            embed.addFields({ name: '🕐 Start Time', value: timeStr, inline: true });
        }
        embed.addFields({ name: '⏳ Closes', value: `<t:${closesAt}:R>`, inline: true });

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('lfg_join').setLabel('Join').setStyle(ButtonStyle.Success).setEmoji('✅'),
                new ButtonBuilder().setCustomId('lfg_leave').setLabel('Leave').setStyle(ButtonStyle.Danger).setEmoji('❌'),
                new ButtonBuilder().setCustomId('lfg_close').setLabel('Close').setStyle(ButtonStyle.Secondary).setEmoji('🔒')
            );

        let message;
        if (postSeparately) {
            message = await target.send({
                content: pingRoleId ? `<@&${pingRoleId}>` : undefined,
                embeds: [embed],
                components: [row],
                allowedMentions: { parse: [], roles: pingRoleId ? [pingRoleId] : [] },
            });
        } else {
            message = await interaction.editReply({ embeds: [embed], components: [row] });
        }

        const [result] = await pool.execute(
            `INSERT INTO lfg_posts (guild_id, channel_id, message_id, creator_id, game_name, activity_type, description, max_players, current_players, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
            [interaction.guild.id, target.id, message.id, interaction.user.id, game, activity, description, maxPlayers, hours]
        );

        await pool.execute(
            'INSERT INTO lfg_participants (lfg_id, user_id) VALUES (?, ?)',
            [result.insertId, interaction.user.id]
        );

        if (postSeparately) {
            const note = configuredButUnusable
                ? '\n(The LFG channel set on the dashboard is missing or I cannot post there, so it went in this channel.)'
                : '';
            await interaction.editReply({ content: `✅ Your LFG post is up in <#${target.id}>: ${message.url}${note}` });
        }
    } catch (error) {
        console.error('[LFG Command Error]', error);
        const replyMethod = interaction.deferred ? 'editReply' : 'reply';
        return interaction[replyMethod]({ content: '❌ An error occurred while creating the LFG post.', ephemeral: true });
    }
}

export async function handleListLfg(interaction) {
    await interaction.deferReply();

    try {
        const [posts] = await pool.execute(
            `SELECT * FROM lfg_posts
             WHERE guild_id = ? AND status = 'open' AND (expires_at IS NULL OR expires_at > NOW())
             ORDER BY created_at DESC
             LIMIT 10`,
            [interaction.guild.id]
        );

        if (posts.length === 0) {
            return interaction.editReply({ content: 'No active LFG posts found. Create one with `/arcade lfg create`!' });
        }

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle('🎮 Active LFG Posts')
            .setTimestamp();

        const postList = await Promise.all(posts.map(async (post) => {
            const creator = await interaction.client.users.fetch(post.creator_id).catch(() => null);
            const creatorName = displayNameFor(creator, interaction.guild);

            return `**${post.game_name}** - ${post.activity_type}\n` +
                `Players: ${post.current_players}/${post.max_players} | Host: ${creatorName}\n` +
                `[Jump to Post](https://discord.com/channels/${post.guild_id}/${post.channel_id}/${post.message_id})`;
        }));

        embed.setDescription(postList.join('\n\n'));

        return interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[LFG Command Error]', error);
        return interaction.editReply({ content: '❌ An error occurred while listing LFG posts.', ephemeral: true });
    }
}

export async function handleClose(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const [posts] = await pool.execute(
            `SELECT * FROM lfg_posts WHERE guild_id = ? AND creator_id = ? AND status IN ('open', 'full')`,
            [interaction.guild.id, interaction.user.id]
        );

        if (posts.length === 0) {
            return interaction.editReply({ content: '❌ You don\'t have any active LFG posts to close.' });
        }

        await pool.execute(
            `UPDATE lfg_posts SET status = 'closed' WHERE guild_id = ? AND creator_id = ? AND status IN ('open', 'full')`,
            [interaction.guild.id, interaction.user.id]
        );
        const client = global.botManager?.getClientForGuild?.(interaction.guild.id) || interaction.client;
        for (const post of posts) await markLfgMessageClosed(client, post, 'Closed');

        return interaction.editReply({ content: `✅ Closed ${posts.length} LFG ${posts.length === 1 ? 'post' : 'posts'}.` });
    } catch (error) {
        console.error('[LFG Command Error]', error);
        return interaction.editReply({ content: '❌ An error occurred while closing your LFG posts.', ephemeral: true });
    }
}

export async function handleButton(interaction) {
    try {
        const messageId = interaction.message.id;

        const [[post]] = await pool.execute(
            'SELECT * FROM lfg_posts WHERE message_id = ?',
            [messageId]
        );

        // 'full' posts stay live: members can still leave and the host can close them.
        const expired = post?.expires_at && new Date(post.expires_at).getTime() <= Date.now();
        if (!post || !LIVE_STATUSES.includes(post.status) || expired) {
            return interaction.reply({ content: '❌ This LFG post is no longer active.', ephemeral: true });
        }

        if (interaction.customId === 'lfg_join') {
            const [[existing]] = await pool.execute(
                'SELECT * FROM lfg_participants WHERE lfg_id = ? AND user_id = ?',
                [post.id, interaction.user.id]
            );

            if (existing) {
                return interaction.reply({ content: '❌ You are already in this group!', ephemeral: true });
            }

            if (post.current_players >= post.max_players) {
                return interaction.reply({ content: '❌ This group is full!', ephemeral: true });
            }

            await pool.execute('INSERT INTO lfg_participants (lfg_id, user_id) VALUES (?, ?)', [post.id, interaction.user.id]);
            await pool.execute('UPDATE lfg_posts SET current_players = current_players + 1 WHERE id = ?', [post.id]);

            const newCount = post.current_players + 1;
            const embed = EmbedBuilder.from(interaction.message.embeds[0]);
            embed.data.fields[0].value = `${newCount}/${post.max_players}`;

            if (newCount >= post.max_players) {
                embed.data.fields[1].value = 'Full';
                await pool.execute('UPDATE lfg_posts SET status = "full" WHERE id = ?', [post.id]);
            }

            await interaction.update({ embeds: [embed] });
            return interaction.followUp({ content: `✅ You joined the group! (${newCount}/${post.max_players})`, ephemeral: true });

        } else if (interaction.customId === 'lfg_leave') {
            const [[participant]] = await pool.execute(
                'SELECT * FROM lfg_participants WHERE lfg_id = ? AND user_id = ?',
                [post.id, interaction.user.id]
            );

            if (!participant) {
                return interaction.reply({ content: '❌ You are not in this group!', ephemeral: true });
            }

            if (interaction.user.id === post.creator_id) {
                return interaction.reply({ content: '❌ You can\'t leave your own group! Use `/arcade lfg close` instead.', ephemeral: true });
            }

            await pool.execute('DELETE FROM lfg_participants WHERE lfg_id = ? AND user_id = ?', [post.id, interaction.user.id]);
            await pool.execute('UPDATE lfg_posts SET current_players = current_players - 1, status = "open" WHERE id = ?', [post.id]);

            const newCount = post.current_players - 1;
            const embed = EmbedBuilder.from(interaction.message.embeds[0]);
            embed.data.fields[0].value = `${newCount}/${post.max_players}`;
            embed.data.fields[1].value = 'Open';

            await interaction.update({ embeds: [embed] });
            return interaction.followUp({ content: '✅ You left the group.', ephemeral: true });

        } else if (interaction.customId === 'lfg_close') {
            if (interaction.user.id !== post.creator_id) {
                return interaction.reply({ content: '❌ Only the group creator can close this post!', ephemeral: true });
            }

            await pool.execute('UPDATE lfg_posts SET status = "closed" WHERE id = ?', [post.id]);

            const embed = EmbedBuilder.from(interaction.message.embeds[0]);
            embed.setColor(themeColor(interaction.guildId, 'danger'));
            embed.data.fields[1].value = 'Closed';

            const row = ActionRowBuilder.from(interaction.message.components[0]);
            row.components.forEach(button => button.setDisabled(true));

            await interaction.update({ embeds: [embed], components: [row] });
            return interaction.followUp({ content: '✅ LFG post closed.', ephemeral: true });
        }
    } catch (error) {
        console.error('[LFG Button Error]', error);
        return interaction.reply({ content: '❌ An error occurred.', ephemeral: true });
    }
}
