import express from 'express';
import rateLimit from 'express-rate-limit';
import { synthesize } from '../../utils/piper-tts.js';
import fs from 'fs';
import logger from '../../utils/logger.js';

const router = express.Router();

// Strict rate limiting for TTS - CPU intensive operation
const voicePreviewLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute window
    max: 5, // 5 requests per minute per user
    keyGenerator: (req) => req.user?.id || req.ip, // Rate limit by user ID if authenticated
    message: { error: 'Too many voice preview requests. Please try again in a minute.' },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => !req.isAuthenticated || !req.isAuthenticated() // Skip if not authenticated (will 401 anyway)
});

/**
 * POST /api/voice-preview
 * Generates a TTS preview for a given voice
 */
router.post('/api/voice-preview', voicePreviewLimiter, async (req, res) => {
    try {
        // Require authentication to prevent abuse
        if (!req.isAuthenticated || !req.isAuthenticated()) {
            return res.status(401).json({ error: 'Authentication required' });
        }

        const { voice } = req.body;

        // Validation
        if (!voice) {
            return res.status(400).json({ error: 'Voice parameter required' });
        }

        // Validate voice name (alphanumeric, dash, underscore only - max 50 chars)
        if (typeof voice !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(voice)) {
            return res.status(400).json({ error: 'Invalid voice parameter' });
        }

        logger.info(`[Voice Preview] Generating preview for voice: ${voice}`);

        // Generate preview text with voice name capitalized
        const voiceLabel = voice.charAt(0).toUpperCase() + voice.slice(1);
        const text = `Hello, I'm ${voiceLabel}. This is how I'd sound if I were your AI DJ. Select me to have your music experience enhanced by commentary with my voice.`;

        // Synthesize audio using Piper TTS
        const audioPath = await synthesize(text, voice);

        if (!audioPath || !fs.existsSync(audioPath)) {
            throw new Error('Failed to generate audio file');
        }

        // Read audio file and send as response
        const audioBuffer = fs.readFileSync(audioPath);

        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Disposition', `inline; filename="${voice}-preview.wav"`);
        res.setHeader('Cache-Control', 'no-cache');
        res.send(audioBuffer);

        logger.info(`[Voice Preview] Successfully generated preview for ${voice} (${audioBuffer.length} bytes)`);

        // Cleanup temp file after a short delay
        setTimeout(() => {
            try {
                if (fs.existsSync(audioPath)) {
                    fs.unlinkSync(audioPath);
                    logger.info(`[Voice Preview] Cleaned up temp file: ${audioPath}`);
                }
            } catch (cleanupError) {
                logger.logError('[Voice Preview] Error cleaning up temp file', cleanupError);
            }
        }, 1000);

    } catch (error) {
        logger.error('[Voice Preview Error]', error);
        res.status(500).json({ error: 'Failed to generate preview', details: error.message });
    }
});

export default router;
