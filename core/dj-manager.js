const { ElevenLabsClient } = require("elevenlabs");
const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

// Voice mapping from dashboard setting to ElevenLabs voice name
const voices = {
    male: "Adam",
    female: "Rachel",
};

class DJManager {
  constructor(player) {
    this.player = player;
    // Hook into the event that fires when a track finishes playing
    this.player.events.on("playerFinish", (queue, track) => this.onTrackFinish(queue, track));
  }

  async onTrackFinish(queue, track) {
    // If DJ mode is not active, or if the queue is now empty, do nothing.
    if (!queue.metadata.djMode || queue.tracks.size === 0) {
        return;
    }

    // Don't generate commentary for our own commentary tracks!
    if (track.isDJCommentary) {
        return;
    }

    const nextTrack = queue.tracks.toArray()[0]; // Peek at the next track
    if (!nextTrack || nextTrack.isDJCommentary) {
        // Don't generate commentary if the queue is about to end or if the next track is already a commentary
        return;
    }

    try {
        // 1. Generate the script
        const script = `That was ${track.title} by ${track.author}. Up next, we have ${nextTrack.title} by ${nextTrack.author}.`;
        logger.info(`[DJ] Generated Script for guild ${queue.guild.id}: ${script}`);

        // 2. Select voice based on guild settings
        const selectedVoice = queue.metadata.djVoice || 'female'; // Default to female
        const voiceId = voices[selectedVoice] || voices['female'];

        // 3. Generate TTS audio
        const audioStream = await elevenlabs.generate({
            voice: voiceId,
            text: script,
            model_id: "eleven_multilingual_v2"
        });

        const tempFilePath = path.join(__dirname, `../temp_audio/${queue.guild.id}_commentary.mp3`);

        // 4. Save the audio to a file, waiting for it to finish writing
        const fileStream = fs.createWriteStream(tempFilePath);
        const writePromise = new Promise((resolve, reject) => {
            audioStream.pipe(fileStream);
            fileStream.on('finish', resolve);
            fileStream.on('error', reject);
        });
        await writePromise;
        
        // 5. Create a track from the local file and inject it
        const { track: commentaryTrack } = await this.player.search(tempFilePath, { requestedBy: queue.client.user });
        if (!commentaryTrack) {
            logger.error(`[DJ] Could not create a track from the commentary file for guild ${queue.guild.id}.`);
            return;
        }
        commentaryTrack.isDJCommentary = true; // Custom flag to identify our track
        
        // Insert the commentary to be played next
        queue.insertTrack(commentaryTrack, 0); 
        logger.info(`[DJ] Injected commentary for ${nextTrack.title} in guild ${queue.guild.id}`);

    } catch (error) {
        logger.error(`[DJ] Failed to generate or inject commentary for guild ${queue.guild.id}:`, { error: error.message, stack: error.stack });
    }
  }
}

module.exports = DJManager;