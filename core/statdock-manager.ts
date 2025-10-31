import db from '../utils/db';
import logger from '../utils/logger';
import { Client, VoiceChannel, Guild } from 'discord.js';
import { RowDataPacket } from 'mysql2';

interface StatdockConfig extends RowDataPacket {
    guild_id: string;
    channel_id: string;
    template: string;
}

async function updateStatdocks(client: Client): Promise<void> {
    logger.info('[StatdockManager] Starting periodic update of statdock channels.', { category: 'statdocks' });
    try {
        const [configs] = await db.execute<StatdockConfig[]>('SELECT * FROM statdocks_config');
        if (configs.length === 0) return;

        // Group configs by guild to reduce fetching guild data repeatedly
        const guildsToUpdate = new Map<string, StatdockConfig[]>();
        for (const config of configs) {
            if (!guildsToUpdate.has(config.guild_id)) {
                guildsToUpdate.set(config.guild_id, []);
            }
            guildsToUpdate.get(config.guild_id)!.push(config);
        }

        for (const [guildId, guildConfigs] of guildsToUpdate.entries()) {
            const guild = await client.guilds.fetch(guildId).catch(() => null);
            if (!guild) {
                // Clean up configs for guilds the bot is no longer in
                await db.execute('DELETE FROM statdocks_config WHERE guild_id = ?', [guildId]);
                continue;
            }

            // Fetch stats for the guild once
            await guild.members.fetch(); // Ensure members are cached
            const memberCount = guild.memberCount;
            const botCount = guild.members.cache.filter(m => m.user.bot).size;
            const onlineCount = guild.members.cache.filter(m => !m.user.bot && m.presence?.status !== 'offline').size;

            for (const config of guildConfigs) {
                const channel = await guild.channels.fetch(config.channel_id).catch(() => null) as VoiceChannel | null;
                if (!channel) {
                    // Clean up config for a deleted channel
                    await db.execute('DELETE FROM statdocks_config WHERE channel_id = ?', [config.channel_id]);
                    continue;
                }

                const newName = config.template
                    .replace(/{members}/g, memberCount.toString())
                    .replace(/{online}/g, onlineCount.toString())
                    .replace(/{bots}/g, botCount.toString());

                if (channel.name !== newName) {
                    await channel.setName(newName, 'Updating statdock').catch(e => {
                        logger.warn(`Failed to update statdock channel ${channel.id} in guild ${guild.id}:`, e.message);
                    });
                }
            }
        }
    } catch (error: any) {
        if (error.code !== 'ER_NO_SUCH_TABLE') {
            logger.error('[StatdockManager] Error updating statdocks:', error as Record<string, any>);
        }
    }
    logger.info('[StatdockManager] Finished periodic statdock update.', { category: 'statdocks' });
}

export { updateStatdocks };
