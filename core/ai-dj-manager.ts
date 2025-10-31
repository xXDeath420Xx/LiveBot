import { Client } from 'discord.js';
import { logger } from '../utils/logger';
import { db } from '../utils/db';
import { RowDataPacket } from 'mysql2/promise';

/**
 * AI DJ Manager
 *
 * Provides 24/7 auto-DJ functionality with AI-powered music curation
 * Features:
 * - Genre, artist, song, and year filtering
 * - AI prompt-based song selection
 * - Randomization for variety in 24/7 mode
 * - Queue management
 * - Seamless playback continuation
 */

interface AIDJConfig {
    guild_id: string;
    enabled: boolean;
    voice_channel_id: string | null;
    genres: string[];  // e.g., ['rock', 'pop', 'jazz']
    artists: string[];  // Preferred artists
    songs: string[];  // Specific songs to include
    years: number[];  // e.g., [1980, 1990, 2000]
    year_range_start: number | null;  // e.g., 1980
    year_range_end: number | null;  // e.g., 2000
    ai_prompt: string | null;  // Custom AI prompt for music selection
    randomness_level: number;  // 0-100, how random the selection should be
    volume: number;  // 0-100
    announce_songs: boolean;  // Announce now playing in text channel
    announcement_channel_id: string | null;
    filter_explicit: boolean;  // Filter out explicit content
    mood: string | null;  // e.g., 'energetic', 'chill', 'focus'
    activity_type: string | null;  // e.g., 'gaming', 'studying', 'party'
}

interface SongMetadata {
    title: string;
    artist: string;
    album?: string;
    year?: number;
    genre?: string;
    duration?: number;
    url: string;
    thumbnail?: string;
    explicit?: boolean;
}

interface QueuedSong extends SongMetadata {
    id: string;
    added_at: Date;
    played: boolean;
}

export class AIDJManager {
    private client: Client;
    private activeGuilds: Map<string, NodeJS.Timeout> = new Map();
    private songQueues: Map<string, QueuedSong[]> = new Map();
    private nowPlaying: Map<string, QueuedSong> = new Map();
    private geminiApiKey: string;

    // Music sources - can be expanded
    private musicSources = {
        youtube: true,
        spotify: true,
        soundcloud: true
    };

    constructor(client: Client) {
        this.client = client;
        this.geminiApiKey = process.env.GEMINI_API_KEY || '';
    }

    /**
     * Initialize AI DJ for a guild
     */
    async start(guildId: string): Promise<void> {
        try {
            const config = await this.getConfig(guildId);

            if (!config.enabled) {
                logger.info(`[AI DJ] AI DJ is disabled for guild ${guildId}`);
                return;
            }

            if (!config.voice_channel_id) {
                logger.warn(`[AI DJ] No voice channel configured for guild ${guildId}`);
                return;
            }

            // Check if already running
            if (this.activeGuilds.has(guildId)) {
                logger.debug(`[AI DJ] AI DJ already running for guild ${guildId}`);
                return;
            }

            logger.info(`[AI DJ] Starting AI DJ for guild ${guildId}`, {
                genres: config?.genres,
                randomness: config.randomness_level,
                mood: config.mood
            });

            // Initialize queue
            await this.initializeQueue(guildId, config);

            // Start playback
            await this.playNext(guildId);

            // Set up continuous playback monitoring
            const interval = setInterval(async () => {
                await this.monitorPlayback(guildId);
            }, 10000); // Check every 10 seconds

            this.activeGuilds.set(guildId, interval);

            logger.info(`[AI DJ] AI DJ started successfully for guild ${guildId}`);
        } catch (error: any) {
            logger.error(`[AI DJ] Error starting AI DJ for guild ${guildId}`, {
                error: error.message,
                stack: error.stack
            });
        }
    }

