const { SlashCommandBuilder, ChannelType, PermissionsBitField, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const { getAvatarUploadChannel } = require('../utils/channel-helpers.js');
const { logAuditEvent } = require('../utils/audit-log.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Configures all features for the bot on this server.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        // ... (all subcommands are defined here as before)
        .addSubcommandGroup(group =>
            group
                .setName('customize')
                .setDescription('Customize the appearance of the bot and its messages.')
                .addSubcommand(subcommand =>
                    subcommand
                        .setName('streamer')
                        .setDescription("Sets a custom name, avatar, or message for a specific streamer's announcements.")
                        .addStringOption(option => option.setName('platform').setDescription('The platform of the streamer.').setRequired(true).addChoices({ name: 'Twitch', value: 'twitch' }, { name: 'Kick', value: 'kick' }, { name: 'YouTube', value: 'youtube' }))
                        .addStringOption(option => option.setName('username').setDescription('The username of the streamer.').setRequired(true).setAutocomplete(true)) // Autocomplete enabled
                        // ... other options
                )
        ),

    async autocomplete(interaction) {
        const focusedOption = interaction.options.getFocused(true);
        if (interaction.options.getSubcommand() === 'streamer' && focusedOption.name === 'username') {
            const focusedValue = focusedOption.value;
            const [streamers] = await db.execute(
                `SELECT DISTINCT s.username FROM streamers s JOIN subscriptions sub ON s.streamer_id = sub.streamer_id WHERE sub.guild_id = ? AND s.username LIKE ? LIMIT 25`,
                [interaction.guild.id, `${focusedValue}%`]
            );
            await interaction.respond(streamers.map(s => ({ name: s.username, value: s.username })));
        }
    },

    async execute(interaction) {
        // ... (The full execute logic for all subcommands is here, including the previously implemented features like audit logging and guild-specific avatar channels)
    },
};