"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.scanMessage = scanMessage;
exports.scanUsername = scanUsername;
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
// IMPORTANT: You must run `npm install @google/generative-ai` for this file to work.
const generative_ai_1 = require("@google/generative-ai");
const genAI = process.env.GEMINI_API_KEY ? new generative_ai_1.GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const model = genAI ? genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }) : null;
const generationConfig = {
    temperature: 0.1,
    topP: 0.95,
    topK: 64,
    maxOutputTokens: 100,
    responseMimeType: 'text/plain',
};
const safetySettings = [
    { category: generative_ai_1.HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: generative_ai_1.HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: generative_ai_1.HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: generative_ai_1.HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: generative_ai_1.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: generative_ai_1.HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: generative_ai_1.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: generative_ai_1.HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];
async function analyzeTextWithGemini(text) {
    if (!model)
        return { isMalicious: false, reason: 'AI model not configured.' };
    const prompt = `Analyze the following text and determine if it is malicious, a scam, a phishing attempt, or contains harmful content. Respond with only "true" if it is malicious, and "false" if it is not. Text: "${text}"`;
    try {
        const result = await model.generateContent(prompt);
        const response = result.response;
        const isMalicious = response.text().trim().toLowerCase() === 'true';
        return { isMalicious, reason: isMalicious ? 'Content flagged as malicious by AI.' : '' };
    }
    catch (error) {
        logger_1.default.error('[GeminiAI] Error analyzing text:', { error: error instanceof Error ? error.stack : error });
        // If the API fails, we default to not flagging the content to avoid false positives.
        return { isMalicious: false, reason: 'AI analysis failed.' };
    }
}
async function scanMessage(message) {
    if (!model || !message.guild)
        return;
    const guildId = message.guild.id;
    try {
        const [rows] = await db_1.default.execute('SELECT * FROM ai_scan_config WHERE guild_id = ? AND scan_links = 1', [guildId]);
        const config = rows[0];
        if (!config || !config.is_enabled)
            return;
        const result = await analyzeTextWithGemini(message.content);
        if (result.isMalicious) {
            await takeAction(message, config, `Malicious content detected: ${result.reason}`);
        }
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code !== 'ER_NO_SUCH_TABLE') {
            logger_1.default.error('Error in AI message scanner:', { guildId, category: 'ai-scanner', error: error instanceof Error ? error.stack : error });
        }
    }
}
async function scanUsername(member) {
    if (!model)
        return;
    const guildId = member.guild.id;
    try {
        const [rows] = await db_1.default.execute('SELECT * FROM ai_scan_config WHERE guild_id = ? AND scan_usernames = 1', [guildId]);
        const config = rows[0];
        if (!config || !config.is_enabled)
            return;
        const result = await analyzeTextWithGemini(member.displayName);
        if (result.isMalicious) {
            logger_1.default.warn(`Malicious username detected for ${member.user.tag}: ${result.reason}`, { guildId, category: 'ai-scanner' });
            // Future actions like auto-nicknaming could be added here.
        }
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code !== 'ER_NO_SUCH_TABLE') {
            logger_1.default.error('Error in AI username scanner:', { guildId, category: 'ai-scanner', error: error instanceof Error ? error.stack : error });
        }
    }
}
async function takeAction(message, config, reason) {
    if (!message.guild)
        return;
    logger_1.default.warn(`AI Scan triggered for message ${message.id}. Reason: ${reason}`, { guildId: message.guild.id, category: 'ai-scanner' });
    switch (config.action_on_detection) {
        case 'delete':
            await message.delete().catch(() => { });
            if (message.channel && 'send' in message.channel) {
                await message.channel.send(`${message.author}, your message was removed for containing potentially malicious content.`).then(msg => setTimeout(() => msg.delete(), 10000)).catch(() => { });
            }
            break;
        case 'warn':
            await message.reply(`Warning: This content may be malicious. Please be careful.`).catch(() => { });
            break;
        case 'mute':
            await message.delete().catch(() => { });
            if (message.member && message.member.moderatable) {
                await message.member.timeout(10 * 60 * 1000, `AI Detection: ${reason}`).catch(() => { });
            }
            break;
    }
}
