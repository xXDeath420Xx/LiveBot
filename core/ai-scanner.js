const db = require('../utils/db');
const logger = require('../utils/logger');
// IMPORTANT: You must run `npm install @google/generative-ai` for this file to work.
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const model = genAI ? genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }) : null;

const generationConfig = {
  temperature: 0.1,
  topP: 0.95,
  topK: 64,
  maxOutputTokens: 100,
  responseMimeType: 'text/plain',
};

const safetySettings = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

async function analyzeTextWithGemini(text) {
    if (!model) return { isMalicious: false, reason: 'AI model not configured.' };

    const prompt = `Analyze the following text and determine if it is malicious, a scam, a phishing attempt, or contains harmful content. Respond with only \"true\" if it is malicious, and \"false\" if it is not. Text: "${text}"`;

    try {
        const result = await model.generateContent(prompt, { generationConfig, safetySettings });
        const response = result.response;
        const isMalicious = response.text().trim().toLowerCase() === 'true';
        return { isMalicious, reason: isMalicious ? 'Content flagged as malicious by AI.' : '' };
    } catch (error) {
        logger.error('[GeminiAI] Error analyzing text:', error);
        // If the API fails, we default to not flagging the content to avoid false positives.
        return { isMalicious: false, reason: 'AI analysis failed.' };
    }
}

async function scanMessage(message) {
    if (!model) return;
    const guildId = message.guild.id;

    try {
        const [[config]] = await db.execute('SELECT * FROM ai_scan_config WHERE guild_id = ? AND scan_links = 1', [guildId]);
        if (!config || !config.is_enabled) return;

        const result = await analyzeTextWithGemini(message.content);
        if (result.isMalicious) {
            await takeAction(message, config, `Malicious content detected: ${result.reason}`);
        }
    } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
            logger.error('Error in AI message scanner:', { guildId, category: 'ai-scanner', error: error.stack });
        }
    }
}

async function scanUsername(member) {
    if (!model) return;
    const guildId = member.guild.id;

    try {
        const [[config]] = await db.execute('SELECT * FROM ai_scan_config WHERE guild_id = ? AND scan_usernames = 1', [guildId]);
        if (!config || !config.is_enabled) return;

        const result = await analyzeTextWithGemini(member.displayName);
        if (result.isMalicious) {
            logger.warn(`Malicious username detected for ${member.user.tag}: ${result.reason}`, { guildId, category: 'ai-scanner' });
            // Future actions like auto-nicknaming could be added here.
        }
    } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
            logger.error('Error in AI username scanner:', { guildId, category: 'ai-scanner', error: error.stack });
        }
    }
}

async function takeAction(message, config, reason) {
    logger.warn(`AI Scan triggered for message ${message.id}. Reason: ${reason}`, { guildId: message.guild.id, category: 'ai-scanner' });
    
    switch (config.action_on_detection) {
        case 'delete':
            await message.delete().catch(() => {});
            await message.channel.send(`${message.author}, your message was removed for containing potentially malicious content.`).then(msg => setTimeout(() => msg.delete(), 10000));
            break;
        case 'warn':
            await message.reply(`Warning: This content may be malicious. Please be careful.`);
            break;
        case 'mute':
            await message.delete().catch(() => {});
            if (message.member.moderatable) {
                await message.member.timeout(10 * 60 * 1000, `AI Detection: ${reason}`);
            }
            break;
    }
}

module.exports = { scanMessage, scanUsername };
