
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const { spawn } = require('child_process');
const geminiApi = require("../utils/gemini-api.js");
const musicMetrics = require("./music-metrics.js");

// --- Piper TTS Configuration ---
const PIPER_PATH = process.env.PIPER_PATH || '/root/.local/bin/piper';
const PIPER_MODEL_DIR = process.env.PIPER_MODEL_DIR || '/root/CertiFriedAnnouncer/piper_models';
const PIPER_DEFAULT_MODEL = process.env.PIPER_DEFAULT_MODEL || 'en_US-amy-medium.onnx';

// --- FFmpeg Configuration ---
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

class DJManager {
  constructor(client) {
    this.client = client;
    this.player = client.player;
    this.player.events.on("playerFinish", (queue, finishedTrack) => this.onPlayerFinish(queue, finishedTrack));
    this.player.events.on("queueEnd", (queue) => this.onQueueEnd(queue));
    this.player.events.on("playerError", (queue, error) => this.onPlayerError(queue, error));
  }

  async generatePiperAudio(text, modelName, finalOutputPath) {
    const modelPath = path.join(PIPER_MODEL_DIR, modelName);
    if (!fs.existsSync(modelPath)) {
        throw new Error(`Piper model not found at: ${modelPath}`);
    }
    return new Promise((resolve, reject) => {
        logger.info(`[DJ/Pipeline] Starting Piper -> FFmpeg audio generation for: ${finalOutputPath}`);
        const piper = spawn(PIPER_PATH, ['--model', modelPath, '--output-raw']);
        const ffmpeg = spawn(FFMPEG_PATH, ['-f', 's16le', '-ar', '22050', '-ac', '1', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '64k', '-y', finalOutputPath]);
        piper.stdin.write(text);
        piper.stdin.end();
        piper.stdout.pipe(ffmpeg.stdin);
        let piperStderr = '';
        piper.stderr.on('data', (data) => { piperStderr += data; });
        let ffmpegStderr = '';
        ffmpeg.stderr.on('data', (data) => { ffmpegStderr += data; });
        piper.on('error', (err) => { logger.error(`[DJ/Piper] Failed to start Piper process: ${err.message}`); reject(err); });
        ffmpeg.on('error', (err) => { logger.error(`[DJ/FFmpeg] Failed to start FFmpeg process: ${err.message}`); reject(err); });
        ffmpeg.on('close', (code) => {
            if (code === 0) {
                logger.info(`[DJ/FFmpeg] FFmpeg process finished successfully. Audio saved to ${finalOutputPath}`);
                resolve(finalOutputPath);
            } else {
                logger.error(`[DJ/FFmpeg] FFmpeg process exited with code ${code}. Stderr: ${ffmpegStderr}`);
                logger.error(`[DJ/Piper] Piper Stderr (for context): ${piperStderr}`);
                reject(new Error(`FFmpeg failed with code ${code}`));
            }
        });
    });
  }

