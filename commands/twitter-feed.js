const { SlashCommandBuilder, PermissionsBitField, ChannelType } = require('discord.js');
const db = require('../utils/db');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('twitter-feed')
        .setDescription('Manage Twitter (X) feeds for the server.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('add')
                .setDescription('Adds a new Twitter feed to a channel.')
                .addStringOption(option => option.setName('username').setDescription('The Twitter @username (without the @).').setRequired(true))
                .addChannelOption(option => option.setName('channel').setDescription('The channel to post tweets in.').addChannelTypes(ChannelType.GuildText).setRequired(true))
        )
        .addSubcommand(subcommand =>
            subcommand
                .setName('remove')
                .setDescription('Removes a Twitter feed.')
                .addStringOption(option => option.setName('username').setDescription('The @username to remove.').setRequired(true).setAutocomplete(true))
                .addChannelOption(option => option.setName('channel').setDescription('The channel the feed is in.').addChannelTypes(ChannelType.GuildText).setRequired(true))
        ),

    async autocomplete(interaction) {
        const focusedValue = interaction.options.getFocused();
        const [feeds] = await db.execute('SELECT DISTINCT twitter_username FROM twitter_feeds WHERE guild_id = ? AND twitter_username LIKE ?', [interaction.guild.id, `${focusedValue}%`]);
        await interaction.respond(feeds.map(feed => ({ name: `@${feed.twitter_username}`, value: feed.twitter_username })));
    },

    async execute(interaction) {
        await interaction.deferReply({ ephemeral: true });
        const subcommand = interaction.options.getSubcommand();
        const username = interaction.options.getString('username').toLowerCase();
        const channel = interaction.options.getChannel('channel');

        try {
            if (subcommand === 'add') {
                await db.execute('INSERT INTO twitter_feeds (guild_id, twitter_username, channel_id) VALUES (?, ?, ?)', [interaction.guild.id, username, channel.id]);
                await interaction.editReply(`✅ Successfully created a feed for \`@${username}\` in ${channel}. New tweets will be posted shortly.`);
            } else if (subcommand === 'remove') {
                const [result] = await db.execute('DELETE FROM twitter_feeds WHERE guild_id = ? AND twitter_username = ? AND channel_id = ?', [interaction.guild.id, username, channel.id]);
                if (result.affectedRows > 0) {
                    await interaction.editReply(`🗑️ Removed the feed for \`@${username}\` from ${channel}.`);
                } else {
                    await interaction.editReply('❌ No feed found for that user in that channel.');
                }
            }
        } catch (error) {
            if (error.code === 'ER_DUP_ENTRY') {
                await interaction.editReply('A feed for that Twitter user in that channel already exists.');
            } else {
                console.error('[Twitter Feed Command Error]', error);
                await interaction.editReply('An error occurred while managing Twitter feeds.');
            }
        }
    },
};