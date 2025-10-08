const { SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const { endGiveaway } = require('../core/giveaway-manager');
const logger = require('../utils/logger');

// Time string parser (e.g., "10m", "1h", "2d")
function parseTime(timeStr) {
    const match = timeStr.match(/^(\d+)(s|m|h|d)$/);
    if (!match) return null;
    const value = parseInt(match[1]);
    const unit = match[2];
    let seconds = 0;
    switch (unit) {
        case 's': seconds = value; break;
        case 'm': seconds = value * 60; break;
        case 'h': seconds = value * 60 * 60; break;
        case 'd': seconds = value * 24 * 60 * 60; break;
    }
    return new Date(Date.now() + seconds * 1000);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Manage server giveaways.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('start')
                .setDescription('Starts a new giveaway in the current channel.')
                .addStringOption(option => option.setName('duration').setDescription('Duration of the giveaway (e.g., 10m, 2h, 1d).').setRequired(true))
                .addIntegerOption(option => option.setName('winners').setDescription('The number of winners.').setRequired(true).setMinValue(1))
                .addStringOption(option => option.setName('prize').setDescription('What the winner(s) will receive.').setRequired(true))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('reroll')
                .setDescription('Selects a new winner for a previous giveaway.')
                .addStringOption(option => option.setName('message-id').setDescription('The message ID of the giveaway to reroll.').setRequired(true))
        ),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const subcommand = interaction.options.getSubcommand();

        try {
            if (subcommand === 'start') {
                const duration = interaction.options.getString('duration');
                const winnerCount = interaction.options.getInteger('winners');
                const prize = interaction.options.getString('prize');
                const endsAt = parseTime(duration);

                if (!endsAt) {
                    return interaction.editReply('Invalid duration format. Please use formats like `30m`, `2h`, `1d`.');
                }

                const embed = new EmbedBuilder()
                    .setColor('#F1C40F')
                    .setTitle('🎉 GIVEAWAY! 🎉')
                    .setDescription(`React with 🎉 to enter!\n\n**Prize:** ${prize}`)
                    .addFields(
                        { name: 'Winners', value: winnerCount.toString(), inline: true },
                        { name: 'Ends', value: `<t:${Math.floor(endsAt.getTime() / 1000)}:R>`, inline: true }
                    )
                    .setFooter({ text: `Hosted by ${interaction.user.tag}` });

                const giveawayMessage = await interaction.channel.send({ embeds: [embed] });
                await giveawayMessage.react('🎉');

                await db.execute(
                    'INSERT INTO giveaways (guild_id, channel_id, message_id, prize, winner_count, ends_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [interaction.guild.id, interaction.channel.id, giveawayMessage.id, prize, winnerCount, endsAt, interaction.user.id]
                );

                await interaction.editReply('Giveaway started successfully!');
            } else if (subcommand === 'reroll') {
                const messageId = interaction.options.getString('message-id');
                const [[giveaway]] = await db.execute('SELECT * FROM giveaways WHERE message_id = ? AND guild_id = ?', [messageId, interaction.guild.id]);

                if (!giveaway) {
                    return interaction.editReply('Could not find a giveaway with that message ID.');
                }
                if (giveaway.is_active) {
                    return interaction.editReply('This giveaway has not ended yet. You can reroll it after it concludes.');
                }

                await endGiveaway(giveaway, true); // true for reroll
                await interaction.editReply('Giveaway has been rerolled.');
            }
        } catch (error) {
            logger.error('[Giveaway Command Error]', error);
            await interaction.editReply('An error occurred while managing the giveaway.');
        }
    },
};