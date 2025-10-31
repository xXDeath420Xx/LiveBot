"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const generative_ai_1 = require("@google/generative-ai");
const logger_1 = __importDefault(require("./logger"));
const GEMINI_API_KEY = process.env.GOOGLE_API_KEY;
if (!GEMINI_API_KEY) {
    logger_1.default.error("[Gemini API] GOOGLE_API_KEY is not set in environment variables.");
}
else {
    logger_1.default.info(`[Gemini API] GOOGLE_API_KEY is loaded.`);
}
const genAI = new generative_ai_1.GoogleGenerativeAI(GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "models/gemini-pro-latest" });
async function withRetry(fn, retries = 3, delay = 1000) {
    let lastError;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        }
        catch (error) {
            lastError = error;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            logger_1.default.warn(`[Retry] Attempt ${i + 1} failed. Retrying in ${delay * (i + 1)}ms...`, { error: errorMessage });
            await new Promise(res => setTimeout(res, delay * (i + 1)));
        }
    }
    throw lastError;
}
async function generatePlaylistRecommendations(song, artist, genre, playedTracks = [], prompt) {
    if (!GEMINI_API_KEY) {
        logger_1.default.error("[Gemini API] Cannot generate recommendations: API key is missing.");
        return [];
    }
    const MAX_RECOMMENDATIONS = 15; // Hard limit to prevent resource exhaustion
    let criteriaPrompt;
    if (prompt) {
        // If a direct prompt is provided, use it as the primary instruction.
        criteriaPrompt = `Generate a diverse and somewhat random list of exactly 10-15 song recommendations based on: ${prompt}`;
    }
    else {
        // Otherwise, build the prompt from song/artist/genre.
        criteriaPrompt = `Generate a diverse and somewhat random list of exactly 10 song recommendations.`;
        const criteria = [];
        if (song && artist) {
            criteria.push(`similar to the song "${song}" by "${artist}"`);
        }
        else if (song) {
            criteria.push(`similar to the song "${song}"`);
        }
        else if (artist) {
            criteria.push(`by artists similar to "${artist}"`);
        }
        if (genre) {
            criteria.push(`in the genre of "${genre}"`);
        }
        if (criteria.length > 0) {
            criteriaPrompt += ` based on the following criteria: ${criteria.join(" and ")}.`;
        }
        criteriaPrompt += `\n\nIt\'s okay to include the original song in the list. Ensure the playlist is not repetitive and explores a good variety of tracks within the requested style. Please ensure the songs are not all from the same artist and that the list is varied. The goal is a creative and surprising playlist that balances popular hits with lesser-known gems.`;
    }
    if (playedTracks.length > 0) {
        criteriaPrompt += ` Avoid recommending any of the following songs that have already been played: ${playedTracks.join(", ")}.`;
    }
    // Always add the JSON formatting instruction for reliable parsing.
    criteriaPrompt += `\n\nIMPORTANT: Provide EXACTLY 10-15 songs, no more. Provide the response as a JSON array of objects, where each object has a "title" and an "artist" property. Do not include any additional text or formatting outside the JSON array.`;
    logger_1.default.info(`[Gemini API] Sending prompt to Gemini: ${criteriaPrompt}`);
    try {
        const result = await withRetry(() => model.generateContent(criteriaPrompt));
        const response = await result.response;
        let text = response.text();
        logger_1.default.info(`[Gemini API] Raw response from Gemini: ${text}`);
        if (text.startsWith("```json") && text.endsWith("```")) {
            text = text.substring(7, text.length - 3).trim();
            logger_1.default.info(`[Gemini API] Cleaned response from Gemini: ${text}`);
        }
        let recommendations = JSON.parse(text);
        if (Array.isArray(recommendations) && recommendations.every(item => typeof item.title === 'string' && typeof item.artist === 'string')) {
            // Enforce hard limit to prevent resource exhaustion
            if (recommendations.length > MAX_RECOMMENDATIONS) {
                logger_1.default.warn(`[Gemini API] Gemini returned ${recommendations.length} recommendations, limiting to ${MAX_RECOMMENDATIONS} to prevent overload.`);
                recommendations = recommendations.slice(0, MAX_RECOMMENDATIONS);
            }
            logger_1.default.info(`[Gemini API] Successfully parsed ${recommendations.length} recommendations.`);
            return recommendations;
        }
        else {
            logger_1.default.error("[Gemini API] Gemini response was not a valid JSON array of {title, artist} objects.", { response: text });
            return [];
        }
    }
    catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        logger_1.default.error("[Gemini API] Error generating playlist recommendations from Gemini:", {
            error: errorObj.message,
            stack: errorObj.stack,
            fullError: errorObj
        });
        return [];
    }
}
async function generatePlaylistCommentary(playlistTracks) {
    if (!GEMINI_API_KEY) {
        logger_1.default.error("[Gemini API] Cannot generate commentary: API key is missing.");
        return "";
    }
    if (!playlistTracks || playlistTracks.length === 0) {
        return "";
    }
    // Handle different track object formats (discord-player uses .title and .author)
    const trackList = playlistTracks.map(track => {
        const title = track.title || track.name || 'Unknown';
        const author = track.author || track.artist || track.uploader?.name || 'Unknown Artist';
        return `"${title}" by ${author}`;
    }).join(", ");
    const prompt = `Generate a single, concise, and engaging introductory commentary for the following playlist. The commentary should be under 60 seconds when spoken. Focus on the songs, artists, and a brief summary of the genre or timeframe. Do not include YouTube channel names or information about every individual song. Do not provide multiple options. Examples: "Up next, we have a modern classic by Taylor Swift. Following her, we've got some contemporary country" or "Welcome to a journey through 80s synth-pop with hits from A-Ha and Eurythmics."\n\nPlaylist: ${trackList}`;
    logger_1.default.info(`[Gemini API] Sending commentary prompt to Gemini: ${prompt}`);
    try {
        const result = await withRetry(() => model.generateContent(prompt));
        const response = await result.response;
        let commentary = response.text();
        logger_1.default.info(`[Gemini API] Generated commentary: ${commentary}`);
        const options = commentary.split(/\n\*\*Option \d+.*:\*\*\n/i).filter(s => s.trim().length > 0);
        if (options.length > 1) {
            const randomIndex = Math.floor(Math.random() * options.length);
            commentary = options[randomIndex].trim();
            logger_1.default.info(`[Gemini API] Multiple options detected. Randomly selected: ${commentary}`);
        }
        return commentary.replace(/[*_`]/g, '');
    }
    catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        logger_1.default.error("[Gemini API] Error generating playlist commentary from Gemini:", {
            error: errorObj.message,
            stack: errorObj.stack,
            fullError: errorObj
        });
        return `Get ready for some great music!`;
    }
}
async function generatePassiveAggressiveCommentary(metrics) {
    if (!GEMINI_API_KEY) {
        logger_1.default.error("[Gemini API] Cannot generate commentary: API key is missing.");
        return "You skipped a song.";
    }
    const { total_plays, total_skips, user_skip_button_presses } = metrics;
    let prompt = `Generate a passive-aggressive comment for a user who just skipped a song. The user has pressed the skip button ${user_skip_button_presses} times in this session. This specific song has been played ${total_plays} times and skipped ${total_skips} times in total by everyone in this server.`;
    prompt += `\n\nThe comment should be under 30 seconds when spoken, witty, and get more passive-aggressive as the user's skip counts increase. Do not provide multiple options.`;
    logger_1.default.info(`[Gemini API] Sending passive-aggressive commentary prompt to Gemini: ${prompt}`);
    try {
        const result = await withRetry(() => model.generateContent(prompt));
        const response = await result.response;
        let commentary = response.text();
        logger_1.default.info(`[Gemini API] Generated passive-aggressive commentary: ${commentary}`);
        return commentary.replace(/[*_`]/g, '');
    }
    catch (error) {
        const errorObj = error instanceof Error ? error : new Error(String(error));
        logger_1.default.error("[Gemini API] Error generating passive-aggressive commentary from Gemini:", {
            error: errorObj.message,
            stack: errorObj.stack,
            fullError: errorObj
        });
        return "Fine, have it your way.";
    }
}
module.exports = { generatePlaylistRecommendations, generatePlaylistCommentary, generatePassiveAggressiveCommentary };
