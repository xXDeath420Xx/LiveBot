import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} from 'discord.js';
import logger from '../utils/logger.js';

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
        const isDJMode = queue && queue.metadata && queue.metadata.djMode;
        const embed = new EmbedBuilder()
            .setColor(isDJMode ? "#9B59B6" : "#2B2D31")
            .setAuthor({ name: isDJMode ? "AI DJ Mode - Live Music Player" : "Live Music Player" });

        if (queue && queue.currentTrack) {
            const track = queue.currentTrack;
            const isDJCommentary = track.metadata && track.metadata.isDJCommentary;
            const isSkipBanter = track.metadata && track.metadata.isSkipBanter;
            const requester = track.requestedBy ? track.requestedBy.tag : 'Unknown User';

            let progressDisplay = '';

            // Special handling for DJ commentary
            if (isDJCommentary) {
                if (isSkipBanter) {
                    embed.setTitle("DJ Skip Commentary");
                    embed.setDescription("The AI DJ is commenting on the track that was just skipped...");
                } else {
                    embed.setTitle("DJ Introduction");
                    embed.setDescription("The AI DJ is introducing the upcoming playlist...");
                }
                embed.setColor("#E74C3C");
                progressDisplay = 'Live DJ Commentary';
            } else {
                embed.setTitle(track.title);
                if (track.url && track.url.startsWith('http')) {
                    embed.setURL(track.url);
                }
            }

            const timestamp = queue.node.getTimestamp();
            if (!isDJCommentary) {
                if (!timestamp || !timestamp.total || !timestamp.current || track.duration === '0:00') {
                    progressDisplay = 'Playing a live stream.';
                } else {
                    // Calculate remaining time in milliseconds
                    const remainingMs = timestamp.total.value - timestamp.current.value;

                    // Validate remaining time is reasonable (not negative, not too large)
                    if (remainingMs > 0 && remainingMs < 24 * 60 * 60 * 1000) { // Less than 24 hours
                        // Calculate the exact UNIX timestamp for when the song will end
                        const songEndTime = Math.floor((Date.now() + remainingMs) / 1000);
                        // Use Discord's relative timestamp feature for a live-updating countdown
                        progressDisplay = `Duration: ${track.duration} | Ends <t:${songEndTime}:R> (<t:${songEndTime}:T>)`;
                    } else {
                        // Fallback if timestamp math doesn't make sense
                        progressDisplay = `Duration: ${track.duration}`;
                    }
                }
            }

            // Validate thumbnail is a proper URL before setting it
            const isValidUrl = (str) => {
                if (!str) return false;
                try {
                    const url = new URL(str);
                    return url.protocol === 'http:' || url.protocol === 'https:';
                } catch {
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
                        { label: 'Add song/playlist by name or URL', description: 'Add a song, YouTube playlist, or Spotify playlist', value: 'add_song_modal' },
                        { label: 'Start an AI DJ session', description: 'AI-generated playlist or play from a playlist link', value: 'start_dj_modal' }
                    ]),
            );

        return [playbackRow, songRequestRow];
    }

    async handleInteraction(interaction) {
        if (!interaction.guildId) return;

        if (interaction.isButton()) {
            // Check that user is in a voice channel before allowing control
            if (!interaction.member?.voice?.channel) {
                try {
                    await interaction.reply({ content: 'You must be in a voice channel to use music controls.', ephemeral: true });
                } catch (e) {
                    // Ignore if interaction already handled
                }
                return;
            }

            // More robust interaction deferral check
            try {
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.deferUpdate();
                }
            } catch (error) {
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
                    if (queue && queue.currentTrack) queue.node.setPaused(!queue.node.isPaused());
                    break;
                case 'music-skip':
                    logger.info(`[Music Panel] Skip button pressed in guild ${interaction.guildId}`);
                    if (queue && queue.currentTrack) {
                        const skippedTrack = queue.currentTrack;
                        const isLastTrack = queue.tracks.size === 0;
                        logger.info(`[Music Panel] Skipping track: ${skippedTrack.title}, isLastTrack: ${isLastTrack}, djMode: ${queue.metadata?.djMode}`);

                        // Always skip immediately — don't let DJ banter block the skip
                        try {
                            queue.node.skip();
                            logger.info(`[Music Panel] queue.node.skip() called successfully`);
                        } catch (skipError) {
                            logger.error(`[Music Panel] Error calling queue.node.skip():`, { error: skipError.message, stack: skipError.stack });
                            try {
                                queue.node.stop();
                                logger.warn(`[Music Panel] Used node.stop() as fallback after skip failed`);
                            } catch (stopError) {
                                logger.error(`[Music Panel] Fallback stop also failed:`, { error: stopError.message });
                            }
                        }

                        // If DJ mode, fire off banter generation in background (non-blocking)
                        if (queue.metadata?.djMode && this.client.djManager) {
                            if (isLastTrack) {
                                setTimeout(() => {
                                    this.client.djManager.onQueueEnd(queue)
                                        .catch(err => logger.error(`[Music Panel] onQueueEnd error:`, { error: err.message }));
                                }, 500);
                            }
                        }
                    } else {
                        logger.warn(`[Music Panel] Skip pressed but no queue or currentTrack`, {
                            hasQueue: !!queue,
                            hasCurrentTrack: queue?.currentTrack ? true : false
                        });
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
                try {
                    const modal = new ModalBuilder().setCustomId('add-song-modal').setTitle('Add Song or Playlist');
                    const songInput = new TextInputBuilder()
                        .setCustomId('song-input')
                        .setLabel("Song/Playlist name or URL")
                        .setPlaceholder("e.g., Never Gonna Give You Up, or a Spotify/YouTube link")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true);
                    modal.addComponents(new ActionRowBuilder().addComponents(songInput));
                    await interaction.showModal(modal);
                } catch (error) {
                    if (error.code !== 10062) {
                        console.error('[Music Panel Modal Error]', error);
                    }
                }
            } else if (interaction.values[0] === 'start_dj_modal') {
                // DIAGNOSTICS - understand why showModal might fail
                console.log('[Music Panel] === SELECT MENU DIAGNOSTIC ===');
                console.log(`[Music Panel] Interaction ID: ${interaction.id}`);
                console.log(`[Music Panel] Already replied: ${interaction.replied}`);
                console.log(`[Music Panel] Already deferred: ${interaction.deferred}`);
                console.log(`[Music Panel] Age (ms): ${Date.now() - interaction.createdTimestamp}`);
                console.log('[Music Panel] Start DJ selected, attempting to show modal...');
                try {
                    const modal = new ModalBuilder().setCustomId('ai-dj-modal').setTitle('Start an AI DJ Session');
                    const playlistInput = new TextInputBuilder()
                        .setCustomId('dj-playlist-input')
                        .setLabel("Playlist URL (Spotify/YouTube)")
                        .setPlaceholder("Paste a playlist link to play directly with DJ mode")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false);
                    const promptInput = new TextInputBuilder()
                        .setCustomId('dj-prompt-input')
                        .setLabel("Or describe what you want to hear")
                        .setPlaceholder("e.g., '90s rock party' or 'chill lofi beats'")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false);
                    const songInput = new TextInputBuilder()
                        .setCustomId('dj-song-input')
                        .setLabel("Song to base playlist on")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false);
                    const artistInput = new TextInputBuilder()
                        .setCustomId('dj-artist-input')
                        .setLabel("Artist to base playlist on")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false);
                    const genreInput = new TextInputBuilder()
                        .setCustomId('dj-genre-input')
                        .setLabel("Genre preference")
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false);
                    modal.addComponents(
                        new ActionRowBuilder().addComponents(playlistInput),
                        new ActionRowBuilder().addComponents(promptInput),
                        new ActionRowBuilder().addComponents(songInput),
                        new ActionRowBuilder().addComponents(artistInput),
                        new ActionRowBuilder().addComponents(genreInput)
                    );
                    await interaction.showModal(modal);
                    console.log('[Music Panel] Modal shown successfully, waiting for user input...');
                } catch (error) {
                    // Modal failed - just log it and ignore (user will see nothing happen)
                    // Don't try to defer or start DJ directly as the interaction may already be acknowledged
                    console.log('[Music Panel] Modal failed with code:', error.code, 'message:', error.message);
                    // Only try fallback if modal truly failed (not rate limited or already acknowledged)
                    if (error.code === 10062) {
                        // Unknown interaction - too slow, can't recover
                        console.log('[Music Panel] Interaction expired, cannot recover');
                    }
                }
            }
        }
    }

    async startDJDirectly(interaction) {
        // Start DJ session directly without modal
        const { spawn } = await import('child_process');
        const fs = await import('fs');
        const path = await import('path');

        console.log('[DJ Direct] Starting DJ session for guild:', interaction.guildId);

        try {
            if (!interaction.member.voice.channel) {
                await interaction.editReply({
                    content: 'You must be in a voice channel to start a DJ session!'
                });
                return;
            }

            await interaction.editReply({
                content: '🎧 **Starting AI DJ session...** Generating playlist with Gemini...'
            });

            // Load Gemini API
            const geminiApi = (await import('../utils/gemini-api.cjs')).default;
            console.log('[DJ Direct] Gemini API loaded');

            // Get recommendations from Gemini
            const recommendations = await geminiApi.generatePlaylistRecommendations(
                null, // song
                null, // artist
                null, // genre
                [],   // played tracks
                'A mix of popular songs from various genres' // prompt
            );

            console.log('[DJ Direct] Gemini returned:', recommendations ? recommendations.length : 0, 'recommendations');

            if (!recommendations || recommendations.length === 0) {
                await interaction.editReply({
                    content: '❌ Failed to get recommendations from AI. Please try again.'
                });
                return;
            }

            await interaction.editReply({
                content: `🎧 **Got ${recommendations.length} recommendations!** Searching YouTube...`
            });

            // Search for tracks using yt-dlp directly
            const tracks = [];
            for (const rec of recommendations.slice(0, 8)) {
                const query = `${rec.title} ${rec.artist}`;
                console.log('[DJ Direct] Searching:', query);

                try {
                    // Use yt-dlp to search YouTube
                    const searchResult = await new Promise((resolve, reject) => {
                        const ytdlp = spawn('yt-dlp', [
                            '--flat-playlist',
                            '--dump-json',
                            '--no-warnings',
                            `ytsearch1:${query}`
                        ]);

                        let stdout = '';
                        let stderr = '';

                        ytdlp.stdout.on('data', (data) => { stdout += data; });
                        ytdlp.stderr.on('data', (data) => { stderr += data; });

                        ytdlp.on('close', (code) => {
                            if (code === 0 && stdout.trim()) {
                                try {
                                    resolve(JSON.parse(stdout.trim()));
                                } catch (e) {
                                    reject(new Error('Failed to parse yt-dlp output'));
                                }
                            } else {
                                reject(new Error(stderr || 'yt-dlp failed'));
                            }
                        });

                        setTimeout(() => {
                            ytdlp.kill();
                            reject(new Error('yt-dlp timeout'));
                        }, 15000);
                    });

                    if (searchResult && searchResult.url) {
                        tracks.push({
                            title: searchResult.title || rec.title,
                            url: searchResult.url.startsWith('http') ? searchResult.url : `https://www.youtube.com/watch?v=${searchResult.id}`,
                            artist: rec.artist,
                            duration: searchResult.duration
                        });
                        console.log('[DJ Direct] Found:', searchResult.title);
                    }
                } catch (searchError) {
                    console.error('[DJ Direct] Search failed for:', query, searchError.message);
                }
            }

            console.log('[DJ Direct] Found', tracks.length, 'tracks total');

            if (tracks.length === 0) {
                await interaction.editReply({
                    content: '❌ Could not find any tracks on YouTube. Please try again.'
                });
                return;
            }

            await interaction.editReply({
                content: `🎧 **Found ${tracks.length} tracks!** Starting playback...`
            });

            // Play the tracks
            const player = this.client.player;
            let queue = player.nodes.get(interaction.guildId);

            // Load DJ voice setting (must be before TTS generation)
            let djVoice = 'alan';
            try {
                const pool = (await import('../utils/db.js')).default;
                const [rows] = await pool.query(
                    'SELECT dj_voice FROM music_config WHERE guild_id = ?',
                    [interaction.guildId]
                );
                if (rows && rows.length > 0) {
                    djVoice = rows[0].dj_voice || 'alan';
                }
            } catch (e) {
                console.error('[DJ Direct] Error loading DJ voice:', e);
            }

            // Generate DJ commentary using Piper TTS
            let commentaryPath = null;
            try {
                const djText = `Welcome to the AI DJ session! I've got ${tracks.length} awesome tracks lined up for you. Let's start with ${tracks[0].title} by ${tracks[0].artist}. Enjoy the music!`;
                const tempDir = '/tmp';
                commentaryPath = path.join(tempDir, `dj_intro_${Date.now()}.wav`);

                console.log('[DJ Direct] Generating TTS commentary...');

                // Map voice name to model path
                const piperModelsDir = process.env.PIPER_MODEL_DIR || '/home/death/CertiFriedUtility/piper_models';
                const voiceModels = {
                    'alan': `${piperModelsDir}/en_GB/alan/medium/en_GB-alan-medium.onnx`,
                    'ryan': `${piperModelsDir}/en_US/ryan/high/en_US-ryan-high.onnx`,
                    'jenny': `${piperModelsDir}/en_GB/jenny/medium/en_GB-jenny-medium.onnx`,
                    'cori': `${piperModelsDir}/en_GB/cori/high/en_GB-cori-high.onnx`
                };
                const modelPath = voiceModels[djVoice] || voiceModels['alan'];
                console.log(`[DJ Direct] Using TTS voice: ${djVoice} (${modelPath})`);

                await new Promise((resolve, reject) => {
                    const piper = spawn('piper', [
                        '--model', modelPath,
                        '--output_file', commentaryPath
                    ]);

                    piper.stdin.write(djText);
                    piper.stdin.end();

                    piper.on('close', (code) => {
                        if (code === 0) {
                            console.log('[DJ Direct] TTS generated successfully');
                            resolve();
                        } else {
                            reject(new Error(`Piper exited with code ${code}`));
                        }
                    });

                    piper.on('error', reject);

                    setTimeout(() => {
                        piper.kill();
                        reject(new Error('Piper timeout'));
                    }, 30000);
                });
            } catch (ttsError) {
                console.error('[DJ Direct] TTS generation failed:', ttsError.message);
                // Continue without commentary
            }

            // Play commentary first if available
            if (commentaryPath && fs.existsSync(commentaryPath)) {
                console.log('[DJ Direct] Playing commentary...');
                try {
                    const { queue: newQueue } = await player.play(interaction.member.voice.channel, commentaryPath, {
                        nodeOptions: {
                            metadata: {
                                channelId: interaction.channelId,
                                djMode: true,
                                djVoice: djVoice,
                                djInitiatorId: interaction.user.id,
                                voiceChannelId: interaction.member.voice.channel.id,
                                playedTracks: [],
                                isDJCommentary: true
                            },
                            selfDeaf: true,
                            volume: 80,
                            leaveOnEmpty: true,
                            leaveOnEmptyCooldown: 300000,
                            leaveOnEnd: false
                        }
                    });
                    queue = newQueue;
                    // Mark first track as commentary
                    if (queue.currentTrack) {
                        queue.currentTrack.metadata = { isDJCommentary: true };
                    }
                } catch (commentaryError) {
                    console.error('[DJ Direct] Failed to play commentary:', commentaryError);
                }
            }

            // Add all tracks to queue
            for (const track of tracks) {
                try {
                    console.log('[DJ Direct] Adding track:', track.title);
                    await player.play(interaction.member.voice.channel, track.url, {
                        nodeOptions: {
                            metadata: {
                                channelId: interaction.channelId,
                                djMode: true,
                                djVoice: djVoice,
                                djInitiatorId: interaction.user.id,
                                voiceChannelId: interaction.member.voice.channel.id,
                                playedTracks: []
                            },
                            selfDeaf: true,
                            volume: 80,
                            leaveOnEmpty: true,
                            leaveOnEmptyCooldown: 300000,
                            leaveOnEnd: false
                        }
                    });
                } catch (addError) {
                    console.error('[DJ Direct] Failed to add track:', track.title, addError.message);
                }
            }

            // Get final queue state
            queue = player.nodes.get(interaction.guildId);
            const queueSize = queue ? queue.tracks.size : 0;
            const currentTrack = queue?.currentTrack;

            await interaction.editReply({
                content: `🎧 **AI DJ Session Started!**\n` +
                    `Now playing: ${currentTrack?.title || 'Starting...'}\n` +
                    `Queue: ${queueSize} tracks`
            });

            // Update the music panel
            await this.updatePanel(queue);

        } catch (error) {
            console.error('[DJ Direct] Error:', error);
            try {
                await interaction.editReply({
                    content: `❌ Failed to start DJ session: ${error.message}`
                });
            } catch (e) {
                // Ignore
            }
        }
    }
}

export default MusicPanel;
