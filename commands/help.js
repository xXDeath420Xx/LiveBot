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
          name: '🌟 Core Setup',
          value: '`/setchannel` - Sets the default channel for live announcements.\n' +
                 '`/setliverole` - Sets a role to be given to linked Discord users when they go live.\n' +
                 '`/customize-bot` - Changes the bot\'s default webhook nickname or avatar for this server.\n' +
                 '`/setup` - Starts an interactive guide for first-time setup.\n' +
                 '`/setup-requests` - **(Admin)** Creates a panel for members to request their own streams to be announced.'
        },
        {
          name: '👤 Streamer Management',
          value: '`/addstreamer` - Adds a streamer using an interactive form.\n' +
                 '`/removestreamer` - Removes a streamer from the notification list.\n' +
                 '`/liststreamers` - Shows all streamers being tracked on this server and their status.\n' +
                 '`/check-live` - Instantly lists all currently live streamers for this server.\n' +
                 '`/editstreamer` - Edits settings for an existing streamer subscription.'
        },
        {
            name: '🎨 Fine-Tuning & Customization',
            value: '`/customize-streamer` - Sets a unique webhook name, avatar, or message for a streamer in a *specific channel*.\n' +
                   '`/customize-channel` - Sets a default webhook name/avatar for *all* announcements in a specific channel.'
        },
        {
          name: '🚀 Bulk & Team Actions',
          value: '`/addteam` - **(One-Time Add)** Adds all members of a Twitch Team.\n' +
                 '`/removeteam` - **(One-Time Remove)** Removes all members of a Twitch Team.\n' +
                 '`/subscribe-team` - **(Automated)** Automatically keeps a channel synced with a Twitch Team.\n' +
                 '`/unsubscribe-team` - Stops the automatic syncing for a team.\n' +
                 '`/massaddstreamer` - Adds multiple streamers from the same platform at once.\n' +
                 '`/massremovestreamer` - Removes multiple streamers.\n' +
                 '`/importcsv` - Adds or updates streamers in bulk by uploading a `.csv` file.\n' +
                 '`/exportcsv` - Exports all tracked streamers on this server to a `.csv` file.\n' +
                 '`/clearstreamers` - **(Admin)** Removes **ALL** streamers from the server.'
        },
        {
            name: '✨ Server Engagement',
            value: '`/rank` - (Any user) Displays your or another member\'s server rank and XP.\n' +
                   '`/leaderboard` - (Any user) Shows the server\'s top members by XP.\n' +
                   '`/invites` - (Any user) Shows your or another user\'s invite statistics.\n' +
                   '`/reaction-roles create` - Creates a new reaction role panel.'
        },
        {
            name: '🛡️ Moderation & Security',
            value: '`/ticket setup` - **(Admin)** Configures the support ticket system.\n' +
                   '`/automod` - **(Admin)** Manage automoderation rules (e.g., banned words, spam).\n' +
                   '`/security` - **(Admin)** Configure anti-nuke and new member join gate settings.\n' +
                   '`/backup` - **(Admin)** Create, list, or restore backups of your server\'s channels and roles.'
        },
        {
            name: '🌐 Full Web Dashboard',
            value: 'For easier management, access the **[Web Dashboard](https://bot.certifriedannouncer.online)** to control everything visually.'
        }
      )
      .setFooter({ text: 'The bot checks for live streams approximately every 1.5 minutes and team updates every hour.' });

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};