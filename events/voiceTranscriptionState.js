/*
 * Voice state for the chat reader and live transcription.
 *
 * Reader (core/voice-reader-manager.js): leave a channel the reader joined once nobody's left in it.
 * Transcription (core/voice-transcription-manager.js): join notices for people arriving mid-session,
 * and auto-stop when the bot is moved out or the room empties.
 *
 * Only the client that owns the session acts on it — in a custom-bot guild the main bot may see
 * the same voice events, and must not decide the custom bot "left" its own session.
 */
import { Events } from 'discord.js';
import logger from '../utils/logger.js';
import { getSession, handleVoiceStateUpdate } from '../core/voice-transcription-manager.js';
import { handleReaderVoiceState } from '../core/voice-reader-manager.js';

export default {
    name: Events.VoiceStateUpdate,
    async execute(oldState, newState) {
        try {
            handleReaderVoiceState(oldState, newState);
        } catch (err) {
            logger.warn(`[VoiceReader] voiceStateUpdate handler failed: ${err.message}`);
        }

        const session = newState.guild && getSession(newState.guild.id);
        if (!session || session.client !== newState.client) return;
        try {
            await handleVoiceStateUpdate(oldState, newState);
        } catch (err) {
            logger.warn(`[Transcribe] voiceStateUpdate handler failed: ${err.message}`);
        }
    },
};
