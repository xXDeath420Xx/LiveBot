const { GoogleGenerativeAI } = require("@google/generative-ai");
const logger = require("./logger");

const GEMINI_API_KEY = process.env.GOOGLE_API_KEY;

if (!GEMINI_API_KEY) {
    logger.error("[Gemini API] GOOGLE_API_KEY is not set in environment variables.");
} else {
    logger.info(`[Gemini API] GOOGLE_API_KEY is loaded. Length: ${GEMINI_API_KEY.length}, Starts with: ${GEMINI_API_KEY.substring(0, 5)}...`);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const model = genAI.getGenerativeModel({ model: "models/gemini-pro-latest" });

async function generatePlaylistRecommendations(song, artist, genre) {
    if (!GEMINI_API_KEY) {
        logger.error("[Gemini API] Cannot generate recommendations: API key is missing.");
        return [];
    }

    let prompt = `Generate a diverse and somewhat random list of 10 song recommendations.`;
    const criteria = [];

    if (song && artist) {
        criteria.push(`similar to the song "${song}" by "${artist}"`);
    } else if (song) {
        criteria.push(`similar to the song "${song}"`);
    } else if (artist) {
        criteria.push(`by artists similar to "${artist}"`);
    }

    if (genre) {
        criteria.push(`in the genre of "${genre}"`);
    }

    if (criteria.length > 0) {
        prompt += ` based on the following criteria: ${criteria.join(" and ")}.`;
    }

    prompt += `\n\nIt's okay to include the original song in the list. Ensure the playlist is not repetitive and explores a good variety of tracks within the requested style. Please ensure the songs are not all from the same artist and that the list is varied. The goal is a creative and surprising playlist, not just a list of the artist's most popular songs. Focus on deep cuts and lesser-known tracks where possible.`;
    prompt += `\n\nProvide the response as a JSON array of objects, where each object has a "title" and an "artist" property. Do not include any additional text or formatting outside the JSON array.`;

    logger.info(`[Gemini API] Sending prompt to Gemini: ${prompt}`);

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text();
        logger.info(`[Gemini API] Raw response from Gemini: ${text}`);

        if (text.startsWith("```json") && text.endsWith("```")) {
            text = text.substring(7, text.length - 3).trim();
            logger.info(`[Gemini API] Cleaned response from Gemini: ${text}`);
        }

        const recommendations = JSON.parse(text);

        if (Array.isArray(recommendations) && recommendations.every(item => typeof item.title === 'string' && typeof item.artist === 'string')) {
            logger.info(`[Gemini API] Successfully parsed ${recommendations.length} recommendations.`);
            return recommendations;
        } else {
            logger.error("[Gemini API] Gemini response was not a valid JSON array of {title, artist} objects.", { response: text });
            return [];
        }
    } catch (error) {
        logger.error("[Gemini API] Error generating playlist recommendations from Gemini:", { error: error.message, stack: error.stack, fullError: error });
        return [];
    }
}

module.exports = { generatePlaylistRecommendations };
