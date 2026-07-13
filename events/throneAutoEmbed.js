import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import Colors from '../utils/colors.js';
import { getCachedProfile, getCachedWishlist, cacheProfileAndWishlist } from '../core/throne-manager.js';

export default {
    name: 'messageCreate',
    async execute(message) {
        if (message.author.bot || !message.guild) return;

        // Quick regex check before any DB queries
        const throneMatch = message.content.match(/https?:\/\/throne\.com\/([a-zA-Z0-9_]+)(?:\/item\/([a-zA-Z0-9-]+))?/);
        if (!throneMatch) return;

        const [, username, itemId] = throneMatch;

        try {
            // Check if auto-embed is enabled for this guild
            const [settings] = await pool.execute(
                'SELECT auto_embed_links FROM throne_guild_settings WHERE guild_id = ?',
                [message.guild.id]
            );
            if (!settings[0]?.auto_embed_links) return;

            // Get or fetch profile
            let profile = await getCachedProfile(username.toLowerCase());
            if (!profile || profile.fetchStatus !== 'ok') {
                try {
                    await cacheProfileAndWishlist(username.toLowerCase());
                    profile = await getCachedProfile(username.toLowerCase());
                } catch { return; } // Silently fail for auto-embed
            }
            if (!profile || profile.fetchStatus !== 'ok') return;

            if (itemId) {
                // Item-specific link — show item details
                const items = await getCachedWishlist(username.toLowerCase());
                const item = items.find(i => i.id === itemId);

                if (item) {
                    const embed = new EmbedBuilder()
                        .setColor(Colors.THRONE)
                        .setAuthor({ name: profile.displayName, iconURL: profile.pictureUrl || undefined, url: profile.profileUrl })
                        .setTitle(item.name.substring(0, 256))
                        .setURL(`https://throne.com/${username.toLowerCase()}/item/${itemId}`)
                        .addFields({ name: 'Price', value: item.priceFormatted || 'N/A', inline: true });

                    if (item.totalContributionFormatted && item.totalContributionFormatted !== item.priceFormatted) {
                        embed.addFields({ name: 'Total to Gift', value: item.totalContributionFormatted, inline: true });
                    }

                    const status = item.notInStock ? '🔴 Out of Stock' : item.isAvailable ? '🟢 Available' : '🟡 Limited';
                    embed.addFields({ name: 'Status', value: status, inline: true });

                    if (item.isCrowdfunded && item.fundingPercentage > 0) {
                        const pct = item.fundingPercentage;
                        const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
                        embed.addFields({ name: 'Crowdfund', value: `${bar} **${pct}%** funded`, inline: false });
                    }

                    if (item.imageUrl) embed.setThumbnail(item.imageUrl);

                    await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
                }
            } else {
                // Profile link — show profile summary
                const items = await getCachedWishlist(username.toLowerCase());
                const embed = new EmbedBuilder()
                    .setColor(Colors.THRONE)
                    .setTitle(profile.displayName)
                    .setURL(profile.profileUrl)
                    .setDescription(profile.bio?.substring(0, 200) || null)
                    .addFields(
                        { name: 'Wishlist Items', value: `${items.length}`, inline: true },
                        { name: 'Platform', value: profile.mainContentPlatform || 'N/A', inline: true },
                    )
                    .setTimestamp();

                if (profile.pictureUrl) embed.setThumbnail(profile.pictureUrl);
                if (profile.socialLinks?.length > 0) {
                    const socials = profile.socialLinks.map(l => l.url ? `[${l.type}](${l.url})` : l.type).join(' | ');
                    embed.addFields({ name: 'Socials', value: socials, inline: false });
                }

                await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } });
            }
        } catch (error) {
            logger.error('[ThroneAutoEmbed] Error', { error: error.message, guild: message.guild.id });
        }
    }
};
