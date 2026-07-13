import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import Colors from '../../utils/colors.js';
import { getCachedProfile, getCachedWishlist, queueProfileFetch, cacheProfileAndWishlist, refreshWishlistIfStale } from '../../core/throne-manager.js';

const LOG_TAG = '[Throne]';

// ─── Helpers ─────────────────────────────────────────────────────

async function resolveUsername(interaction) {
    const provided = interaction.options.getString('username');
    if (provided) return provided.toLowerCase().trim();

    // Fall back to linked username
    const [rows] = await pool.execute(
        'SELECT throne_username FROM throne_user_links WHERE user_id = ?',
        [interaction.user.id]
    );

    if (rows.length === 0) {
        await interaction.editReply({
            content: 'No username provided and you haven\'t linked a Throne account. Use `/throne link <username>` first, or provide a username.',
            ephemeral: true,
        });
        return null;
    }

    return rows[0].throne_username;
}

/**
 * Get a profile from cache, or fetch it live if not cached.
 * Returns { profile, error } — profile is null if fetch failed.
 */
async function getOrFetchProfile(username, interaction) {
    // Check cache first
    const cached = await getCachedProfile(username);
    if (cached && cached.fetchStatus === 'ok') return { profile: cached };
    if (cached && cached.fetchStatus === 'error') return { error: `Could not find **${username}** on Throne. Make sure the username is correct.` };

    // Not cached — fetch live (user sees "thinking" while we work)
    try {
        await interaction.editReply({ content: `Fetching **${username}**'s Throne data for the first time...` });
        await cacheProfileAndWishlist(username);
        const profile = await getCachedProfile(username);
        if (profile && profile.fetchStatus === 'ok') return { profile };
        return { error: `Could not find **${username}** on Throne. Make sure the username is correct.` };
    } catch (e) {
        logger.error(`${LOG_TAG} Live fetch failed for ${username}`, { error: e.message });
        return { error: 'Throne is temporarily unavailable. Try again in a few minutes.' };
    }
}

function buildProfileEmbed(profile) {
    const embed = new EmbedBuilder()
        .setColor(Colors.THRONE)
        .setTitle(profile.displayName)
        .setURL(profile.profileUrl)
        .setTimestamp();

    if (profile.bio) embed.setDescription(profile.bio);
    if (profile.pictureUrl) embed.setThumbnail(profile.pictureUrl);
    if (profile.backgroundPictureUrl) embed.setImage(profile.backgroundPictureUrl);

    const fields = [];

    if (profile.birthday) {
        fields.push({ name: 'Birthday', value: profile.birthday, inline: true });
    }
    if (profile.mainContentPlatform) {
        fields.push({ name: 'Platform', value: profile.mainContentPlatform, inline: true });
    }

    if (profile.wishlistCount != null) {
        fields.push(
            { name: 'Wishlist Items', value: `${profile.wishlistCount}`, inline: true },
            { name: 'Gifts Received', value: `${profile.giftedCount || 0}`, inline: true },
            { name: 'Collections', value: `${profile.collectionsCount || 0}`, inline: true },
        );
    }

    if (profile.socialLinks?.length > 0) {
        const socials = profile.socialLinks
            .map(link => link.url ? `[${link.type}](${link.url})` : link.type)
            .join(' | ');
        fields.push({ name: 'Socials', value: socials, inline: false });
    }

    if (profile.interests?.length > 0) {
        fields.push({ name: 'Interests', value: profile.interests.join(', '), inline: false });
    }

    if (profile.surpriseCategories?.length > 0) {
        fields.push({ name: 'Surprise Categories', value: profile.surpriseCategories.join(', '), inline: false });
    }

    if (profile.createdAt && profile.createdAt.getTime() > 0) {
        fields.push({ name: 'Joined Throne', value: `<t:${Math.floor(profile.createdAt.getTime() / 1000)}:R>`, inline: true });
    }

    embed.addFields(fields);
    embed.setFooter({ text: 'Throne Wishlist' });

    return embed;
}

// ─── Lookup Handlers ─────────────────────────────────────────────

export async function handleProfile(interaction) {
    await interaction.deferReply();

    const username = await resolveUsername(interaction);
    if (!username) return;

    const { profile, error } = await getOrFetchProfile(username, interaction);
    if (error) return interaction.editReply({ content: error });

    await interaction.editReply({ embeds: [buildProfileEmbed(profile)] });
}