    /**
     * Stop AI DJ for a guild
     */
    async stop(guildId: string): Promise<void> {
        try {
            const interval = this.activeGuilds.get(guildId);
            if (interval) {
                clearInterval(interval);
                this.activeGuilds.delete(guildId);
            }

            // Stop playback
            const guild = this.client.guilds.cache.get(guildId);
            if (guild) {
                const connection = guild.members.me?.voice.channel;
                if (connection) {
                    // Stop current playback
                    // This will be integrated with your existing music system
                }
            }

            this.songQueues.delete(guildId);
            this.nowPlaying.delete(guildId);

            logger.info(`[AI DJ] AI DJ stopped for guild ${guildId}`);
        } catch (error: any) {
            logger.error(`[AI DJ] Error stopping AI DJ for guild ${guildId}`, {
                error: error.message
            });
        }
    }

    /**
     * Get AI DJ configuration for a guild
     */
    private async getConfig(guildId: string): Promise<AIDJConfig> {
        try {
            const [rows] = await db.execute<RowDataPacket[]>(
                'SELECT * FROM ai_dj_config WHERE guild_id = ?',
                [guildId]
            );

            if (rows.length === 0) {
                // Return default config
                return {
                    guild_id: guildId,
                    enabled: false,
                    voice_channel_id: null,
                    genres: [],
                    artists: [],
                    songs: [],
                    years: [],
                    year_range_start: null,
                    year_range_end: null,
                    ai_prompt: null,
                    randomness_level: 50,
                    volume: 50,
                    announce_songs: true,
                    announcement_channel_id: null,
                    filter_explicit: false,
                    mood: null,
                    activity_type: null
                };
            }

            const config = rows[0];
            return {
                ...config,
                genres: config?.genres ? JSON.parse(config?.genres) : [],
                artists: config?.artists ? JSON.parse(config?.artists) : [],
                songs: config?.songs ? JSON.parse(config?.songs) : [],
                years: config?.years ? JSON.parse(config?.years) : []
            };
        } catch (error: any) {
            logger.error(`[AI DJ] Error getting config for guild ${guildId}`, {
                error: error.message
            });
            throw error;
        }
    }

    /**
     * Initialize song queue using AI
     */
    private async initializeQueue(guildId: string, config: AIDJConfig): Promise<void> {
        try {
            logger.info(`[AI DJ] Initializing queue for guild ${guildId}`);

            // Generate initial queue of 10-20 songs
            const queueSize = 10 + Math.floor(Math.random() * 10);
            const songs: QueuedSong[] = [];

            for (let i = 0; i < queueSize; i++) {
                const song = await this.selectNextSong(config);
                if (song) {
                    songs.push({
                        ...song,
                        id: `ai-dj-${Date.now()}-${i}`,
                        added_at: new Date(),
                        played: false
                    });
                }
            }

            this.songQueues.set(guildId, songs);

            logger.info(`[AI DJ] Queue initialized with ${songs.length} songs for guild ${guildId}`);
        } catch (error: any) {
            logger.error(`[AI DJ] Error initializing queue for guild ${guildId}`, {
                error: error.message
            });
        }
    }

    /**
     * Use AI to select the next song based on configuration
     */
    private async selectNextSong(config: AIDJConfig): Promise<SongMetadata | null> {
        try {
            // Build AI prompt
            const prompt = this.buildAIPrompt(config);

            // Use Gemini AI to suggest a song
            const suggestion = await this.getAISuggestion(prompt);

            // Parse AI response and search for the song
            const song = await this.searchSong(suggestion, config);

            return song;
        } catch (error: any) {
            logger.error(`[AI DJ] Error selecting next song`, {
                error: error.message
            });
            return null;
        }
    }

