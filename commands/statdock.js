const { SlashCommandBuilder, PermissionsBitField, ChannelType, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const logger = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('statdock')
        .setDescription('Manage dynamic channel name counters.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Creates a new statdock channel.')
                .addStringOption(option => 
                    option.setName('template')
                        .setDescription('The name template. Use {members}, {online}, {bots}. e.g., "👥 Members: {members}"')
                        .setRequired(true))
                .addChannelOption(option => 
                    option.setName('category')
                        .setDescription('Optional category to create the channel in.')
                        .addChannelTypes(ChannelType.GuildCategory)
                        .setRequired(false))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Removes a statdock channel.')
                .addChannelOption(option => option.setName('channel').setDescription('The statdock channel to remove.').setRequired(true))
        ),

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const subcommand = interaction.options.getSubcommand();
        const guild = interaction.guild;

        try {
            if (subcommand === 'add') {
                const template = interaction.options.getString('template');
                const category = interaction.options.getChannel('category');

                const newChannel = await guild.channels.create({
                    name: 'Loading...',
                    type: ChannelType.GuildVoice,
                    parent: category?.id || null,
                    permissionOverwrites: [
                        { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.Connect] }
                    ]
                });

                await db.execute(
                    'INSERT INTO statdocks_config (guild_id, channel_id, template) VALUES (?, ?, ?)',
                    [guild.id, newChannel.id, template]
                );

                await interaction.editReply(`✅ Statdock channel ${newChannel} created! It will update shortly.`);
                // We could trigger an immediate update here, but the scheduler will pick it up.

            } else if (subcommand === 'remove') {
                const channel = interaction.options.getChannel('channel');

                const [result] = await db.execute('DELETE FROM statdocks_config WHERE guild_id = ? AND channel_id = ?', [guild.id, channel.id]);
                
                if (result.affectedRows > 0) {
                    await channel.delete('Statdock removed.').catch(e => logger.warn(`Failed to delete statdock channel ${channel.id}:`, e));
                    await interaction.editReply(`🗑️ Statdock channel has been removed.`);
                } else {
                    await interaction.editReply(`❌ That channel is not a configured statdock.`);
                }
            }
        } catch (error) {
            if (error.code === 'ER_NO_SUCH_TABLE') {
                await interaction.editReply('The database tables for this feature have not been created yet. Please ask the bot owner to update the schema.');
            } else {
                logger.error('[Statdock Command Error]', error);
                await interaction.editReply('An error occurred while managing statdocks.');
            }
        }
    },
};