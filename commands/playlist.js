const {SlashCommandBuilder, EmbedBuilder} = require("discord.js");
const {checkMusicPermissions} = require("../utils/music_helpers");
const db = require("../utils/db");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("playlist")
    .setDescription("Manages your custom playlists.")
    .addSubcommand(subcommand =>
      subcommand
        .setName("create")
        .setDescription("Creates a new playlist.")
        .addStringOption(option => option.setName("name").setDescription("The name of the playlist.").setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName("delete")
        .setDescription("Deletes a playlist.")
        .addStringOption(option => option.setName("name").setDescription("The name of the playlist to delete.").setRequired(true).setAutocomplete(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName("add")
        .setDescription("Adds the current song to a playlist.")
        .addStringOption(option => option.setName("name").setDescription("The name of the playlist.").setRequired(true).setAutocomplete(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName("remove")
        .setDescription("Removes a song from a playlist.")
        .addStringOption(option => option.setName("name").setDescription("The name of the playlist.").setRequired(true).setAutocomplete(true))
        .addIntegerOption(option => option.setName("position").setDescription("The position of the song to remove.").setRequired(true).setMinValue(1)))
    .addSubcommand(subcommand =>
      subcommand
        .setName("list")
        .setDescription("Lists all of your playlists."))
    .addSubcommand(subcommand =>
      subcommand
        .setName("show")
        .setDescription("Shows the songs in a playlist.")
        .addStringOption(option => option.setName("name").setDescription("The name of the playlist.").setRequired(true).setAutocomplete(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName("play")
        .setDescription("Plays a playlist.")
        .addStringOption(option => option.setName("name").setDescription("The name of the playlist to play.").setRequired(true).setAutocomplete(true))),

  async autocomplete(interaction) {
    const focusedOption = interaction.options.getFocused(true);
    if (focusedOption.name === "name") {
      const focusedValue = focusedOption.value;
      try {
        const [playlists] = await db.execute("SELECT name FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name LIKE ? LIMIT 25", [interaction.guild.id, interaction.user.id, `${focusedValue}%`]);
        await interaction.respond(playlists.map(p => ({name: p.name, value: p.name})));
      } catch (error) {
        console.error("[Playlist Autocomplete Error]", error);
        await interaction.respond([]);
      }
    }
  },

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const name = interaction.options.getString("name");
    const guildId = interaction.guild.id;
    const userId = interaction.user.id;

    try {
      switch (subcommand) {
        case "create": {
          await db.execute("INSERT INTO user_playlists (guild_id, user_id, name, songs) VALUES (?, ?, ?, ?)", [guildId, userId, name, JSON.stringify([])]);
          return interaction.reply({content: `✅ Playlist **${name}** created.`, ephemeral: true});
        }
        case "delete": {
          const [result] = await db.execute("DELETE FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?", [guildId, userId, name]);
          if (result.affectedRows > 0) {
            return interaction.reply({content: `🗑️ Playlist **${name}** deleted.`, ephemeral: true});
          } else {
            return interaction.reply({content: `❌ You don\'t have a playlist named **${name}**.`, ephemeral: true});
          }
        }
        case "add": {
          const queue = interaction.client.player.nodes.get(guildId);
          if (!queue || !queue.isPlaying()) {
            return interaction.reply({content: "There is nothing playing to add!", ephemeral: true});
          }
          const currentTrack = queue.currentTrack;

          const [[playlist]] = await db.execute("SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?", [guildId, userId, name]);
          if (!playlist) {
            return interaction.reply({content: `❌ You don\'t have a playlist named **${name}**.`, ephemeral: true});
          }

          const songs = JSON.parse(playlist.songs);
          songs.push({title: currentTrack.title, url: currentTrack.url});
          await db.execute("UPDATE user_playlists SET songs = ? WHERE playlist_id = ?", [JSON.stringify(songs), playlist.playlist_id]);

          return interaction.reply({content: `✅ Added **${currentTrack.title}** to the **${name}** playlist.`, ephemeral: true});
        }
        case "remove": {
          const position = interaction.options.getInteger("position") - 1;
          const [[playlist]] = await db.execute("SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?", [guildId, userId, name]);
          if (!playlist) {
            return interaction.reply({content: `❌ You don\'t have a playlist named **${name}**.`, ephemeral: true});
          }

          const songs = JSON.parse(playlist.songs);
          if (position < 0 || position >= songs.length) {
            return interaction.reply({content: "❌ Invalid song position.", ephemeral: true});
          }

          const removedSong = songs.splice(position, 1);
          await db.execute("UPDATE user_playlists SET songs = ? WHERE playlist_id = ?", [JSON.stringify(songs), playlist.playlist_id]);

          return interaction.reply({content: `🗑️ Removed **${removedSong[0].title}** from the **${name}** playlist.`, ephemeral: true});
        }
        case "list": {
          const [playlists] = await db.execute("SELECT name FROM user_playlists WHERE guild_id = ? AND user_id = ?", [guildId, userId]);
          if (playlists.length === 0) {
            return interaction.reply({content: "You don't have any playlists yet.", ephemeral: true});
          }

          const embed = new EmbedBuilder()
            .setColor("#3498DB")
            .setAuthor({name: `${interaction.user.username}\'s Playlists`})
            .setDescription(playlists.map(p => `• ${p.name}`).join("\n"));

          return interaction.reply({embeds: [embed], ephemeral: true});
        }
        case "show": {
          const [[playlist]] = await db.execute("SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?", [guildId, userId, name]);
          if (!playlist) {
            return interaction.reply({content: `❌ You don\'t have a playlist named **${name}**.`, ephemeral: true});
          }

          const songs = JSON.parse(playlist.songs);
          const embed = new EmbedBuilder()
            .setColor("#3498DB")
            .setAuthor({name: `Playlist: ${name}`})
            .setDescription(songs.length > 0 ? songs.map((s, i) => `**${i + 1}.** [${s.title}](${s.url})`).join("\n") : "This playlist is empty.");

          return interaction.reply({embeds: [embed], ephemeral: true});
        }
        case "play": {
          const permissionCheck = await checkMusicPermissions(interaction);
          if (!permissionCheck.permitted) {
            return interaction.reply({content: permissionCheck.message, ephemeral: true});
          }

          if (!interaction.member.voice.channel) {
            return interaction.reply({content: "You must be in a voice channel to play music!", ephemeral: true});
          }

          const [[playlist]] = await db.execute("SELECT * FROM user_playlists WHERE guild_id = ? AND user_id = ? AND name = ?", [guildId, userId, name]);
          if (!playlist) {
            return interaction.reply({content: `❌ You don\'t have a playlist named **${name}**.`, ephemeral: true});
          }

          const songs = JSON.parse(playlist.songs);
          if (songs.length === 0) {
            return interaction.reply({content: `The **${name}** playlist is empty.`, ephemeral: true});
          }

          await interaction.deferReply();

          try {
            // Correctly use the global player to play the playlist tracks
            await interaction.client.player.play(interaction.member.voice.channel, songs.map(s => s.url).join("\n"), {
              nodeOptions: {
                metadata: {
                  channel: interaction.channel
                }
              },
              requestedBy: interaction.user
            });

            return interaction.followUp({content: `▶️ Now playing the **${name}** playlist.`});

          } catch (e) {
            console.error("[Playlist Play Error]", e);
            return interaction.followUp({content: `❌ An error occurred while trying to play the playlist: ${e.message}`});
          }
        }
      }
    } catch (error) {
      console.error("[Playlist Command Error]", error);
      if (error.code === "ER_DUP_ENTRY") {
        return interaction.reply({content: `❌ You already have a playlist named **${name}**.`, ephemeral: true});
      }
      return interaction.reply({content: "❌ An error occurred while executing this command.", ephemeral: true});
    }
  },
  category: "Music",
};