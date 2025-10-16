const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");
const { Readable } = require('stream');
const { Track } = require('discord-player');
const { exec } = require('child_process'); // Import child_process

// --- Piper TTS Configuration ---
const PIPER_PATH = process.env.PIPER_PATH || 'piper'; // Assuming 'piper' is in PATH or provide full path
const PIPER_MODEL_DIR = process.env.PIPER_MODEL_DIR || path.join(__dirname, '../piper_models'); // Directory where .onnx and .json files are
const PIPER_DEFAULT_MODEL = process.env.PIPER_DEFAULT_MODEL || 'en_US-amy-medium.onnx'; // Default model file name
const PIPER_DEFAULT_CONFIG = process.env.PIPER_DEFAULT_CONFIG || 'en_US-amy-medium.onnx.json'; // Default config file name

class DJManager {
  constructor(player) {
    this.player = player;
    this.player.events.on("playerFinish", (queue, finishedTrack) => this.onPlayerFinish(queue, finishedTrack));
  }

  async generatePiperAudio(text, modelName, configName, outputPath) {
    const modelPath = path.join(PIPER_MODEL_DIR, modelName);
    const configPath = path.join(PIPER_MODEL_DIR, configName);

    if (!fs.existsSync(modelPath)) {
        throw new Error(`Piper model not found at: ${modelPath}`);
    }
    if (!fs.existsSync(configPath)) {
        throw new Error(`Piper config not found at: ${configPath}`);
    }

    const tempDir = path.dirname(outputPath);
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    // Use a temporary input file for the text to avoid issues with complex characters in shell commands
    const tempInputFilePath = path.join(tempDir, `piper_input_${Date.now()}.txt`);
    fs.writeFileSync(tempInputFilePath, text);

    const command = `${PIPER_PATH} -m "${modelPath}" -c "${configPath}" -i "${tempInputFilePath}" -f "${outputPath}"`;

    logger.info(`[DJ/Piper] Executing command: ${command}`);

    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            // Clean up the temporary input file
            fs.unlink(tempInputFilePath, (err) => {
                if (err) logger.error(`[DJ/Piper] Failed to delete temp input file: ${tempInputFilePath}`, err.message);
            });

            if (error) {
                logger.error(`[DJ/Piper] Error generating audio: ${error.message}`);
                logger.error(`[DJ/Piper] Stderr: ${stderr}`);
                return reject(error);
            }
            if (stderr) {
                logger.warn(`[DJ/Piper] Stderr output: ${stderr}`);
            }
            logger.info(`[DJ/Piper] Audio generated successfully to ${outputPath}`);
            resolve(outputPath);
        });
    });
  }

  async prepareNextCommentary(queue, currentTrack) {
    logger.info(`[DJ] prepareNextCommentary triggered for guild ${queue.guild.id}. Current track: ${currentTrack.title}`);

    // If DJ mode is off, skip.
    if (!queue.metadata.djMode) {
        logger.info(`[DJ] Skipping commentary pre-generation: DJ mode not active for guild ${queue.guild.id}.`);
        return;
    }

    // If the current track is commentary, don't pre-generate more.
    if (currentTrack.metadata && currentTrack.metadata.isDJCommentary) {
        logger.info(`[DJ] Skipping commentary pre-generation: Current track is commentary for guild ${queue.guild.id}.`);
        return;
    }

    const nextTrackInQueue = queue.tracks.at(0); // This is the track that will play after currentTrack

    if (!nextTrackInQueue || (nextTrackInQueue.metadata && nextTrackInQueue.metadata.isDJCommentary)) {
        logger.info(`[DJ] Skipping commentary pre-generation: No valid next track in queue or next track is commentary for guild ${queue.guild.id}.`);
        return;
    }

    // Check if commentary is already prepared for this next track
    if (nextTrackInQueue.metadata && nextTrackInQueue.metadata.preGeneratedCommentaryPath) {
        logger.info(`[DJ] Commentary already pre-generated for ${nextTrackInQueue.title} for guild ${queue.guild.id}.`);
        return;
    }

    try {
        const script = `That was ${currentTrack.title} by ${currentTrack.author}. Up next, we have ${nextTrackInQueue.title} by ${nextTrackInQueue.author}.`;
        logger.info(`[DJ] Generated Script for pre-generation for guild ${queue.guild.id}: ${script}`);

        let audioFilePath = null;
        const piperTempFilePath = path.join(__dirname, `../temp_audio/${queue.guild.id}_commentary_piper.wav`);

        try {
            logger.info(`[DJ] Attempting Piper TTS pre-generation for guild ${queue.guild.id}...`);
            audioFilePath = await this.generatePiperAudio(script, PIPER_DEFAULT_MODEL, PIPER_DEFAULT_CONFIG, piperTempFilePath);
        } catch (piperError) {
            logger.error(`[DJ] Piper TTS pre-generation failed for guild ${queue.guild.id}: ${piperError.message}. Skipping commentary pre-generation.`);
            return;
        }

        if (audioFilePath) {
            // Store the path to the pre-generated commentary in the next track's metadata
            if (!nextTrackInQueue.metadata) {
                nextTrackInQueue.metadata = {};
            }
            nextTrackInQueue.metadata.preGeneratedCommentaryPath = audioFilePath;
            logger.info(`[DJ] Stored pre-generated commentary path for ${nextTrackInQueue.title}: ${audioFilePath}`);
        }

    } catch (error) {
        logger.error(`[DJ] Failed to pre-generate commentary for guild ${queue.guild.id}:`, { error: error.message, stack: error.stack, fullError: error });
    }
  }

  async onPlayerFinish(queue, finishedTrack) {
    logger.info(`[DJ] onPlayerFinish event triggered for guild ${queue.guild.id}. Track: ${finishedTrack.title}`);

    // Debugging logs for early exit conditions
    logger.debug(`[DJ] Debugging onPlayerFinish: djMode=${queue.metadata.djMode}, finishedTrack.isDJCommentary=${finishedTrack.metadata?.isDJCommentary} for guild ${queue.guild.id}.`);

    // If the track that just finished was commentary, don't generate more.
    if (finishedTrack.metadata && finishedTrack.metadata.isDJCommentary) {
        logger.info(`[DJ] Skipping commentary: The finished track was already a commentary for guild ${queue.guild.id}.`);
        // Clean up the commentary file if it was a pre-generated one
        if (finishedTrack.metadata.localPath && fs.existsSync(finishedTrack.metadata.localPath)) {
            fs.unlink(finishedTrack.metadata.localPath, (err) => {
                if (err) logger.error(`[Cleanup] Failed to delete commentary temp file: ${finishedTrack.metadata.localPath}`, err.message);
                else logger.info(`[Cleanup] Deleted commentary temp file: ${finishedTrack.metadata.localPath}`);
            });
        }
        return;
    }

    // If DJ mode is off, skip commentary.
    if (!queue.metadata.djMode) {
        logger.info(`[DJ] Skipping commentary: DJ mode not active for guild ${queue.guild.id}.`);
        return;
    }

    // Get the next track that is actually in the queue to play.
    const nextTrackInQueue = queue.tracks.at(0);

    logger.debug(`[DJ] Debugging onPlayerFinish: nextTrackInQueue=${nextTrackInQueue ? nextTrackInQueue.title : 'null'}, nextTrackInQueue.isDJCommentary=${nextTrackInQueue?.metadata?.isDJCommentary} for guild ${queue.guild.id}.`);

    // If there's no next track in the queue, or it's a commentary, skip.
    if (!nextTrackInQueue || (nextTrackInQueue.metadata && nextTrackInQueue.metadata.isDJCommentary)) {
        logger.info(`[DJ] Skipping commentary: No valid next track in queue or next track is commentary for guild ${queue.guild.id}.`);
        return;
    }

    try {
        let audioFilePath = null;
        let script = null;

        // Check if commentary was pre-generated for the next track
        if (nextTrackInQueue.metadata && nextTrackInQueue.metadata.preGeneratedCommentaryPath) {
            audioFilePath = nextTrackInQueue.metadata.preGeneratedCommentaryPath;
            logger.info(`[DJ] Using pre-generated commentary for ${nextTrackInQueue.title} from ${audioFilePath}`);
        } else {
            // If not pre-generated, generate it now
            script = `That was ${finishedTrack.title} by ${finishedTrack.author}. Up next, we have ${nextTrackInQueue.title} by ${nextTrackInQueue.author}.`;
            logger.info(`[DJ] Generating commentary on the fly for guild ${queue.guild.id}: ${script}`);

            const piperTempFilePath = path.join(__dirname, `../temp_audio/${queue.guild.id}_commentary_piper.wav`);

            try {
                audioFilePath = await this.generatePiperAudio(script, PIPER_DEFAULT_MODEL, PIPER_DEFAULT_CONFIG, piperTempFilePath);
            } catch (piperError) {
                logger.error(`[DJ] Piper TTS failed (on-the-fly) for guild ${queue.guild.id}: ${piperError.message}. Skipping commentary.`);
                return;
            }
        }

        if (!audioFilePath) {
            logger.error(`[DJ] No audio file path generated for commentary for guild ${queue.guild.id}. Skipping commentary.`);
            return;
        }

        const requestedBy = this.player.client.user ? { id: this.player.client.user.id, tag: this.player.client.user.tag } : { id: 'bot', tag: 'DJ Bot' };
        logger.info(`[DJ] Creating commentary track from local file ${audioFilePath} for guild ${queue.guild.id}...`);

        // Directly create a Track object for the local file
        const commentaryTrack = new Track(this.player, {
            url: audioFilePath,
            title: `DJ Commentary for ${nextTrackInQueue.title}`,
            description: `DJ Commentary for ${nextTrackInQueue.title}`,
            author: 'DJ Bot',
            duration: '0:00', // Duration will be determined by discord-player
            requestedBy: requestedBy,
            thumbnail: 'https://i.imgur.com/GBp9Ahl.png', // Generic thumbnail
            metadata: {
                localPath: audioFilePath,
                isDJCommentary: true,
            }
        });

        logger.info(`[DJ] Successfully created commentary track: ${commentaryTrack.title} for guild ${queue.guild.id}.`);

        // Play the commentary track immediately. This will interrupt the natural progression
        // to nextTrackInQueue and play the commentary instead. When it finishes, the queue
        // will naturally proceed to nextTrackInQueue.
        await queue.node.play(commentaryTrack, { immediate: true });
        logger.info(`[DJ] Immediately playing commentary track. Next up is ${nextTrackInQueue.title}.`);

    } catch (error) {
        logger.error(`[DJ] Failed to generate or inject commentary for guild ${queue.guild.id}:`, { error: error.message, stack: error.stack, fullError: error });
    }
  }
}

module.exports = DJManager;