const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Displays a guide for all bot commands and their permissions.'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor('#5865F2')
      .setTitle('CertiFried Announcer Command & Feature Guide')
      .setDescription('Here is a list of all available commands. Most commands require `Manage Server` permissions, unless otherwise noted.')
      .addFields(
        {
          name: '⚙️ Configuration (The All-in-One Command)',
          value: '`/config channel` - Sets the default channel where all live announcements will be posted.\n' +
                 '`/config liverole` - Sets a role to be given to linked Discord users when they go live.\n' +
                 '`/config customize bot` - Changes the bot\'s default nickname or announcement avatar for this server.\n' +
                 '`/config customize channel` - Sets a default webhook name/avatar for *all* announcements in a specific channel.\n' +
                 '`/config customize streamer` - **The power tool!** Sets a unique webhook name, avatar, or message for a streamer in a *specific channel*.\n'
        },
        {
          name: '👤 Streamer Management',
          value: '`/addstreamer` - Adds a streamer to one or more channels with shared settings.\n' +
                 '`/removestreamer` - Removes a streamer from this server\'s notification list and purges their announcements.\n' +
                 '`/liststreamers` - Shows all streamers being tracked on this server and their status.\n' +
                 '`/check-live` - Instantly lists all currently live streamers for this server.'
        },
        {
          name: '🚀 Bulk & Team Actions',
          value: '`/addteam` - **(One-Time Add)** Adds all members of a Twitch Team to a specific channel.\n' +
                 '`/removeteam` - **(One-Time Remove)** Removes all members of a Twitch Team from a specific channel and purges their announcements.\n' +
                 '`/subscribe-team` - **(Automated)** Automatically keeps a channel synced with a Twitch Team, adding and removing members.\n' +
                 '`/unsubscribe-team` - Stops the automatic syncing for a team on a channel.\n' +
                 '`/importteamcsv` - **(Sync)** A channel with a CSV, adding/updating members from the file and removing anyone not in it.\n' +
                 '`/massaddstreamer` - Adds multiple streamers from the same platform at once.\n' +
                 '`/massremovestreamer` - Removes multiple streamers and purges their announcements.\n' +
                 '`/importcsv` - Adds or updates streamers in bulk by uploading a `.csv` file.\n' +
                 '`/exportcsv` - Exports all tracked streamers on this server to a `.csv` file.\n' +
                 '`/clearstreamers` - **(Admin Only)** Removes **ALL** streamers and purges **ALL** announcements from the server.'
        },
        {
            name: '👋 Member-Facing Features',
            value: '`/setup-requests` - **(Admin Only)** Creates a panel for members to request their own streams be announced.'
        },
        {
            name: '🌐 Full Web Dashboard',
            value: 'For easier management, you can access the **[Web Dashboard](https://bot.certifriedannouncer.online)** to control everything visually.'
        }
      )
      .setFooter({ text: 'The bot checks for live streams approximately every 1.5 minutes and team updates every 15 minutes.' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};