// BigInt JSON serialization
(BigInt.prototype as any).toJSON = function() { return this.toString(); };

import { Worker, Job } from 'bullmq';
import logger from '../utils/logger';
import db from '../utils/db';
import { redisOptions } from '../utils/cache';
import { updateAnnouncement, getAndUpdateWebhook } from '../utils/announcer';
import { processRole as handleRole } from '../core/role-manager';
import { Client, Guild, GuildMember } from 'discord.js';

const getWebhookClient = getAndUpdateWebhook;

interface Subscription {
    subscription_id: number;
    streamer_id: number;
    guild_id: string;
    username: string;
    announcement_channel_id?: string;
    team_subscription_id?: number;
    discord_user_id?: string;
    live_role_id?: string;
}

interface LiveData {
    game: string | null;
    title: string | null;
    thumbnailUrl: string | null;
    platform: string;
    url: string;
    username: string;
    profileImageUrl: string | null;
}

interface GuildSettings {
    live_role_id?: string;
    [key: string]: any;
}

interface TeamSettings {
    announcement_channel_id?: string;
    live_role_id?: string;
    [key: string]: any;
}

interface AnnouncementData {
    announcement_id: number;
    message_id?: string;
    channel_id?: string;
    stream_game?: string;
    stream_title?: string;
    stream_thumbnail_url?: string;
}

interface JobData {
    sub: Subscription;
    liveData: LiveData;
}

