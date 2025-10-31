import {
    Events,
    AttachmentBuilder,
    GuildMember,
    TextChannel,
    TextBasedChannel,
    NewsChannel,
    ThreadChannel,
    PrivateThreadChannel,
    PublicThreadChannel,
    VoiceChannel,
    StageChannel
} from 'discord.js';
import { RowDataPacket } from 'mysql2/promise';

// Default imports for TypeScript versions
import db from '../utils/db';
import logger from '../utils/logger';

// Import welcome banner generator
const { generateWelcomeBanner } = require('../core/welcome-banner');

// Define the WelcomeSettings interface extending RowDataPacket for MySQL results
interface WelcomeSettings extends RowDataPacket {
    channel_id: string | null;
    message: string | null;
    banner_enabled: boolean;
    banner_background_url: string | null;
}

// Define the message payload interface
interface MessagePayload {
    content: string;
    files?: AttachmentBuilder[];
}

// Define the event module interface
interface EventModule {
    name: string;
    once?: boolean;
    execute: (...args: any[]) => Promise<void>;
}

const guildMemberAddEvent: EventModule = {
    name: Events.GuildMemberAdd,
    once: false,

    async execute(member: GuildMember): Promise<void> {
        try {
            // Fetch welcome settings for this guild
            const [rows] = await db.execute<WelcomeSettings[]>(
                'SELECT channel_id, message, banner_enabled, banner_background_url FROM welcome_settings WHERE guild_id = ?',
                [member.guild.id]
            );

            // Check if settings exist and have a channel configured
            const settings = rows[0];
            if (!settings || !settings.channel_id) {
                // No welcome settings configured
                return;
            }

            // Fetch the channel and validate it's a text-based channel
            const channel = await member.guild.channels.fetch(settings.channel_id).catch(() => null);

            // Type guard to ensure the channel is text-based
            if (!channel || !channel.isTextBased()) {
                logger.warn(`[Welcome] Channel ${settings.channel_id} not found or not a text channel for guild ${member.guild.id}`);
                return;
            }

            // Prepare welcome message with placeholders
            let welcomeMessage: string = settings.message || 'Welcome {user} to {server}!';
            welcomeMessage = welcomeMessage
                .replace(/{user}/g, `<@${member.id}>`)
                .replace(/{server}/g, member.guild.name)
                .replace(/{member_count}/g, member.guild.memberCount.toString());

            // Initialize message payload
            const messagePayload: MessagePayload = {
                content: welcomeMessage
            };

            // Generate and attach banner if enabled
            if (settings.banner_enabled) {
                try {
                    // Generate the welcome banner
                    const bannerBuffer: Buffer = await generateWelcomeBanner(
                        member,
                        settings.banner_background_url
                    );

                    // Create attachment from buffer
                    const attachment = new AttachmentBuilder(bannerBuffer, {
                        name: 'welcome.png',
                        description: `Welcome banner for ${member.user.tag}`
                    });

                    // Add attachment to message payload
                    messagePayload.files = [attachment];

                    logger.info(`[Welcome] Generated banner for ${member.user.tag} in ${member.guild.name}`);
                } catch (error: unknown) {
                    // Log error but continue without banner
                    logger.error(`[Welcome] Failed to generate banner for ${member.user.tag}:`, error as Record<string, any>);
                    // Continue without banner if generation fails
                }
            }

            // Send welcome message to the channel
            // Cast to TextChannel since we know it's text-based from the check above
            await (channel as TextChannel).send(messagePayload);

            // Log successful welcome message
            logger.info(
                `[Welcome] Sent welcome message for ${member.user.tag} in ${member.guild.name} ` +
                `(banner: ${settings.banner_enabled ? 'enabled' : 'disabled'})`
            );

        } catch (error: unknown) {
            // Log any errors that occur during execution
            logger.error('[Welcome] Error in guildMemberAdd event:', error as Record<string, any>);
        }
    }
};

// Export using CommonJS for compatibility
module.exports = guildMemberAddEvent;
export default guildMemberAddEvent;