import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import logger from '../../utils/logger.js';

export default {
    category: 'info',
    data: new SlashCommandBuilder()
        .setName('user')
        .setDescription('User profiles, avatars & emoji statistics')

        // ── Profile Group ──
        .addSubcommandGroup(group =>
            group.setName('profile')
                .setDescription('User profile information')
                .addSubcommand(sub =>
                    sub.setName('avatar')
                        .setDescription('Display a user\'s avatar')
                        .addUserOption(opt => opt.setName('user').setDescription('The user whose avatar to display (defaults to you)')))
                .addSubcommand(sub =>
                    sub.setName('info')
                        .setDescription('Display information about a user')
                        .addUserOption(opt => opt.setName('user').setDescription('The user to get info about (defaults to you)'))))

        // ── Emoji Stats Group ──
        .addSubcommandGroup(group =>
            group.setName('emojistats')
                .setDescription('View emoji usage statistics')
                .addSubcommand(sub =>
                    sub.setName('top')
                        .setDescription('View most used emojis')
                        .addIntegerOption(opt => opt.setName('days').setDescription('Number of days to analyze (default: 7)').setMinValue(1).setMaxValue(90))
                        .addBooleanOption(opt => opt.setName('custom').setDescription('Show only custom server emojis')))
                .addSubcommand(sub =>
                    sub.setName('user')
                        .setDescription('View a user\'s most used emojis')
                        .addUserOption(opt => opt.setName('target').setDescription('User to check (default: you)'))
                        .addIntegerOption(opt => opt.setName('days').setDescription('Number of days to analyze (default: 30)').setMinValue(1).setMaxValue(90)))
                .addSubcommand(sub =>
                    sub.setName('topusers')
                        .setDescription('View users who use emojis the most')
                        .addIntegerOption(opt => opt.setName('days').setDescription('Number of days to analyze (default: 7)').setMinValue(1).setMaxValue(30)))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        try {
            if (group === 'profile') {
                if (subcommand === 'avatar') {
                    return await handleAvatar(interaction);
                } else if (subcommand === 'info') {
                    return await handleUserInfo(interaction);
                }
            } else if (group === 'emojistats') {
                return await handleEmojiStats(interaction, subcommand);
            }
        } catch (error) {
            logger.error('[User Command] Error:', { error: error.message, group, subcommand, stack: error.stack });

            const reply = { content: `Error: ${error.message}`, ephemeral: true };
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(reply);
            } else {
                await interaction.reply(reply);
            }
        }
    }
};

