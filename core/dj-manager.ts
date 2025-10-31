import type { Client, User } from 'discord.js';
import type { RowDataPacket } from 'mysql2';
import type { GuildQueue, Track } from 'discord-player';
import * as fs from "fs";
import * as path from "path";
import logger from "../utils/logger";
import { spawn } from 'child_process';
import * as geminiApi from "../utils/gemini-api.js";
import * as musicMetrics from "./music-metrics.js";
import db from "../utils/db";

interface DJVoiceConfig extends RowDataPacket {
    guild_id: string;
    dj_voice: string | null;
}

interface VoiceMapping {
    [key: string]: string;
}

interface VoiceInfo {
    name: string;
    path: string;
    locale: string;
    quality: string;
}

interface RecommendedTrack {
    title: string;
    artist: string;
}

// --- Piper TTS Configuration ---
const PIPER_PATH = process.env.PIPER_PATH || '/root/.local/bin/piper';
const PIPER_MODEL_DIR = process.env.PIPER_MODEL_DIR || '/root/CertiFriedAnnouncer/piper_models';
const PIPER_DEFAULT_MODEL = process.env.PIPER_DEFAULT_MODEL || 'en/en_US/amy/medium/en_US-amy-medium.onnx';

// --- FFmpeg Configuration ---
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

class DJManager {
    private client: Client;
    private player: any;

    constructor(client: Client & { player: any }) {
        this.client = client;
        this.player = client.player;
        this.player.events.on("playerFinish", (queue: GuildQueue, finishedTrack: Track) => this.onPlayerFinish(queue, finishedTrack));
        this.player.events.on("queueEnd", (queue: GuildQueue) => this.onQueueEnd(queue));
        this.player.events.on("playerError", (queue: GuildQueue, error: Error) => this.onPlayerError(queue, error));
    }

    async getDJVoiceModel(guildId: string): Promise<string> {
        try {
            const [[config]] = await db.execute<DJVoiceConfig[]>("SELECT dj_voice FROM music_config WHERE guild_id = ?", [guildId]);
            if (config && config.dj_voice) {
                // If dj_voice contains a path separator or .onnx extension, use it as-is
                if (config.dj_voice.includes('/') || config.dj_voice.includes('.onnx')) {
                    return config.dj_voice;
                }
                // Otherwise treat it as a simple name and map to models
                const voiceMap = this.getAllVoices();
                return voiceMap[config.dj_voice] || PIPER_DEFAULT_MODEL;
            }
        } catch (error: any) {
            logger.warn(`[DJ] Failed to fetch DJ voice for guild ${guildId}, using default: ${error.message}`);
        }
        return PIPER_DEFAULT_MODEL;
    }

