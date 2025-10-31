"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getVoices = getVoices;
const axios_1 = __importDefault(require("axios"));
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';
if (!ELEVENLABS_API_KEY) {
    console.warn('ELEVENLABS_API_KEY is not set. ElevenLabs features may not work.');
}
const elevenlabsApi = axios_1.default.create({
    baseURL: ELEVENLABS_API_URL,
    headers: {
        'xi-api-key': ELEVENLABS_API_KEY || '',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
});
async function getVoices() {
    if (!ELEVENLABS_API_KEY) {
        console.error('ElevenLabs API key is not configured.');
        return null;
    }
    try {
        const response = await elevenlabsApi.get('/voices');
        return response.data.voices;
    }
    catch (error) {
        const errorData = axios_1.default.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        console.error('Error fetching ElevenLabs voices:', errorData);
        return null;
    }
}