    /**
     * Build AI prompt based on configuration
     */
    private buildAIPrompt(config: AIDJConfig): string {
        let prompt = 'Suggest a song';

        if (config.ai_prompt) {
            prompt += ` that ${config.ai_prompt}`;
        }

        if (config?.genres.length > 0) {
            prompt += ` in the genres: ${config?.genres.join(', ')}`;
        }

        if (config?.artists.length > 0) {
            prompt += ` by artists similar to: ${config?.artists.join(', ')}`;
        }

        if (config.year_range_start && config.year_range_end) {
            prompt += ` from years ${config.year_range_start} to ${config.year_range_end}`;
        } else if (config?.years.length > 0) {
            prompt += ` from years: ${config?.years.join(', ')}`;
        }

        if (config.mood) {
            prompt += ` with a ${config.mood} mood`;
        }

        if (config.activity_type) {
            prompt += ` suitable for ${config.activity_type}`;
        }

        if (config.filter_explicit) {
            prompt += '. Must be clean/non-explicit';
        }

        prompt += '. Respond with just "Artist - Song Title" format.';

        // Add randomness instruction
        if (config.randomness_level > 70) {
            prompt += ' Be creative and suggest lesser-known songs.';
        } else if (config.randomness_level < 30) {
            prompt += ' Suggest popular, well-known songs.';
        }

        return prompt;
    }