    getAllVoices(): VoiceMapping {
        return {
            // US English - Female Voices
            'female': 'en_US/amy/medium/en_US-amy-medium.onnx',
            'amy': 'en_US/amy/medium/en_US-amy-medium.onnx',
            'amy-low': 'en_US/amy/low/en_US-amy-low.onnx',
            'kristin': 'en_US/kristin/medium/en_US-kristin-medium.onnx',
            'kathleen': 'en_US/kathleen/low/en_US-kathleen-low.onnx',
            'hfc-female': 'en_US/hfc_female/medium/en_US-hfc_female-medium.onnx',
            'ljspeech': 'en_US/ljspeech/medium/en_US-ljspeech-medium.onnx',
            'ljspeech-high': 'en_US/ljspeech/high/en_US-ljspeech-high.onnx',
            'lessac': 'en_US/lessac/medium/en_US-lessac-medium.onnx',
            'lessac-high': 'en_US/lessac/high/en_US-lessac-high.onnx',
            'lessac-low': 'en_US/lessac/low/en_US-lessac-low.onnx',

            // US English - Male Voices
            'male': 'en_US/joe/medium/en_US-joe-medium.onnx',
            'joe': 'en_US/joe/medium/en_US-joe-medium.onnx',
            'bryce': 'en_US/bryce/medium/en_US-bryce-medium.onnx',
            'danny': 'en_US/danny/low/en_US-danny-low.onnx',
            'john': 'en_US/john/medium/en_US-john-medium.onnx',
            'hfc-male': 'en_US/hfc_male/medium/en_US-hfc_male-medium.onnx',
            'ryan': 'en_US/ryan/medium/en_US-ryan-medium.onnx',
            'ryan-high': 'en_US/ryan/high/en_US-ryan-high.onnx',
            'ryan-low': 'en_US/ryan/low/en_US-ryan-low.onnx',
            'sam': 'en_US/sam/medium/en_US-sam-medium.onnx',
            'norman': 'en_US/norman/medium/en_US-norman-medium.onnx',

            // US English - Neutral/Other Voices
            'arctic': 'en_US/arctic/medium/en_US-arctic-medium.onnx',
            'kusal': 'en_US/kusal/medium/en_US-kusal-medium.onnx',
            'l2arctic': 'en_US/l2arctic/medium/en_US-l2arctic-medium.onnx',
            'libritts': 'en_US/libritts/high/en_US-libritts-high.onnx',
            'libritts-r': 'en_US/libritts_r/medium/en_US-libritts_r-medium.onnx',
            'reza': 'en_US/reza_ibrahim/medium/en_US-reza_ibrahim-medium.onnx',

            // UK English - Female Voices
            'uk-female': 'en_GB/alba/medium/en_GB-alba-medium.onnx',
            'alba': 'en_GB/alba/medium/en_GB-alba-medium.onnx',
            'cori': 'en_GB/cori/medium/en_GB-cori-medium.onnx',
            'cori-high': 'en_GB/cori/high/en_GB-cori-high.onnx',
            'jenny': 'en_GB/jenny_dioco/medium/en_GB-jenny_dioco-medium.onnx',
            'southern-english-female': 'en_GB/southern_english_female/low/en_GB-southern_english_female-low.onnx',

            // UK English - Male Voices
            'uk-male': 'en_GB/alan/medium/en_GB-alan-medium.onnx',
            'alan': 'en_GB/alan/medium/en_GB-alan-medium.onnx',
            'alan-low': 'en_GB/alan/low/en_GB-alan-low.onnx',
            'northern-english-male': 'en_GB/northern_english_male/medium/en_GB-northern_english_male-medium.onnx',

            // UK English - Neutral/Other Voices
            'aru': 'en_GB/aru/medium/en_GB-aru-medium.onnx',
            'semaine': 'en_GB/semaine/medium/en_GB-semaine-medium.onnx',
            'vctk': 'en_GB/vctk/medium/en_GB-vctk-medium.onnx'
        };
    }

    getVoicesList(): VoiceInfo[] {
        const voices = this.getAllVoices();
        return Object.keys(voices).map(key => ({
            name: key,
            path: voices[key],
            locale: voices[key].startsWith('en_US/') ? 'US English' : 'UK English',
            quality: voices[key].includes('/high/') ? 'High' : voices[key].includes('/low/') ? 'Low' : 'Medium'
        }));
    }

