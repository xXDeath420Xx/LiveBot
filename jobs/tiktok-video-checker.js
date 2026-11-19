import cron from 'node-cron';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';
import { getUserVideos, downloadTikTokVideo } from '../utils/platforms/tiktok.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js';

let schedulerTask = null;

/**
 * Check for new TikTok videos and announce them
 */
async function checkTikTokVideos(client) {
    try {
        logger.info('[TikTok Video Checker] Starting video check cycle');

        // Get all TikTok streamers with video notifications enabled
        const [subscriptions] = await pool.execute(`
            SELECT DISTINCT s.streamer_id, s.username, s.profile_image_url, s.platform,
                   sub.subscription_id,
                   sub.guild_id, sub.announcement_channel_id AS video_announcement_channel_id,
                   sub.tiktok_vod_notifications AS notify_videos,
                   sub.custom_message, sub.tiktok_embed_video, sub.ping_role_id,
                   sub.feed_posted_from
            FROM streamers s
            JOIN subscriptions sub ON s.streamer_id = sub.streamer_id
            WHERE s.platform = 'tiktok'
            AND sub.tiktok_vod_notifications = 1
            AND sub.announcement_channel_id IS NOT NULL
            -- Skip subscriptions paused by the leveling gate or by streamer-departure. Without
            -- this, somebody who left the server still gets their TikTok VODs posted in it.
            AND sub.paused = 0
        `);

        if (subscriptions.length === 0) {
            logger.info('[TikTok Video Checker] No TikTok video subscriptions found');
            return;
        }

        logger.info(`[TikTok Video Checker] Checking ${subscriptions.length} TikTok users for new videos`);

        // Group subscriptions by streamer to avoid duplicate API calls
        const streamerMap = new Map();
        for (const sub of subscriptions) {
            if (!streamerMap.has(sub.streamer_id)) {
                streamerMap.set(sub.streamer_id, {
                    ...sub,
                    subscriptions: []
                });
            }
            streamerMap.get(sub.streamer_id).subscriptions.push(sub);
        }

        // Check streamers in parallel batches of 3 for faster processing
        const streamers = Array.from(streamerMap.values());
        const BATCH_SIZE = 3;

        for (let i = 0; i < streamers.length; i += BATCH_SIZE) {
            const batch = streamers.slice(i, i + BATCH_SIZE);

            await Promise.all(batch.map(async (streamerData) => {
                try {
                    await checkStreamerVideos(client, streamerData);
                } catch (error) {
                    logger.error(`[TikTok Video Checker] Error checking ${streamerData.username}:`, {
                        error: error.message,
                        streamer: streamerData.username
                    });
                }
            }));

            // Small delay between batches to avoid rate limits
            if (i + BATCH_SIZE < streamers.length) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        logger.info('[TikTok Video Checker] Video check cycle complete');
    } catch (error) {
        logger.error('[TikTok Video Checker] Error in video check cycle:', {
            error: error.message,
            stack: error.stack
        });
    }
}

/**
 * Check a specific streamer for new videos
 */
async function checkStreamerVideos(client, streamerData) {
    const { streamer_id, username, profile_image_url, subscriptions } = streamerData;

    logger.info(`[TikTok Video Checker] Checking ${username} for new videos`);

    // Fetch recent videos from TikTok (check last 15 to catch up on any missed)
    const videos = await getUserVideos(username, 15);

    if (videos.length === 0) {
        logger.info(`[TikTok Video Checker] No videos found for ${username}`);
        return;
    }

    // Get fresh avatar from video data (TikWM returns author.avatar)
    let freshAvatarUrl = profile_image_url;
    const firstVideoWithAvatar = videos.find(v => v.author?.avatar);
    if (firstVideoWithAvatar?.author?.avatar) {
        freshAvatarUrl = firstVideoWithAvatar.author.avatar;

        // Update the database with fresh avatar if it changed
        if (freshAvatarUrl !== profile_image_url) {
            try {
                await pool.execute(
                    'UPDATE streamers SET profile_image_url = ? WHERE streamer_id = ?',
                    [freshAvatarUrl, streamer_id]
                );
                logger.info(`[TikTok Video Checker] Updated avatar for ${username}: ${freshAvatarUrl}`);
            } catch (dbError) {
                logger.warn(`[TikTok Video Checker] Failed to update avatar for ${username}:`, {
                    error: dbError.message
                });
            }
        }
    }

    // Check which videos are new (not in database)
    for (const video of videos) {
        try {
            // Check if video already announced (by video_id OR by URL to catch duplicate IDs)
            const [[existing]] = await pool.execute(
                'SELECT id FROM tiktok_video_posts WHERE video_id = ? OR video_url = ?',
                [video.video_id, video.url || null]
            );

            if (existing) {
                continue; // Video already announced
            }

            // This is a new video - save it and announce to all subscribed guilds
            // Convert ISO datetime to MySQL format
            let postedAtMysql = null;
            if (video.posted_at) {
                const date = new Date(video.posted_at);
                if (!isNaN(date.getTime())) {
                    postedAtMysql = date.toISOString().slice(0, 19).replace('T', ' ');
                }
            }

            // Second line of defence: even with no watermark, never backfill.
            if (video.posted_at) {
                const videoAge = Date.now() - new Date(video.posted_at).getTime();
                if (videoAge > 24 * 60 * 60 * 1000) {
                    // Still save to DB so we don't re-check, but don't announce
                    await pool.execute(`
                        INSERT INTO tiktok_video_posts
                        (streamer_id, video_id, video_url, title, description, thumbnail_url,
                         view_count, like_count, share_count, comment_count, posted_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [streamer_id, video.video_id, video.url || null, (video.title || '').substring(0, 500),
                        (video.description || '').substring(0, 2000), video.thumbnail || null,
                        // Same fields as the insert below (utils/platforms/tiktok.js returns view_count etc.; the old
                        // views/likes/shares/comments names do not exist, so these rows were saved with zeros).
                        video.view_count ?? 0, video.like_count ?? 0, video.share_count ?? 0, video.comment_count ?? 0, postedAtMysql]);
                    logger.info(`[TikTok Video Checker] Skipping old video ${video.video_id} from ${username} (${Math.round(videoAge / 3600000)}h old)`);
                    continue;
                }
            }

            await pool.execute(`
                INSERT INTO tiktok_video_posts
                (streamer_id, video_id, video_url, title, description, thumbnail_url,
                 view_count, like_count, share_count, comment_count, posted_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                streamer_id,
                video.video_id,
                video.url || null,
                (video.title || 'Untitled').substring(0, 255),
                video.description || null,
                video.thumbnail || null,
                video.view_count ?? 0,
                video.like_count ?? 0,
                video.share_count ?? 0,
                video.comment_count ?? 0,
                postedAtMysql
            ]);

            logger.info(`[TikTok Video Checker] New video from ${username}: ${video.video_id}`);

            // Announce to all subscribed guilds - use fresh avatar
            for (const sub of subscriptions) {
                try {
                    // The watermark, checked per guild because each one switched the feed
                    // on at its own moment. Nothing that already existed at that instant is
                    // ever announced there — stricter than the 24-hour rule above, which
                    // would still let through a video posted twenty-three hours ago.
                    if (sub.feed_posted_from && video.posted_at
                        && new Date(video.posted_at) <= new Date(sub.feed_posted_from)) {
                        logger.info(`[TikTok Video Checker] ${video.video_id} predates guild ${sub.guild_id}'s watermark — not announced there`);
                        continue;
                    }
                    await announceVideo(client, sub, video, username, freshAvatarUrl);
                } catch (error) {
                    logger.error(`[TikTok Video Checker] Failed to announce video to guild ${sub.guild_id}:`, {
                        error: error.message
                    });
                }
            }
        } catch (error) {
            logger.error(`[TikTok Video Checker] Error processing video ${video.video_id}:`, {
                error: error.message
            });
        }
    }
}

/**
 * Announce a new video to a guild
 */
async function announceVideo(client, subscription, video, username, profileImageUrl) {
    const { guild_id, video_announcement_channel_id, custom_message, tiktok_embed_video, ping_role_id } = subscription;
    const embedVideo = tiktok_embed_video !== 0; // Default true

    let guild = null;
    let announcingClient = client;

    // Try current client first
    guild = client.guilds.cache.get(guild_id);

    // If not found, search through all bot clients (including custom bots)
    if (!guild && global.botManager?.clients) {
        for (const [botId, botClient] of global.botManager.clients.entries()) {
            const foundGuild = botClient.guilds.cache.get(guild_id);
            if (foundGuild) {
                guild = foundGuild;
                announcingClient = botClient;
                logger.info(`[TikTok Video Checker] Found guild ${guild_id} in bot ${botId}`);
                break;
            }
        }
    }

    if (!guild) {
        logger.warn(`[TikTok Video Checker] Guild ${guild_id} not found in any bot client`);
        return;
    }

    /* One account, two audiences. Her TikTok carries Fortnite clips and her dog,
       and they belong in different rooms. A caption route diverts the posts that
       match its terms and leaves everything else on the subscription's channel. */
    let destinationId = video_announcement_channel_id;
    try {
        const [routes] = await pool.execute(
            'SELECT match_terms, channel_id, label FROM feed_caption_routes WHERE subscription_id = ? AND enabled = 1',
            [subscription.subscription_id]);
        if (routes.length) {
            const hay = `${video.description || ''}`.toLowerCase();
            for (const route of routes) {
                const terms = JSON.parse(route.match_terms || '[]');
                // Whole-word match: "ellie" must not fire on "intelligence".
                const hit = terms.find((t) => {
                    const term = String(t).toLowerCase().trim();
                    if (!term) return false;
                    if (term.startsWith('#')) return hay.includes(term);
                    return new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(hay);
                });
                if (hit) {
                    destinationId = route.channel_id;
                    logger.info(`[TikTok Video Checker] ${video.video_id} -> ${route.label || route.channel_id} (matched "${hit}")`);
                    break;
                }
            }
        }
    } catch (e) {
        // A routing fault must never swallow the post — fall back to the default room.
        logger.error(`[TikTok Video Checker] caption routing failed: ${e.message}`);
    }

    const channel = guild.channels.cache.get(destinationId);
    if (!channel) {
        logger.warn(`[TikTok Video Checker] Channel ${destinationId} not found in guild ${guild_id}`);
        return;
    }

    // Build video caption/description
    let caption = video.description || '';

    // Truncate caption if too long
    if (caption.length > 500) {
        caption = caption.substring(0, 497) + '...';
    }

    // Build ping content from custom_message — placed as message content (not inside embed)
    // Escape Discord markdown in dynamic values to prevent formatting issues (e.g. kateooo_ losing the underscore)
    const escMd = str => str.replace(/([_*~`|\\])/g, '\\$1');
    let pingContent = '';
    if (custom_message) {
        pingContent = custom_message
            .replace(/{username}/g, escMd(username))
            .replace(/{streamer}/g, escMd(username))
            .replace(/{url}/g, video.url || '')
            .replace(/{title}/g, escMd(video.title || ''))
            .replace(/{description}/g, escMd(caption || ''))
            .replace(/{everyone}/g, '@everyone')
            .replace(/{here}/g, '@here')
            .trim();
    }

    // Prepend ping role mention if configured
    if (ping_role_id) {
        const mention = ping_role_id === 'everyone' ? '@everyone' : `<@&${ping_role_id}>`;
        pingContent = pingContent ? `${mention} ${pingContent}` : mention;
    }

    let embedDescription = caption || 'Check out this new TikTok!';

    // Create FreshTok-style embed
    const embed = new EmbedBuilder()
        .setColor('#5865F2') // Discord blurple to match FreshTok style
        .setTitle(`${username} uploaded a new TikTok!`)
        .setDescription(embedDescription)
        .setThumbnail(video.thumbnail || profileImageUrl) // Thumbnail on right side like FreshTok
        .setTimestamp();

    // Create "View on TikTok" button (matching FreshTok style)
    const viewButton = new ButtonBuilder()
        .setLabel('View on TikTok')
        .setStyle(ButtonStyle.Link)
        .setURL(video.url);

    // Create "View Analytics" button linking to our analytics page
    const analyticsButton = new ButtonBuilder()
        .setLabel('View Analytics')
        .setStyle(ButtonStyle.Link)
        .setURL(`https://certifriedmultitool.com/analytics/${username}`);

    const row = new ActionRowBuilder().addComponents(viewButton, analyticsButton);

    // Build message payload
    const messagePayload = {
        content: pingContent || undefined,
        embeds: [embed],
        components: [row]
    };

    if (embedVideo) {
        // Download and attach the video file
        const videoFile = await downloadTikTokVideo(video.url);

        if (videoFile && videoFile.buffer) {
            const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB default Discord limit

            if (videoFile.size <= MAX_FILE_SIZE) {
                const attachment = new AttachmentBuilder(videoFile.buffer, {
                    name: `${username}_${video.video_id}.mp4`
                });
                messagePayload.files = [attachment];
                logger.info(`[TikTok Video Checker] Uploading video file for ${username} (${(videoFile.size / 1024 / 1024).toFixed(2)}MB)`);
            } else {
                logger.warn(`[TikTok Video Checker] Video too large (${(videoFile.size / 1024 / 1024).toFixed(2)}MB), using URL instead`);
                messagePayload.content = (messagePayload.content ? messagePayload.content + '\n' : '') + video.url;
            }
        } else {
            logger.warn(`[TikTok Video Checker] Failed to download video, using URL instead`);
            messagePayload.content = (messagePayload.content ? messagePayload.content + '\n' : '') + video.url;
        }
    } else {
        // Link only — include TikTok URL in message content (no video download)
        messagePayload.content = (messagePayload.content ? messagePayload.content + '\n' : '') + video.url;
        logger.info(`[TikTok Video Checker] Link-only mode for ${username} in guild ${guild_id}`);
    }

    // Send single message with video + embed + button
    await channel.send(messagePayload);

    logger.info(`[TikTok Video Checker] Announced video ${video.video_id} to guild ${guild_id}`);
}

/**
 * Format large numbers (1000 -> 1K, 1000000 -> 1M)
 */
function formatNumber(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
}

/**
 * Start the TikTok video checker scheduler
 * Runs every 2 minutes to check for new videos
 * Runs ONCE globally - announceVideo finds the correct bot for each guild
 */
export function startTikTokVideoChecker(client) {
    if (schedulerTask) {
        logger.debug('[TikTok Video Checker] Scheduler already running'); // expected: index.js calls this again once custom bots load
        return;
    }

    // Run every 5 minutes (yt-dlp primary method takes ~10s per user)
    schedulerTask = cron.schedule('*/5 * * * *', async () => {
        logger.info('[TikTok Video Checker] Running scheduled video check');

        // Use any available client - announceVideo will find correct bot per guild
        const defaultClient = global.botManager?.getDefaultClient() || client;
        if (defaultClient) {
            try {
                await checkTikTokVideos(defaultClient);
            } catch (error) {
                logger.error('[TikTok Video Checker] Error in scheduled check:', {
                    error: error.message,
                    stack: error.stack
                });
            }
        }
    });

    logger.info('[TikTok Video Checker] Scheduler started (every 5 minutes)');

    // Run initial check after 30 seconds - only ONCE
    setTimeout(async () => {
        const defaultClient = global.botManager?.getDefaultClient() || client;
        if (defaultClient) {
            checkTikTokVideos(defaultClient).catch(error => {
                logger.error('[TikTok Video Checker] Error in initial check:', { error: error.message });
            });
        }
    }, 30000);
}

/**
 * Stop the TikTok video checker scheduler
 */
export function stopTikTokVideoChecker() {
    if (schedulerTask) {
        schedulerTask.stop();
        schedulerTask = null;
        logger.info('[TikTok Video Checker] Scheduler stopped');
    }
}

export default { startTikTokVideoChecker, stopTikTokVideoChecker };