export async function handleWishlist(interaction) {
    await interaction.deferReply();

    const username = await resolveUsername(interaction);
    if (!username) return;

    const { profile, error } = await getOrFetchProfile(username, interaction);
    if (error) return interaction.editReply({ content: error });

    try {
        // Force refresh if data is older than 60 seconds (user explicitly asked)
        await refreshWishlistIfStale(username, 60);
        const items = await getCachedWishlist(username);
        if (items.length === 0) {
            return interaction.editReply({ content: `**${username}** has no wishlist items.` });
        }

        const ITEMS_PER_PAGE = 5;
        const totalPages = Math.ceil(items.length / ITEMS_PER_PAGE);
        let page = 0;

        function buildPage(p) {
            const start = p * ITEMS_PER_PAGE;
            const pageItems = items.slice(start, start + ITEMS_PER_PAGE);

            const embed = new EmbedBuilder()
                .setColor(Colors.THRONE)
                .setAuthor({ name: profile.displayName, iconURL: profile.pictureUrl || undefined, url: profile.profileUrl })
                .setTitle(`${profile.displayName}'s Wishlist`)
                .setURL(`https://throne.com/${username.toLowerCase()}`)
                .setFooter({ text: `Page ${p + 1}/${totalPages} | ${items.length} item${items.length !== 1 ? 's' : ''}` })
                .setTimestamp();

            if (profile.pictureUrl && pageItems.length > 0) embed.setThumbnail(profile.pictureUrl);

            for (const item of pageItems) {
                const status = item.notInStock ? '🔴 Out of Stock' : item.isAvailable ? '🟢' : '🟡';
                const digital = item.isDigital ? ' 💾' : '';
                const qty = item.quantity > 1 ? ` x${item.quantity}` : '';
                const crowdfund = item.isCrowdfunded ? ' 🤝' : '';

                let costLine = item.priceFormatted || 'N/A';
                if (item.totalContributionFormatted && item.totalContributionFormatted !== item.priceFormatted) {
                    costLine += ` (${item.totalContributionFormatted} to gift)`;
                }

                let fundLine = '';
                if (item.isCrowdfunded) {
                    const pct = item.fundingPercentage || 0;
                    const totalCents = item.priceRaw || 0;
                    const raisedCents = Math.round(totalCents * pct / 100);
                    const raised = (raisedCents / 100).toLocaleString('en-US', { style: 'currency', currency: item.currency || 'USD' });
                    const remaining = ((totalCents - raisedCents) / 100).toLocaleString('en-US', { style: 'currency', currency: item.currency || 'USD' });
                    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
                    fundLine = `\n${bar} **${pct}%** funded | ${raised} raised | ${remaining} remaining`;
                }

                embed.addFields({
                    name: `${status}${crowdfund}${digital} ${item.name.substring(0, 70)}${qty}`,
                    value: `${costLine}${fundLine}\n[View on Throne](https://throne.com/${username.toLowerCase()}/item/${item.id})`,
                    inline: false,
                });
            }

            if (pageItems.length === 1 && pageItems[0].imageUrl) {
                embed.setThumbnail(pageItems[0].imageUrl);
            }

            return embed;
        }

        function buildButtons(p) {
            return new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('throne_wishlist_prev')
                    .setLabel('◀ Previous')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(p === 0),
                new ButtonBuilder()
                    .setCustomId('throne_wishlist_next')
                    .setLabel('Next ▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(p === totalPages - 1),
            );
        }

        const message = await interaction.editReply({
            embeds: [buildPage(page)],
            components: totalPages > 1 ? [buildButtons(page)] : [],
        });

        if (totalPages <= 1) return;

        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time: 300000,
        });

        collector.on('collect', async i => {
            if (i.customId === 'throne_wishlist_prev') page = Math.max(0, page - 1);
            if (i.customId === 'throne_wishlist_next') page = Math.min(totalPages - 1, page + 1);
            await i.update({ embeds: [buildPage(page)], components: [buildButtons(page)] });
        });

        collector.on('end', () => {
            interaction.editReply({ components: [] }).catch(() => {});
        });
    } catch (error) {
        return handleThroneError(interaction, error);
    }
}

