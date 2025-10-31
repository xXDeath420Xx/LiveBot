import { Client, Guild, GuildMember } from 'discord.js';
import db from '../utils/db';
import logger from '../utils/logger';

interface StreamerMatch {
    streamerId: number;
    streamerUsername: string;
    platform: string;
    discordUserId: string;
    discordUsername: string;
    guildId: string;
    guildName: string;
    confidence: 'exact' | 'high' | 'medium' | 'low';
}

interface AuditResults {
    totalGuilds: number;
    totalMembers: number;
    totalStreamers: number;
    exactMatches: StreamerMatch[];
    fuzzyMatches: StreamerMatch[];
    newLinks: number;
    existingLinks: number;
    errors: string[];
}

export class UserStreamerLinker {
    private client: Client;

    constructor(client: Client) {
        this.client = client;
    }

    /**
     * Run a full audit across all guilds to find and link Discord users to streamers
     */
    async runFullAudit(): Promise<AuditResults> {
        logger.info('[UserStreamerLinker] Starting full audit across all guilds');

        const results: AuditResults = {
            totalGuilds: 0,
            totalMembers: 0,
            totalStreamers: 0,
            exactMatches: [],
            fuzzyMatches: [],
            newLinks: 0,
            existingLinks: 0,
            errors: []
        };

        try {
            // Get all streamers from database
            const [streamers] = await db.query<any[]>(
                'SELECT streamer_id as id, platform, username, platform_user_id FROM streamers'
            );
            results.totalStreamers = streamers.length;

            logger.info(`[UserStreamerLinker] Found ${streamers.length} streamers to match`);

            // Get all guilds
            const guilds = this.client.guilds.cache;
            results.totalGuilds = guilds.size;

            logger.info(`[UserStreamerLinker] Scanning ${guilds.size} guilds`);

            for (const [guildId, guild] of guilds) {
                try {
                    // Get all subscribed streamers for this guild
                    const [guildStreamers] = await db.query<any[]>(
                        `SELECT DISTINCT s.streamer_id as id, s.platform, s.username, s.platform_user_id
                         FROM streamers s
                         JOIN subscriptions sub ON s.streamer_id = sub.streamer_id
                         WHERE sub.guild_id = ?`,
                        [guildId]
                    );

                    if (guildStreamers.length === 0) continue;

                    logger.info(`[UserStreamerLinker] Guild ${guild.name} has ${guildStreamers.length} streamers`);

                    // Fetch all members for this guild
                    await guild.members.fetch();
                    const members = guild.members.cache;
                    results.totalMembers += members.size;

                    logger.info(`[UserStreamerLinker] Scanning ${members.size} members in ${guild.name}`);

                    // Check each member against streamers
                    for (const [userId, member] of members) {
                        if (member.user.bot) continue;

                        const username = member.user.username.toLowerCase();
                        const displayName = member.displayName.toLowerCase();

                        // Check against each streamer
                        for (const streamer of guildStreamers) {
                            const streamerName = streamer.username.toLowerCase();

                            // Check for exact match
                            if (username === streamerName || displayName === streamerName) {
                                const match: StreamerMatch = {
                                    streamerId: streamer.id,
                                    streamerUsername: streamer.username,
                                    platform: streamer.platform,
                                    discordUserId: userId,
                                    discordUsername: member.user.username,
                                    guildId,
                                    guildName: guild.name,
                                    confidence: 'exact'
                                };

                                results.exactMatches.push(match);
                                logger.info(`[UserStreamerLinker] EXACT MATCH: ${member.user.username} → ${streamer.username} (${streamer.platform})`);
                            }
                            // Check for fuzzy match (contains username)
                            else if (
                                username.includes(streamerName) ||
                                displayName.includes(streamerName) ||
                                streamerName.includes(username)
                            ) {
                                const match: StreamerMatch = {
                                    streamerId: streamer.id,
                                    streamerUsername: streamer.username,
                                    platform: streamer.platform,
                                    discordUserId: userId,
                                    discordUsername: member.user.username,
                                    guildId,
                                    guildName: guild.name,
                                    confidence: 'medium'
                                };

                                results.fuzzyMatches.push(match);
                                logger.info(`[UserStreamerLinker] FUZZY MATCH: ${member.user.username} ≈ ${streamer.username} (${streamer.platform})`);
                            }
                        }
                    }
                } catch (error: any) {
                    logger.error(`[UserStreamerLinker] Error scanning guild ${guild.name}: ${error.message}`);
                    results.errors.push(`Guild ${guild.name}: ${error.message}`);
                }
            }

            // Link exact matches automatically
            for (const match of results.exactMatches) {
                const linked = await this.linkUserToStreamer(
                    match.discordUserId,
                    match.streamerId,
                    match.guildId,
                    true // auto-verified for exact matches
                );

                if (linked.isNew) {
                    results.newLinks++;
                } else {
                    results.existingLinks++;
                }
            }

            logger.info(`[UserStreamerLinker] Audit complete: ${results.exactMatches.length} exact matches, ${results.fuzzyMatches.length} fuzzy matches`);

        } catch (error: any) {
            logger.error(`[UserStreamerLinker] Fatal error during audit: ${error.message}`);
            results.errors.push(`Fatal: ${error.message}`);
        }

        return results;
    }

