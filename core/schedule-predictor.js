"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.predictStreamerSchedule = predictStreamerSchedule;
exports.getCachedPrediction = getCachedPrediction;
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
const generative_ai_1 = require("@google/generative-ai");
const GEMINI_API_KEY = process.env.GOOGLE_API_KEY;
const genAI = GEMINI_API_KEY ? new generative_ai_1.GoogleGenerativeAI(GEMINI_API_KEY) : null;
const model = genAI ? genAI.getGenerativeModel({ model: "models/gemini-pro-latest" }) : null;
/**
 * Analyzes historical stream data and predicts future streaming schedule
 * @param {number} streamerId - The streamer's database ID
 * @param {number} daysToAnalyze - How many days of history to analyze (default: 30)
 * @returns {Promise<object>} - Prediction results with schedule and confidence
 */
async function predictStreamerSchedule(streamerId, daysToAnalyze = 30) {
    if (!GEMINI_API_KEY || !model) {
        logger_1.default.error('[Schedule Predictor] Cannot predict schedule: Gemini API key is missing.');
        return { error: 'AI prediction service is not configured' };
    }
    try {
        // Fetch historical stream data from live_announcements and announcements tables
        const [[streamerInfo]] = await db_1.default.execute('SELECT username, platform FROM streamers WHERE streamer_id = ?', [streamerId]);
        if (!streamerInfo) {
            return { error: 'Streamer not found' };
        }
        // Get historical live announcement times
        const [historicalData] = await db_1.default.execute(`
            SELECT created_at, updated_at
            FROM live_announcements
            WHERE streamer_id = ?
              AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            ORDER BY created_at DESC
        `, [streamerId, daysToAnalyze]);
        if (historicalData.length < 3) {
            return {
                error: 'Insufficient data for prediction',
                message: `Need at least 3 streams in the past ${daysToAnalyze} days. Found: ${historicalData.length}`
            };
        }
        // Process the data for AI analysis
        const streamTimes = historicalData.map(record => {
            const date = new Date(record.created_at);
            return {
                dayOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][date.getDay()],
                hour: date.getHours(),
                date: date.toISOString().split('T')[0],
                timestamp: record.created_at
            };
        });
        // Create AI prompt for schedule prediction
        const prompt = `You are analyzing streaming patterns for ${streamerInfo.username} on ${streamerInfo.platform}.

Historical Stream Data (last ${daysToAnalyze} days):
${JSON.stringify(streamTimes, null, 2)}

Based on this data, predict:
1. What days of the week they typically stream (with confidence percentage)
2. What time(s) of day they usually go live (in 24-hour format)
3. How often they stream per week
4. Any notable patterns (e.g., "streams every weekday evening", "weekend warrior", "irregular schedule")

Provide your response as a JSON object with this structure:
{
  "weeklyFrequency": "number of streams per week",
  "mostLikelyDays": [
    {"day": "Monday", "confidence": 85, "timeRange": "18:00-20:00"},
    ...
  ],
  "patterns": ["pattern description 1", "pattern description 2"],
  "consistency": "high/medium/low",
  "recommendation": "user-friendly summary of when to expect streams"
}

Be analytical and data-driven. If the data shows no clear pattern, say so in the consistency field.`;
        logger_1.default.info(`[Schedule Predictor] Analyzing ${streamTimes.length} historical streams for ${streamerInfo.username}`);
        // Get prediction from Gemini
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();
        // Clean markdown code blocks if present
        if (text.startsWith("```json") && text.endsWith("```")) {
            text = text.substring(7, text.length - 3).trim();
        }
        else if (text.startsWith("```") && text.endsWith("```")) {
            text = text.substring(3, text.length - 3).trim();
        }
        const prediction = JSON.parse(text);
        // Save prediction to database
        await db_1.default.execute(`
            INSERT INTO schedule_predictions (streamer_id, prediction_data, analyzed_streams_count, created_at, expires_at)
            VALUES (?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY))
            ON DUPLICATE KEY UPDATE
                prediction_data = VALUES(prediction_data),
                analyzed_streams_count = VALUES(analyzed_streams_count),
                created_at = NOW(),
                expires_at = DATE_ADD(NOW(), INTERVAL 7 DAY)
        `, [streamerId, JSON.stringify(prediction), streamTimes.length]);
        logger_1.default.info(`[Schedule Predictor] Successfully predicted schedule for ${streamerInfo.username}`);
        return {
            streamer: streamerInfo,
            prediction,
            dataPoints: streamTimes.length,
            analyzedDays: daysToAnalyze
        };
    }
    catch (error) {
        logger_1.default.error('[Schedule Predictor] Error predicting schedule:', { error: error.message, stack: error.stack });
        return { error: 'Failed to generate prediction', details: error.message };
    }
}
/**
 * Gets cached schedule prediction for a streamer
 * @param {number} streamerId - The streamer's database ID
 * @returns {Promise<object|null>} - Cached prediction or null
 */
async function getCachedPrediction(streamerId) {
    try {
        const [[cached]] = await db_1.default.execute(`
            SELECT sp.*, s.username, s.platform
            FROM schedule_predictions sp
            JOIN streamers s ON sp.streamer_id = s.streamer_id
            WHERE sp.streamer_id = ? AND sp.expires_at > NOW()
        `, [streamerId]);
        if (!cached) {
            return null;
        }
        return {
            streamer: { username: cached.username, platform: cached.platform },
            prediction: JSON.parse(cached.prediction_data),
            dataPoints: cached.analyzed_streams_count,
            cachedAt: cached.created_at,
            expiresAt: cached.expires_at
        };
    }
    catch (error) {
        logger_1.default.error('[Schedule Predictor] Error fetching cached prediction:', error);
        return null;
    }
}
