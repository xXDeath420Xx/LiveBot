import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { sendLogEmbed, saveAuditLog } from '../core/log-manager.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';

export default {
    name: Events.ChannelPinsUpdate,
    async execute(channel, time) {
        try {
            if (!channel.guild) return;
            // discord.js 14 emits Date.parse(last_pin_timestamp) — epoch ms, not a Date — and null
            // when the last pin was removed. Accept either so the log line never throws.
            const lastPin = time == null ? null : new Date(time);
            const lastPinValid = lastPin !== null && !Number.isNaN(lastPin.getTime());

            if (channel.client.isDefaultBot && await shouldIgnoreGuild(channel.guild.id)) return;

            logger.info(`[Pins] Pins updated in #${channel.name}`, {
                guildId: channel.guild.id,
                channelId: channel.id,
                category: 'channelPins'
            });

            const embed = new EmbedBuilder()
                .setColor(0xFEE75C)
                .setTitle('📌 Channel Pins Updated')
                .setDescription(`Pins were modified in ${channel}`)
                .addFields(
                    { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: true },
                    { name: 'Last Pin At', value: lastPinValid ? `<t:${Math.floor(lastPin.getTime() / 1000)}:F>` : 'Unknown', inline: true }
                )
                .setTimestamp();

            await sendLogEmbed(channel.guild, 'channelPinsUpdate', embed, 'channelPinsUpdate', { channel });

            await saveAuditLog(
                channel.guild.id,
                'CHANNEL_PINS_UPDATE',
                null,
                channel.id,
                null,
                channel.id,
                'Pins updated',
                null,
                null,
                null,
                { lastPinAt: lastPinValid ? lastPin.toISOString() : null }
            );
        } catch (error) {
            logger.error('[Pins] Error logging pins update:', { error: error.message });
        }
    }
};