export async function handleCollections(interaction) {
    await interaction.deferReply();

    const username = await resolveUsername(interaction);
    if (!username) return;

    const { profile, error } = await getOrFetchProfile(username, interaction);
    if (error) return interaction.editReply({ content: error });

    // Collections data isn't cached separately — show a link instead
    return interaction.editReply({
        content: `View **${profile.displayName}**'s collections on Throne: ${profile.profileUrl}`,
    });

    // Legacy code below (kept for reference if collections caching is added later)
    try {
        const collections = [];
        if (collections.length === 0) {
            return interaction.editReply({ content: `**${username}** has no collections.` });
        }

        const ITEMS_PER_PAGE = 5;
        const totalPages = Math.ceil(collections.length / ITEMS_PER_PAGE);
        let page = 0;

        function buildPage(p) {
            const start = p * ITEMS_PER_PAGE;
            const pageCols = collections.slice(start, start + ITEMS_PER_PAGE);

            const embed = new EmbedBuilder()
                .setColor(Colors.THRONE)
                .setTitle(`${username}'s Collections`)
                .setURL(`https://throne.com/${username.toLowerCase()}`)
                .setFooter({ text: `Page ${p + 1}/${totalPages} | ${collections.length} collection${collections.length !== 1 ? 's' : ''}` })
                .setTimestamp();

            for (const col of pageCols) {
                const desc = col.description ? `\n${col.description.substring(0, 100)}${col.description.length > 100 ? '...' : ''}` : '';
                embed.addFields({
                    name: col.title,
                    value: `${col.itemCount} item${col.itemCount !== 1 ? 's' : ''} | ${col.totalPriceFormatted}${desc}`,
                    inline: false,
                });
            }

            return embed;
        }

        function buildButtons(p) {
            return new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('throne_collections_prev')
                    .setLabel('◀ Previous')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(p === 0),
                new ButtonBuilder()
                    .setCustomId('throne_collections_next')
                    .setLabel('Next ▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(p === totalPages - 1),
            );
        }

        const message = await interaction.editReply({
            embeds: [buildPage(page)],
            components: totalPages > 1 ? [buildButtons(page)] : [],
        });

        if (totalPages <= 1) return;

        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time: 300000,
        });

        collector.on('collect', async i => {
            if (i.customId === 'throne_collections_prev') page = Math.max(0, page - 1);
            if (i.customId === 'throne_collections_next') page = Math.min(totalPages - 1, page + 1);
            await i.update({ embeds: [buildPage(page)], components: [buildButtons(page)] });
        });

        collector.on('end', () => {
            interaction.editReply({ components: [] }).catch(() => {});
        });
    } catch (error) {
        return handleThroneError(interaction, error);
    }
}

export async function handleGifts(interaction) {
    await interaction.deferReply();

    const username = await resolveUsername(interaction);
    if (!username) return;

    const { profile, error } = await getOrFetchProfile(username, interaction);
    if (error) return interaction.editReply({ content: error });

    return interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor(Colors.THRONE)
            .setTitle(`${profile.displayName}'s Gift History`)
            .setURL(`https://throne.com/${username}/gifters`)
            .setDescription(`View gift history and gifter leaderboard on Throne.`)
            .setThumbnail(profile.pictureUrl || null)],
    });

    // Legacy live-fetch code below
    try {
        const gifts = [];
        if (gifts.length === 0) {
            return interaction.editReply({ content: `**${username}** hasn't received any gifts yet.` });
        }

        const ITEMS_PER_PAGE = 5;
        const totalPages = Math.ceil(gifts.length / ITEMS_PER_PAGE);
        let page = 0;

        function buildPage(p) {
            const start = p * ITEMS_PER_PAGE;
            const pageGifts = gifts.slice(start, start + ITEMS_PER_PAGE);

            const embed = new EmbedBuilder()
                .setColor(Colors.THRONE)
                .setTitle(`${username}'s Gift History`)
                .setURL(`https://throne.com/${username.toLowerCase()}/gifters`)
                .setFooter({ text: `Page ${p + 1}/${totalPages} | ${gifts.length} gift${gifts.length !== 1 ? 's' : ''}` })
                .setTimestamp();

            for (const gift of pageGifts) {
                const gifters = gift.gifters.map(g => g.username).join(', ') || 'Anonymous';
                const date = gift.purchasedAt ? `<t:${Math.floor(gift.purchasedAt.getTime() / 1000)}:R>` : 'Unknown';
                const crowdfunded = gift.isCrowdfunded ? ` (Crowdfunded — ${gift.contributorCount} contributors)` : '';

                embed.addFields({
                    name: gift.name,
                    value: `From: **${gifters}**\nValue: ${gift.totalFormatted} | Status: ${gift.status} | ${date}${crowdfunded}`,
                    inline: false,
                });
            }

            return embed;
        }

        function buildButtons(p) {
            return new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('throne_gifts_prev')
                    .setLabel('◀ Previous')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(p === 0),
                new ButtonBuilder()
                    .setCustomId('throne_gifts_next')
                    .setLabel('Next ▶')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(p === totalPages - 1),
            );
        }

        const message = await interaction.editReply({
            embeds: [buildPage(page)],
            components: totalPages > 1 ? [buildButtons(page)] : [],
        });

        if (totalPages <= 1) return;

        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time: 300000,
        });

        collector.on('collect', async i => {
            if (i.customId === 'throne_gifts_prev') page = Math.max(0, page - 1);
            if (i.customId === 'throne_gifts_next') page = Math.min(totalPages - 1, page + 1);
            await i.update({ embeds: [buildPage(page)], components: [buildButtons(page)] });
        });

        collector.on('end', () => {
            interaction.editReply({ components: [] }).catch(() => {});
        });
    } catch (error) {
        return handleThroneError(interaction, error);
    }
}

