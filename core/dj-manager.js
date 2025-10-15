const { ElevenLabsClient } = require("elevenlabs");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const { Readable } = require('stream');
const { Track } = require('discord-player');

const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

// Voice mapping from dashboard setting to ElevenLabs voice name
const voices = {
    male: "Adam",
    female: "Rachel",
};

class DJManager {
  constructor(player) {
    this.player = player;
    this.player.events.on("playerFinish", (queue, track) => this.onTrackFinish(queue, track));
  }

  async onTrackFinish(queue, track) {
    logger.info(`[DJ] onTrackFinish event triggered for guild ${queue.guild.id}. Track: ${track.title}`);

    if (!queue.metadata.djMode || queue.tracks.size === 0) {
        logger.info(`[DJ] Skipping commentary: DJ mode not active or queue empty for guild ${queue.guild.id}.`);
        return;
    }

    // Check if the current track's metadata indicates it's a DJ commentary
    if (track.metadata && track.metadata.isDJCommentary) {
        logger.info(`[DJ] Skipping commentary: Current track is already a DJ commentary for guild ${queue.guild.id}.`);
        return;
    }

    const nextTrack = queue.tracks.toArray()[0];
    // Check if the next track's metadata indicates it's a DJ commentary
    if (!nextTrack || (nextTrack.metadata && nextTrack.metadata.isDJCommentary)) {
        logger.info(`[DJ] Skipping commentary: No next track or next track is commentary for guild ${queue.guild.id}.`);
        return;
    }

    try {
        const script = `That was ${track.title} by ${track.author}. Up next, we have ${nextTrack.title} by ${nextTrack.author}.`;
        logger.info(`[DJ] Generated Script for guild ${queue.guild.id}: ${script}`);

        const selectedVoiceSetting = queue.metadata.djVoice || 'Rachel'; 
        const voiceId = voices[selectedVoiceSetting] || selectedVoiceSetting;
        logger.info(`[DJ] Using voice ID: ${voiceId} for guild ${queue.guild.id}.`);

        logger.info(`[DJ] Calling ElevenLabs generate for guild ${queue.guild.id}...`);
        const elevenLabsAudioStream = await elevenlabs.generate({
            voice: voiceId,
            text: script,
            model_id: "eleven_multilingual_v2"
        });
        logger.info(`[DJ] ElevenLabs generate call completed for guild ${queue.guild.id}.`);

        const audioStream = Readable.fromWeb(elevenLabsAudioStream);
        logger.info(`[DJ] Converted WebStream to Node.js Readable for guild ${queue.guild.id}.`);

        const tempFilePath = path.join(__dirname, `../temp_audio/${queue.guild.id}_commentary.mp3`);

        const fileStream = fs.createWriteStream(tempFilePath);
        const writePromise = new Promise((resolve, reject) => {
            audioStream.pipe(fileStream);
            fileStream.on('finish', () => {
                logger.info(`[DJ] Commentary audio saved to ${tempFilePath} for guild ${queue.guild.id}.`);
                resolve();
            });
            fileStream.on('error', (err) => {
                logger.error(`[DJ] Error writing commentary audio to file for guild ${queue.guild.id}:`, { error: err.message, stack: err.stack });
                reject(err);
            });
        });
        await writePromise;
        
        const requestedBy = this.player.client.user ? { id: this.player.client.user.id, tag: this.player.client.user.tag } : { id: 'bot', tag: 'DJ Bot' };
        logger.info(`[DJ] Searching for commentary track from ${tempFilePath} for guild ${queue.guild.id}...`);
        
        const searchResult = await this.player.search(tempFilePath, { 
            requestedBy: requestedBy,
            searchEngine: "com.livebot.ytdlp"
        });
        
        if (!searchResult || searchResult.tracks.length === 0) {
            logger.error(`[DJ] Could not create a track from the commentary file for guild ${queue.guild.id}. Search result was empty.`);
            return;
        }

        const existingTrack = searchResult.tracks[0]; // This is already a Track object
        logger.debug(`[DJ] existingTrack (from searchResult.tracks[0]) title: ${existingTrack.title}, url: ${existingTrack.url}`);

        // Manually extract properties to avoid circular reference issues with toJSON()
        const rawCommentaryTrackData = {
            url: existingTrack.url,
            title: existingTrack.title,
            description: existingTrack.description,
            views: existingTrack.views,
            author: existingTrack.author,
            thumbnail: existingTrack.thumbnail,
            duration: existingTrack.duration,
            requestedBy: requestedBy, // Set requestedBy here
            metadata: {
                ...(existingTrack.metadata || {}),
                localPath: tempFilePath,
                isDJCommentary: true, // Moved isDJCommentary into metadata
            }
        };
        logger.debug(`[DJ] rawCommentaryTrackData (after manual construction and modification) title: ${rawCommentaryTrackData.title}, url: ${rawCommentaryTrackData.url}`);

        const commentaryTrack = new Track(this.player, rawCommentaryTrackData);
        logger.debug(`[DJ] commentaryTrack (after new Track construction) title: ${commentaryTrack.title}, url: ${commentaryTrack.url}`);

        logger.info(`[DJ] Successfully created commentary track: ${commentaryTrack.title} for guild ${queue.guild.id}.`);
        
        queue.insertTrack(commentaryTrack, 0); 
        logger.info(`[DJ] Injected commentary for ${nextTrack.title} in guild ${queue.guild.id}`);

    } catch (error) {
        logger.error(`[DJ] Failed to generate or inject commentary for guild ${queue.guild.id}:`, { error: error.message, stack: error.stack, fullError: error });
    }
  }
}

module.exports = DJManager;