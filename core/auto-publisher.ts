import { Message, ChannelType } from 'discord.js';
import db from '../utils/db';
import logger from '../utils/logger';
import { RowDataPacket } from 'mysql2/promise';

interface AutoPublisherConfig extends RowDataPacket {
    guild_id: string;
    is_enabled: boolean;
}

export async function handleNewMessage(message: Message): Promise<void> {
    if (message.channel.type !== ChannelType.GuildAnnouncement) {
        return; // Only act on announcement channels
    }

    if (message.author.bot) {
        return; // Don't try to publish messages from other bots
    }

    if (!message.guild) return;
    const guildId = message.guild.id;

    try {
        const [rows] = await db.execute<AutoPublisherConfig[]>(
            'SELECT is_enabled FROM auto_publisher_config WHERE guild_id = ?',
            [guildId]
        );
        const config = rows[0];

        if (config && config.is_enabled) {
            await message.crosspost();
            logger.info(`Automatically published message ${message.id} in channel ${message.channel.id}.`, { guildId, category: 'auto-publisher' });
        }
    } catch (error: unknown) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 50024) { // Cannot crosspost message
            logger.warn(`Failed to publish message ${message.id}. It may have already been published.`, { guildId, category: 'auto-publisher' });
        } else {
            logger.error(`Error processing message ${message.id}.`, { guildId, category: 'auto-publisher', error: error instanceof Error ? error.stack : error });
        }
    }
}
