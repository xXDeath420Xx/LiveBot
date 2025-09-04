// commands/massremovestreamer.js
const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('massremovestreamer')
    .setDescription('Removes multiple streamers from this server\'s list.')
    .addStringOption(o => o.setName('platform').setDescription('The platform to remove streamers from.').setRequired(true).addChoices(
        {name:'Twitch',value:'twitch'}, {name:'YouTube',value:'youtube'},
        {name:'Kick',value:'kick'}, {name:'TikTok',value:'tiktok'}, {name:'Trovo',value:'trovo'}
    ))
    .addStringOption(o => o.setName('usernames').setDescription('A comma-separated list of usernames.').setRequired(true))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const platform = interaction.options.getString('platform');
    const usernames = [...new Set(interaction.options.getString('usernames').split(',').map(name => name.trim().toLowerCase()).filter(Boolean))];
    if (usernames.length === 0) return interaction.editReply('Please provide at least one username.');

    const removed = [], failed = [];

    // To remove many users efficiently, we find all of their IDs first with one query.
    const [streamers] = await db.execute(
        `SELECT streamer_id, LOWER(username) as lower_username FROM streamers WHERE platform = ? AND LOWER(username) IN (?)`,
        [platform, usernames]
    );

    const streamerMap = new Map(streamers.map(s => [s.lower_username, s.streamer_id]));
    
    const idsToRemove = [];
    for(const username of usernames){
        if(streamerMap.has(username)) {
            idsToRemove.push(streamerMap.get(username));
            removed.push(username);
        } else {
            failed.push(`${username} (Not Found)`);
        }
    }

    if (idsToRemove.length > 0) {
        await db.execute(
            'DELETE FROM subscriptions WHERE guild_id = ? AND streamer_id IN (?)',
            [interaction.guild.id, idsToRemove]
        );
    }
    
    const embed = new EmbedBuilder().setTitle('Mass Remove Report').setColor('#f04747');
    const field = (l) => l.length > 0 ? l.join(', ').substring(0, 1020) : 'None';
    embed.addFields(
        { name: `✅ Removed (${removed.length})`, value: field(removed) },
        { name: `❌ Failed (${failed.length})`, value: field(failed) }
    );
    await interaction.editReply({ embeds: [embed] });
  },
};