  async playPlaylistIntro(queue, playlistTracks, addToEnd = false) {
    logger.info(`[DJ] playPlaylistIntro triggered for guild ${queue.guild.id}.`);
    if (!playlistTracks || playlistTracks.length === 0) {
        logger.warn(`[DJ] No playlist tracks provided for intro commentary for guild ${queue.guild.id}.`);
        return;
    }

    // In DJ mode, add commentary, then add all tracks in a single batch.
    if (queue.metadata.djMode) {
        try {
            const commentaryText = await geminiApi.generatePlaylistCommentary(playlistTracks);
            let script = commentaryText || `Here\'s your upcoming playlist!`;
            logger.info(`[DJ] Generated intro script for guild ${queue.guild.id}: ${script}`);
            const piperTempFilePath = path.join(__dirname, `../temp_audio/${queue.guild.id}_intro_commentary_piper.opus`);
            let audioFilePath;

            try {
                audioFilePath = await this.generatePiperAudio(script, PIPER_DEFAULT_MODEL, piperTempFilePath);
            } catch (piperError) {
                logger.error(`[DJ] Audio generation pipeline failed for intro commentary: ${piperError.message}. Adding tracks without intro.`);
                queue.addTrack(playlistTracks); // Add tracks directly if commentary fails
                return;
            }

            const commentarySearchResult = await this.player.search(audioFilePath, { searchEngine: 'com.livebot.ytdlp', requestedBy: this.client.user, metadata: { isDJCommentary: true } });
            if (!commentarySearchResult || !commentarySearchResult.hasTracks()) {
                logger.error(`[DJ] Failed to resolve commentary track from local file: ${audioFilePath}. Adding tracks without intro.`);
                queue.addTrack(playlistTracks);
                return;
            }

            const commentaryTrack = commentarySearchResult.tracks[0];
            commentaryTrack.title = 'DJ Playlist Intro';
            commentaryTrack.description = 'DJ Intro for upcoming playlist';
            commentaryTrack.author = 'DJ Bot';
            commentaryTrack.thumbnail = 'https://i.imgur.com/GBp9Ahl.png';

            // Add commentary first, then the rest of the tracks.
            // The queue.addTrack method will trigger the necessary events.
            const tracksToAdd = [commentaryTrack, ...playlistTracks];
            queue.addTrack(tracksToAdd);

            logger.info(`[DJ] Added commentary and ${playlistTracks.length} playlist tracks.`);
        } catch (error) {
            logger.error(`[DJ] Failed to generate or inject intro commentary for guild ${queue.guild.id}:`, { error: error.message, stack: error.stack });
            queue.addTrack(playlistTracks); // Fallback to adding tracks without commentary
        }
    } else {
        // If not in DJ mode, just add the tracks.
        queue.addTrack(playlistTracks);
    }

    this.client.musicPanelManager?.get(queue.guild.id)?.updatePanel();
  }

  async playSkipBanter(queue, skippedTrack, skipper) {
    if (!queue.metadata.djMode) return;
    try {
        await musicMetrics.incrementSkipButtonPresses(queue.guild.id, skipper.id);
        const requester = skippedTrack.requestedBy;
        if (requester) {
            await musicMetrics.incrementSkipCount(skippedTrack.url, queue.guild.id, requester.id);
        }

        const metrics = await musicMetrics.getMusicMetrics(skippedTrack.url, queue.guild.id, skipper.id);
        const commentaryText = await geminiApi.generatePassiveAggressiveCommentary(metrics);
        const filePath = path.join(__dirname, `../temp_audio/${queue.guild.id}_skip_banter.opus`);
        const audioFilePath = await this.generatePiperAudio(commentaryText, PIPER_DEFAULT_MODEL, filePath);
        const searchResult = await this.player.search(audioFilePath, { searchEngine: 'com.livebot.ytdlp', requestedBy: this.client.user, metadata: { isDJCommentary: true, isSkipBanter: true } });
        if (searchResult.hasTracks()) {
            const banterTrack = searchResult.tracks[0];
            banterTrack.title = 'DJ Banter';
            queue.insertTrack(banterTrack, 0);
            logger.info(`[DJ] Inserted skip banter for guild ${queue.guild.id}.`);
        }
    } catch (error) {
        logger.error(`[DJ] Failed to play skip banter for guild ${queue.guild.id}:`, { error: error.message, stack: error.stack });
    } finally {
        this.client.musicPanelManager?.get(queue.guild.id)?.updatePanel();
    }
  }

  async onPlayerFinish(queue, finishedTrack) {
    logger.info(`[DJ] onPlayerFinish event triggered for guild ${queue.guild.id}. Track: ${finishedTrack.title}, Queue Size: ${queue.tracks.size}`);
    this.client.musicPanelManager?.get(queue.guild.id)?.updatePanel();

    if (finishedTrack.metadata?.isDJCommentary || finishedTrack.metadata?.isSkipBanter) {
        const localPath = finishedTrack.url;
        if (localPath && fs.existsSync(localPath)) {
            fs.unlink(localPath, (err) => {
                if (err) logger.error(`[Cleanup] Failed to delete commentary temp file: ${localPath}`, err.message);
                else logger.info(`[Cleanup] Deleted commentary temp file: ${localPath}`);
            });
        }
    } else if (finishedTrack.requestedBy) {
        const requester = finishedTrack.requestedBy;
        const djInitiatorId = queue.metadata?.djInitiatorId;
        const finalUserId = (requester.id === this.client.user.id && djInitiatorId) ? djInitiatorId : requester.id;
        await musicMetrics.incrementPlayCount(finishedTrack.url, queue.guild.id, finalUserId);
    }

    if (queue.tracks.size > 0 && queue.tracks.size <= 3 && queue.metadata.djMode && !queue.metadata.isGenerating) {
        logger.info(`[DJ] Queue nearing end (${queue.tracks.size} tracks left). Triggering onQueueEnd to pre-fetch next playlist.`);
        this.onQueueEnd(queue).catch(e => logger.error(`[DJ] Error during pre-emptive onQueueEnd: ${e.message}`));
    } else if (queue.tracks.size === 0 && queue.metadata.djMode) {
        logger.info(`[DJ] Queue is empty after track finish. Manually triggering onQueueEnd logic.`);
        setTimeout(() => this.onQueueEnd(queue), 500);
    }
  }