export = function startAnnouncementWorker(client: Client): Worker {
    // The logger is initialized in the main index.js file. DO NOT re-initialize it here.
    logger.info('[Announcement Worker] Initializing BullMQ Worker.');

    async function cleanupOldAnnouncements(
        discordClient: Client,
        subscriptionId: number,
        guildId: string,
        platform: string,
        username: string,
        messageIdToKeep: string | null = null
    ): Promise<void> {
        try {
            const [oldAnnouncements] = await db.execute(
                `SELECT announcement_id, message_id, channel_id FROM announcements WHERE subscription_id = ?`,
                [subscriptionId]
            ) as any;

            for (const oldAnn of oldAnnouncements as AnnouncementData[]) {
                if (oldAnn.message_id && oldAnn.message_id !== messageIdToKeep) {
                    const webhookClient = await getWebhookClient(discordClient, oldAnn.channel_id!, '', '');
                    if (webhookClient) {
                        await webhookClient.deleteMessage(oldAnn.message_id).catch((e: any) => {
                            if (e.code !== 10008) logger.warn(`[Worker] Failed to delete old message ${oldAnn.message_id}.`, { error: e });
                        });
                    }
                }
                if (oldAnn.message_id !== messageIdToKeep) {
                    await db.execute('DELETE FROM announcements WHERE announcement_id = ?', [oldAnn.announcement_id]);

                    // Also delete from live_announcements table
                    await db.execute(
                        'DELETE FROM live_announcements WHERE guild_id = ? AND platform = ? AND username = ? AND channel_id = ?',
                        [guildId, platform, username, oldAnn.channel_id]
                    ).catch((error: any) => {
                        if (error.code !== 'ER_NO_SUCH_TABLE') {
                            logger.warn(`[Worker] Failed to delete from live_announcements:`, { error: error.message });
                        }
                    });
                }
            }
        } catch (error) {
            logger.error(`[Worker] Error during cleanupOldAnnouncements for subscription ${subscriptionId}:`, { error });
        }
    }

    const announcementWorker = new Worker<JobData>('announcements', async (job: Job<JobData>) => {
        if (!client.isReady()) {
            logger.warn(`[Worker] Discord client not ready. Retrying job ${job.id}...`);
            throw new Error('Discord client not ready');
        }

        const { sub, liveData } = job.data;
        logger.info(`[Worker] Processing job ${job.id} for ${sub.username}.`, { guildId: sub.guild_id });

        try {
            const [[guildSettings]] = await db.execute('SELECT * FROM guilds WHERE guild_id = ?', [sub.guild_id]) as any;
            const [[teamSettings]] = sub.team_subscription_id
                ? await db.execute('SELECT * FROM twitch_teams WHERE id = ?', [sub.team_subscription_id]) as any
                : [[null]];

            let targetChannelId: string | undefined = sub.announcement_channel_id;
            if (sub.team_subscription_id && teamSettings) {
                targetChannelId = (teamSettings as TeamSettings).announcement_channel_id;
            }

            if (!targetChannelId) {
                logger.warn(`[Worker] No announcement channel found for subscription ${sub.subscription_id}. Skipping.`, { guildId: sub.guild_id });
                return;
            }

            const [[channelSettings]] = await db.execute('SELECT * FROM channel_settings WHERE channel_id = ?', [targetChannelId]) as any;

            const [existingAnnouncements] = await db.execute(
                `SELECT * FROM announcements WHERE subscription_id = ? AND channel_id = ? ORDER BY announcement_id DESC LIMIT 1`,
                [sub.subscription_id, targetChannelId]
            ) as any;
            const existingAnnouncementFromDb: AnnouncementData | null = existingAnnouncements[0] || null;

            await cleanupOldAnnouncements(client, sub.subscription_id, sub.guild_id, liveData.platform, sub.username, existingAnnouncementFromDb?.message_id || null);

            const sentMessage = await updateAnnouncement(
                client,
                {
                    streamer_id: sub.streamer_id,
                    username: sub.username,
                    guild_id: sub.guild_id,
                    profile_image_url: null,
                    custom_message: null,
                    override_nickname: null,
                    override_avatar_url: null,
                    discord_user_id: sub.discord_user_id || null
                },
                liveData,
                existingAnnouncementFromDb ? {
                    message_id: existingAnnouncementFromDb.message_id || '',
                    channel_id: existingAnnouncementFromDb.channel_id
                } : null,
                guildSettings as any,
                channelSettings as any,
                teamSettings as any,
                targetChannelId
            );

            if (sentMessage && sentMessage.id && targetChannelId) {
                const query = existingAnnouncementFromDb
                    ? "UPDATE announcements SET message_id = ?, stream_game = ?, stream_title = ?, stream_thumbnail_url = ? WHERE announcement_id = ?"
                    : "INSERT INTO announcements (subscription_id, streamer_id, guild_id, message_id, channel_id, stream_game, stream_title, platform, stream_thumbnail_url, stream_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
                const params = existingAnnouncementFromDb
                    ? [sentMessage.id, liveData.game || null, liveData.title || null, liveData.thumbnailUrl || null, existingAnnouncementFromDb.announcement_id]
                    : [sub.subscription_id, sub.streamer_id, sub.guild_id, sentMessage.id, targetChannelId, liveData.game || null, liveData.title || null, liveData.platform, liveData.thumbnailUrl || null, liveData.url || null];

                await db.execute(query, params);

                // Update live_announcements table for stream manager tracking
                await db.execute(
                    `INSERT INTO live_announcements (guild_id, platform, username, channel_id, message_id, streamer_id, discord_user_id, stream_started_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
                     ON DUPLICATE KEY UPDATE message_id = VALUES(message_id), updated_at = CURRENT_TIMESTAMP`,
                    [sub.guild_id, liveData.platform, sub.username, targetChannelId, sentMessage.id, sub.streamer_id, sub.discord_user_id || null]
                ).catch((error: any) => {
                    if (error.code !== 'ER_NO_SUCH_TABLE') {
                        logger.warn(`[Worker] Failed to update live_announcements table:`, { error: error.message });
                    }
                });

                const rolesToApply = [...new Set([
                    (guildSettings as GuildSettings)?.live_role_id,
                    (teamSettings as TeamSettings)?.live_role_id,
                    sub.live_role_id
                ].filter(Boolean))] as string[];

                if (rolesToApply.length > 0 && sub.discord_user_id) {
                    const guild: Guild | null = await client.guilds.fetch(sub.guild_id).catch(() => null);
                    if (guild) {
                        const member: GuildMember | null = await guild.members.fetch(sub.discord_user_id).catch(() => null);
                        if (member) await handleRole(member, rolesToApply, 'add', sub.guild_id);
                    }
                }
            }
        } catch (error: any) {
            logger.error(`[Worker] Job ${job.id} failed for ${sub.username}:`, { error: error.message, stack: error.stack, guildId: sub.guild_id });
            throw error;
        }
    }, { connection: redisOptions, concurrency: 10 });

    announcementWorker.on('error', (err: Error) => logger.error('[Announcement Worker] Worker error:', { error: err }));
    announcementWorker.on('completed', (job: Job<JobData>) => logger.info(`[Announcement Worker] Job ${job.id} has completed for ${job.data.sub.username}.`));
    announcementWorker.on('failed', (job: Job<JobData> | undefined, err: Error) => logger.error(`[Announcement Worker] Job ${job?.id} for ${job?.data?.sub?.username} has failed.`, { error: err }));

    return announcementWorker;
};
