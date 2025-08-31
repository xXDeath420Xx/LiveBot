const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');

module.exports = {
  data: new SlashCommandBuilder().setName('massremovestreamer').setDescription('Removes multiple streamers from the notification list.')
    .addStringOption(option=>option.setName('platform').setDescription('The platform of the streamers to remove.').setRequired(true).addChoices(
        {name:'Twitch',value:'twitch'},
        {name:'YouTube',value:'youtube'},
        {name:'Kick',value:'kick'},
        {name:'TikTok',value:'tiktok'},
        {name:'Trovo',value:'trovo'}
    ))
    .addStringOption(option=>option.setName('usernames').setDescription('A comma-separated list of usernames to remove').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
    
  async execute(interaction) {
    const platform = interaction.options.getString('platform');
    const usernames = [...new Set(interaction.options.getString('usernames').split(',').map(n => n.trim().toLowerCase()).filter(Boolean))];
    if (usernames.length === 0) return interaction.reply({ content: 'Please provide at least one valid username.', ephemeral: true });
    
    await interaction.deferReply({ ephemeral: true });
    
    const [streamersToRemove] = await db.query(
        'SELECT streamer_id, username FROM streamers WHERE platform = ? AND LOWER(username) IN (?)', 
        [platform, usernames]
    );

    const successfullyRemoved = [];
    const streamerIdsToRemove = streamersToRemove.map(s => s.streamer_id);

    if (streamerIdsToRemove.length > 0) {
        const [deleteResult] = await db.query(
            'DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id IN (?)', 
            [interaction.guild.id, streamerIdsToRemove]
        );

        if (deleteResult.affectedRows > 0) {
           successfullyRemoved.push(...streamersToRemove.map(s => s.username));
        }
    }

    const removedSet = new Set(successfullyRemoved.map(u => u.toLowerCase()));
    const notFound = usernames.filter(u => !removedSet.has(u));

    const embed = new EmbedBuilder().setTitle('Mass Remove Report').setColor('#FF0000');
    const createField = list => list.length > 0 ? list.join(', ').substring(0, 1020) : 'None';
    embed.addFields(
        { name: `✅ Removed (${successfullyRemoved.length})`, value: createField(successfullyRemoved) },
        { name: `❌ Not Found or Not on This Server (${notFound.length})`, value: createField(notFound) }
    );
    await interaction.editReply({ embeds: [embed] });
  },
};
