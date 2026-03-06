import { isStreamerLive, getStreamDetails } from './utils/platforms/trovo-api.js';
import pool from './utils/db.js';
import { Client, GatewayIntentBits } from 'discord.js';
import { updateAnnouncement } from './utils/announcer.js';
import dotenv from 'dotenv';

dotenv.config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once('ready', async () => {
    console.log('Bot ready! Forcing Trovo check...');

    try {
        const username = 'xXDeath420Xx';

        // Check if live
        const isLive = await isStreamerLive(username);
        console.log(`${username} is live: ${isLive}`);

        if (!isLive) {
            console.log('Not live, exiting...');
            await pool.end();
            client.destroy();
            process.exit(0);
            return;
        }

        // Get stream details
        const streamDetails = await getStreamDetails(username);
        console.log('Stream details:', streamDetails);

        // Get all Trovo subscriptions for this user
        const [subscriptions] = await pool.execute(
            `SELECT sub.subscription_id, sub.guild_id, sub.announcement_channel_id,
                    sub.delete_on_end, sub.override_nickname, sub.override_avatar_url,
                    sub.custom_message, s.streamer_id, s.discord_user_id, s.profile_image_url
             FROM subscriptions sub
             JOIN streamers s ON sub.streamer_id = s.streamer_id
             WHERE s.platform = 'trovo' AND s.username = ?`,
            [username]
        );

        console.log(`Found ${subscriptions.length} subscriptions`);

        for (const sub of subscriptions) {
            console.log(`\nProcessing subscription for guild ${sub.guild_id}, channel ${sub.announcement_channel_id}`);

            const channelId = sub.announcement_channel_id;
            if (!channelId) {
                console.log('No channel ID, skipping...');
                continue;
            }

            // Get the correct client for this guild
            let guildClient = client;
            if (global.botManager) {
                guildClient = global.botManager.getClientForGuild(sub.guild_id);
                if (!guildClient) {
                    console.log(`Could not get client for guild ${sub.guild_id}`);
                    continue;
                }
            }

            const subContext = {
                streamer_id: sub.streamer_id,
                username: username,
                guild_id: sub.guild_id,
                profile_image_url: streamDetails.profile_image_url || sub.profile_image_url,
                custom_message: sub.custom_message,
                override_nickname: sub.override_nickname,
                override_avatar_url: sub.override_avatar_url,
                discord_user_id: sub.discord_user_id
            };

            const liveData = {
                game: streamDetails.game_name,
                title: streamDetails.title,
                thumbnailUrl: streamDetails.thumbnail_url,
                platform: 'trovo',
                url: streamDetails.url,
                username: username,
                profileImageUrl: streamDetails.profile_image_url
            };

            // Create announcement
            const message = await updateAnnouncement(
                guildClient,
                subContext,
                liveData,
                null, // No existing announcement
                {}, // Guild settings
                null, // Channel settings
                null, // Team settings
                channelId
            );

            if (message && message.id) {
                console.log(`Created announcement: ${message.id}`);

                // Save to database
                await pool.execute(
                    `INSERT INTO live_announcements (guild_id, platform, username, channel_id, message_id, streamer_id, discord_user_id, stream_started_at, offline_check_count, delete_on_end)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                     ON DUPLICATE KEY UPDATE message_id = VALUES(message_id), stream_started_at = VALUES(stream_started_at), offline_check_count = 0, delete_on_end = VALUES(delete_on_end), updated_at = CURRENT_TIMESTAMP`,
                    [sub.guild_id, 'trovo', username, channelId, message.id, sub.streamer_id, sub.discord_user_id, new Date(), sub.delete_on_end ? 1 : 0]
                );

                console.log('Saved to database');
            }
        }

        console.log('\nDone!');
        await pool.end();
        client.destroy();
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        await pool.end();
        client.destroy();
        process.exit(1);
    }
});

client.login(process.env.DISCORD_TOKEN);
