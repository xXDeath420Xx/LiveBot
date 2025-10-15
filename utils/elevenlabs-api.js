const axios = require('axios');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

if (!ELEVENLABS_API_KEY) {
    console.warn("ELEVENLABS_API_KEY is not set. ElevenLabs features may not work.");
}

const elevenlabsApi = axios.create({
    baseURL: ELEVENLABS_API_URL,
    headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
});

async function getVoices() {
    if (!ELEVENLABS_API_KEY) {
        console.error("ElevenLabs API key is not configured.");
        return null;
    }
    try {
        const response = await elevenlabsApi.get('/voices');
        return response.data.voices;
    } catch (error) {
        console.error("Error fetching ElevenLabs voices:", error.response ? error.response.data : error.message);
        return null;
    }
}

module.exports = {
    getVoices,
};