export async function handleLeaderboard(interaction) {
    await interaction.deferReply();

    const username = await resolveUsername(interaction);
    if (!username) return;

    const { profile, error } = await getOrFetchProfile(username, interaction);
    if (error) return interaction.editReply({ content: error });

    return interaction.editReply({
        embeds: [new EmbedBuilder()
            .setColor(Colors.THRONE)
            .setTitle(`${profile.displayName}'s Gifter Leaderboard`)
            .setURL(`https://throne.com/${username}/gifters`)
            .setDescription(`View the full gifter leaderboard on Throne.`)
            .setThumbnail(profile.pictureUrl || null)],
    });

    // Legacy live-fetch code below
    try {
        const period = interaction.options.getString('period') || 'allTime';
        const entries = [];
        const periodLabels = { allTime: 'All Time', lastMonth: 'Last Month', lastWeek: 'Last Week' };

        if (entries.length === 0) {
            return interaction.editReply({ content: `**${username}** has no gifters for ${periodLabels[period]}.` });
        }

        const medals = ['🥇', '🥈', '🥉'];
        const lines = entries.slice(0, 15).map((entry, i) => {
            const medal = medals[i] || `**${i + 1}.**`;
            return `${medal} **${entry.username}** — ${entry.giftCount} gift${entry.giftCount !== 1 ? 's' : ''} (${entry.totalSpentFormatted})`;
        });

        const embed = new EmbedBuilder()
            .setColor(Colors.THRONE)
            .setTitle(`${profile.displayName}'s Gifter Leaderboard`)
            .setURL(`https://throne.com/${username.toLowerCase()}/gifters`)
            .setDescription(lines.join('\n'))
            .setFooter({ text: `Period: ${periodLabels[period]}` })
            .setTimestamp();

        if (profile.pictureUrl) embed.setThumbnail(profile.pictureUrl);

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        return handleThroneError(interaction, error);
    }
}

// ─── Account Linking ─────────────────────────────────────────────

export async function handleLink(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const username = interaction.options.getString('username').toLowerCase().trim();

    if (!username || username.length > 100) {
        return interaction.editReply({ content: 'Please provide a valid Throne username.' });
    }

    await pool.execute(
        `INSERT INTO throne_user_links (user_id, throne_username) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE throne_username = VALUES(throne_username), linked_at = CURRENT_TIMESTAMP`,
        [interaction.user.id, username]
    );

    // Queue background fetch so /throne me works quickly
    await queueProfileFetch(username);

    const embed = new EmbedBuilder()
        .setColor(Colors.THRONE)
        .setTitle('Throne Account Linked')
        .setDescription(`Your Discord account is now linked to **${username}** on Throne.\nYour profile data will be fetched in the background. Use \`/throne me\` in a few minutes.`)
        .setURL(`https://throne.com/${username}`)
        .setFooter({ text: 'If the username is wrong, just run /throne link again' });

    await interaction.editReply({ embeds: [embed] });
}

