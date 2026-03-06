import { EmbedBuilder } from 'discord.js';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import SteamAPIService from '../../../utils/services/steam-api.js';
import { triggerManualSteamWatchCheck } from '../../../jobs/steam-watch-scheduler.js';

const steamAPI = new SteamAPIService();

export async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
        case 'watch':
            return await handleWatch(interaction);
        case 'unwatch':
            return await handleUnwatch(interaction);
        case 'watchers':
            return await handleWatchers(interaction);
        case 'news':
            return await handleNews(interaction);
        case 'price':
            return await handlePrice(interaction);
        case 'search':
            return await handleSearch(interaction);
        case 'currency':
            return await handleCurrency(interaction);
        case 'check':
            return await handleCheck(interaction);
        case 'mentions':
            return await handleMentions(interaction);
    }
}

async function handleWatch(interaction) {
    await interaction.deferReply();

    const appQuery = interaction.options.getString('app');
    const watcherType = interaction.options.getString('type');
    const channel = interaction.options.getChannel('channel');
    const mentionRole = interaction.options.getRole('mention-role');
    let appId = appQuery;

    try {
        let appName = null;
        if (!['free_promotions', 'valve_news'].includes(watcherType)) {
            if (!/^\d+$/.test(appQuery)) {
                const searchResults = await steamAPI.searchApps(appQuery, 5);

                if (searchResults.length === 0) {
                    return interaction.editReply({
                        content: `❌ No Steam apps found matching "${appQuery}". Try searching with a more specific name or use the App ID.`
                    });
                }

                if (searchResults.length > 1) {
                    const resultsList = searchResults
                        .map((app, index) => `${index + 1}. **${app.name}** (ID: ${app.app_id})`)
                        .join('\n');

                    return interaction.editReply({
                        content: `❓ Multiple apps found for "${appQuery}". Please use the App ID for the one you want:\n\n${resultsList}\n\nExample: \`/media steam watch app:${searchResults[0].app_id}\``
                    });
                }

                appId = searchResults[0].app_id.toString();
                logger.info(`[Steam Watch] Resolved "${appQuery}" to app ID ${appId} (${searchResults[0].name})`);
            }

            const appDetails = await steamAPI.getAppDetails(appId);
            if (!appDetails) {
                return interaction.editReply({
                    content: `❌ Could not find Steam app "${appQuery}". Please verify the App ID is correct.`
                });
            }
            appName = appDetails.name;
        } else {
            appName = watcherType === 'free_promotions' ? 'Free Promotions' : 'Valve News';
        }

        const [[existing]] = await pool.execute(
            'SELECT id FROM steam_watchers WHERE guild_id = ? AND discord_channel_id = ? AND watcher_type = ? AND steam_id = ?',
            [interaction.guild.id, channel.id, watcherType, appId]
        );

        if (existing) {
            return interaction.editReply({
                content: `❌ A watcher already exists for this app/type combination in ${channel}.\n\nUse \`/media steam watchers\` to see all watchers or \`/media steam unwatch\` to remove it.`
            });
        }

        const mentionRoles = mentionRole ? JSON.stringify([mentionRole.id]) : null;

        await pool.execute(
            `INSERT INTO steam_watchers (
          guild_id, discord_channel_id, watcher_type, steam_id, steam_name,
          mention_role_ids, check_interval_minutes, is_enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
            [interaction.guild.id, channel.id, watcherType, appId, appName, mentionRoles, 30]
        );

        const typeNames = {
            'app_news': 'News Updates',
            'app_price': 'Price Changes',
            'app_workshop': 'Workshop Items',
            'free_promotions': 'Free Promotions',
            'valve_news': 'Valve News'
        };

        const embed = new EmbedBuilder()
            .setColor('#1B2838')
            .setTitle('✅ Steam Watcher Added')
            .setDescription(`Now watching **${appName}** for ${typeNames[watcherType]}`)
            .addFields(
                { name: 'Channel', value: `${channel}`, inline: true },
                { name: 'Type', value: typeNames[watcherType], inline: true },
                { name: 'App ID', value: appId, inline: true }
            )
            .setFooter({ text: 'Checks will start within 5 minutes. Use /media steam check for immediate check.' })
            .setTimestamp();

        if (mentionRole) {
            embed.addFields({ name: 'Mentions', value: `${mentionRole}`, inline: false });
        }

        await interaction.editReply({ embeds: [embed] });
        logger.info(`[Steam] Watcher created: ${watcherType}:${appId} in guild ${interaction.guild.id}`);

    } catch (error) {
        logger.error('[Steam Watch] Error:', { error: error.message, stack: error.stack });
        await interaction.editReply({ content: '❌ An error occurred while creating the watcher. Please try again.' });
    }
}

async function handleUnwatch(interaction) {
    await interaction.deferReply();

    const watcherId = interaction.options.getInteger('watcher-id');

    try {
        const [[watcher]] = await pool.execute(
            'SELECT * FROM steam_watchers WHERE id = ? AND guild_id = ?',
            [watcherId, interaction.guild.id]
        );

        if (!watcher) {
            return interaction.editReply({
                content: `❌ Watcher with ID \`${watcherId}\` not found in this server.\n\nUse \`/media steam watchers\` to see all watchers.`
            });
        }

        await pool.execute('DELETE FROM steam_watchers WHERE id = ?', [watcherId]);

        await interaction.editReply({
            content: `✅ Removed watcher for **${watcher.steam_name}** (${watcher.watcher_type}).`
        });

        logger.info(`[Steam] Watcher removed: ${watcherId} from guild ${interaction.guild.id}`);

    } catch (error) {
        logger.error('[Steam Unwatch] Error:', { error: error.message, stack: error.stack });
        await interaction.editReply({ content: '❌ An error occurred while removing the watcher. Please try again.' });
    }
}