    async generatePiperAudio(text: string, modelName: string, finalOutputPath: string): Promise<string> {
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

    async playPlaylistIntro(queue: GuildQueue, playlistTracks: Track[], addToEnd: boolean = false): Promise<void> {
        logger.info(`[DJ] playPlaylistIntro triggered for guild ${queue.guild.id}.`);
        if (!playlistTracks || playlistTracks.length === 0) {
            logger.warn(`[DJ] No playlist tracks provided for intro commentary for guild ${queue.guild.id}.`);
            return;
        }

        // In DJ mode, add commentary, then add all tracks in a single batch.
        if (queue.metadata.djMode) {
            try {
                // Validate playlistTracks before proceeding
                if (!Array.isArray(playlistTracks) || playlistTracks.length === 0) {
                    logger.warn(`[DJ] Invalid playlist tracks provided for guild ${queue.guild.id}. Skipping commentary.`);
                    return;
                }

                const commentaryText = await geminiApi.generatePlaylistCommentary(playlistTracks);
                let script = commentaryText || `Here's your upcoming playlist!`;
                logger.info(`[DJ] Generated intro script for guild ${queue.guild.id}: ${script}`);
                const piperTempFilePath = path.join(__dirname, `../temp_audio/${queue.guild.id}_intro_commentary_piper.opus`);
                let audioFilePath: string;

                try {
                    const djVoiceModel = await this.getDJVoiceModel(queue.guild.id);
                    audioFilePath = await this.generatePiperAudio(script, djVoiceModel, piperTempFilePath);
                } catch (piperError: any) {
                    logger.error(`[DJ] Audio generation pipeline failed for intro commentary: ${piperError.message}. Adding tracks without intro.`);
                    queue.addTrack(playlistTracks); // Add tracks directly if commentary fails
                    (this.client as any).musicPanelManager?.get(queue.guild.id)?.updatePanel();
                    return;
                }

                // Search for the local file using discord-player's built-in file handling
                const commentarySearchResult = await this.player.search(audioFilePath, {
                    requestedBy: this.client.user!,
                    metadata: { isDJCommentary: true }
                });

                if (!commentarySearchResult || !commentarySearchResult.hasTracks()) {
                    logger.error(`[DJ] Failed to resolve commentary track from local file: ${audioFilePath}. Adding tracks without intro.`);
                    queue.addTrack(playlistTracks);
                    (this.client as any).musicPanelManager?.get(queue.guild.id)?.updatePanel();
                    return;
                }

                const commentaryTrack = commentarySearchResult.tracks[0];
                commentaryTrack.title = 'DJ Playlist Intro';
                commentaryTrack.description = 'DJ Intro for upcoming playlist';
                commentaryTrack.author = 'DJ Bot';
                commentaryTrack.thumbnail = 'https://i.imgur.com/GBp9Ahl.png';

                // Add commentary first, then the rest of the tracks.
                const tracksToAdd = [commentaryTrack, ...playlistTracks];
                queue.addTrack(tracksToAdd);

                logger.info(`[DJ] Added commentary and ${playlistTracks.length} playlist tracks.`);
            } catch (error: any) {
                logger.error(`[DJ] Failed to generate or inject intro commentary for guild ${queue.guild.id}:`, { error: error.message, stack: error.stack });
                // Ensure tracks are added even if commentary completely fails
                try {
                    queue.addTrack(playlistTracks);
                } catch (addError: any) {
                    logger.error(`[DJ] Critical error: Failed to add tracks after commentary failure:`, { error: addError.message, stack: addError.stack });
                }
            }
        } else {
            // If not in DJ mode, just add the tracks.
            queue.addTrack(playlistTracks);
        }

        (this.client as any).musicPanelManager?.get(queue.guild.id)?.updatePanel();
    }

    async playSkipBanter(queue: GuildQueue, skippedTrack: Track, skipper: User): Promise<void> {
        if (!queue.metadata.djMode) return;
        try {
            await musicMetrics.incrementSkipButtonPresses(queue.guild.id, skipper.id);
            const requester = skippedTrack.requestedBy as User;
            if (requester) {
                await musicMetrics.incrementSkipCount(skippedTrack.url, queue.guild.id, requester.id);
            }

            const metrics = await musicMetrics.getMusicMetrics(skippedTrack.url, queue.guild.id, skipper.id);
            const commentaryText = await geminiApi.generatePassiveAggressiveCommentary(metrics);
            const filePath = path.join(__dirname, `../temp_audio/${queue.guild.id}_skip_banter.opus`);
            const djVoiceModel = await this.getDJVoiceModel(queue.guild.id);
            const audioFilePath = await this.generatePiperAudio(commentaryText, djVoiceModel, filePath);

            const searchResult = await this.player.search(audioFilePath, {
                requestedBy: this.client.user!,
                metadata: { isDJCommentary: true, isSkipBanter: true }
            });

            if (searchResult.hasTracks()) {
                const banterTrack = searchResult.tracks[0];
                banterTrack.title = 'DJ Banter';
                queue.insertTrack(banterTrack, 0);
                logger.info(`[DJ] Inserted skip banter for guild ${queue.guild.id}.`);
            }
        } catch (error: any) {
            logger.error(`[DJ] Failed to play skip banter for guild ${queue.guild.id}:`, { error: error.message, stack: error.stack });
        } finally {
            (this.client as any).musicPanelManager?.get(queue.guild.id)?.updatePanel();
        }
    }

    async onPlayerFinish(queue: GuildQueue, finishedTrack: Track): Promise<void> {
        logger.info(`[DJ] onPlayerFinish event triggered for guild ${queue.guild.id}. Track: ${finishedTrack.title}, Queue Size: ${queue.tracks.size}`);
        (this.client as any).musicPanelManager?.get(queue.guild.id)?.updatePanel();

        if (finishedTrack.metadata?.isDJCommentary || finishedTrack.metadata?.isSkipBanter) {
            const localPath = finishedTrack.url;
            if (localPath && fs.existsSync(localPath)) {
                fs.unlink(localPath, (err) => {
                    if (err) logger.error(`[Cleanup] Failed to delete commentary temp file: ${localPath}`, err.message);
                    else logger.info(`[Cleanup] Deleted commentary temp file: ${localPath}`);
                });
            }
        } else if (finishedTrack.requestedBy) {
            const requester = finishedTrack.requestedBy as User;
            const djInitiatorId = queue.metadata?.djInitiatorId;
            const finalUserId = (requester.id === this.client.user!.id && djInitiatorId) ? djInitiatorId : requester.id;
            await musicMetrics.incrementPlayCount(finishedTrack.url, queue.guild.id, finalUserId);
        }

        if (queue.tracks.size > 0 && queue.tracks.size <= 3 && queue.metadata.djMode && !queue.metadata.isGenerating) {
            logger.info(`[DJ] Queue nearing end (${queue.tracks.size} tracks left). Triggering onQueueEnd to pre-fetch next playlist.`);
            this.onQueueEnd(queue).catch((e: any) => logger.error(`[DJ] Error during pre-emptive onQueueEnd: ${e.message}`));
        } else if (queue.tracks.size === 0 && queue.metadata.djMode) {
            logger.info(`[DJ] Queue is empty after track finish. Manually triggering onQueueEnd logic.`);
            setTimeout(() => this.onQueueEnd(queue), 500);
        }
    }

    async onQueueEnd(queue: GuildQueue): Promise<void> {
        logger.info(`[DJ] queueEnd event triggered for guild ${queue.guild.id}.`);
        const panel = (this.client as any).musicPanelManager?.get(queue.guild.id);
        if (queue.metadata.isGenerating) {
            logger.warn(`[DJ] Playlist generation is already in progress for guild ${queue.guild.id}. Skipping.`);
            return;
        }
        if (queue.metadata.djMode) {
            const shouldAddToEnd = queue.tracks.size > 0;
            try {
                queue.metadata.isGenerating = true;
                if (panel) await panel.updatePanel();
                logger.info(`[DJ] DJ mode is active. Generating new playlist. addToEnd: ${shouldAddToEnd}`);
                let { inputSong, inputArtist, inputGenre, playedTracks, djInitiatorId, prompt } = queue.metadata;

                const djUser = await this.client.users.fetch(djInitiatorId).catch(() => null);
                if (!djUser) {
                    logger.error(`[DJ] Could not fetch the DJ initiator user (ID: ${djInitiatorId}). Ending session.`);
                    const channel = await this.client.channels.cache.get(queue.metadata.channelId);
                    if (channel && channel.isTextBased()) (channel as any).send("🎧 | Could not identify the original DJ. Ending the session.");
                    if (queue.connection) queue.delete();
                    return;
                }

                // Detect and handle YouTube URLs in the prompt to prevent overload
                if (prompt && (prompt.includes('youtube.com') || prompt.includes('youtu.be'))) {
                    logger.info(`[DJ] Detected YouTube URL in prompt: ${prompt}. Extracting video info...`);
                    try {
                        // Try yt-dlp extractor first, fall back to Playwright if needed
                        let ytExtractor = this.player.extractors.get('com.certifried.ytdlp') ||
                            this.player.extractors.get('com.certifried.playwright-youtube');
                        if (ytExtractor && ytExtractor.getVideoInfo) {
                            const videoInfo = await ytExtractor.getVideoInfo(prompt);
                            if (videoInfo && videoInfo.title && videoInfo.author) {
                                logger.info(`[DJ] Extracted video info: "${videoInfo.title}" by "${videoInfo.author}"`);
                                // Use the extracted video info as seed song/artist instead of URL
                                inputSong = videoInfo.title;
                                inputArtist = videoInfo.author;
                                prompt = null; // Clear the prompt so it uses song/artist instead
                            }
                        }
                    } catch (error: any) {
                        logger.error(`[DJ] Failed to extract YouTube video info: ${error.message}. Using prompt as-is.`);
                    }
                }

                const geminiRecommendedTracks = await geminiApi.generatePlaylistRecommendations(inputSong, inputArtist, inputGenre, playedTracks, prompt);
                if (geminiRecommendedTracks && geminiRecommendedTracks.length > 0) {
                    // Process tracks in batches to prevent resource exhaustion
                    const BATCH_SIZE = 3; // Process 3 searches at a time
                    const resolvedTracks: Track[] = [];

                    for (let i = 0; i < geminiRecommendedTracks.length; i += BATCH_SIZE) {
                        const batch = geminiRecommendedTracks.slice(i, i + BATCH_SIZE);
                        const batchPromises = batch.map(async (recTrack: RecommendedTrack) => {
                            const query = `${recTrack.title} ${recTrack.artist}`;
                            // Let discord-player automatically select best extractor (yt-dlp first, then Playwright fallback)
                            const searchResult = await this.player.search(query, { requestedBy: djUser, metadata: { artist: recTrack.artist } });
                            if (searchResult.hasTracks()) {
                                const track = searchResult.tracks[0];
                                if (!track.url.includes('youtube.com/shorts')) return track;
                            }
                            return null;
                        });
                        const batchResults = await Promise.all(batchPromises);
                        resolvedTracks.push(...batchResults.filter((track: Track | null) => track !== null) as Track[]);
                        logger.info(`[DJ] Processed batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(geminiRecommendedTracks.length / BATCH_SIZE)} (${resolvedTracks.length} tracks found so far)`);
                    }
                    if (resolvedTracks.length > 0) {
                        playedTracks.push(...resolvedTracks.map(t => t.title));
                        await this.playPlaylistIntro(queue, resolvedTracks, shouldAddToEnd);
                        if (!queue.isPlaying() && !shouldAddToEnd) {
                            await queue.node.play();
                        }
                    } else {
                        logger.warn(`[DJ] No playable tracks found for new recommendations.`);
                        const channel = await this.client.channels.cache.get(queue.metadata.channelId);
                        if (channel && channel.isTextBased()) (channel as any).send("🎧 | The AI DJ has run out of new recommendations. Ending the session.");
                        if (queue.connection) queue.delete();
                    }
                } else {
                    logger.info(`[DJ] Gemini AI did not return new recommendations. Ending DJ session.`);
                    const channel = await this.client.channels.cache.get(queue.metadata.channelId);
                    if (channel && channel.isTextBased()) (channel as any).send("🎧 | The AI DJ has run out of new recommendations. Ending the session.");
                    if (queue.connection) queue.delete();
                }
            } finally {
                queue.metadata.isGenerating = false;
                if (panel) await panel.updatePanel();
            }
        }
    }

    async onPlayerError(queue: GuildQueue, error: Error): Promise<void> {
        logger.error(`[Player Error] Guild: ${queue.guild.id}, Error: ${error.message}`);
        const channel = await this.client.channels.cache.get(queue.metadata.channelId);
        if (channel && channel.isTextBased()) {
            (channel as any).send(`🎧 | Encountered an error with a track and had to skip it. Sorry about that!`);
        }
    }
}

export default DJManager;