export async function handleUnlink(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const [result] = await pool.execute(
        'DELETE FROM throne_user_links WHERE user_id = ?',
        [interaction.user.id]
    );

    if (result.affectedRows === 0) {
        return interaction.editReply({ content: 'You don\'t have a linked Throne account.' });
    }

    await interaction.editReply({
        embeds: [
            new EmbedBuilder()
                .setColor(Colors.THRONE)
                .setTitle('Throne Account Unlinked')
                .setDescription('Your Throne account link has been removed.'),
        ],
    });
}

export async function handleMe(interaction) {
    await interaction.deferReply();

    const [rows] = await pool.execute(
        'SELECT throne_username FROM throne_user_links WHERE user_id = ?',
        [interaction.user.id]
    );

    if (rows.length === 0) {
        return interaction.editReply({
            content: 'You haven\'t linked a Throne account yet. Use `/throne link <username>` first.',
        });
    }

    const username = rows[0].throne_username;
    const { profile, error } = await getOrFetchProfile(username, interaction);
    if (error) return interaction.editReply({ content: error });

    await interaction.editReply({ embeds: [buildProfileEmbed(profile)] });
}

// ─── Notification Tracking ───────────────────────────────────────

export async function handleTrack(interaction) {
    // Require ManageGuild
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need the **Manage Server** permission to set up Throne tracking.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const username = interaction.options.getString('username').toLowerCase().trim();
    const channel = interaction.options.getChannel('channel');

    if (!username || username.length > 100) {
        return interaction.editReply({ content: 'Please provide a valid Throne username.' });
    }

    await pool.execute(
        `INSERT INTO throne_notifications (guild_id, throne_username, channel_id, added_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), added_by = VALUES(added_by)`,
        [interaction.guildId, username, channel.id, interaction.user.id]
    );

    const embed = new EmbedBuilder()
        .setColor(Colors.THRONE)
        .setTitle('Throne Tracking Enabled')
        .setDescription(`Now tracking **${username}** in ${channel}`)
        .setURL(`https://throne.com/${username}`)
        .addFields(
            { name: 'New Items', value: 'Enabled', inline: true },
            { name: 'Gift Alerts', value: 'Enabled', inline: true },
            { name: 'Contributions', value: 'Enabled', inline: true },
        )
        .setFooter({ text: 'Notifications will appear within 5 minutes of changes' });

    await interaction.editReply({ embeds: [embed] });
}

export async function handleUntrack(interaction) {
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need the **Manage Server** permission to manage Throne tracking.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const username = interaction.options.getString('username').toLowerCase().trim();

    const [result] = await pool.execute(
        'DELETE FROM throne_notifications WHERE guild_id = ? AND throne_username = ?',
        [interaction.guildId, username]
    );

    if (result.affectedRows === 0) {
        return interaction.editReply({ content: `**${username}** is not being tracked in this server.` });
    }

    await interaction.editReply({
        embeds: [
            new EmbedBuilder()
                .setColor(Colors.THRONE)
                .setTitle('Throne Tracking Removed')
                .setDescription(`Stopped tracking **${username}**. No more notifications will be sent.`),
        ],
    });
}

export async function handleTracked(interaction) {
    await interaction.deferReply();

    const [rows] = await pool.execute(
        'SELECT throne_username, channel_id, notify_new_items, notify_gifts, notify_contributions, added_by FROM throne_notifications WHERE guild_id = ?',
        [interaction.guildId]
    );

    if (rows.length === 0) {
        return interaction.editReply({ content: 'No Throne users are being tracked in this server. Use `/throne track` to set one up.' });
    }

    const lines = rows.map(row => {
        const features = [];
        if (row.notify_new_items) features.push('Items');
        if (row.notify_gifts) features.push('Gifts');
        if (row.notify_contributions) features.push('Contributions');

        return `**${row.throne_username}** → <#${row.channel_id}>\n  Tracking: ${features.join(', ')} | Added by: <@${row.added_by}>`;
    });

    const embed = new EmbedBuilder()
        .setColor(Colors.THRONE)
        .setTitle('Tracked Throne Users')
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: `${rows.length} user${rows.length !== 1 ? 's' : ''} tracked` })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

// ─── Featured Wishlist ───────────────────────────────────────────