async function handleWatchers(interaction) {
    await interaction.deferReply();

    const filterChannel = interaction.options.getChannel('channel');

    try {
        let query = 'SELECT * FROM steam_watchers WHERE guild_id = ?';
        const params = [interaction.guild.id];

        if (filterChannel) {
            query += ' AND discord_channel_id = ?';
            params.push(filterChannel.id);
        }

        query += ' ORDER BY created_at DESC';

        const [watchers] = await pool.execute(query, params);

        if (watchers.length === 0) {
            return interaction.editReply({
                content: '📋 No Steam watchers configured.\n\nUse `/media steam watch` to add one!'
            });
        }

        const embed = new EmbedBuilder()
            .setColor('#1B2838')
            .setTitle('🔍 Steam Watchers')
            .setDescription(`**${watchers.length}** watcher(s) configured`)
            .setTimestamp();

        const typeNames = {
            'app_news': '📰 News',
            'app_price': '💰 Price',
            'app_workshop': '🛠️ Workshop',
            'free_promotions': '🎉 Free Promos',
            'valve_news': '📢 Valve News'
        };

        for (const watcher of watchers.slice(0, 10)) {
            const channel = await interaction.guild.channels.fetch(watcher.discord_channel_id).catch(() => null);
            const channelMention = channel ? `<#${watcher.discord_channel_id}>` : '⚠️ Channel not found';

            let mentions = 'None';
            if (watcher.mention_role_ids) {
                try {
                    const roles = JSON.parse(watcher.mention_role_ids);
                    mentions = roles.map(id => `<@&${id}>`).join(', ');
                } catch (e) { /* Invalid JSON */ }
            }

            const status = watcher.is_enabled ? '✅ Enabled' : '❌ Disabled';
            const checkInterval = watcher.check_interval_minutes;
            const intervalText = checkInterval <= 5 ? '⚡ Fast' : checkInterval <= 30 ? '🕐 Normal' : '🐌 Slow';

            let fieldValue = `**ID:** ${watcher.id}\n`;
            fieldValue += `**Channel:** ${channelMention}\n`;
            fieldValue += `**Type:** ${typeNames[watcher.watcher_type] || watcher.watcher_type}\n`;
            fieldValue += `**Status:** ${status} | **Interval:** ${intervalText} (${checkInterval}m)\n`;
            fieldValue += `**Mentions:** ${mentions}`;

            embed.addFields({ name: `${watcher.steam_name || watcher.steam_id}`, value: fieldValue, inline: false });
        }

        if (watchers.length > 10) {
            embed.setFooter({ text: `Showing 10 of ${watchers.length} watchers` });
        }

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        logger.error('[Steam Watchers] Error:', { error: error.message, stack: error.stack });
        await interaction.editReply({ content: '❌ An error occurred while fetching watchers. Please try again.' });
    }
}

