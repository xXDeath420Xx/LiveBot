const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const { Track } = require('discord-player');
const { spawn } = require('child_process');
const geminiApi = require("../utils/gemini-api.js");

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
  }

  async generatePiperAudio(text, modelName, finalOutputPath) {
    const modelPath = path.join(PIPER_MODEL_DIR, modelName);

    if (!fs.existsSync(modelPath)) {
        throw new Error(`Piper model not found at: ${modelPath}`);
    }

    return new Promise((resolve, reject) => {
        logger.info(`[DJ/Pipeline] Starting Piper -> FFmpeg audio generation for: ${finalOutputPath}`);

        const piper = spawn(PIPER_PATH, [
            '--model', modelPath,
            '--output-raw'
        ]);

        const ffmpeg = spawn(FFMPEG_PATH, [
            '-f', 's16le',
            '-ar', '22050',
            '-ac', '1',
            '-i', 'pipe:0',
            '-c:a', 'libopus',
            '-b:a', '64k',
            '-y',
            finalOutputPath
        ]);

        piper.stdin.write(text);
        piper.stdin.end();

        piper.stdout.pipe(ffmpeg.stdin);

        let piperStderr = '';
        piper.stderr.on('data', (data) => {
            piperStderr += data;
        });

        let ffmpegStderr = '';
        ffmpeg.stderr.on('data', (data) => {
            ffmpegStderr += data;
        });

        piper.on('error', (err) => {
            logger.error(`[DJ/Piper] Failed to start Piper process: ${err.message}`);
            reject(err);
        });

        ffmpeg.on('error', (err) => {
            logger.error(`[DJ/FFmpeg] Failed to start FFmpeg process: ${err.message}`);
            reject(err);
        });

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

  async playPlaylistIntro(queue, playlistTracks) {
    logger.info(`[DJ] playPlaylistIntro triggered for guild ${queue.guild.id}.`);

    if (!queue.metadata.djMode) {
        logger.info(`[DJ] DJ mode not active for guild ${queue.guild.id}. Adding tracks directly.`);
        queue.addTrack(playlistTracks);
        return;
    }

    if (!playlistTracks || playlistTracks.length === 0) {
        logger.warn(`[DJ] No playlist tracks provided for intro commentary for guild ${queue.guild.id}.`);
        queue.addTrack(playlistTracks);
        return;
    }

    try {
        const commentaryText = await geminiApi.generatePlaylistCommentary(playlistTracks);
        let script = commentaryText || `Here's your upcoming playlist!`;

        logger.info(`[DJ] Generated intro script for guild ${queue.guild.id}: ${script}`);

        const piperTempFilePath = path.join(__dirname, `../temp_audio/${queue.guild.id}_intro_commentary_piper.opus`);
        let audioFilePath;

        try {
            audioFilePath = await this.generatePiperAudio(script, PIPER_DEFAULT_MODEL, piperTempFilePath);
        } catch (piperError) {
            logger.error(`[DJ] Audio generation pipeline failed for intro commentary: ${piperError.message}. Adding tracks without intro.`);
            queue.addTrack(playlistTracks);
            return;
        }

        const commentarySearchResult = await this.player.search(audioFilePath, {
            searchEngine: 'com.livebot.ytdlp',
            metadata: { requesterId: this.client.user.id, isDJCommentary: true }
        });

        if (!commentarySearchResult || !commentarySearchResult.hasTracks()) {
            logger.error(`[DJ] Failed to resolve commentary track from local file: ${audioFilePath}. Adding tracks without intro.`);
            queue.addTrack(playlistTracks);
            return;
        }

        const commentaryTrack = commentarySearchResult.tracks[0];

        // The track from the extractor is already a Track instance, but we can override properties if needed
        commentaryTrack.title = 'DJ Playlist Intro';
        commentaryTrack.description = 'DJ Intro for upcoming playlist';
        commentaryTrack.author = 'DJ Bot';
        commentaryTrack.thumbnail = 'https://i.imgur.com/GBp9Ahl.png';

        queue.insertTrack(commentaryTrack, 0);
        logger.info(`[DJ] Inserted intro commentary track for guild ${queue.guild.id}.`);

        queue.addTrack(playlistTracks);
        logger.info(`[DJ] Added ${playlistTracks.length} playlist tracks after intro commentary.`);

    } catch (error) {
        logger.error(`[DJ] Failed to generate or inject intro commentary for guild ${queue.guild.id}:`, { error: error.message, stack: error.stack });
        queue.addTrack(playlistTracks);
    }
  }

  async onPlayerFinish(queue, finishedTrack) {
    logger.info(`[DJ] onPlayerFinish event triggered for guild ${queue.guild.id}. Track: ${finishedTrack.title}`);

    if (finishedTrack.metadata && finishedTrack.metadata.isDJCommentary) {
        logger.info(`[DJ] Finished track was a commentary. Cleaning up temp file if exists.`);
        const localPath = finishedTrack.url;
        if (localPath && fs.existsSync(localPath)) {
            fs.unlink(localPath, (err) => {
                if (err) logger.error(`[Cleanup] Failed to delete commentary temp file: ${localPath}`, err.message);
                else logger.info(`[Cleanup] Deleted commentary temp file: ${localPath}`);
            });
        }
        return;
    }

    if (queue.metadata.djMode && queue.tracks.size === 0 && queue.currentTrack === null) {
        logger.info(`[DJ] DJ mode active and queue is empty. Generating new recommendations.`);
        const { inputSong, inputArtist, inputGenre } = queue.metadata;
        const geminiRecommendedTracks = await geminiApi.generatePlaylistRecommendations(inputSong, inputArtist, inputGenre, queue.metadata.playedTracks);

        if (geminiRecommendedTracks && geminiRecommendedTracks.length > 0) {
            const trackPromises = geminiRecommendedTracks.map(async (recTrack) => {
                const query = `${recTrack.title} ${recTrack.artist}`;
                const searchResult = await this.player.search(query, {
                    searchEngine: 'com.livebot.ytdlp',
                    metadata: { requesterId: this.client.user.id, artist: recTrack.artist }
                });
                if (searchResult.hasTracks()) {
                    return searchResult.tracks[0];
                }
                return null;
            });

            const resolvedTracks = await Promise.all(trackPromises);
            const newPlaylistTracks = resolvedTracks.filter(track => track !== null);

            if (newPlaylistTracks.length > 0) {
                queue.metadata.playedTracks.push(...newPlaylistTracks.map(t => t.title));
                await this.playPlaylistIntro(queue, newPlaylistTracks);
                if (!queue.isPlaying()) {
                    await queue.node.play();
                }
            } else {
                logger.warn(`[DJ] No playable tracks found for new recommendations.`);
                const channel = await this.client.channels.cache.get(queue.metadata.channelId);
                if (channel) {
                    channel.send("🎧 | The AI DJ has run out of new recommendations. Ending the session.");
                }
                queue.delete();
            }
        } else {
            logger.info(`[DJ] Gemini AI did not return new recommendations. Ending DJ session.`);
            const channel = await this.client.channels.cache.get(queue.metadata.channelId);
            if (channel) {
                channel.send("🎧 | The AI DJ has run out of new recommendations. Ending the session.");
            }
            queue.delete(); // Stop the queue if no new songs can be found
        }
    } else {
        logger.info(`[DJ] Regular track finished. No inter-song commentary will be played.`);
    }
  }
}

module.exports = DJManager;