    /**
     * Search for a specific streamer username across all guilds
     */
    async searchForStreamer(streamerUsername: string, platform?: string): Promise<StreamerMatch[]> {
        const matches: StreamerMatch[] = [];

        try {
            // Get streamer from database
            let query = 'SELECT streamer_id as id, platform, username FROM streamers WHERE LOWER(username) = ?';
            const params: any[] = [streamerUsername.toLowerCase()];

            if (platform) {
                query += ' AND platform = ?';
                params.push(platform);
            }

            const [streamers] = await db.query<any[]>(query, params);

            if (streamers.length === 0) {
                logger.warn(`[UserStreamerLinker] No streamer found with username: ${streamerUsername}`);
                return matches;
            }

            // Search for this streamer across all guilds
            for (const streamer of streamers) {
                // Get guilds that have this streamer
                const [guilds] = await db.query<any[]>(
                    'SELECT DISTINCT guild_id FROM subscriptions WHERE streamer_id = ?',
                    [streamer.id]
                );

                for (const { guild_id } of guilds) {
                    const guild = this.client.guilds.cache.get(guild_id);
                    if (!guild) continue;

                    await guild.members.fetch();
                    const members = guild.members.cache;

                    for (const [userId, member] of members) {
                        if (member.user.bot) continue;

                        const username = member.user.username.toLowerCase();
                        const displayName = member.displayName.toLowerCase();
                        const streamerName = streamer.username.toLowerCase();

                        if (username === streamerName || displayName === streamerName) {
                            matches.push({
                                streamerId: streamer.id,
                                streamerUsername: streamer.username,
                                platform: streamer.platform,
                                discordUserId: userId,
                                discordUsername: member.user.username,
                                guildId: guild_id,
                                guildName: guild.name,
                                confidence: 'exact'
                            });
                        }
                    }
                }
            }
        } catch (error: any) {
            logger.error(`[UserStreamerLinker] Error searching for streamer: ${error.message}`);
        }

        return matches;
    }

    /**
     * Link a Discord user to a streamer profile
     */
    async linkUserToStreamer(
        discordUserId: string,
        streamerId: number,
        guildId: string,
        verified: boolean = false
    ): Promise<{ success: boolean; isNew: boolean }> {
        try {
            // Check if link already exists
            const [existing] = await db.query<any[]>(
                'SELECT id FROM streamer_discord_links WHERE discord_user_id = ? AND streamer_id = ?',
                [discordUserId, streamerId]
            );

            if (existing.length > 0) {
                logger.info(`[UserStreamerLinker] Link already exists: User ${discordUserId} → Streamer ${streamerId}`);
                return { success: true, isNew: false };
            }

            // Create new link
            await db.query(
                `INSERT INTO streamer_discord_links
                (discord_user_id, streamer_id, guild_id, verified, linked_at)
                VALUES (?, ?, ?, ?, NOW())`,
                [discordUserId, streamerId, guildId, verified ? 1 : 0]
            );

            logger.info(`[UserStreamerLinker] NEW LINK: User ${discordUserId} → Streamer ${streamerId} (verified: ${verified})`);
            return { success: true, isNew: true };

        } catch (error: any) {
            logger.error(`[UserStreamerLinker] Error linking user to streamer: ${error.message}`);
            return { success: false, isNew: false };
        }
    }

    /**
     * Get all Discord users linked to a streamer
     */
    async getLinkedUsers(streamerId: number): Promise<any[]> {
        try {
            const [links] = await db.query<any[]>(
                `SELECT sdl.*, s.username as streamer_username, s.platform
                 FROM streamer_discord_links sdl
                 JOIN streamers s ON sdl.streamer_id = s.id
                 WHERE sdl.streamer_id = ?`,
                [streamerId]
            );

            return links;
        } catch (error: any) {
            logger.error(`[UserStreamerLinker] Error getting linked users: ${error.message}`);
            return [];
        }
    }

    /**
     * Get all streamers linked to a Discord user
     */
    async getLinkedStreamers(discordUserId: string): Promise<any[]> {
        try {
            const [links] = await db.query<any[]>(
                `SELECT sdl.*, s.username as streamer_username, s.platform
                 FROM streamer_discord_links sdl
                 JOIN streamers s ON sdl.streamer_id = s.id
                 WHERE sdl.discord_user_id = ?`,
                [discordUserId]
            );

            return links;
        } catch (error: any) {
            logger.error(`[UserStreamerLinker] Error getting linked streamers: ${error.message}`);
            return [];
        }
    }

    /**
     * Unlink a Discord user from a streamer
     */
    async unlinkUserFromStreamer(discordUserId: string, streamerId: number): Promise<boolean> {
        try {
            await db.query(
                'DELETE FROM streamer_discord_links WHERE discord_user_id = ? AND streamer_id = ?',
                [discordUserId, streamerId]
            );

            logger.info(`[UserStreamerLinker] UNLINKED: User ${discordUserId} from Streamer ${streamerId}`);
            return true;
        } catch (error: any) {
            logger.error(`[UserStreamerLinker] Error unlinking: ${error.message}`);
            return false;
        }
    }

    /**
     * Verify a pending link
     */
    async verifyLink(discordUserId: string, streamerId: number): Promise<boolean> {
        try {
            await db.query(
                'UPDATE streamer_discord_links SET verified = 1 WHERE discord_user_id = ? AND streamer_id = ?',
                [discordUserId, streamerId]
            );

            logger.info(`[UserStreamerLinker] VERIFIED: User ${discordUserId} → Streamer ${streamerId}`);
            return true;
        } catch (error: any) {
            logger.error(`[UserStreamerLinker] Error verifying link: ${error.message}`);
            return false;
        }
    }
}

export default UserStreamerLinker;