async function handleNews(interaction) {
    await interaction.deferReply();

    const appQuery = interaction.options.getString('app');
    let appId = appQuery;

    try {
        if (!/^\d+$/.test(appQuery)) {
            const searchResults = await steamAPI.searchApps(appQuery, 5);

            if (searchResults.length === 0) {
                return interaction.editReply({
                    content: `❌ No Steam apps found matching "${appQuery}". Try searching with a more specific name or use the App ID.`
                });
            }

            if (searchResults.length > 1) {
                const resultsList = searchResults
                    .map((app, index) => `${index + 1}. **${app.name}** (ID: ${app.app_id})`)
                    .join('\n');

                return interaction.editReply({
                    content: `❓ Multiple apps found for "${appQuery}". Please use the App ID for the one you want:\n\n${resultsList}\n\nExample: \`/media steam news app:${searchResults[0].app_id}\``
                });
            }

            appId = searchResults[0].app_id.toString();
            logger.info(`[Steam News] Resolved "${appQuery}" to app ID ${appId} (${searchResults[0].name})`);
        }

        const news = await steamAPI.getAppNews(appId, 1);

        if (news.length === 0) {
            return interaction.editReply({ content: `❌ No news found for app "${appQuery}".` });
        }

        const latestNews = news[0];

        let content = latestNews.contents || '';

        // Handle HTML tags
        content = content
            .replace(/<br\s*\/?>/gi, '\n').replace(/<p>/gi, '\n').replace(/<\/p>/gi, '\n')
            .replace(/<li>/gi, '• ').replace(/<\/li>/gi, '\n')
            .replace(/<ul>/gi, '').replace(/<\/ul>/gi, '')
            .replace(/<ol>/gi, '').replace(/<\/ol>/gi, '')
            .replace(/<[^>]*>/g, '');

        // Handle BBCode tags
        content = content
            .replace(/\[b\]/gi, '**').replace(/\[\/b\]/gi, '**')
            .replace(/\[i\]/gi, '').replace(/\[\/i\]/gi, '')
            .replace(/\[u\]/gi, '').replace(/\[\/u\]/gi, '')
            .replace(/\[strike\]/gi, '~~').replace(/\[\/strike\]/gi, '~~')
            .replace(/\[h[123]\]/gi, '\n').replace(/\[\/h[123]\]/gi, '\n')
            .replace(/\[list\]/gi, '\n').replace(/\[\/list\]/gi, '\n')
            .replace(/\[\*\]/gi, '• ')
            .replace(/\[hr\]\[\/hr\]/gi, '\n')
            .replace(/\[url=([^\]]+)\]([^\[]+)\[\/url\]/gi, '$2')
            .replace(/\[url\]([^\[]+)\[\/url\]/gi, '$1')
            .replace(/\[img\]([^\[]+)\[\/img\]/gi, '')
            .replace(/\[quote\]/gi, '').replace(/\[\/quote\]/gi, '')
            .replace(/\[code\]/gi, '').replace(/\[\/code\]/gi, '')
            .replace(/\[previewyoutube=[^\]]+\]\[\/previewyoutube\]/gi, '')
            .replace(/\[[^\]]+\]/g, '');

        // Handle HTML entities
        content = content
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        let message = `**${latestNews.title}**\n\n`;

        if (content) {
            const maxContentLength = 1800 - latestNews.title.length - latestNews.url.length;
            if (content.length > maxContentLength) {
                content = content.substring(0, maxContentLength - 3) + '...';
            }
            message += `${content}\n\n`;
        }

        message += latestNews.url;

        await interaction.editReply({ content: message });

    } catch (error) {
        logger.error('[Steam News] Error:', { error: error.message, stack: error.stack });
        await interaction.editReply({ content: '❌ An error occurred while fetching news. Please try again.' });
    }
}

