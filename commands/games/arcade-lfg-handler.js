import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../../utils/db.js';

export async function handleCreate(interaction) {
    const game = interaction.options.getString('game');
    const activity = interaction.options.getString('activity');
    const maxPlayers = interaction.options.getInteger('players');
    const description = interaction.options.getString('description') || 'No additional details';
    const timeStr = interaction.options.getString('time');

    await interaction.deferReply();

    try {
        const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setTitle(`🎮 LFG: ${game}`)
            .setDescription(`**Activity:** ${activity.charAt(0).toUpperCase() + activity.slice(1)}\n**Description:** ${description}`)
            .addFields(
                { name: '👥 Players', value: `1/${maxPlayers}`, inline: true },
                { name: '🎯 Status', value: 'Open', inline: true }
            )
            .setAuthor({
                name: interaction.user.username,
                iconURL: interaction.user.displayAvatarURL()
            })
            .setFooter({ text: 'Click Join to participate!' })
            .setTimestamp();

        if (timeStr) {
            embed.addFields({ name: '🕐 Start Time', value: timeStr, inline: true });
        }

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('lfg_join').setLabel('Join').setStyle(ButtonStyle.Success).setEmoji('✅'),
                new ButtonBuilder().setCustomId('lfg_leave').setLabel('Leave').setStyle(ButtonStyle.Danger).setEmoji('❌'),
                new ButtonBuilder().setCustomId('lfg_close').setLabel('Close').setStyle(ButtonStyle.Secondary).setEmoji('🔒')
            );

        const message = await interaction.editReply({ embeds: [embed], components: [row] });

        const [result] = await pool.execute(
            `INSERT INTO lfg_posts (guild_id, channel_id, message_id, creator_id, game_name, activity_type, description, max_players, current_players, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, DATE_ADD(NOW(), INTERVAL 4 HOUR))`,
            [interaction.guild.id, interaction.channel.id, message.id, interaction.user.id, game, activity, description, maxPlayers]
        );

        await pool.execute(
            'INSERT INTO lfg_participants (lfg_id, user_id) VALUES (?, ?)',
            [result.insertId, interaction.user.id]
        );
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
            .setColor('#5865F2')
            .setTitle('🎮 Active LFG Posts')
            .setTimestamp();

        const postList = await Promise.all(posts.map(async (post) => {
            const creator = await interaction.client.users.fetch(post.creator_id).catch(() => null);
            const creatorName = creator ? creator.username : 'Unknown';

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
            'SELECT * FROM lfg_posts WHERE guild_id = ? AND creator_id = ? AND status = "open"',
            [interaction.guild.id, interaction.user.id]
        );

        if (posts.length === 0) {
            return interaction.editReply({ content: '❌ You don\'t have any active LFG posts to close.' });
        }

        await pool.execute(
            'UPDATE lfg_posts SET status = "closed" WHERE guild_id = ? AND creator_id = ? AND status = "open"',
            [interaction.guild.id, interaction.user.id]
        );

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

        if (!post || post.status !== 'open') {
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
            embed.setColor('#ED4245');
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
