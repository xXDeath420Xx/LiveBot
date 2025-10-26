
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const logger = require('../utils/logger');

class MusicPanel {
    constructor(client, guildId) {
        this.client = client;
        this.guildId = guildId;
        this.message = null;
        this.lastUpdate = 0;
        this.updateThrottle = 1000; // Minimum 1 second between updates
    }

    async createPanel(channel) {
        const queue = this.client.player.nodes.get(this.guildId);
        const embed = await this.buildEmbed(queue);
        const components = this.buildComponents(queue);
        this.message = await channel.send({ embeds: [embed], components });
        return this.message;
    }

    // This is the single entry point for updating the panel, called by player events.
    async updatePanel(queue) {
        if (!this.message) return;

        // Throttle updates to prevent rapid successive updates
        const now = Date.now();
        if (now - this.lastUpdate < this.updateThrottle) {
            return; // Skip this update, too soon after last one
        }
        this.lastUpdate = now;

        try {
            // Fetch the message if the channel is not cached
            if (!this.message.channel) {
                const channel = await this.client.channels.fetch(this.message.channelId);
                this.message = await channel.messages.fetch(this.message.id);
            }

            const embed = await this.buildEmbed(queue);
            const components = this.buildComponents(queue);
            await this.message.edit({ embeds: [embed], components });
        } catch (error) {
            if (error.code === 10008) { // Unknown Message
                logger.warn(`[Music Panel] Message ${this.message.id} not found in guild ${this.guildId}.`);
                this.message = null; // Clear invalid message reference
            } else if (error.code === 'ChannelNotCached') {
                logger.error(`[Music Panel] Channel not cached, attempting to fetch...`);
                try {
                    const channel = await this.client.channels.fetch(this.message.channelId);
                    this.message = await channel.messages.fetch(this.message.id);
                    const embed = await this.buildEmbed(queue);
                    const components = this.buildComponents(queue);
                    await this.message.edit({ embeds: [embed], components });
                } catch (retryError) {
                    logger.error(`[Music Panel] Failed to update panel after fetching:`, retryError);
                }
            } else {
                logger.error(`[Music Panel] Failed to update panel for guild ${this.guildId}:`, error);
            }
        }
    }

    async buildEmbed(queue) {
        const embed = new EmbedBuilder()
            .setColor("#2B2D31")
            .setAuthor({ name: "Live Music Player" });

        if (queue && queue.currentTrack) {
            const track = queue.currentTrack;
            const requester = track.requestedBy ? track.requestedBy.tag : 'Unknown User';

            embed.setTitle(track.title);
            if (track.url && track.url.startsWith('http')) {
                embed.setURL(track.url);
            }

            const timestamp = queue.node.getTimestamp();
            let progressDisplay;
            if (!timestamp || track.duration === '0:00') {
                progressDisplay = 'Playing a live stream or commentary.';
            } else {
                // Calculate the exact UNIX timestamp for when the song will end
                const songEndTime = Math.floor((Date.now() + timestamp.total.value - timestamp.current.value) / 1000);
                // Use Discord's relative timestamp feature for a live-updating countdown, and add the absolute time with seconds.
                progressDisplay = `Duration: ${track.duration} | Ends <t:${songEndTime}:R> (<t:${songEndTime}:T>)`;
            }

            embed.setThumbnail(track.thumbnail || null)
                .setDescription(`**Artist:** ${track.author}\n**Requested by:** ${requester}`)
                .addFields({ name: 'Progress', value: progressDisplay, inline: false });

            const nextTrack = queue.tracks.data[0];
            if (nextTrack) {
                embed.addFields({ name: "Up Next", value: `[${nextTrack.title}](${nextTrack.url}) - ${nextTrack.author}` });
            } else {
                embed.addFields({ name: "Up Next", value: "Nothing else in the queue." });
            }

            embed.setFooter({ text: `Queue: ${queue.tracks.size} song(s) | Use the controls below.` });
        } else {
            embed.setTitle("The queue is empty")
                .setDescription("Add a song using the dropdown menu below to get started.")
                .setThumbnail(this.client.user.displayAvatarURL())
                .setFooter({ text: "Use the controls below to manage the music." });
        }

        return embed;
    }