async function handlePrice(interaction) {
    await interaction.deferReply();

    const appQuery = interaction.options.getString('app');
    let appId = appQuery;

    try {
        if (!/^\d+$/.test(appQuery)) {
            const searchResults = await steamAPI.searchApps(appQuery, 5);

            if (searchResults.length === 0) {
                return interaction.editReply({
                    content: `❌ No Steam apps found matching "${appQuery}". Try searching with a more specific name or use the App ID.`
                });
            }

            if (searchResults.length > 1) {
                const resultsList = searchResults
                    .map((app, index) => `${index + 1}. **${app.name}** (ID: ${app.app_id})`)
                    .join('\n');

                return interaction.editReply({
                    content: `❓ Multiple apps found for "${appQuery}". Please use the App ID for the one you want:\n\n${resultsList}\n\nExample: \`/media steam price app:${searchResults[0].app_id}\``
                });
            }

            appId = searchResults[0].app_id.toString();
            logger.info(`[Steam Price] Resolved "${appQuery}" to app ID ${appId} (${searchResults[0].name})`);
        }

        const [[settings]] = await pool.execute(
            'SELECT currency FROM steam_guild_settings WHERE guild_id = ?',
            [interaction.guild.id]
        );

        const currency = settings?.currency || 'us';
        const price = await steamAPI.getAppPrice(appId, currency);
        const appDetails = await steamAPI.getAppDetails(appId, currency);

        if (!appDetails) {
            return interaction.editReply({ content: `❌ Could not find app "${appQuery}".` });
        }

        const embed = new EmbedBuilder()
            .setColor(price.discount_percent > 0 ? '#4CAF50' : '#1B2838')
            .setTitle(`💰 ${appDetails.name}`)
            .setURL(`https://store.steampowered.com/app/${appId}`)
            .setTimestamp();

        if (appDetails.header_image) {
            embed.setThumbnail(appDetails.header_image);
        }

        if (price.is_free) {
            embed.addFields({ name: 'Price', value: '**FREE**', inline: true });
        } else if (price.discount_percent > 0) {
            embed.addFields(
                { name: 'Discount', value: `**${price.discount_percent}% OFF**`, inline: true },
                { name: 'Original Price', value: `~~${steamAPI.constructor.prototype.formatPrice.call(steamAPI, price.initial, price.currency)}~~`, inline: true },
                { name: 'Sale Price', value: `**${price.formatted}**`, inline: true }
            );
        } else {
            embed.addFields({ name: 'Price', value: price.formatted || 'Not available', inline: true });
        }

        if (appDetails.short_description) {
            embed.setDescription(appDetails.short_description.substring(0, 300));
        }

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        logger.error('[Steam Price] Error:', { error: error.message, stack: error.stack });
        await interaction.editReply({ content: '❌ An error occurred while fetching price. Please try again.' });
    }
}

async function handleSearch(interaction) {
    await interaction.deferReply();

    const query = interaction.options.getString('query');

    try {
        const results = await steamAPI.searchApps(query, 10);

        if (results.length === 0) {
            return interaction.editReply({ content: `❌ No results found for \`${query}\`.` });
        }

        const embed = new EmbedBuilder()
            .setColor('#1B2838')
            .setTitle(`🔍 Search Results: ${query}`)
            .setDescription(`Found ${results.length} result(s)`)
            .setTimestamp();

        for (const app of results.slice(0, 10)) {
            let value = `**App ID:** ${app.app_id}\n**Type:** ${app.type}`;

            if (app.price) {
                if (app.price.discount_percent > 0) {
                    value += `\n**Price:** ~~${(app.price.initial / 100).toFixed(2)}~~ **${(app.price.final / 100).toFixed(2)}** (${app.price.discount_percent}% off)`;
                } else {
                    value += `\n**Price:** ${(app.price.final / 100).toFixed(2)} ${app.price.currency}`;
                }
            }

            embed.addFields({ name: app.name, value, inline: false });
        }

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        logger.error('[Steam Search] Error:', { error: error.message, stack: error.stack });
        await interaction.editReply({ content: '❌ An error occurred while searching. Please try again.' });
    }
}

