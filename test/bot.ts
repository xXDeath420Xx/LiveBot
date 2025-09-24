// bot.ts
import 'dotenv/config'; // Use 'dotenv/config' for direct loading
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as WebSocket from 'ws';

// --- Interfaces ---
interface KickUser {
    id: number;
    username: string;
    // Add other user properties if known/needed
}

interface KickChatroom {
    id: number;
    // Add other chatroom properties if known/needed
}

interface KickStream {
    is_live: boolean;
    viewer_count: number;
    // Add other stream properties if known/needed
}

interface KickChannelData {
    id: number; // This ID is used for chatroom settings
    user_id: number;
    slug: string;
    user: KickUser;
    chatroom: KickChatroom;
    stream: KickStream | null; // Stream might be null if not live
    // Add other channel properties if known/needed
}

interface KickPublicChannelResponse {
    data: KickChannelData[];
}

interface KickChatroomSettings {
    websocket_url: string;
    // Add other chatroom settings properties if known/needed
}

interface ChatMessageSender {
    id: number;
    username: string;
    // Add other sender properties if known/needed
}

interface ChatMessage {
    sender: ChatMessageSender;
    content: string;
    // Add other chat message properties if known/needed
}

type SendMessageFunction = (content: string) => Promise<void>;

interface Command {
    name: string;
    execute: (chatMessage: ChatMessage, sendMessage: SendMessageFunction) => void;
    // Add other command properties if known/needed
}

// --- Configuration ---
const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID;
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET;
const KICK_OAUTH_TOKEN = process.env.KICK_OAUTH_ACCESS_TOKEN;
const CHANNEL_SLUG = "mindlesschaos";

// --- Command Handler Setup ---
const commands = new Map<string, Command>();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((file: string) => file.endsWith('.js')); // Commands are still .js for now
for (const file of commandFiles) {
    const command: Command = require(path.join(commandsPath, file));
    commands.set(command.name, command);
    console.log(`✅ Loaded command: !${command.name}`);
}

// --- Global Variables ---
let appAccessToken: string | null = null;
let currentChannelData: KickChannelData | null = null;

// --- Core Bot Functions ---

async function refreshAppAccessToken(): Promise<boolean> {
    if (!KICK_CLIENT_ID || !KICK_CLIENT_SECRET) {
        console.error("❌ Cannot refresh App Token, Client ID or Secret is missing from .env");
        return false;
    }
    try {
        console.log("🚀 Refreshing App Access Token...");
        const response = await axios.post('https://id.kick.com/oauth/token', new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: KICK_CLIENT_ID,
            client_secret: KICK_CLIENT_SECRET
        }));
        appAccessToken = response.data.access_token;
        console.log("✅ New App Access Token obtained!");
        return true;
    } catch (error: any) {
        console.error("❌ FAILED to refresh App Access Token:", error.response ? error.response.data : error.message);
        return false;
    }
}

async function getChannelInfo(): Promise<boolean> {
    if (!appAccessToken) {
        console.error("Cannot get channel info, App Access Token is missing.");
        return false;
    }
    try {
        console.log(`📡 Fetching channel info for: ${CHANNEL_SLUG} using public v1 API...`);
        const response = await axios.get<KickPublicChannelResponse>(`https://api.kick.com/public/v1/channels?slug=${CHANNEL_SLUG}`, {
            headers: { 'Authorization': `Bearer ${appAccessToken}`, 'Accept': 'application/json' },
        });

        if (response.data.data && response.data.data.length > 0) {
            currentChannelData = response.data.data[0];
            const streamInfo = currentChannelData.stream;
            if (streamInfo) {
                console.log(`--- Channel Status --- | Is Live: ${streamInfo.is_live ? 'Yes' : 'No'} | Viewers: ${streamInfo.viewer_count} ---`);
            } else {
                console.log(`--- Channel Status --- | Not live ---`);
            }
            console.log(`--- Channel Info Acquired --- | User ID: ${currentChannelData.user_id} ---`);
            return true;
        } else {
            console.error(`❌ FAILED to get channel info: No data returned for channel ${CHANNEL_SLUG}`);
            return false;
        }
    } catch (error: any) {
        console.error("❌ FAILED to get channel info:", error.response ? error.response.data : error.message);
        return false;
    }
}

