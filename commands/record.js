const {SlashCommandBuilder, PermissionsBitField, EmbedBuilder} = require("discord.js");
const {joinVoiceChannel, createAudioReceiver, EndBehaviorType} = require("@discordjs/voice");
const fs = require("fs");
const prism = require("prism-media");
const db = require("../utils/db");
const logger = require("../utils/logger");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("record")
    .setDescription("Records the audio in a voice channel."),
  async execute(interaction) {
    await interaction.deferReply({ephemeral: true});

    const guildId = interaction.guild.id;
    const member = interaction.member;

    // Fetch record configuration from the database
    const [[recordConfig]] = await db.execute("SELECT is_enabled, allowed_role_ids, output_channel_id FROM record_config WHERE guild_id = ?", [guildId]);

    if (!recordConfig || !recordConfig.is_enabled) {
      return interaction.editReply({content: "Voice recording is not enabled for this server."});
    }

    const allowedRoleIds = recordConfig.allowed_role_ids ? JSON.parse(recordConfig.allowed_role_ids) : [];
    const outputChannelId = recordConfig.output_channel_id;

    // Check permissions
    const isAdmin = member.permissions.has(PermissionsBitField.Flags.Administrator);
    const hasAllowedRole = allowedRoleIds.some(roleId => member.roles.cache.has(roleId));

    if (!isAdmin && !hasAllowedRole) {
      return interaction.editReply({content: "You do not have permission to use this command."});
    }

    const voiceChannel = member.voice.channel;
    if (!voiceChannel) {
      return interaction.editReply({content: "You must be in a voice channel to use this command."});
    }

    let outputChannel = null;
    if (outputChannelId) {
      try {
        outputChannel = await interaction.client.channels.fetch(outputChannelId);
      } catch (e) {
        logger.error(`[Record Command] Could not fetch output channel ${outputChannelId} for guild ${guildId}:`, e);
      }
    }

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guildId,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      const receiver = connection.receiver;
      const audioStream = receiver.subscribe(member.id, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 1000,
        },
      });

      const recordingsDir = "./recordings";
      if (!fs.existsSync(recordingsDir)) {
        fs.mkdirSync(recordingsDir);
      }

      const filename = `${recordingsDir}/${Date.now()}-${member.user.username}.pcm`;
      const fileStream = fs.createWriteStream(filename);
      const pcmStream = audioStream.pipe(new prism.opus.Decoder({rate: 48000, channels: 2, frameSize: 960}));

      pcmStream.pipe(fileStream);

      let recordingStartTime = Date.now();

      const startEmbed = new EmbedBuilder()
        .setColor("#00FF00")
        .setDescription(`🎙️ Recording started in ${voiceChannel.name} by ${member.user.tag}.`);

      if (outputChannel) {
        try {
          await outputChannel.send({embeds: [startEmbed]});
        } catch (sendError) {
          logger.error(`[Record Command] Failed to send start embed to output channel ${outputChannel.id}:`, sendError);
        }
      }
      await interaction.editReply({content: `✅ Recording started. The recording will be saved.`, ephemeral: true});

      fileStream.on("finish", async () => {
        const durationSeconds = Math.floor((Date.now() - recordingStartTime) / 1000);
        const endEmbed = new EmbedBuilder()
          .setColor("#FF0000")
          .setDescription(`🔴 Recording stopped in ${voiceChannel.name}. Duration: ${durationSeconds} seconds.`);

        if (outputChannel) {
          try {
            await outputChannel.send({embeds: [endEmbed]});
          } catch (sendError) {
            logger.error(`[Record Command] Failed to send end embed to output channel ${outputChannel.id}:`, sendError);
          }
        }
        logger.info(`[Record Command] Recording for ${member.user.tag} in ${voiceChannel.name} finished. Saved to ${filename}`);
      });

      connection.on("stateChange", (oldState, newState) => {
        if (newState.status === "disconnected") {
          fileStream.end();
          logger.info(`[Record Command] Voice connection disconnected for ${member.user.tag}.`);
        }
      });

    } catch (error) {
      logger.error("[Record Command Error]", error);
      await interaction.editReply({content: "An error occurred while trying to start the recording."});
    }
  },
};