// ── Avatar Handler ──
async function handleAvatar(interaction) {
    const user = interaction.options.getUser('user') || interaction.user;

    const embed = new EmbedBuilder()
        .setColor('#5865F2')
        .setTitle(`${user.tag}'s Avatar`)
        .setImage(user.displayAvatarURL({ size: 1024, dynamic: true }))
        .setDescription(`[Download PNG](${user.displayAvatarURL({ extension: 'png', size: 1024 })}) | [Download JPG](${user.displayAvatarURL({ extension: 'jpg', size: 1024 })}) | [Download WEBP](${user.displayAvatarURL({ extension: 'webp', size: 1024 })})`)
        .setFooter({ text: `Requested by ${interaction.user.tag}` })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

// ── User Info Handler ──
export async function handleUserInfo(interaction) {
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const member = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

    if (!member) {
        return interaction.editReply({ content: 'Could not find that user in the server.' });
    }

    const roles = member.roles.cache
        .sort((a, b) => b.position - a.position)
        .map(role => role.toString())
        .slice(0, -1);

    const embed = new EmbedBuilder()
        .setColor(member.displayHexColor || '#95A5A6')
        .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
        .setThumbnail(member.user.displayAvatarURL({ size: 256 }))
        .addFields(
            { name: 'User', value: `${member.user} (${member.id})`, inline: false },
            { name: 'Nickname', value: member.nickname || 'None', inline: true },
            { name: 'Bot Account', value: member.user.bot ? 'Yes' : 'No', inline: true },
            { name: 'Joined Server', value: `<t:${Math.floor((member.joinedTimestamp || 0) / 1000)}:R>`, inline: true },
            { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
            { name: `Roles [${roles.length}]`, value: roles.length > 0 ? roles.join(', ').substring(0, 1024) : 'None', inline: false }
        )
        .setFooter({ text: `Requested by ${interaction.user.tag}` })
        .setTimestamp();

    if (member.presence) {
        const statusEmojis = {
            online: '🟢 Online', idle: '🟡 Idle',
            dnd: '🔴 Do Not Disturb', offline: '⚫ Offline'
        };
        embed.addFields({ name: 'Status', value: statusEmojis[member.presence.status] || 'Unknown', inline: true });
    }

    return interaction.editReply({ embeds: [embed] });
}

// ── Emoji Stats Handler ──
async function handleEmojiStats(interaction, subcommand) {
    const emojiStatsManager = interaction.client.emojiStatsManager;

    if (!emojiStatsManager) {
        return interaction.reply({ content: 'Emoji statistics system is not available.', ephemeral: true });
    }

    await interaction.deferReply();

    if (subcommand === 'top') {
        const days = interaction.options.getInteger('days') || 7;
        const customOnly = interaction.options.getBoolean('custom') || false;

        const topEmojis = await emojiStatsManager.getTopEmojis(interaction.guild.id, days, 15, customOnly);

        if (topEmojis.length === 0) {
            return interaction.editReply({
                content: customOnly ? 'No custom emoji usage data available yet.' : 'No emoji usage data available yet.'
            });
        }

        const embed = new EmbedBuilder()
            .setColor('#FEE75C')
            .setTitle(`${customOnly ? '🎨 Top Custom Emojis' : '😀 Top Emojis'} (Last ${days} Days)`)
            .setTimestamp();

        const emojiList = topEmojis.map((emoji, index) => {
            const emojiDisplay = emojiStatsManager.formatEmoji(emoji);
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**${index + 1}.**`;
            return `${medal} ${emojiDisplay} \`${emoji.emoji_name}\`\n└ ${emoji.total_uses.toLocaleString()} uses | ${emoji.unique_users} ${emoji.unique_users === 1 ? 'user' : 'users'}`;
        }).join('\n\n');

        embed.setDescription(emojiList);
        return interaction.editReply({ embeds: [embed] });

    } else if (subcommand === 'user') {
        const targetUser = interaction.options.getUser('target') || interaction.user;
        const days = interaction.options.getInteger('days') || 30;
        const isOwnProfile = targetUser.id === interaction.user.id;

        const topEmojis = await emojiStatsManager.getUserTopEmojis(interaction.guild.id, targetUser.id, days, 10);

        if (topEmojis.length === 0) {
            return interaction.editReply({
                content: `${isOwnProfile ? 'You haven\'t' : `${targetUser.username} hasn't`} used any emojis in the last ${days} days.`
            });
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle(`${isOwnProfile ? 'Your' : `${targetUser.username}'s`} Favorite Emojis`)
            .setDescription(`Most used emojis in the last ${days} days`)
            .setThumbnail(targetUser.displayAvatarURL())
            .setTimestamp();

        const emojiList = topEmojis.map((emoji, index) => {
            const emojiDisplay = emojiStatsManager.formatEmoji(emoji);
            return `**${index + 1}.** ${emojiDisplay} \`${emoji.emoji_name}\` - ${emoji.total_uses.toLocaleString()} ${emoji.total_uses === 1 ? 'use' : 'uses'}`;
        }).join('\n');

        embed.addFields({ name: 'Top Emojis', value: emojiList });
        return interaction.editReply({ embeds: [embed] });

    } else if (subcommand === 'topusers') {
        const days = interaction.options.getInteger('days') || 7;

        const topUsers = await emojiStatsManager.getTopEmojiUsers(interaction.guild.id, days, 10);

        if (topUsers.length === 0) {
            return interaction.editReply({ content: 'No emoji usage data available yet.' });
        }

        const embed = new EmbedBuilder()
            .setColor('#EB459E')
            .setTitle(`👥 Top Emoji Users (Last ${days} Days)`)
            .setDescription('Users who love emojis the most!')
            .setTimestamp();

        const userList = await Promise.all(
            topUsers.map(async (userData, index) => {
                const user = await interaction.client.users.fetch(userData.user_id).catch(() => null);
                const username = user ? user.username : 'Unknown User';
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**${index + 1}.**`;
                return `${medal} **${username}**\n└ ${userData.total_emojis.toLocaleString()} emojis | ${userData.unique_emojis} different emojis`;
            })
        );

        embed.setDescription(userList.join('\n\n'));
        return interaction.editReply({ embeds: [embed] });
    }
}
