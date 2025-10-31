import axios, { AxiosInstance } from 'axios';

const ELEVENLABS_API_KEY: string | undefined = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_API_URL = 'https://api.elevenlabs.io/v1';

if (!ELEVENLABS_API_KEY) {
    console.warn('ELEVENLABS_API_KEY is not set. ElevenLabs features may not work.');
}

const elevenlabsApi: AxiosInstance = axios.create({
    baseURL: ELEVENLABS_API_URL,
    headers: {
        'xi-api-key': ELEVENLABS_API_KEY || '',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
});

interface Voice {
    voice_id: string;
    name: string;
    category: string;
    [key: string]: any;
}

interface VoicesResponse {
    voices: Voice[];
}

async function getVoices(): Promise<Voice[] | null> {
    if (!ELEVENLABS_API_KEY) {
        console.error('ElevenLabs API key is not configured.');
        return null;
    }
    try {
        const response = await elevenlabsApi.get<VoicesResponse>('/voices');
        return response.data.voices;
    } catch (error: unknown) {
        const errorData = axios.isAxiosError(error) ? (error.response?.data || error.message) : 'Unknown error';
        console.error('Error fetching ElevenLabs voices:', errorData);
        return null;
    }
}

export {
    getVoices,
};