async function getChatroomSettings(): Promise<KickChatroomSettings | null> {
    if (!appAccessToken || !currentChannelData) {
        console.error("Cannot get chatroom settings, App Access Token or channel data is missing.");
        return null;
    }
    try {
        console.log(`📡 Fetching chatroom settings...`);
        // Keeping this endpoint as there's no public/v1 equivalent provided in the reference.
        // This endpoint likely requires the channel ID obtained from the public/v1 API.
        const response = await axios.get<KickChatroomSettings>(`https://kick.com/api/v2/channels/${currentChannelData.id}/chatroom`, {
            headers: { 'Authorization': `Bearer ${appAccessToken}`, 'Accept': 'application/json' },
        });
        console.log(`✅ Chatroom settings acquired!`);
        return response.data;
    } catch (error: any) {
        console.error("❌ FAILED to get chatroom settings:", error.response ? error.response.data : error.message);
        return null;
    }
}

function connectToChat(chatroomData: KickChatroomSettings) {
    if (!currentChannelData) {
        console.error("Cannot connect to chat, currentChannelData is missing.");
        return;
    }
    const websocketUrl: string = chatroomData.websocket_url;
    console.log(`🔌 Connecting to WebSocket at: ${websocketUrl}`);
    const ws = new WebSocket(websocketUrl);

    ws.on('open', () => {
        console.log('✅ Chat connection opened!');
    });

    ws.on('message', (data: WebSocket.RawData) => {
        const messageData = JSON.parse(data.toString());
        
        // This is a PING message from the server to keep the connection alive
        if (messageData.event === 'App\\Events\\PingEvent') {
            ws.send(JSON.stringify({ event: "pusher:pong" }));
            return;
        }

        if (messageData.event === 'App\\Events\\ChatMessageEvent') {
            const chatMessage: ChatMessage = JSON.parse(messageData.data);
            const author: string = chatMessage.sender.username;
            const content: string = chatMessage.content;
            console.log(`[CHAT] ${author}: ${content}`);

            const prefix: string = '!';
            if (!content.startsWith(prefix) || chatMessage.sender.id === currentChannelData.user.id) return;

            const args: string[] = content.slice(prefix.length).trim().split(/ +/);
            const commandName: string = args.shift()!.toLowerCase();
            const command = commands.get(commandName);

            if (!command) return;

            try {
                command.execute(chatMessage, sendMessage);
            } catch (error: any) {
                console.error(`Error executing command ${commandName}:`, error);
            }
        }
    });

    ws.on('close', () => {
        console.log('❌ Chat connection closed. Reconnecting in 5 seconds...');
        setTimeout(() => main(), 5000); // Rerun the main function to get a fresh URL
    });

    ws.on('error', (error: Error) => {
        console.error('❌ A chat WebSocket error occurred:', error);
    });
}

async function sendMessage(content: string): Promise<void> {
    if (!KICK_OAUTH_TOKEN || !currentChannelData) {
        console.error("Cannot send message, User OAuth Token or channel data is missing.");
        return;
    }
    const chatroomId = currentChannelData.user_id; // Use broadcaster_user_id from the public v1 channel data
    const url = 'https://api.kick.com/public/v1/chat'; // Updated to use the public v1 chat endpoint
    try {
        await axios.post(url, {
            content: content,
            broadcaster_user_id: chatroomId, // As per the reference code
            type: 'bot' // As per the reference code
        }, {
            headers: {
                'Authorization': `Bearer ${KICK_OAUTH_TOKEN}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            }
        });
        console.log(`[SENT] ${content}`);
    } catch (error: any) {
        console.error(`❌ FAILED to send message: "${content}"`, error.response ? error.response.data : error.message);
    }
}

// --- Main Startup Logic ---
async function main(): Promise<void> {
    console.log("🤖 CannaKick Bot is starting up...");
    if (await refreshAppAccessToken() && await getChannelInfo()) {
        const chatroomData = await getChatroomSettings();
        if (chatroomData) {
            connectToChat(chatroomData);
        }
    }
}

main();