async function handleCurrency(interaction) {
    await interaction.deferReply();

    const currency = interaction.options.getString('currency');

    try {
        await pool.execute(
            `INSERT INTO steam_guild_settings (guild_id, currency)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE currency = VALUES(currency)`,
            [interaction.guild.id, currency]
        );

        const currencyNames = {
            'us': 'USD (United States)', 'eu': 'EUR (Europe)',
            'uk': 'GBP (United Kingdom)', 'ca': 'CAD (Canada)',
            'au': 'AUD (Australia)', 'jp': 'JPY (Japan)',
            'ru': 'RUB (Russia)', 'br': 'BRL (Brazil)'
        };

        await interaction.editReply({
            content: `✅ Currency preference set to **${currencyNames[currency]}** for this server.`
        });

        logger.info(`[Steam] Currency set to ${currency} for guild ${interaction.guild.id}`);

    } catch (error) {
        logger.error('[Steam Currency] Error:', { error: error.message, stack: error.stack });
        await interaction.editReply({ content: '❌ An error occurred while setting currency. Please try again.' });
    }
}

async function handleCheck(interaction) {
    await interaction.deferReply();

    try {
        await interaction.editReply('🔍 Checking all Steam watchers...');
        await triggerManualSteamWatchCheck();
        await interaction.editReply('✅ Steam Watch check complete! Any new updates will be posted shortly.');

    } catch (error) {
        logger.error('[Steam Check] Error:', { error: error.message, stack: error.stack });
        await interaction.editReply({ content: '❌ An error occurred while checking watchers. Please try again.' });
    }
}

async function handleMentions(interaction) {
    await interaction.deferReply();

    const watcherId = interaction.options.getInteger('watcher-id');
    const addRole = interaction.options.getRole('add-role');
    const addUser = interaction.options.getUser('add-user');
    const clearAll = interaction.options.getBoolean('clear-all');

    try {
        const [[watcher]] = await pool.execute(
            'SELECT * FROM steam_watchers WHERE id = ? AND guild_id = ?',
            [watcherId, interaction.guild.id]
        );

        if (!watcher) {
            return interaction.editReply({
                content: `❌ Watcher with ID \`${watcherId}\` not found in this server.`
            });
        }

        if (clearAll) {
            await pool.execute(
                'UPDATE steam_watchers SET mention_role_ids = NULL, mention_user_ids = NULL WHERE id = ?',
                [watcherId]
            );
            return interaction.editReply({
                content: `✅ Cleared all mentions for watcher **${watcher.steam_name}**.`
            });
        }

        if (addRole) {
            const currentRoles = watcher.mention_role_ids ? JSON.parse(watcher.mention_role_ids) : [];
            if (!currentRoles.includes(addRole.id)) {
                currentRoles.push(addRole.id);
            }

            await pool.execute(
                'UPDATE steam_watchers SET mention_role_ids = ? WHERE id = ?',
                [JSON.stringify(currentRoles), watcherId]
            );

            return interaction.editReply({
                content: `✅ Added ${addRole} to mentions for watcher **${watcher.steam_name}**.`
            });
        }

        if (addUser) {
            const currentUsers = watcher.mention_user_ids ? JSON.parse(watcher.mention_user_ids) : [];
            if (!currentUsers.includes(addUser.id)) {
                currentUsers.push(addUser.id);
            }

            await pool.execute(
                'UPDATE steam_watchers SET mention_user_ids = ? WHERE id = ?',
                [JSON.stringify(currentUsers), watcherId]
            );

            return interaction.editReply({
                content: `✅ Added ${addUser} to mentions for watcher **${watcher.steam_name}**.`
            });
        }

        return interaction.editReply({
            content: '❌ Please specify either a role to add, a user to add, or clear-all.'
        });

    } catch (error) {
        logger.error('[Steam Mentions] Error:', { error: error.message, stack: error.stack });
        await interaction.editReply({ content: '❌ An error occurred while updating mentions. Please try again.' });
    }
}