    /**
     * Get song suggestion from AI
     */
    private async getAISuggestion(prompt: string): Promise<string> {
        try {
            if (!this.geminiApiKey) {
                logger.warn(`[AI DJ] No Gemini API key configured, using fallback`);
                return this.getFallbackSuggestion();
            }

            // Call Gemini API
            const response = await fetch('https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent?key=' + this.geminiApiKey, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [{
                        parts: [{ text: prompt }]
                    }]
                })
            });

            const data = await response.json();
            const suggestion = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

            logger.debug(`[AI DJ] AI suggestion: ${suggestion}`);

            return suggestion.trim();
        } catch (error: any) {
            logger.error(`[AI DJ] Error getting AI suggestion`, {
                error: error.message
            });
            return this.getFallbackSuggestion();
        }
    }

    /**
     * Fallback song suggestion when AI is unavailable
     */
    private getFallbackSuggestion(): string {
        const fallbackSongs = [
            'The Beatles - Hey Jude',
            'Queen - Bohemian Rhapsody',
            'Led Zeppelin - Stairway to Heaven',
            'Pink Floyd - Wish You Were Here',
            'Fleetwood Mac - Dreams',
            'Eagles - Hotel California',
            'Nirvana - Smells Like Teen Spirit',
            'Radiohead - Creep',
            'Oasis - Wonderwall',
            'The Killers - Mr. Brightside'
        ];

        return fallbackSongs[Math.floor(Math.random() * fallbackSongs.length)];
    }

    /**
     * Search for a song across music sources
     */
    private async searchSong(suggestion: string, config: AIDJConfig): Promise<SongMetadata | null> {
        try {
            // Parse suggestion (format: "Artist - Song Title")
            const parts = suggestion.split(' - ');
            const artist = parts[0]?.trim() || '';
            const title = parts[1]?.trim() || suggestion;

            const searchQuery = `${artist} ${title}`;

            logger.debug(`[AI DJ] Searching for: ${searchQuery}`);

            // This will integrate with your existing music search system
            // For now, returning a placeholder
            return {
                title,
                artist,
                url: `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`,
                thumbnail: `https://via.placeholder.com/480x360?text=${encodeURIComponent(title)}`
            };

            // TODO: Integrate with existing music/ytdlp-extractor system
        } catch (error: any) {
            logger.error(`[AI DJ] Error searching for song`, {
                suggestion,
                error: error.message
            });
            return null;
        }
    }

    /**
     * Play the next song in queue
     */
    private async playNext(guildId: string): Promise<void> {
        try {
            const queue = this.songQueues.get(guildId);
            if (!queue || queue.length === 0) {
                logger.warn(`[AI DJ] Queue empty for guild ${guildId}, refilling...`);
                const config = await this.getConfig(guildId);
                await this.initializeQueue(guildId, config);
                return;
            }

            // Get next unplayed song
            const nextSong = queue.find(s => !s.played);
            if (!nextSong) {
                logger.info(`[AI DJ] All songs played for guild ${guildId}, refilling queue...`);
                const config = await this.getConfig(guildId);
                await this.initializeQueue(guildId, config);
                return;
            }

            // Mark as played
            nextSong.played = true;
            this.nowPlaying.set(guildId, nextSong);

            logger.info(`[AI DJ] Now playing: ${nextSong.artist} - ${nextSong.title} for guild ${guildId}`);

            // Announce song if configured
            const config = await this.getConfig(guildId);
            if (config.announce_songs && config.announcement_channel_id) {
                await this.announceSong(guildId, nextSong, config.announcement_channel_id);
            }

            // TODO: Integrate with existing music player
            // await this.playAudio(guildId, nextSong);

            // Refill queue when it gets low
            if (queue.filter(s => !s.played).length < 3) {
                const newSongs = await this.selectNextSong(config);
                if (newSongs) {
                    queue.push({
                        ...newSongs,
                        id: `ai-dj-${Date.now()}`,
                        added_at: new Date(),
                        played: false
                    });
                }
            }
        } catch (error: any) {
            logger.error(`[AI DJ] Error playing next song for guild ${guildId}`, {
                error: error.message
            });
        }
    }

    /**
     * Announce currently playing song
     */
    private async announceSong(guildId: string, song: QueuedSong, channelId: string): Promise<void> {
        try {
            const guild = this.client.guilds.cache.get(guildId);
            if (!guild) return;

            const channel = guild.channels.cache.get(channelId);
            if (!channel || !channel.isTextBased()) return;

            await channel.send({
                embeds: [{
                    color: 0x9B59B6,
                    title: '🎵 Now Playing',
                    description: `**${song.title}**\nby ${song.artist}`,
                    thumbnail: song.thumbnail ? { url: song.thumbnail } : undefined,
                    fields: [
                        song.album ? { name: 'Album', value: song.album, inline: true } : null,
                        song.year ? { name: 'Year', value: song.year.toString(), inline: true } : null,
                        song.genre ? { name: 'Genre', value: song.genre, inline: true } : null
                    ].filter(Boolean) as any[],
                    footer: {
                        text: '🤖 AI DJ - Powered by AI music curation'
                    },
                    timestamp: new Date()
                }]
            });
        } catch (error: any) {
            logger.error(`[AI DJ] Error announcing song for guild ${guildId}`, {
                error: error.message
            });
        }
    }

    /**
     * Monitor playback and continue to next song
     */
    private async monitorPlayback(guildId: string): Promise<void> {
        try {
            // TODO: Check if current song has finished playing
            // If finished, play next song
            // This will integrate with your existing music player
        } catch (error: any) {
            logger.error(`[AI DJ] Error monitoring playback for guild ${guildId}`, {
                error: error.message
            });
        }
    }

    /**
     * Get current queue for a guild
     */
    getQueue(guildId: string): QueuedSong[] {
        return this.songQueues.get(guildId) || [];
    }

    /**
     * Get currently playing song
     */
    getNowPlaying(guildId: string): QueuedSong | null {
        return this.nowPlaying.get(guildId) || null;
    }

    /**
     * Skip current song
     */
    async skip(guildId: string): Promise<void> {
        await this.playNext(guildId);
    }

    /**
     * Update configuration
     */
    async updateConfig(guildId: string, config: Partial<AIDJConfig>): Promise<void> {
        try {
            const updates: string[] = [];
            const values: any[] = [];

            Object.entries(config).forEach(([key, value]) => {
                if (key !== 'guild_id') {
                    if (Array.isArray(value)) {
                        updates.push(`${key} = ?`);
                        values.push(JSON.stringify(value));
                    } else {
                        updates.push(`${key} = ?`);
                        values.push(value);
                    }
                }
            });

            values.push(guildId);

            await db.execute(
                `UPDATE ai_dj_config SET ${updates.join(', ')} WHERE guild_id = ?`,
                values
            );

            logger.info(`[AI DJ] Configuration updated for guild ${guildId}`);

            // Restart if currently running
            if (this.activeGuilds.has(guildId)) {
                await this.stop(guildId);
                await this.start(guildId);
            }
        } catch (error: any) {
            logger.error(`[AI DJ] Error updating config for guild ${guildId}`, {
                error: error.message
            });
        }
    }
}

export default AIDJManager;