  async onQueueEnd(queue) {
    logger.info(`[DJ] queueEnd event triggered for guild ${queue.guild.id}.`);
    const panel = this.client.musicPanelManager?.get(queue.guild.id);
    if (queue.metadata.isGenerating) {
        logger.warn(`[DJ] Playlist generation is already in progress for guild ${queue.guild.id}. Skipping.`);
        return;
    }
    if (queue.metadata.djMode) {
        const shouldAddToEnd = queue.tracks.size > 0;
        try {
            queue.metadata.isGenerating = true;
            if(panel) await panel.updatePanel();
            logger.info(`[DJ] DJ mode is active. Generating new playlist. addToEnd: ${shouldAddToEnd}`);
            const { inputSong, inputArtist, inputGenre, playedTracks, djInitiatorId, prompt } = queue.metadata;

            const djUser = await this.client.users.fetch(djInitiatorId).catch(() => null);
            if (!djUser) {
                logger.error(`[DJ] Could not fetch the DJ initiator user (ID: ${djInitiatorId}). Ending session.`);
                const channel = await this.client.channels.cache.get(queue.metadata.channelId);
                if (channel) channel.send("🎧 | Could not identify the original DJ. Ending the session.");
                if (queue.connection) queue.delete();
                return;
            }

            const geminiRecommendedTracks = await geminiApi.generatePlaylistRecommendations(inputSong, inputArtist, inputGenre, playedTracks, prompt);
            if (geminiRecommendedTracks && geminiRecommendedTracks.length > 0) {
                const trackPromises = geminiRecommendedTracks.map(async (recTrack) => {
                    const query = `${recTrack.title} ${recTrack.artist}`;
                    const searchResult = await this.player.search(query, { searchEngine: 'com.livebot.ytdlp', requestedBy: djUser, metadata: { artist: recTrack.artist } });
                    if (searchResult.hasTracks()) {
                        const track = searchResult.tracks[0];
                        if (!track.url.includes('youtube.com/shorts')) return track;
                    }
                    return null;
                });
                const resolvedTracks = (await Promise.all(trackPromises)).filter(track => track !== null);
                if (resolvedTracks.length > 0) {
                    playedTracks.push(...resolvedTracks.map(t => t.title));
                    this.player.extractors.get('com.livebot.ytdlp').preloadTracks(resolvedTracks);
                    await this.playPlaylistIntro(queue, resolvedTracks, shouldAddToEnd);
                    if (!queue.isPlaying() && !shouldAddToEnd) {
                        await queue.node.play();
                    }
                } else {
                    logger.warn(`[DJ] No playable tracks found for new recommendations.`);
                    const channel = await this.client.channels.cache.get(queue.metadata.channelId);
                    if (channel) channel.send("🎧 | The AI DJ has run out of new recommendations. Ending the session.");
                    if (queue.connection) queue.delete();
                }
            } else {
                logger.info(`[DJ] Gemini AI did not return new recommendations. Ending DJ session.`);
                const channel = await this.client.channels.cache.get(queue.metadata.channelId);
                if (channel) channel.send("🎧 | The AI DJ has run out of new recommendations. Ending the session.");
                if (queue.connection) queue.delete();
            }
        } finally {
            queue.metadata.isGenerating = false;
            if(panel) await panel.updatePanel();
        }
    }
  }

  async onPlayerError(queue, error) {
      logger.error(`[Player Error] Guild: ${queue.guild.id}, Error: ${error.message}`);
      const channel = await this.client.channels.cache.get(queue.metadata.channelId);
      if (channel) {
          channel.send(`🎧 | Encountered an error with a track and had to skip it. Sorry about that!`);
      }
  }
}

module.exports = DJManager;
