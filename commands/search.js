const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { checkMusicPermissions } = require('../utils/music_helpers');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('search')
    .setDescription('Searches for a song and lets you choose from the top results.')
    .addStringOption(option =>
        option.setName('query')
            .setDescription('The song to search for.')
            .setRequired(true)),

  async execute(interaction) {
    const permissionCheck = await checkMusicPermissions(interaction);
    if (!permissionCheck.permitted) {
        return interaction.reply({ content: permissionCheck.message, ephemeral: true });
    }

    const query = interaction.options.getString('query');
    const { member, guild } = interaction;

    if (!member.voice.channel) {
        return interaction.reply({ content: 'You must be in a voice channel to search for music!', ephemeral: true });
    }

    await interaction.deferReply();

    try {
        const results = await interaction.client.player.search(query, { requestedBy: interaction.user });

        if (!results || !results.hasTracks()) {
            return interaction.editReply({ content: `❌ | No results found for \`${query}\`.` });
        }

        const tracks = results.tracks.slice(0, 10); // Get the top 10 results

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setAuthor({ name: `Top 10 Search Results for "${query}"` })
            .setDescription(tracks.map((track, i) => `**${i + 1}.** ${track.title} - \`${track.duration}\``).join('\n'))
            .setFooter({ text: 'Type the number of the song you want to play. You have 30 seconds.' });

        await interaction.editReply({ embeds: [embed] });

        const filter = m => m.author.id === interaction.user.id && parseInt(m.content) >= 1 && parseInt(m.content) <= tracks.length;
        const collector = interaction.channel.createMessageCollector({ filter, time: 30000, max: 1 });

        collector.on('collect', async m => {
            const choice = parseInt(m.content) - 1;
            const track = tracks[choice];

            await interaction.client.player.play(member.voice.channel, track, {
                nodeOptions: {
                    metadata: {
                        channel: interaction.channel,
                    }
                },
                requestedBy: interaction.user
            });
            
            m.delete().catch(() => {});
            interaction.editReply({ content: `✅ | Added **${track.title}** to the queue.`, embeds: [] });
        });

        collector.on('end', (collected, reason) => {
            if (reason === 'time') {
                interaction.editReply({ content: '❌ | You did not make a selection in time.', embeds: [] });
            }
        });

    } catch (error) {
        console.error('[Search Command Error]', { guildId: guild.id, error: error.message, stack: error.stack, category: 'music' });
        await interaction.editReply({ content: `❌ An error occurred: ${error.message}` });
    }
  },
};