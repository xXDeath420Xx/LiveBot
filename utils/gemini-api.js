import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const geminiAPI = require('./gemini-api.cjs');

export const {
    generatePlaylistRecommendations,
    generatePlaylistCommentary,
    generatePassiveAggressiveCommentary
} = geminiAPI;