export async function handleFeatured(interaction) {
    const action = interaction.options.getString('action');

    if (action === 'view') {
        await interaction.deferReply();

        const [rows] = await pool.execute(
            'SELECT featured_username FROM throne_guild_config WHERE guild_id = ?',
            [interaction.guildId]
        );

        if (rows.length === 0) {
            return interaction.editReply({ content: 'This server has no featured Throne wishlist. An admin can set one with `/throne featured set <username>`.' });
        }

        const { profile, error: fetchErr } = await getOrFetchProfile(rows[0].featured_username, interaction);
        if (fetchErr) return interaction.editReply({ content: fetchErr });
        const embed = buildProfileEmbed(profile);
        embed.setAuthor({ name: 'Featured Wishlist' });
        await interaction.editReply({ embeds: [embed] });
        return;
    }

    // set and clear require ManageGuild
    if (!interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: 'You need the **Manage Server** permission to change the featured wishlist.', ephemeral: true });
    }

    if (action === 'set') {
        const username = interaction.options.getString('username');
        if (!username) {
            return interaction.reply({ content: 'You must provide a Throne username when setting the featured wishlist.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const cleanUsername = username.toLowerCase().trim();
        await pool.execute(
            `INSERT INTO throne_guild_config (guild_id, featured_username, set_by)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE featured_username = VALUES(featured_username), set_by = VALUES(set_by), set_at = CURRENT_TIMESTAMP`,
            [interaction.guildId, cleanUsername, interaction.user.id]
        );

        await interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setColor(Colors.THRONE)
                    .setTitle('Featured Wishlist Updated')
                    .setDescription(`This server's featured wishlist is now **${cleanUsername}**`)
                    .setURL(`https://throne.com/${cleanUsername}`),
            ],
        });
    } else if (action === 'clear') {
        await interaction.deferReply({ ephemeral: true });

        const [result] = await pool.execute(
            'DELETE FROM throne_guild_config WHERE guild_id = ?',
            [interaction.guildId]
        );

        if (result.affectedRows === 0) {
            return interaction.editReply({ content: 'This server has no featured wishlist to clear.' });
        }

        await interaction.editReply({
            embeds: [
                new EmbedBuilder()
                    .setColor(Colors.THRONE)
                    .setTitle('Featured Wishlist Cleared')
                    .setDescription('The featured wishlist has been removed.'),
            ],
        });
    }
}

// ─── Random / Search / Stats ────────────────────────────────────

export async function handleRandom(interaction) {
    await interaction.deferReply();
    const username = await resolveUsername(interaction);
    if (!username) return;

    const { profile, error } = await getOrFetchProfile(username, interaction);
    if (error) return interaction.editReply({ content: error });

    const items = await getCachedWishlist(username);
    const available = items.filter(i => i.isAvailable && !i.notInStock);

    if (available.length === 0) {
        return interaction.editReply({ content: `**${profile.displayName}** has no available items on their wishlist.` });
    }

    const item = available[Math.floor(Math.random() * available.length)];

    const embed = new EmbedBuilder()
        .setColor(Colors.THRONE)
        .setAuthor({ name: `Random pick from ${profile.displayName}'s wishlist`, iconURL: profile.pictureUrl || undefined })
        .setTitle(item.name.substring(0, 256))
        .setURL(`https://throne.com/${username}/item/${item.id}`)
        .setTimestamp();

    const fields = [{ name: 'Price', value: item.priceFormatted || 'N/A', inline: true }];

    if (item.totalContributionFormatted && item.totalContributionFormatted !== item.priceFormatted) {
        fields.push({ name: 'Total to Gift', value: item.totalContributionFormatted, inline: true });
    }

    if (item.isCrowdfunded && item.fundingPercentage > 0) {
        const pct = item.fundingPercentage;
        const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
        fields.push({ name: 'Crowdfund Progress', value: `${bar} **${pct}%**`, inline: false });
    }

    if (item.isDigital) fields.push({ name: 'Type', value: 'Digital', inline: true });

    embed.addFields(fields);
    if (item.imageUrl) embed.setImage(item.imageUrl);

    await interaction.editReply({ embeds: [embed] });
}

