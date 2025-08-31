const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Displays a complete guide for all bot commands.'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor('#5865F2') 
      .setTitle('CertiFried Announcer Command Guide')
      .setDescription('Here is a list of all available commands and their functions. Most commands require "Manage Server" permissions.')
      .addFields(
        {
          name: '🌟 Core Setup',
          value: '`/setchannel` - Sets the single channel where all live announcements will be posted.\n' +
                 '`/setliverole` - Sets a role to be given to linked Discord users when they go live.'
        },
        {
          name: '👤 Streamer Management',
          value: '`/addstreamer` - Adds a single streamer to the notification list.\n' +
                 '`/removestreamer` - Removes a single streamer from the notification list.\n' +
                 '`/liststreamers` - Shows the status of *all* tracked streamers.\n' +
                 '`/check-live` - Shows a list of *only* currently live streamers.'
        },
        {
          name: '💬 Customization',
          value: '`/setcustommessage` - Sets a unique announcement message for a specific streamer.'
        },
        {
          name: '🚀 Bulk Actions',
          value: '`/massaddstreamer` - Adds multiple streamers from the same platform at once.\n' +
                 '`/massremovestreamer` - Removes multiple streamers from the same platform at once.\n' +
                 '`/importcsv` - Adds or updates streamers in bulk by uploading a `.csv` file.\n' +
                 '`/exportcsv` - Exports all tracked streamers on this server to a `.csv` file.\n' +
                 '`/clearstreamers` - (Admin Only) Removes **ALL** streamers from this server.'
        },
        {
            name: '🌐 Web Dashboard',
            value: 'Access the full web dashboard at [bot.certifriedannouncer.online](https://bot.certifriedannouncer.online) to manage your server visually.'
        }
      )
      .setFooter({ text: 'The bot checks for live streams approximately every 5 minutes.' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
