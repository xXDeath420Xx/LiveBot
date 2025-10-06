const { SlashCommandBuilder } = require('@discordjs/builders');
const { PermissionsBitField } = require('discord.js');
const { joinVoiceChannel, createAudioReceiver, EndBehaviorType } = require('@discordjs/voice');
const fs = require('fs');
const prism = require('prism-media');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('record')
    .setDescription('Records the audio in a voice channel.'),
  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    }

    const voiceChannel = interaction.member.voice.channel;
    if (!voiceChannel) {
      return interaction.reply({ content: 'You must be in a voice channel to use this command.', ephemeral: true });
    }

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
      });

      const receiver = connection.receiver;
      const audioStream = receiver.subscribe(interaction.member.id, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 1000,
        },
      });

      if (!fs.existsSync('./recordings')) {
        fs.mkdirSync('./recordings');
      }

      const filename = `./recordings/${Date.now()}.pcm`;
      const fileStream = fs.createWriteStream(filename);
      const pcmStream = audioStream.pipe(new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 }));

      pcmStream.pipe(fileStream);

      await interaction.reply({ content: `Recording started. The recording will be saved to ${filename}.`, ephemeral: true });

    } catch (error) {
      console.error(error);
      await interaction.reply({ content: 'An error occurred while trying to start the recording.', ephemeral: true });
    }
  },
};