    buildComponents(queue) {
        const isPlaying = queue && queue.currentTrack;
        const isPaused = isPlaying && queue.node.isPaused();

        const playbackRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('music-play-pause').setLabel(isPaused ? '▶️' : '⏸️').setStyle(ButtonStyle.Primary).setDisabled(!isPlaying),
                new ButtonBuilder().setCustomId('music-skip').setLabel('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(!isPlaying),
                new ButtonBuilder().setCustomId('music-stop').setLabel('⏹️').setStyle(ButtonStyle.Danger).setDisabled(!isPlaying),
                new ButtonBuilder().setCustomId('music-clear').setLabel('🗑️').setStyle(ButtonStyle.Secondary).setDisabled(!queue || queue.tracks.size === 0),
            );

        const songRequestRow = new ActionRowBuilder()
            .addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('music-add-song')
                    .setPlaceholder('Add a song or start a DJ')
                    .addOptions([
                        { label: 'Add a song by name or URL', description: 'Opens a form to enter a song name or YouTube/Spotify URL', value: 'add_song_modal' },
                        { label: 'Start an AI DJ session', description: 'Opens a form to configure and start an AI-powered DJ', value: 'start_dj_modal' }
                    ]),
            );

        return [playbackRow, songRequestRow];
    }

    async handleInteraction(interaction) {
        if (!interaction.guildId) return;

        if (interaction.isButton()) {
            await interaction.deferUpdate();
            const queue = this.client.player.nodes.get(interaction.guildId);

            if (!queue && interaction.customId !== 'music-stop') {
                return this.updatePanel(null);
            }

            switch (interaction.customId) {
                case 'music-play-pause':
                    if (queue && queue.currentTrack) queue.node.setPaused(!queue.node.isPaused());
                    break;
                case 'music-skip':
                    if (queue && queue.currentTrack) {
                        const skippedTrack = queue.currentTrack;
                        const isLastTrack = queue.tracks.size === 0;
                        if (queue.metadata.djMode) {
                            await this.client.djManager.playSkipBanter(queue, skippedTrack, interaction.user);
                        }
                        queue.node.skip();
                        if (isLastTrack && queue.metadata.djMode) {
                            await this.client.djManager.onQueueEnd(queue);
                        }
                    }
                    break;
                case 'music-stop':
                    if (queue) queue.delete();
                    break;
                case 'music-clear':
                    if (queue && queue.tracks.size > 0) queue.tracks.clear();
                    break;
            }
            await this.updatePanel(this.client.player.nodes.get(interaction.guildId));

        } else if (interaction.isStringSelectMenu() && interaction.customId === 'music-add-song') {
            if (interaction.values[0] === 'add_song_modal') {
                const modal = new ModalBuilder().setCustomId('add-song-modal').setTitle('Add a Song');
                const songInput = new TextInputBuilder().setCustomId('song-input').setLabel("Song Name or URL").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(songInput));
                await interaction.showModal(modal);
            } else if (interaction.values[0] === 'start_dj_modal') {
                const modal = new ModalBuilder().setCustomId('ai-dj-modal').setTitle('Start an AI DJ Session');
                const promptInput = new TextInputBuilder().setCustomId('dj-prompt-input').setLabel("Prompt (e.g., '90s rock party')").setStyle(TextInputStyle.Short).setRequired(false);
                const songInput = new TextInputBuilder().setCustomId('dj-song-input').setLabel("Song to influence the playlist").setStyle(TextInputStyle.Short).setRequired(false);
                const artistInput = new TextInputBuilder().setCustomId('dj-artist-input').setLabel("Artist to influence the playlist").setStyle(TextInputStyle.Short).setRequired(false);
                const genreInput = new TextInputBuilder().setCustomId('dj-genre-input').setLabel("Genre to influence the playlist").setStyle(TextInputStyle.Short).setRequired(false);
                modal.addComponents(
                    new ActionRowBuilder().addComponents(promptInput),
                    new ActionRowBuilder().addComponents(songInput),
                    new ActionRowBuilder().addComponents(artistInput),
                    new ActionRowBuilder().addComponents(genreInput)
                );
                await interaction.showModal(modal);
            }
        }
    }
}

module.exports = MusicPanel;
