const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const db = require('../utils/db');
const apiChecks = require('../utils/api_checks');

module.exports = {
  data: new SlashCommandBuilder()
    // ... (command definition is the same)
    ,

  async execute(interaction) {
    const platform = interaction.options.getString('platform');
    const usernames = [...new Set(interaction.options.getString('usernames').split(',').map(name => name.trim()).filter(Boolean))];
    if (usernames.length === 0) return interaction.reply({ content: 'Please provide at least one valid username.', ephemeral: true });
    
    await interaction.deferReply({ ephemeral: true });

    const added = [], failed = [], existed = [];

    for (const username of usernames) {
        try {
            // Step 1: Validate streamer and get canonical data
            let validatedData;
            if (platform === 'twitch') {
                const u = await apiChecks.getTwitchUser(username);
                if (!u) { failed.push(`${username} (Not Found)`); continue; }
                validatedData = { puid: u.id, dbUsername: u.login };
            } else if (platform === 'kick') {
                const u = await apiChecks.getKickUser(username);
                if (!u) { failed.push(`${username} (Not Found)`); continue; }
                validatedData = { puid: u.id.toString(), dbUsername: u.user.username };
            } else if (platform === 'youtube') {
                if (!username.startsWith('UC')) {failed.push(`${username} (YT requires Channel ID)`); continue;}
                validatedData = { puid: username, dbUsername: username };
            } else { // For TikTok, Trovo, etc.
                validatedData = { puid: username, dbUsername: username };
            }
            
            // Step 2: Find or create the global streamer record using the validated platform_user_id
            let [streamer] = await db.execute('SELECT streamer_id FROM streamers WHERE platform = ? AND platform_user_id = ?', [platform, validatedData.puid]);
            let streamerId;

            if (streamer.length > 0) {
                streamerId = streamer[0].streamer_id;
            } else {
                const [result] = await db.execute('INSERT INTO streamers (platform,username,platform_user_id) VALUES (?,?,?)', [platform, validatedData.dbUsername, validatedData.puid]);
                streamerId = result.insertId;
            }

            // Step 3: Create subscription if it doesn't exist
            const [subResult] = await db.execute('INSERT IGNORE INTO subscriptions (guild_id, streamer_id) VALUES (?, ?)', [interaction.guild.id, streamerId]);

            if (subResult.affectedRows > 0) {
                added.push(username);
            } else {
                existed.push(username);
            }
        } catch (e) {
            console.error(`Mass Add Error for ${username}:`, e);
            failed.push(`${username} (API/DB Error)`);
        }
    }

    const embed = new EmbedBuilder().setTitle('Mass Add Report').setColor('#5865F2');
    const field = (l) => l.length > 0 ? l.join(', ').substring(0, 1020) : 'None';
    embed.addFields(
        { name: `✅ Added (${added.length})`, value: field(added) },
        { name: `ℹ️ Already Existed (${existed.length})`, value: field(existed) },
        { name: `❌ Failed (${failed.length})`, value: field(failed) }
    );
    await interaction.editReply({ embeds: [embed] });
  },
};