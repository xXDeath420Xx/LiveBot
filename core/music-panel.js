"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const discord_js_1 = require("discord.js");
const logger_1 = __importDefault(require("../utils/logger"));
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
        if (!this.message)
            return;
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
        }
        catch (error) {
            if (error.code === 10008) { // Unknown Message
                logger_1.default.warn(`[Music Panel] Message ${this.message.id} not found in guild ${this.guildId}.`);
                this.message = null; // Clear invalid message reference
            }
            else if (error.code === 'ChannelNotCached') {
                logger_1.default.error(`[Music Panel] Channel not cached, attempting to fetch...`);
                try {
                    const channel = await this.client.channels.fetch(this.message.channelId);
                    this.message = await channel.messages.fetch(this.message.id);
                    const embed = await this.buildEmbed(queue);
                    const components = this.buildComponents(queue);
                    await this.message.edit({ embeds: [embed], components });
                }
                catch (retryError) {
                    logger_1.default.error(`[Music Panel] Failed to update panel after fetching:`, retryError);
                }
            }
            else {
                logger_1.default.error(`[Music Panel] Failed to update panel for guild ${this.guildId}:`, error);
            }
        }
    }
    async buildEmbed(queue) {
        const isDJMode = queue && queue.metadata && queue.metadata.djMode;
        const embed = new discord_js_1.EmbedBuilder()
            .setColor(isDJMode ? "#9B59B6" : "#2B2D31")
            .setAuthor({ name: isDJMode ? "🎙️ AI DJ Mode - Live Music Player" : "Live Music Player" });
        if (queue && queue.currentTrack) {
            const track = queue.currentTrack;
            const isDJCommentary = track.metadata && track.metadata.isDJCommentary;
            const isSkipBanter = track.metadata && track.metadata.isSkipBanter;
            const requester = track.requestedBy ? track.requestedBy.tag : 'Unknown User';
            let progressDisplay = '';
            // Special handling for DJ commentary
            if (isDJCommentary) {
                if (isSkipBanter) {
                    embed.setTitle("🎤 DJ Skip Commentary");
                    embed.setDescription("The AI DJ is commenting on the track that was just skipped...");
                }
                else {
                    embed.setTitle("🎤 DJ Introduction");
                    embed.setDescription("The AI DJ is introducing the upcoming playlist...");
                }
                embed.setColor("#E74C3C");
                progressDisplay = '🔴 **Live DJ Commentary**';
            }
            else {
                embed.setTitle(track.title);
                if (track.url && track.url.startsWith('http')) {
                    embed.setURL(track.url);
                }
            }
            const timestamp = queue.node.getTimestamp();
            if (!isDJCommentary) {
                if (!timestamp || !timestamp.total || !timestamp.current || track.duration === '0:00') {
                    progressDisplay = 'Playing a live stream.';
                }
                else {
                    // Calculate remaining time in milliseconds
                    const remainingMs = timestamp.total.value - timestamp.current.value;
                    // Validate remaining time is reasonable (not negative, not too large)
                    if (remainingMs > 0 && remainingMs < 24 * 60 * 60 * 1000) { // Less than 24 hours
                        // Calculate the exact UNIX timestamp for when the song will end
                        const songEndTime = Math.floor((Date.now() + remainingMs) / 1000);
                        // Use Discord's relative timestamp feature for a live-updating countdown
                        progressDisplay = `Duration: ${track.duration} | Ends <t:${songEndTime}:R> (<t:${songEndTime}:T>)`;
                    }
                    else {
                        // Fallback if timestamp math doesn't make sense
                        progressDisplay = `Duration: ${track.duration}`;
                    }
                }
            }
            // Validate thumbnail is a proper URL before setting it
            const isValidUrl = (str) => {
                if (!str)
                    return false;
                try {
                    const url = new URL(str);
                    return url.protocol === 'http:' || url.protocol === 'https:';
                }
                catch {
                    return false;
                }
            };
            const thumbnailUrl = (track.thumbnail && isValidUrl(track.thumbnail)) ? track.thumbnail : null;
            if (!isDJCommentary) {
                if (thumbnailUrl) {
                    embed.setThumbnail(thumbnailUrl);
                }
                embed.setDescription(`**Artist:** ${track.author}\n**Requested by:** ${requester}`);
            }
            embed.addFields({ name: 'Progress', value: progressDisplay, inline: false });
            const nextTrack = queue.tracks.data[0];
            if (nextTrack) {
                embed.addFields({ name: "Up Next", value: `[${nextTrack.title}](${nextTrack.url}) - ${nextTrack.author}` });
            }
            else {
                embed.addFields({ name: "Up Next", value: "Nothing else in the queue." });
            }
            embed.setFooter({ text: `Queue: ${queue.tracks.size} song(s) | Use the controls below.` });
        }
        else {
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
        const playbackRow = new discord_js_1.ActionRowBuilder()
            .addComponents(new discord_js_1.ButtonBuilder().setCustomId('music-play-pause').setLabel(isPaused ? '▶️' : '⏸️').setStyle(discord_js_1.ButtonStyle.Primary).setDisabled(!isPlaying), new discord_js_1.ButtonBuilder().setCustomId('music-skip').setLabel('⏭️').setStyle(discord_js_1.ButtonStyle.Secondary).setDisabled(!isPlaying), new discord_js_1.ButtonBuilder().setCustomId('music-stop').setLabel('⏹️').setStyle(discord_js_1.ButtonStyle.Danger).setDisabled(!isPlaying), new discord_js_1.ButtonBuilder().setCustomId('music-clear').setLabel('🗑️').setStyle(discord_js_1.ButtonStyle.Secondary).setDisabled(!queue || queue.tracks.size === 0));
        const songRequestRow = new discord_js_1.ActionRowBuilder()
            .addComponents(new discord_js_1.StringSelectMenuBuilder()
            .setCustomId('music-add-song')
            .setPlaceholder('Add a song or start a DJ')
            .addOptions([
            { label: 'Add a song by name or URL', description: 'Opens a form to enter a song name or YouTube/Spotify URL', value: 'add_song_modal' },
            { label: 'Start an AI DJ session', description: 'Opens a form to configure and start an AI-powered DJ', value: 'start_dj_modal' }
        ]));
        return [playbackRow, songRequestRow];
    }
    async handleInteraction(interaction) {
        if (!interaction.guildId)
            return;
        if (interaction.isButton()) {
            // More robust interaction deferral check
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.deferUpdate();
                }
            }
            catch (error) {
                // Silently handle interaction already acknowledged (40060) or expired (10062) errors
                if (error.code !== 40060 && error.code !== 10062) {
                    console.error('[Music Panel] Unexpected interaction error:', error);
                }
            }
            const queue = this.client.player.nodes.get(interaction.guildId);
            if (!queue && interaction.customId !== 'music-stop') {
                return this.updatePanel(undefined);
            }
            switch (interaction.customId) {
                case 'music-play-pause':
                    if (queue && queue.currentTrack)
                        queue.node.setPaused(!queue.node.isPaused());
                    break;
                case 'music-skip':
                    if (queue && queue.currentTrack) {
                        const skippedTrack = queue.currentTrack;
                        const isLastTrack = queue.tracks.size === 0;
                        if (queue.metadata.djMode && this.client.djManager) {
                            await this.client.djManager.playSkipBanter(queue, skippedTrack, interaction.user);
                        }
                        queue.node.skip();
                        if (isLastTrack && queue.metadata.djMode && this.client.djManager) {
                            await this.client.djManager.onQueueEnd(queue);
                        }
                    }
                    break;
                case 'music-stop':
                    if (queue)
                        queue.delete();
                    break;
                case 'music-clear':
                    if (queue && queue.tracks.size > 0)
                        queue.tracks.clear();
                    break;
            }
            await this.updatePanel(this.client.player.nodes.get(interaction.guildId));
        }
        else if (interaction.isStringSelectMenu() && interaction.customId === 'music-add-song') {
            try {
                if (interaction.values[0] === 'add_song_modal') {
                    const modal = new discord_js_1.ModalBuilder().setCustomId('add-song-modal').setTitle('Add a Song');
                    const songInput = new discord_js_1.TextInputBuilder().setCustomId('song-input').setLabel("Song Name or URL").setStyle(discord_js_1.TextInputStyle.Short).setRequired(true);
                    modal.addComponents(new discord_js_1.ActionRowBuilder().addComponents(songInput));
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.showModal(modal);
                    }
                }
                else if (interaction.values[0] === 'start_dj_modal') {
                    const modal = new discord_js_1.ModalBuilder().setCustomId('ai-dj-modal').setTitle('Start an AI DJ Session');
                    const promptInput = new discord_js_1.TextInputBuilder().setCustomId('dj-prompt-input').setLabel("Prompt (e.g., '90s rock party')").setStyle(discord_js_1.TextInputStyle.Short).setRequired(false);
                    const songInput = new discord_js_1.TextInputBuilder().setCustomId('dj-song-input').setLabel("Song to influence the playlist").setStyle(discord_js_1.TextInputStyle.Short).setRequired(false);
                    const artistInput = new discord_js_1.TextInputBuilder().setCustomId('dj-artist-input').setLabel("Artist to influence the playlist").setStyle(discord_js_1.TextInputStyle.Short).setRequired(false);
                    const genreInput = new discord_js_1.TextInputBuilder().setCustomId('dj-genre-input').setLabel("Genre to influence the playlist").setStyle(discord_js_1.TextInputStyle.Short).setRequired(false);
                    modal.addComponents(new discord_js_1.ActionRowBuilder().addComponents(promptInput), new discord_js_1.ActionRowBuilder().addComponents(songInput), new discord_js_1.ActionRowBuilder().addComponents(artistInput), new discord_js_1.ActionRowBuilder().addComponents(genreInput));
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.showModal(modal);
                    }
                }
            }
            catch (error) {
                // Silently catch interaction timeout errors - these are expected if user takes too long
                if (error.code !== 10062) { // Only log if not "Unknown interaction" error
                    console.error('[Music Panel Modal Error]', error);
                }
            }
        }
    }
}
exports.default = MusicPanel;
