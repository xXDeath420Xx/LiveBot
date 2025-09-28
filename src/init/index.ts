import {PrismaClient} from "@prisma/client";
import initCycleTLS, {CycleTLSClient} from "cycletls";
import {Client, Collection, Events, GatewayIntentBits, GuildMember, Partials} from "discord.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import {handleInteraction} from "../core/interaction-handler";
import {getStatus, setStatus} from "../core/status-manager";
import {dashboard} from "../dashboard/server";
import {updateAnnouncement} from "../utils/announcer";
import * as apiChecks from "../utils/api_checks";
import * as cache from "../utils/cache";
import {logger} from "../utils/logger";
import {connect as db_connect} from "./db";

dotenv.config();

class Initialize {
    isChecking: boolean = false;
    isCheckingTeams: boolean = false;
    prisma: PrismaClient;

    loadCommands(client: Client) {
        client.commands = new Collection();
        const commandsPath = path.join(__dirname, "commands");
        const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith(".js"));
        for (const file of commandFiles) {
            try {
                const command = require(path.join(commandsPath, file));
                if (command.data && command.execute) {
                    client.commands.set(command.data.name, command);
                }
            } catch (e) {
                logger.error(`[CMD Load Error] ${file}:`, e);
            }
        }
    };

    getFilesRecursively(directory: string) {
        let files: string[] = [];
        const items = fs.readdirSync(directory, {withFileTypes: true});
        for (const item of items) {
            const fullPath = path.join(directory, item.name);
            if (item.isDirectory()) {
                files = files.concat(this.getFilesRecursively(fullPath));
            } else {
                files.push(fullPath);
            }
        }
        return files;
    };

    populateInteractions(client: Client) {
        const interactionsPath = path.join(__dirname, "interactions");
        const interactionFolders = fs.readdirSync(interactionsPath);
        for (const folder of interactionFolders) {
            const folderPath = path.join(interactionsPath, folder);
            const interactionFiles = this.getFilesRecursively(folderPath).filter(file => file.endsWith(".js"));
            for (const file of interactionFiles) {
                try {
                    const handler = require(file);
                    if (handler.customId && handler.execute) {
                        const key = handler.customId.toString();
                        if (folder === "buttons") {
                            client.buttons.set(key, handler);
                        } else if (folder === "modals") {
                            client.modals.set(key, handler);
                        } else if (folder === "selects") {
                            client.selects.set(key, handler);
                        }
                    }
                } catch (e) {
                    logger.error(`[Interaction Load Error] ${file}:`, e);
                }
            }
        }
    };

    async main() {
        try {
            // Test the database connection first
            logger.info("[Startup] Testing database connection...");
            this.prisma = await db_connect();
            logger.info("[Startup] Database connection successful.");

            setStatus("STARTING", "Initializing Dashboard...");
            await dashboard.start(null, getStatus);

            const client = new Client({intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration], partials: [Partials.User, Partials.GuildMember]});

            // Graceful Shutdown
            let isShuttingDown = false;
            const intervals: ReturnType<typeof setInterval>[] = [];

            async function shutdown(signal: string) {
                if (isShuttingDown) {
                    return;
                }
                isShuttingDown = true;
                logger.warn(`[Shutdown] Received ${signal}. Shutting down gracefully...`);
                setStatus("MAINTENANCE", "Bot is shutting down.");
                intervals.forEach(clearInterval);
                await client.destroy();
                await end(); // Use the new end function
                await cache.redis.quit();
                process.exit(0);
            }

            process.on("SIGTERM", () => shutdown("SIGTERM"));
            process.on("SIGINT", () => shutdown("SIGINT"));

            // Load Commands
            this.loadCommands(client);
            logger.info(`[Startup] ${client.commands.size} commands loaded.`);

            // Load Interaction Handlers
            client.buttons = new Collection();
            client.modals = new Collection();
            client.selects = new Collection();
            this.populateInteractions(client);
            logger.info(`[Startup] Loaded ${client.buttons.size} button handlers, ${client.modals.size} modal handlers, and ${client.selects.size} select menu handlers.`);

            client.on(Events.InteractionCreate, handleInteraction);
            client.once(Events.ClientReady, async c => {
                logger.info(`[READY] Logged in as ${c.user.tag}${c.shard ? ` on Shard #${c.shard.ids.join()}` : ""}`);
                dashboard.setClient(c);
                setStatus("STARTING", "Running startup cleanup...");
                await this.startupCleanup();
                setStatus("ONLINE", "Bot is online and operational.");

                // Trigger initial checks immediately
                await this.checkStreams();
                await checkTeams();

                // Then schedule recurring checks
                intervals.push(setInterval(() => this.checkStreams(), 180 * 1000));
                intervals.push(setInterval(() => this.checkTeams(), 15 * 60 * 1000));
            });

            await client.login(process.env.DISCORD_TOKEN);
        } catch (error) {
            logger.error("[Main Error] A fatal error occurred during bot startup:", error);
            process.exit(1);
        }
    }

    async cleanupInvalidRole(guildId: string, roleId: string) {
        if (!guildId || !roleId) {
            return;
        }
        logger.info(`[Role Cleanup] Aggressively purging invalid role ID ${roleId} for guild ${guildId}.`);
        try {
            await this.prisma.guilds.update({
                where: {guild_id: guildId, live_role_id: roleId},
                data: {
                    live_role_id: null,
                }
            });
            await this.prisma.twitch_teams.update({
                where: {guild_id: guildId, live_role_id: roleId},
                data: {live_role_id: null},
            });
        } catch (error) {
            logger.error(`[Role Cleanup] DB Error while purging role ${roleId} for guild ${guildId}:`, error);
        }
    };

    async doGuildCleanup() {
        const guildRoles = await this.prisma.guilds.findMany({
            where: {live_role_id: {not: null}}
        });
        const teamRoles = await this.prisma.twitch_teams.findMany({
            where: {live_role_id: {not: null}}
        });
        const allRoleConfigs = [...guildRoles, ...teamRoles];
        const uniqueGuildIds = [...new Set(allRoleConfigs.map((c: { guild_id: any; }) => c.guild_id))];
        for (const guildId of uniqueGuildIds) {
            try {
                const guild = await client.guilds.fetch(guildId);
                const rolesForGuild = allRoleConfigs.filter((c: { guild_id: any; }) => c.guild_id === guildId);
                const uniqueRoleIds = [...new Set(rolesForGuild.map((c: { live_role_id: any; }) => c.live_role_id))];

                for (const roleId of uniqueRoleIds) {
                    if (!roleId) {
                        continue;
                    }
                    const roleExists = await guild.roles.fetch(roleId).catch(() => null);
                    if (!roleExists) {
                        logger.info(`[Startup Cleanup] Found invalid role ${roleId} in guild ${guildId} during validation.`);
                        await cleanupInvalidRole(guildId, roleId);
                    }
                }
            } catch (e) {
                // Guild likely no longer exists, ignore.
                // No, lets not fucking ignore it. Fuck sake
                logger.info(`[Cleanup]: Guild not found ${guildId}. Skipping`, e);
            }
        }
    };

    async doRepostMessage(ann: { guild_id: any; channel_id: any; subscription_id: any; streamer_id: any; custom_message: any; override_nickname: any; override_avatar_url: any; username: any; platform: any; profile_image_url: any; discord_user_id: any; stream_title: any; stream_game: any; stream_thumbnail_url: any; announcement_id: any; }) {
        // Message was deleted, need to repost
        const guildSettings = await this.prisma.guilds.findOne({
            where: {guild_id: ann.guild_id},
        }) ?? {};

        const channelSettings = await this.prisma.channel_settings.findOne({
            where: {guild_id: ann.guild_id, channel_id: ann.channel_id},
        }) ?? {};

        const teamSettings = await this.prisma.twitch_teams.findMany({
            where: {guild_id: ann.guild_id, announcement_channel_id: ann.channel_id},
        });

        const subContext = {
            subscription_id: ann.subscription_id,
            streamer_id: ann.streamer_id,
            guild_id: ann.guild_id,
            announcement_channel_id: ann.channel_id,
            custom_message: ann.custom_message,
            override_nickname: ann.override_nickname,
            override_avatar_url: ann.override_avatar_url,
            username: ann.username,
            platform: ann.platform,
            profile_image_url: ann.profile_image_url,
            discord_user_id: ann.discord_user_id // Ensure discord_user_id is passed
        };

        let url;
        switch (ann.platform) {
            case "twitch":
                url = `https://twitch.tv/${ann.username}`;
                break;
            case "kick":
                url = `https://kick.com/${ann.username}`;
                break;
            default:
                url = "#";
                break;
        }

        const liveData = {
            username: ann.username,
            platform: ann.platform,
            title: ann.stream_title,
            game: ann.stream_game,
            thumbnailUrl: ann.stream_thumbnail_url,
            url
        };

        const repostedMessage = await updateAnnouncement(client, subContext, liveData, null, guildSettings, channelSettings, teamSettings);

        if (repostedMessage && repostedMessage.id) {
            await this.prisma.announcements.update({
                where: {announcement_id: ann.announcement_id},
                data: {message_id: repostedMessage.id}
            });
            logger.info(`[Startup Cleanup] Reposted announcement ${ann.announcement_id} in channel ${ann.channel_id} with new message ID ${repostedMessage.id}.`);
        } else {
            logger.error(`[Startup Cleanup] Failed to repost announcement ${ann.announcement_id}. updateAnnouncement returned:`, repostedMessage);
        }
    };

    async doAnnouncementCleanup() {
        const allAnnouncements = this.prisma.announcements.findMany({
            include: {
                streamers: true,
                subscriptions: true,
            },
            select: {
                streamers: {
                    select: {
                        username: true,
                        platform: true,
                        profile_image_url: true,
                    }
                },
                subscriptions: {
                    select: {
                        custom_message: true,
                        override_nickname: true,
                        override_avatar_url: true,
                        discord_user_id: true,
                    }
                }
            }
        });

        for (const ann of allAnnouncements) {
            try {
                const channel = await client.channels.fetch(ann.channel_id).catch((e: { code: number; }) => {
                    if (e.code === 10003) { // Unknown Channel
                        logger.warn(`[Startup Cleanup] Channel ${ann.channel_id} for announcement ${ann.announcement_id} not found. Deleting announcement from DB.`);
                        return null;
                    }
                    throw e; // Re-throw other errors
                });

                if (!channel || !channel.isTextBased()) {
                    await this.prisma.announcements.delete({
                        where: {announcement_id: ann.announcement_id}
                    });
                    continue;
                }

                const message = await channel.messages.fetch(ann.message_id).catch((e: { code: number; }) => {
                    if (e.code === 10008) { // Unknown Message
                        logger.warn(`[Startup Cleanup] Message ${ann.message_id} for announcement ${ann.announcement_id} in channel ${ann.channel_id} not found. Reposting.`);
                        return null;
                    }
                    throw e; // Re-throw other errors
                });

                if (!message) {
                    await this.doRepostMessage(ann);
                }
            } catch (e) {
                logger.error(`[Startup Cleanup] Error processing announcement ${ann.announcement_id}:`, e);
            }
        }
    };

    async startupCleanup() {
        logger.info("[Startup Cleanup] Starting...");
        try {
            // --- STAGE 1: Proactive Role Validation and Cleanup ---
            logger.info("[Startup Cleanup] Stage 1: Validating all configured role IDs...");
            await this.doGuildCleanup();
            logger.info("[Startup Cleanup] Stage 1: Proactive role validation complete.");

            // --- STAGE 2: Handle Deleted Announcement Messages ---
            logger.info("[Startup Cleanup] Stage 2: Checking for deleted announcement messages...");
            await this.doAnnouncementCleanup();
            logger.info("[Startup Cleanup] Stage 2: Deleted announcement message check complete.");

            // --- STAGE 3: Load Existing Announcements for Persistence ---
            logger.info("[Startup Cleanup] Stage 3: Loading existing announcements for persistence...");

        } catch (e) {
            logger.error("[Startup Cleanup] A CRITICAL ERROR occurred:", e);
        } finally {
            logger.info("[Startup Cleanup] Full-stage cleanup/load process has finished.");
        }
    };

    async processAvatars(
        uniqueStreamers: any[],
        liveStatusMap: Map<string | null, { guildId?: string | null | undefined, platforms?: Set<string>, live_role_id?: string | null, announcement_channel_id?: string | null }>,
        cycleTLS: CycleTLSClient
    ) {
        let streamer: { platform: string, username: string, platform_user_id: string, profile_image_url?: string | null, streamer_id: string | null, kick_username?: string | null };
        for (streamer of uniqueStreamers) {
            try {
                let primaryLiveData: {
                    guildId?: string | null | undefined,
                    platforms?: Set<string>,
                    profileImageUrl?: string | null,
                    isLive?: boolean | null,
                    live_role_id?: string | null | undefined,
                    announcement_channel_id?: string | null | undefined,
                } | null = null;
                switch (streamer.platform) {
                    case "twitch":
                        primaryLiveData = await apiChecks.checkTwitch(streamer);
                        break;
                    case "kick":
                        primaryLiveData = await apiChecks.checkKick(cycleTLS, streamer.username);
                        break;
                    case "youtube":
                        primaryLiveData = await apiChecks.checkYouTube(streamer.platform_user_id);
                        break;
                    case "tiktok":
                        primaryLiveData = await apiChecks.checkTikTok(streamer.username);
                        break;
                    case "trovo":
                        primaryLiveData = await apiChecks.checkTrovo(streamer.username);
                        break;
                }

                if (primaryLiveData && primaryLiveData.profileImageUrl && primaryLiveData.profileImageUrl !== streamer.profile_image_url) {
                    await this.prisma.streamers.update({
                        where: {streamer_id: streamer.streamer_id},
                        data: {profile_image_url: primaryLiveData.profileImageUrl},
                    });
                    logger.info(`[Avatar Update] Updated ${streamer.username}'s avatar.`);
                }
                if (primaryLiveData?.isLive) {
                    liveStatusMap.set(streamer.streamer_id, primaryLiveData);
                }

                if (streamer.platform === "twitch" && streamer.kick_username) {
                    await this.doUpdateKickInfo(streamer, cycleTLS, liveStatusMap);
                }
            } catch (e) {
                logger.error(`[API Check Error] for ${streamer.username}:`, e);
            }
        }
    };

    async doUpdateKickInfo(
        streamer: { platform: string; username: string; platform_user_id: string; profile_image_url?: string | null; streamer_id?: string | null; kick_username: string | null; },
        cycleTLS: CycleTLSClient,
        liveStatusMap: Map<string | null, {}>
    ) {
        const kickInfo = await this.prisma.streamers.findOne({
            where: {platform: "kick", username: streamer.kick_username},
        });
        if (kickInfo) {
            const linkedKickLiveData = await apiChecks.checkKick(cycleTLS, streamer.kick_username);
            if (linkedKickLiveData && linkedKickLiveData.profileImageUrl && linkedKickLiveData.profileImageUrl !== kickInfo.profile_image_url) {
                await this.prisma.streamers.update({
                    where: {streamer_id: kickInfo.streamer_id},
                    data: {profile_image_url: linkedKickLiveData.profileImageUrl},
                });
                logger.info(`[Avatar Update] Updated linked Kick account ${streamer.kick_username}'s avatar.`);
            }
            if (linkedKickLiveData?.isLive) {
                liveStatusMap.set(kickInfo.streamer_id, linkedKickLiveData);
            }
        }
    };

    async doSendAnnouncement(
        client: Client,
        sub: { username: any; subscription_id: any; streamer_id: any; guild_id: any; },
        liveData: { game: any; title: any; platform: any; thumbnailUrl: any; },
        existing: any,
        guildSettings: {} | null,
        channelSettings: unknown,
        teamSettings: unknown,
        targetChannelId: string | null
    ) {
        const sentMessage = await updateAnnouncement(client, sub, liveData, existing, guildSettings, channelSettings, teamSettings);

        if (sentMessage && sentMessage.id && sentMessage.channel_id) {
            if (existing) {
                if (existing && sentMessage.id !== existing.message_id) {
                    logger.info(`[Announce] UPDATED message ID for ${sub.username}`);
                    await this.prisma.announcements.update({
                        where: {announcement_id: existing.announcement_id},
                        data: {message_id: sentMessage.id},
                    });
                }
            } else {
                logger.info(`[Announce] CREATED new announcement for ${sub.username} in channel ${targetChannelId}`);
                const announcementResult = await this.prisma.announcements.upsert({
                    subscription_id: sub.subscription_id,
                    streamer_id: sub.streamer_id,
                    guild_id: sub.guild_id,
                    message_id: sentMessage.id,
                    channel_id: sentMessage.channel_id,
                    platform: liveData.platform,
                    stream_game: liveData.game ?? null,
                    stream_title: liveData.title ?? null,
                    stream_thumbnail_url: liveData.thumbnailUrl ?? null,
                });

                const newAnnouncementId = announcementResult.announcement_id;
                if (newAnnouncementId) {
                    await this.prisma.stream_sessions.upsert({
                        announcement_id: newAnnouncementId,
                        streamer_id: sub.streamer_id,
                        guild_id: sub.guild_id,
                        game_name: liveData.game ?? null,
                        start_time: new Date("now"),
                    });
                    logger.info(`[Stats] Started tracking new stream session for announcement ID: ${newAnnouncementId}`);
                }
            }
        } else {
            logger.error(`[Announce] updateAnnouncement did not return a valid message object for ${sub.username}. Sent message:`, sentMessage);
        }
    };

    async processAnnouncements(
        subscriptionsWithStreamerInfo: [{ subscription_id: string, guild_id: string, streamer_id: number, custom_message: string | null, announcement_channel_id: string | null, override_nickname: string | null, override_avatar_url: string | null, platform: string | null, username: string, platform_user_id: string, discord_user_id: string | null, kick_username: string | null }],
        liveStatusMap: Map<string | number, { game: string, title: string, platform: string, thumbnailUrl: string | null, streamer_id: string }>,
        guildSettingsMap: Map<string, { announcement_channel_id: string | null }>,
        desiredAnnouncementKeys: Set<string>,
        announcementsMap: Map<string, string | null>,
        channelSettingsMap: Map<string, string | null>,
        teamSettingsMap: Map<string, string | null>
    ) {
        for (const sub of subscriptionsWithStreamerInfo) {
            const liveData = liveStatusMap.get(sub.streamer_id);
            if (!liveData) {
                continue;
            }

            const guildSettings = guildSettingsMap.get(sub.guild_id) ?? null;
            const targetChannelId = sub.announcement_channel_id || guildSettings?.announcement_channel_id;
            if (!targetChannelId) {
                continue;
            }

            desiredAnnouncementKeys.add(sub.subscription_id);
            const existing = announcementsMap.get(sub.subscription_id);
            const channelSettings = channelSettingsMap.get(`${sub.guild_id}-${targetChannelId}`);
            const teamSettings = teamSettingsMap.get(`${sub.guild_id}-${targetChannelId}`);

            try {
                await this.doSendAnnouncement(client, sub, liveData, existing, guildSettings, channelSettings, teamSettings, targetChannelId);
            } catch (error) {
                if (error.code === "ECONNREFUSED") {
                    logger.error(`[FATAL DB Error] Connection refused for ${sub.username}.`, error);
                } else {
                    logger.error(`[Announce] Error processing announcement for ${sub.username}:`, error);
                }
            }
        }
    };

    async processCleanup(
        announcementsMap: Map<string, { channel_id: string | null, message_id: string | null, announcement_id: string | null }>,
        desiredAnnouncementKeys: Set<string>
    ) {
        let subscriptionId: string;
        let existing: { channel_id: string | null, message_id: string | null, announcement_id: string | null };
        for ([subscriptionId, existing] of announcementsMap.entries()) {
            if (!desiredAnnouncementKeys.has(subscriptionId)) {
                try {
                    logger.info(`[Cleanup] Deleting announcement for subscription ${subscriptionId}`);
                    const channel = await client.channels.fetch(existing.channel_id).catch(() => null);
                    if (channel) {
                        await channel.messages.delete(existing.message_id).catch((err: { code: number; }) => {
                            if (err.code !== 10008) {
                                logger.error(`[Cleanup] Failed to delete message ${existing.message_id}:`, err);
                            }
                        });
                    }
                    await this.prisma.announcements.delete({
                        where: {announcement_id: existing.announcement_id},
                    });
                } catch (e) {
                    logger.error(`[Cleanup] Error during deletion for announcement ${existing.announcement_id}:`, e);
                }
            }
        }
    };

    getUsersToUpdate(
        subscriptionsWithStreamerInfo: any,
        liveStatusMap: Map<string, string | null>
    ) {
        const usersToUpdate: Map<string, { guildId: string, userId: string, livePlatforms: Set<string> }> = new Map();
        for (const sub of subscriptionsWithStreamerInfo) {
            if (!sub.streamer_discord_user_id) {
                continue;
            }
            const key = `${sub.guild_id}-${sub.streamer_discord_user_id}`;
            if (!usersToUpdate.has(key)) {
                usersToUpdate.set(key, {guildId: sub.guild_id, userId: sub.streamer_discord_user_id, livePlatforms: new Set()});
            }
            if (liveStatusMap.has(sub.streamer_id)) {
                usersToUpdate.get(key)?.livePlatforms.add(sub.platform);
            }
        }
        return usersToUpdate;
    };

    async processRoles(
        usersToUpdate: Map<string, {
            guildId: string,
            userId: string,
            livePlatforms: Set<string>
        }>,
        guildSettingsMap: Map<string, {
            guildId: string,
            userId: string,
            livePlatforms: Set<string>,
            live_role_id: string | null
        }>,
        subscriptionsWithStreamerInfo: {
            subscription_id: number,
            guild_id: string | null,
            streamer_id: number,
            custom_message: string | null,
            announcement_channel_id: string | null,
            override_nickname: string | null,
            override_avatar_url: string | null,
            platform: string | null,
            username: string,
            platform_user_id: string,
            discord_user_id: string | null,
            kick_username: string | null,
            streamer_discord_user_id: string | null
        }[],
        teamConfigs: {
            guild_id: string,
            live_role_id: string,
            announcement_channel_id: string
        }[]
    ) {
        for (const [key, userState] of usersToUpdate.entries()) {
            const {guildId, userId, livePlatforms} = userState;
            const member = await client.guilds.fetch(guildId).then(g => g.members.fetch(userId)).catch(() => null);
            if (!member) {
                continue;
            }

            const guildSettings = guildSettingsMap.get(guildId);
            const streamerSubscriptions = subscriptionsWithStreamerInfo.filter(s => s.streamer_discord_user_id === userId && s.guild_id === guildId);
            const allTeamConfigsForGuild = teamConfigs.filter(t => t.guild_id === guildId && t.live_role_id);

            const desiredRoles = new Set();
            if (guildSettings?.live_role_id && livePlatforms.size > 0) {
                desiredRoles.add(guildSettings.live_role_id);
            }

            for (const teamConfig of allTeamConfigsForGuild) {
                const isStreamerInTeam = streamerSubscriptions.some(sub => sub.announcement_channel_id === teamConfig.announcement_channel_id && sub.platform === "twitch");
                if (isStreamerInTeam && livePlatforms.size > 0) {
                    desiredRoles.add(teamConfig.live_role_id);
                }
            }

            const allManagedRoles = new Set([guildSettings?.live_role_id, ...allTeamConfigsForGuild.map((t: { live_role_id: string; }) => t.live_role_id)].filter(Boolean));

            for (const roleId of allManagedRoles) {
                if (desiredRoles.has(roleId)) {
                    if (!member.roles.cache.has(roleId)) {
                        await handleRole(member, [roleId], "add", guildId);
                    }
                } else {
                    if (member.roles.cache.has(roleId)) {
                        await handleRole(member, [roleId], "remove", guildId);
                    }
                }
            }
        }
    };

    async checkStreams() {
        if (this.isChecking) {
            return;
        }
        this.isChecking = true;
        logger.info(`[Check] ---> Starting stream check @ ${new Date().toLocaleTimeString()}`);
        let cycleTLS = null;
        try {
            const subscriptionsWithStreamerInfo = await this.prisma.subscriptions.findMany({
                include: {
                    streamers: true,
                },
                select: {
                    streamers: {
                        select: {
                            discord_user_id: true,
                            platform_user_id: true,
                            username: true,
                            platform: true,
                            kick_username: true,
                        }
                    }
                }
            });
            const announcementsInDb = await this.prisma.announcement_id.findMany();
            const announcementsMap: Map<string, any> = new Map(announcementsInDb.map((a: { subscription_id: string; }) => [a.subscription_id, a]));
            const guildSettingsList = await this.prisma.guilds.findMany();
            const guildSettingsMap: Map<string, { announcement_channel_id: string | null, guildId: string, userId: string, livePlatforms: Set<string>, live_role_id: string | null, }> = new Map(guildSettingsList.map((g: { guild_id: string; }) => [g.guild_id, g]));
            const channelSettingsList = await this.prisma.channel_settings.findMany();
            const channelSettingsMap: Map<string, string | null> = new Map(channelSettingsList.map((cs: { guild_id: string; channel_id: string; }) => [`${cs.guild_id}-${cs.channel_id}`, cs]));
            const teamConfigs = await this.prisma.twitch_teams.findMany();
            const teamSettingsMap: Map<string, string | null> = new Map(teamConfigs.map((t: { guild_id: string; announcement_channel_id: string; }) => [`${t.guild_id}-${t.announcement_channel_id}`, t]));

            cycleTLS = await initCycleTLS({timeout: 60000});
            const liveStatusMap = new Map();
            const uniqueStreamers = [...new Map(subscriptionsWithStreamerInfo.map((item: { streamer_id: string; }) => [item.streamer_id, item])).values()];
            await this.processAvatars(uniqueStreamers, liveStatusMap, cycleTLS);

            const desiredAnnouncementKeys: Set<string> = new Set();
            await this.processAnnouncements(subscriptionsWithStreamerInfo, liveStatusMap, guildSettingsMap, desiredAnnouncementKeys, announcementsMap, channelSettingsMap, teamSettingsMap);
            await this.processCleanup(announcementsMap, desiredAnnouncementKeys);

            const usersToUpdate = this.getUsersToUpdate(subscriptionsWithStreamerInfo, liveStatusMap);

            logger.info(`[Role Management] Processing ${usersToUpdate.size} users for role updates.`);
            await this.processRoles(usersToUpdate, guildSettingsMap, subscriptionsWithStreamerInfo, teamConfigs);

        } catch (e) {
            logger.error("[checkStreams] CRITICAL ERROR:", e);
        } finally {
            if (cycleTLS) {
                try {
                    await cycleTLS.exit();
                } catch (e) {
                    // Ignore exit errors
                    // DON'T FUCKING IGNORE THE ERRORS, MEIN GOTT
                    logger.warn("Exit error in CycleTLS: ", e);
                }
            }
            this.isChecking = false;
            logger.info("[Check] ---> Finished stream check");
        }
    };

    async checkTeams() {
        if (this.isCheckingTeams) {
            return;
        }
        this.isCheckingTeams = true;
        logger.info(`[Team Sync] ---> Starting team sync @ ${new Date().toLocaleTimeString()}`);
        let cycleTLS = null;
        try {
            const teamSubscriptions = await this.prisma.twitch_teams.findMany();
            if (teamSubscriptions.length === 0) {
                return;
            }

            for (const sub of teamSubscriptions) {
                try {
                    const apiMembers = await apiChecks.getTwitchTeamMembers(sub.team_name);
                    if (!apiMembers) {
                        continue;
                    }

                    const dbTwitchSubs = await this.prisma.subscriptions.findMany({
                        include: {streamers: true},
                        select: {
                            streamer_id: true,
                        },
                        where: {
                            guild_id: sub.guild_id,
                            announcement_channel_id: sub.announcement_channel_id,
                            platform: "twitch",
                        }
                    });
                    const dbKickSubs = await this.prisma.subscriptions.findMany({
                        include: {streamers: true},
                        select: {streamer_id: true},
                        where: {
                            guild_id: sub.guild_id,
                            announcement_channel_id: sub.announcement_channel_id,
                            platform: "kick",
                        }
                    });

                    const currentTwitchStreamerIds = new Set();
                    const currentKickStreamerIds = new Set();

                    for (const member of apiMembers) {
                        await this.prisma.streamers.upsert({
                            create: {platform: "twitch", platform_user_id: member.user_id, username: member.user_login, profile_image_url: member.profile_image_url ?? null},
                            update: {username: member.user_login, profile_image_url: member.profile_image_url ?? null},
                            where: {platform: "twitch", platform_user_id: member.user_id}
                        });
                        const ts = await this.prisma.streamers.findFirst({
                            where: {platform: "twitch", platform_user_id: member.user_id}
                        });
                        if (ts) {
                            currentTwitchStreamerIds.add(ts.streamer_id);
                            await this.prisma.subscriptions.upsert({
                                create: {
                                    guild_id: sub.guild_id,
                                    streamer_id: ts.streamer_id,
                                    announcement_channel_id: sub.announcement_channel_id,
                                },
                            });
                            if (ts.kick_username) {
                                if (!cycleTLS) {
                                    cycleTLS = await initCycleTLS({timeout: 60000});
                                }
                                const kickUser = await apiChecks.getKickUser(cycleTLS, ts.kick_username);
                                if (kickUser && kickUser.id) {
                                    await this.prisma.subscriptions.upsert({
                                        create: {platform: "kick", platform_user_id: kickUser.id, username: kickUser.user.username, profile_image_url: kickUser.user.profile_image_url ?? null},
                                        update: {username: kickUser.user.username, profile_image_url: kickUser.user.profile_image_url ?? null},
                                        where: {platform: "kick", platform_user_id: kickUser.id}
                                    });
                                    const kickStreamer = await this.prisma.streamers.findFirst({
                                        where: {platform: "kick", platform_user_id: kickUser.id},
                                        select: {streamer_id: true},
                                    });
                                    if (kickStreamer) {
                                        currentKickStreamerIds.add(kickStreamer.streamer_id);
                                        await this.prisma.subscriptions.upsert({
                                            create: {
                                                guild_id: sub.guild_id,
                                                streamer_id: kickStreamer.streamer_id,
                                                announcement_channel_id: sub.announcement_channel_id,
                                            }
                                        });
                                    }
                                } else {
                                    logger.warn(`[Team Sync] Could not find Kick user details for ${ts.kick_username}.`);
                                }
                            }
                        }
                    }

                    const twitchToRemove = dbTwitchSubs.filter(dbSub => !currentTwitchStreamerIds.has(dbSub.streamer_id)).map(s => s.streamer_id);
                    if (twitchToRemove.length > 0) {
                        await this.prisma.subscriptions.deleteMany({
                            where: {
                                guild_id: sub.guild_id,
                                announcement_channel_id: sub.announcement_channel_id,
                                streamer_id: {in: twitchToRemove}
                            }
                        });
                        logger.info(`[Team Sync] Removed ${twitchToRemove.length} old Twitch subscriptions.`);
                    }

                    const kickToRemove = dbKickSubs.filter(dbSub => !currentKickStreamerIds.has(dbSub.streamer_id)).map(s => s.streamer_id);
                    if (kickToRemove.length > 0) {
                        await this.prisma.subscriptions.deleteMany({
                            where: {
                                guild_id: sub.guild_id,
                                announcement_channel_id: sub.announcement_channel_id,
                                streamer_id: {in: kickToRemove}
                            }
                        });
                        logger.info(`[Team Sync] Removed ${kickToRemove.length} old Kick subscriptions.`);
                    }

                } catch (e) {
                    logger.error(`[Team Sync] Error processing team ${sub.team_name}:`, e);
                }
            }
        } catch (error) {
            logger.error("[Team Sync] CRITICAL ERROR:", error);
        } finally {
            if (cycleTLS) {
                try {
                    await cycleTLS.exit();
                } catch (e) {
                    logger.error("[Team Sync] Error exiting cycleTLS:", e);
                }
            }
            this.isCheckingTeams = false;
            logger.info("[Team Sync] ---> Finished team sync.");
        }
    }

    async handleRole(member: GuildMember, roleIds: string[], action: string, guildId: string) {
        if (!member || !roleIds || roleIds.length === 0) {
            return;
        }
        for (const roleId of roleIds) {
            if (!roleId) {
                continue;
            }
            try {
                if (action === "add" && !member.roles.cache.has(roleId)) {
                    await member.roles.add(roleId);
                } else if (action === "remove" && member.roles.cache.has(roleId)) {
                    await member.roles.remove(roleId);
                }
            } catch (e) {
                if (e.code === 10011 || (e.message && e.message.includes("Unknown Role"))) {
                    logger.warn(`[handleRole] Invalid role ${roleId} for guild ${guildId}. Cleaning up.`);
                    await cleanupInvalidRole(guildId, roleId);
                } else if (e.code === 50013) {
                    logger.error(`[handleRole] Missing permissions to ${action} role ${roleId} in guild ${guildId}.`, e);
                } else {
                    logger.error(`[handleRole] Failed to ${action} role ${roleId} for member ${member.id}:`, e);
                }
            }
        }
    }
}

new Initialize()
    .main()
    .catch(error => {
        logger.error("Unhandled rejection during main execution:", error);
        process.exit(1);
    });