export async function handleSearch(interaction) {
    await interaction.deferReply();
    const username = await resolveUsername(interaction);
    if (!username) return;
    const query = interaction.options.getString('query').toLowerCase();

    const { profile, error } = await getOrFetchProfile(username, interaction);
    if (error) return interaction.editReply({ content: error });

    const items = await getCachedWishlist(username);
    const matches = items.filter(i => i.name.toLowerCase().includes(query));

    if (matches.length === 0) {
        return interaction.editReply({ content: `No items matching "**${query}**" in **${profile.displayName}**'s wishlist.` });
    }

    const embed = new EmbedBuilder()
        .setColor(Colors.THRONE)
        .setAuthor({ name: `${profile.displayName}'s Wishlist`, iconURL: profile.pictureUrl || undefined })
        .setTitle(`Search: "${query}"`)
        .setFooter({ text: `${matches.length} result${matches.length !== 1 ? 's' : ''}` })
        .setTimestamp();

    for (const item of matches.slice(0, 10)) {
        const status = item.notInStock ? '🔴' : item.isAvailable ? '🟢' : '🟡';
        let value = item.priceFormatted || 'N/A';
        if (item.isCrowdfunded && item.fundingPercentage > 0) value += ` (${item.fundingPercentage}% funded)`;
        value += ` | [View](https://throne.com/${username}/item/${item.id})`;
        embed.addFields({ name: `${status} ${item.name.substring(0, 80)}`, value, inline: false });
    }

    if (matches.length > 10) {
        embed.setFooter({ text: `Showing 10 of ${matches.length} results` });
    }

    await interaction.editReply({ embeds: [embed] });
}

export async function handleStats(interaction) {
    await interaction.deferReply();
    const username = await resolveUsername(interaction);
    if (!username) return;

    const { profile, error } = await getOrFetchProfile(username, interaction);
    if (error) return interaction.editReply({ content: error });

    const items = await getCachedWishlist(username);

    if (items.length === 0) {
        return interaction.editReply({ content: `**${profile.displayName}** has no wishlist items.` });
    }

    const available = items.filter(i => i.isAvailable && !i.notInStock);
    const crowdfunded = items.filter(i => i.isCrowdfunded);
    const digital = items.filter(i => i.isDigital);
    const totalValue = items.reduce((sum, i) => sum + (i.priceRaw || 0), 0);
    const avgPrice = totalValue / items.length;
    const mostExpensive = items.reduce((max, i) => (i.priceRaw || 0) > (max.priceRaw || 0) ? i : max, items[0]);
    const cheapest = items.reduce((min, i) => (i.priceRaw || 0) < (min.priceRaw || 0) ? i : min, items[0]);

    // Calculate total crowdfund progress
    let totalFunded = 0;
    let totalCrowdfundValue = 0;
    for (const item of crowdfunded) {
        totalCrowdfundValue += item.priceRaw || 0;
        totalFunded += (item.priceRaw || 0) * (item.fundingPercentage || 0) / 100;
    }

    const currency = items[0]?.currency || 'USD';
    const fmt = (cents) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency });

    const embed = new EmbedBuilder()
        .setColor(Colors.THRONE)
        .setAuthor({ name: profile.displayName, iconURL: profile.pictureUrl || undefined, url: profile.profileUrl })
        .setTitle('Wishlist Statistics')
        .addFields(
            { name: 'Total Items', value: `${items.length}`, inline: true },
            { name: 'Available', value: `${available.length}`, inline: true },
            { name: 'Digital', value: `${digital.length}`, inline: true },
            { name: 'Total Value', value: fmt(totalValue), inline: true },
            { name: 'Average Price', value: fmt(avgPrice), inline: true },
            { name: 'Crowdfunded', value: `${crowdfunded.length}`, inline: true },
            { name: 'Most Expensive', value: `${mostExpensive.name.substring(0, 40)}... (${mostExpensive.priceFormatted})`, inline: false },
            { name: 'Most Affordable', value: `${cheapest.name.substring(0, 40)}... (${cheapest.priceFormatted})`, inline: false },
        )
        .setTimestamp();

    if (crowdfunded.length > 0 && totalCrowdfundValue > 0) {
        const overallPct = Math.round(totalFunded / totalCrowdfundValue * 100);
        const bar = '█'.repeat(Math.round(overallPct / 10)) + '░'.repeat(10 - Math.round(overallPct / 10));
        embed.addFields({ name: 'Overall Crowdfund Progress', value: `${bar} **${overallPct}%** (${fmt(totalFunded)} of ${fmt(totalCrowdfundValue)})`, inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
}
