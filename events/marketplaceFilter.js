/**
 * Marketplace Account Age Filter
 * Prevents new accounts from posting in marketplace channels
 */

import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import pool from '../utils/db.js';

// Minimum account age in days
const MIN_ACCOUNT_AGE_DAYS = 7;

// Marketplace channel keywords to match
const MARKETPLACE_KEYWORDS = ['marketplace', 'market', 'trading', 'buy-sell', 'for-sale', 'wtb', 'wts', 'seed-exchange'];

export default {
    name: 'messageCreate',
    async execute(message) {
        // Ignore bots and DMs
        if (message.author.bot || !message.guild) return;

        // Check if this is a marketplace channel
        const channelName = message.channel.name?.toLowerCase() || '';
        const isMarketplace = MARKETPLACE_KEYWORDS.some(keyword => channelName.includes(keyword));

        if (!isMarketplace) return;

        // Check if filter is enabled for this guild
        const [settings] = await pool.execute(
            'SELECT * FROM marketplace_settings WHERE guild_id = ?',
            [message.guild.id]
        ).catch(() => [[]]);

        // Default to enabled if no settings exist
        const filterEnabled = settings.length === 0 || settings[0]?.account_age_filter !== 0;
        const minAgeDays = settings[0]?.min_account_age_days || MIN_ACCOUNT_AGE_DAYS;
        const traderBypass = settings.length === 0 || settings[0]?.trader_role_bypass !== 0;

        if (!filterEnabled) return;

        // Check for Trader role bypass
        if (traderBypass) {
            const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
            if (member) {
                const hasTraderRole = member.roles.cache.some(r =>
                    r.name.toLowerCase().includes('trader') ||
                    r.name.toLowerCase().includes('trusted') ||
                    r.name.toLowerCase().includes('veteran') ||
                    r.name.toLowerCase().includes('elite')
                );
                if (hasTraderRole) return; // Bypass filter for established traders
            }
        }

        // Calculate account age
        const accountCreated = message.author.createdAt;
        const accountAgeDays = (Date.now() - accountCreated.getTime()) / (1000 * 60 * 60 * 24);

        if (accountAgeDays < minAgeDays) {
            // Delete the message
            await message.delete().catch(() => {});

            // Calculate when they can post
            const canPostDate = new Date(accountCreated.getTime() + (minAgeDays * 24 * 60 * 60 * 1000));
            const canPostTimestamp = Math.floor(canPostDate.getTime() / 1000);

            // Send warning to user
            const embed = new EmbedBuilder()
                .setColor(0xE74C3C)
                .setTitle('⚠️ Account Too New')
                .setDescription(`Your account must be at least **${minAgeDays} days old** to post in marketplace channels.`)
                .addFields(
                    { name: 'Account Created', value: `<t:${Math.floor(accountCreated.getTime() / 1000)}:R>`, inline: true },
                    { name: 'Can Post', value: `<t:${canPostTimestamp}:R>`, inline: true }
                )
                .setFooter({ text: 'This helps protect our community from scammers.' });

            try {
                await message.author.send({ embeds: [embed] });
            } catch {
                // Can't DM user, send ephemeral-like message in channel
                const warning = await message.channel.send({
                    content: `${message.author}, your account is too new to post here. Check your DMs or wait until your account is ${minAgeDays} days old.`
                });
                setTimeout(() => warning.delete().catch(() => {}), 10000);
            }

            // Log the action
            logger.info(`[MarketplaceFilter] Blocked message from new account`, {
                guildId: message.guild.id,
                userId: message.author.id,
                accountAgeDays: Math.floor(accountAgeDays),
                channelId: message.channel.id
            });

            // Log to mod-logs if exists
            const modLogChannel = message.guild.channels.cache.find(c =>
                c.name.includes('mod-log') || c.name.includes('modlog')
            );

            if (modLogChannel) {
                const logEmbed = new EmbedBuilder()
                    .setColor(0xF39C12)
                    .setTitle('🛡️ Marketplace Filter')
                    .setDescription(`Blocked message from new account in ${message.channel}`)
                    .addFields(
                        { name: 'User', value: `${message.author} (${message.author.tag})`, inline: true },
                        { name: 'Account Age', value: `${Math.floor(accountAgeDays)} days`, inline: true },
                        { name: 'Required', value: `${minAgeDays} days`, inline: true },
                        { name: 'Message Preview', value: message.content.substring(0, 200) || '*No text content*', inline: false }
                    )
                    .setTimestamp();

                await modLogChannel.send({ embeds: [logEmbed] }).catch(() => {});
            }
        }
    }
};
