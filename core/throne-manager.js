import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import Colors from '../utils/colors.js';
import {
    fetchThroneProfile,
    fetchThroneWishlist,
    fetchThroneGiftHistory,
    formatPrice,
    ThroneUserNotFoundError,
    ThroneUnavailableError,
    ThroneParseError,
} from '../utils/scrapers/throne-scraper.js';

const LOG_TAG = '[ThroneManager]';

// ─── Profile & Wishlist Caching ──────────────────────────────────

/**
 * Refresh cached data for all known Throne usernames
 * (linked users + tracked users + featured users)
 */
export async function refreshAllCachedData() {
    let usernames;
    try {
        const [rows] = await pool.execute(`
            SELECT DISTINCT throne_username FROM (
                SELECT throne_username FROM throne_user_links
                UNION SELECT throne_username FROM throne_notifications
                UNION SELECT featured_username AS throne_username FROM throne_guild_config
            ) AS all_users
        `);
        usernames = rows.map(r => r.throne_username);
    } catch (error) {
        logger.error(`${LOG_TAG} Failed to load usernames for refresh`, { error: error.message });
        return;
    }

    if (usernames.length === 0) return;

    logger.info(`${LOG_TAG} Refreshing cached data for ${usernames.length} Throne user(s)`);

    for (const username of usernames) {
        try {
            await cacheProfileAndWishlist(username);
        } catch (error) {
            if (error instanceof ThroneUserNotFoundError) {
                await pool.execute(
                    `INSERT INTO throne_cached_profiles (throne_username, fetch_status) VALUES (?, 'error')
                     ON DUPLICATE KEY UPDATE fetch_status = 'error', last_fetched_at = CURRENT_TIMESTAMP`,
                    [username]
                );
            } else if (error instanceof ThroneUnavailableError) {
                logger.warn(`${LOG_TAG} Throne unavailable for "${username}", will retry next cycle`);
                return; // Stop if Throne is down
            } else {
                logger.error(`${LOG_TAG} Error caching "${username}"`, { error: error.message });
            }
        }
    }
}

/**
 * Scrape and cache a single user's profile + wishlist to DB
 */
export async function cacheProfileAndWishlist(username, { force = false } = {}) {
    const profile = await fetchThroneProfile(username, { force });

    // Cache profile
    await pool.execute(
        `INSERT INTO throne_cached_profiles
         (throne_username, display_name, bio, birthday, picture_url, background_url, platform, social_links, interests, profile_url, created_at_throne, fetch_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')
         ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name), bio = VALUES(bio), birthday = VALUES(birthday),
         picture_url = VALUES(picture_url), background_url = VALUES(background_url),
         platform = VALUES(platform), social_links = VALUES(social_links), interests = VALUES(interests),
         profile_url = VALUES(profile_url), created_at_throne = VALUES(created_at_throne),
         fetch_status = 'ok', last_fetched_at = CURRENT_TIMESTAMP`,
        [
            username,
            profile.displayName,
            profile.bio,
            profile.birthday,
            profile.pictureUrl,
            profile.backgroundPictureUrl,
            profile.mainContentPlatform,
            JSON.stringify(profile.socialLinks),
            JSON.stringify(profile.interests),
            profile.profileUrl,
            profile.createdAt ? profile.createdAt.getTime() : null,
        ]
    );

    // Cache wishlist
    try {
        const items = await fetchThroneWishlist(username, { force });

        // Clear old items and insert new
        await pool.execute('DELETE FROM throne_cached_wishlists WHERE throne_username = ?', [username]);

        for (const item of items) {
            await pool.execute(
                `INSERT INTO throne_cached_wishlists
                 (throne_username, item_id, item_name, price_formatted, price_raw, currency, quantity,
                  is_digital, is_available, not_in_stock, is_featured, is_crowdfunded, funding_percentage,
                  image_url, link, collection_ids, total_contribution_formatted, created_at_throne)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    username, item.id, item.name, item.priceFormatted, item.priceRaw,
                    item.currency, item.quantity, item.isDigital ? 1 : 0,
                    item.isAvailable ? 1 : 0, item.notInStock ? 1 : 0, item.isFeatured ? 1 : 0,
                    item.isCrowdfunded ? 1 : 0, item.fundingPercentage || 0,
                    item.imageUrl, item.link, JSON.stringify(item.collectionIds),
                    item.totalContributionFormatted, item.createdAt ? item.createdAt.getTime() : null,
                ]
            );
        }

        logger.info(`${LOG_TAG} Cached ${items.length} wishlist items for "${username}"`);
    } catch (error) {
        // Profile cached ok, wishlist failed — that's fine
        logger.warn(`${LOG_TAG} Could not cache wishlist for "${username}": ${error.message}`);
    }
}

/**
 * Get cached profile from DB (instant)
 */
export async function getCachedProfile(username) {
    const [rows] = await pool.execute(
        'SELECT * FROM throne_cached_profiles WHERE throne_username = ?',
        [username]
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
        username: row.throne_username,
        displayName: row.display_name || row.throne_username,
        bio: row.bio,
        birthday: row.birthday,
        pictureUrl: row.picture_url,
        backgroundPictureUrl: row.background_url,
        mainContentPlatform: row.platform,
        socialLinks: row.social_links ? JSON.parse(row.social_links) : [],
        interests: row.interests ? JSON.parse(row.interests) : [],
        profileUrl: row.profile_url || `https://throne.com/${username}`,
        createdAt: row.created_at_throne ? new Date(row.created_at_throne) : null,
        lastFetchedAt: row.last_fetched_at,
        fetchStatus: row.fetch_status,
    };
}

/**
 * Get cached wishlist from DB (instant)
 */
export async function getCachedWishlist(username) {
    const [rows] = await pool.execute(
        'SELECT * FROM throne_cached_wishlists WHERE throne_username = ? ORDER BY created_at_throne DESC',
        [username]
    );
    return rows.map(r => ({
        id: r.item_id,
        name: r.item_name,
        priceFormatted: r.price_formatted,
        priceRaw: r.price_raw,
        currency: r.currency,
        quantity: r.quantity,
        isDigital: !!r.is_digital,
        isAvailable: !!r.is_available,
        notInStock: !!r.not_in_stock,
        isFeatured: !!r.is_featured,
        isCrowdfunded: !!r.is_crowdfunded,
        fundingPercentage: r.funding_percentage || 0,
        imageUrl: r.image_url,
        link: r.link,
        collectionIds: r.collection_ids ? JSON.parse(r.collection_ids) : [],
        totalContributionFormatted: r.total_contribution_formatted,
        createdAt: r.created_at_throne ? new Date(r.created_at_throne) : null,
    }));
}

/**
 * Mark a username as pending fetch (called on link/track)
 */
export async function queueProfileFetch(username) {
    await pool.execute(
        `INSERT INTO throne_cached_profiles (throne_username, fetch_status) VALUES (?, 'pending')
         ON DUPLICATE KEY UPDATE throne_username = throne_username`,
        [username]
    );
}

/**
 * Refresh wishlist from live Throne data if the cache is older than maxAgeSeconds.
 * Called by interactive commands so users always see fresh data.
 */
export async function refreshWishlistIfStale(username, maxAgeSeconds = 60) {
    try {
        const [rows] = await pool.execute(
            'SELECT last_fetched_at FROM throne_cached_profiles WHERE throne_username = ?',
            [username]
        );
        if (rows.length === 0) return; // not cached at all — getOrFetchProfile handles this

        const age = (Date.now() - new Date(rows[0].last_fetched_at).getTime()) / 1000;
        if (age > maxAgeSeconds) {
            logger.debug(`${LOG_TAG} Refreshing stale wishlist for "${username}" (${Math.round(age)}s old)`);
            await cacheProfileAndWishlist(username, { force: true });
        }
    } catch (error) {
        logger.warn(`${LOG_TAG} Could not refresh wishlist for "${username}": ${error.message}`);
        // Non-fatal — fall back to cached data
    }
}

// ─── Notification Checking ───────────────────────────────────────

export async function checkThroneNotifications() {
    let trackedUsers;
    try {
        [trackedUsers] = await pool.execute(
            'SELECT DISTINCT throne_username FROM throne_notifications'
        );
    } catch (error) {
        logger.error(`${LOG_TAG} Failed to load tracked users`, { error: error.message });
        return;
    }

    if (trackedUsers.length === 0) return;

    logger.info(`${LOG_TAG} Checking ${trackedUsers.length} tracked Throne user(s)`);

    for (const { throne_username } of trackedUsers) {
        try {
            await checkUserNotifications(throne_username);
        } catch (error) {
            if (error instanceof ThroneUserNotFoundError) {
                logger.warn(`${LOG_TAG} Tracked user "${throne_username}" not found on Throne`);
            } else if (error instanceof ThroneUnavailableError) {
                logger.warn(`${LOG_TAG} Throne unavailable for "${throne_username}", will retry`);
                return;
            } else {
                logger.error(`${LOG_TAG} Error checking "${throne_username}"`, { error: error.message });
            }
        }
    }
}

async function checkUserNotifications(username) {
    // Get per-guild tracking configs
    const [configs] = await pool.execute(
        'SELECT n.guild_id, n.channel_id, s.* FROM throne_notifications n LEFT JOIN throne_guild_settings s ON n.guild_id = s.guild_id WHERE n.throne_username = ?',
        [username]
    );
    if (configs.length === 0) return;

    // Determine what data we need to fetch
    const needItems = configs.some(c => c.notify_item_added || c.notify_item_removed || c.notify_price_change);
    const needGifts = configs.some(c => c.notify_gift_received || c.notify_contribution || c.notify_gift_thankyou);

    let newItems = [], removedItems = [], priceChanges = [], newGifts = [], contributionUpdates = [];

    if (needItems) {
        const itemResults = await checkForItemChanges(username, configs);
        newItems = itemResults.newItems;
        removedItems = itemResults.removedItems;
        priceChanges = itemResults.priceChanges;
    }

    if (needGifts) {
        const r = await checkForNewGiftsAndContributions(username);
        newGifts = r.newGifts;
        contributionUpdates = r.contributionUpdates;
    }

    // Check milestones
    const milestones = await checkMilestones(username, configs);

    // Post notifications per guild
    for (const config of configs) {
        const channelId = config.notification_channel_id || config.channel_id;
        const channel = findChannel(config.guild_id, channelId);
        if (!channel) continue;

        try {
            if (config.notify_item_added && newItems.length > 0) {
                await postNewItemNotifications(channel, username, newItems);
                await logNotification(config.guild_id, username, 'item_added', channelId, { count: newItems.length });
            }
            if (config.notify_item_removed && removedItems.length > 0) {
                await postRemovedItemNotifications(channel, username, removedItems);
                await logNotification(config.guild_id, username, 'item_removed', channelId, { count: removedItems.length });
            }
            if (config.notify_price_change && priceChanges.length > 0) {
                await postPriceChangeNotifications(channel, username, priceChanges, config.price_change_threshold || 10);
                await logNotification(config.guild_id, username, 'price_change', channelId, { count: priceChanges.length });
            }
            if (config.notify_gift_received && newGifts.length > 0) {
                await postGiftNotifications(channel, username, newGifts);
                await logNotification(config.guild_id, username, 'gift_received', channelId, { count: newGifts.length });
            }
            if (config.notify_contribution && contributionUpdates.length > 0) {
                await postContributionNotifications(channel, username, contributionUpdates);
                await logNotification(config.guild_id, username, 'contribution', channelId, { count: contributionUpdates.length });
            }
            if (config.notify_milestone && milestones.length > 0) {
                await postMilestoneNotifications(channel, username, milestones);
                await logNotification(config.guild_id, username, 'milestone', channelId, { milestones });
            }
        } catch (error) {
            logger.error(`${LOG_TAG} Failed to post notification`, { channel: channelId, guild: config.guild_id, error: error.message });
        }
    }
}

// ─── Notification Logging ────────────────────────────────────────
async function logNotification(guildId, username, type, channelId, details) {
    try {
        await pool.execute(
            'INSERT INTO throne_notification_log (guild_id, throne_username, notification_type, channel_id, details) VALUES (?, ?, ?, ?, ?)',
            [guildId, username, type, channelId, JSON.stringify(details)]
        );
    } catch { /* best effort */ }
}

// ─── Item Change Detection (additions, removals, price changes) ──
async function checkForItemChanges(username, configs) {
    const items = await fetchThroneWishlist(username);
    const [knownRows] = await pool.execute('SELECT item_id, item_name, still_present FROM throne_seen_items WHERE throne_username = ?', [username]);
    const knownMap = new Map(knownRows.map(r => [r.item_id, r]));
    const currentIds = new Set(items.map(i => i.id));

    const newItems = [];
    const removedItems = [];
    const priceChanges = [];

    // Detect new items
    for (const item of items) {
        if (!knownMap.has(item.id)) {
            newItems.push(item);
        }
    }

    // Detect removed items (were present, now gone)
    for (const [id, row] of knownMap) {
        if (row.still_present && !currentIds.has(id)) {
            removedItems.push({ id, name: row.item_name });
        }
    }

    // Detect price changes
    const [priceRows] = await pool.execute(
        `SELECT item_id, price_raw FROM throne_price_history WHERE throne_username = ? AND (item_id, recorded_at) IN (SELECT item_id, MAX(recorded_at) FROM throne_price_history WHERE throne_username = ? GROUP BY item_id)`,
        [username, username]
    );
    const lastPriceMap = new Map(priceRows.map(r => [r.item_id, r.price_raw]));

    for (const item of items) {
        const lastPrice = lastPriceMap.get(item.id);
        if (lastPrice != null && lastPrice !== item.priceRaw) {
            const changePct = Math.abs((item.priceRaw - lastPrice) / lastPrice * 100);
            priceChanges.push({
                ...item,
                oldPrice: lastPrice,
                changePct: Math.round(changePct),
                direction: item.priceRaw > lastPrice ? 'up' : 'down',
            });
        }
    }

    // Update DB: insert new items, mark removed, record prices
    if (newItems.length > 0) {
        const values = newItems.map(item => [username, item.id, item.name]);
        const placeholders = values.map(() => '(?, ?, ?)').join(', ');
        await pool.execute(`INSERT IGNORE INTO throne_seen_items (throne_username, item_id, item_name) VALUES ${placeholders}`, values.flat());
    }

    if (removedItems.length > 0) {
        for (const item of removedItems) {
            await pool.execute('UPDATE throne_seen_items SET still_present = 0 WHERE throne_username = ? AND item_id = ?', [username, item.id]);
        }
    }

    // Record current prices
    for (const item of items) {
        await pool.execute(
            'INSERT INTO throne_price_history (throne_username, item_id, price_raw, currency) VALUES (?, ?, ?, ?)',
            [username, item.id, item.priceRaw, item.currency]
        );
    }

    // First run — seed only, no notifications
    if (knownMap.size === 0) return { newItems: [], removedItems: [], priceChanges: [] };

    return { newItems, removedItems, priceChanges };
}

// ─── Milestone Detection ─────────────────────────────────────────
async function checkMilestones(username, configs) {
    const milestones = [];

    // Check total gifts milestone (every 10 gifts)
    const [giftCount] = await pool.execute('SELECT COUNT(*) as cnt FROM throne_seen_gifts WHERE throne_username = ?', [username]);
    const total = giftCount[0]?.cnt || 0;
    if (total > 0 && total % 10 === 0) {
        // Check if we already posted this milestone
        const [existing] = await pool.execute(
            "SELECT id FROM throne_notification_log WHERE throne_username = ? AND notification_type = 'milestone' AND JSON_EXTRACT(details, '$.giftCount') = ? LIMIT 1",
            [username, total]
        );
        if (existing.length === 0) {
            milestones.push({ type: 'gift_count', value: total, message: `has received their **${total}th** gift!` });
        }
    }

    // Check crowdfund milestone (item fully funded)
    const items = await getCachedWishlist(username);
    for (const item of items) {
        if (item.isCrowdfunded && item.fundingPercentage === 100) {
            const [existing] = await pool.execute(
                "SELECT id FROM throne_notification_log WHERE throne_username = ? AND notification_type = 'milestone' AND JSON_EXTRACT(details, '$.itemFunded') = ? LIMIT 1",
                [username, item.id]
            );
            if (existing.length === 0) {
                milestones.push({ type: 'item_funded', itemId: item.id, value: item.name, message: `**${item.name.substring(0, 60)}** is fully funded!` });
            }
        }
    }

    return milestones;
}

// Legacy single-purpose function kept for backwards compatibility
async function checkForNewItems(username) {
    const items = await fetchThroneWishlist(username);
    if (items.length === 0) return [];

    const [knownRows] = await pool.execute('SELECT item_id FROM throne_seen_items WHERE throne_username = ?', [username]);
    const knownIds = new Set(knownRows.map(r => r.item_id));
    const newItems = items.filter(item => !knownIds.has(item.id));

    if (newItems.length > 0) {
        const values = newItems.map(item => [username, item.id, item.name]);
        const placeholders = values.map(() => '(?, ?, ?)').join(', ');
        await pool.execute(`INSERT IGNORE INTO throne_seen_items (throne_username, item_id, item_name) VALUES ${placeholders}`, values.flat());
    }

    if (knownIds.size === 0 && newItems.length > 0) return []; // first run — seed only
    return newItems;
}

async function checkForNewGiftsAndContributions(username) {
    const gifts = await fetchThroneGiftHistory(username);
    if (gifts.length === 0) return { newGifts: [], contributionUpdates: [] };

    const [knownRows] = await pool.execute('SELECT gift_id, status, contributor_count FROM throne_seen_gifts WHERE throne_username = ?', [username]);
    const knownMap = new Map(knownRows.map(r => [r.gift_id, r]));

    const newGifts = [];
    const contributionUpdates = [];

    for (const gift of gifts) {
        const known = knownMap.get(gift.id);
        if (!known) newGifts.push(gift);
        else if (gift.isCrowdfunded && gift.contributorCount > known.contributor_count) {
            contributionUpdates.push({ ...gift, previousContributorCount: known.contributor_count });
        }
    }

    for (const gift of gifts) {
        await pool.execute(
            `INSERT INTO throne_seen_gifts (throne_username, gift_id, gift_name, status, is_crowdfunded, contributor_count)
             VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE status = VALUES(status), contributor_count = VALUES(contributor_count)`,
            [username, gift.id, gift.name, gift.status, gift.isCrowdfunded ? 1 : 0, gift.contributorCount]
        );
    }

    if (knownMap.size === 0 && newGifts.length > 0) return { newGifts: [], contributionUpdates: [] }; // first run
    return { newGifts, contributionUpdates };
}

function findChannel(guildId, channelId) {
    if (global.botManager?.clients) {
        for (const [, botClient] of global.botManager.clients) {
            const guild = botClient.guilds.cache.get(guildId);
            if (guild) { const ch = guild.channels.cache.get(channelId); if (ch) return ch; }
        }
    }
    return null;
}

// ─── Notification Helpers ────────────────────────────────────────

async function getProfileInfo(username) {
    const profile = await getCachedProfile(username);
    return {
        displayName: profile?.displayName || username,
        avatarUrl: profile?.pictureUrl || null,
        url: `https://throne.com/${username.toLowerCase()}`,
    };
}

function itemButtons(item, username) {
    const itemUrl = `https://throne.com/${username.toLowerCase()}/item/${item.id}`;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('View on Throne').setStyle(ButtonStyle.Link).setURL(itemUrl).setEmoji('👑'),
        new ButtonBuilder().setLabel('View Wishlist').setStyle(ButtonStyle.Link).setURL(`https://throne.com/${username.toLowerCase()}`).setEmoji('🎁')
    );
}

function wishlistButton(username) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel('View Wishlist').setStyle(ButtonStyle.Link).setURL(`https://throne.com/${username.toLowerCase()}`).setEmoji('👑')
    );
}

// ─── New Item Added ──────────────────────────────────────────────
async function postNewItemNotifications(channel, username, items) {
    const { displayName, avatarUrl, url } = await getProfileInfo(username);

    for (const item of items) {
        const embed = new EmbedBuilder()
            .setColor(Colors.THRONE)
            .setAuthor({ name: displayName, iconURL: avatarUrl, url })
            .setTitle('🆕 New Wishlist Item Added')
            .setDescription(`**${item.name}**`)
            .setURL(`https://throne.com/${username.toLowerCase()}/item/${item.id}`)
            .addFields(
                { name: 'Price', value: item.priceFormatted || 'N/A', inline: true },
                { name: 'Status', value: item.notInStock ? '🔴 Out of Stock' : item.isAvailable ? '🟢 Available' : '🟡 Limited', inline: true },
            )
            .setTimestamp();

        if (item.totalContributionFormatted && item.totalContributionFormatted !== item.priceFormatted) {
            embed.addFields({ name: 'Total to Gift', value: item.totalContributionFormatted, inline: true });
        }
        if (item.isCrowdfunded) embed.addFields({ name: 'Type', value: '🤝 Crowdfundable', inline: true });
        if (item.isDigital) embed.addFields({ name: 'Type', value: '💾 Digital', inline: true });
        if (item.quantity > 1) embed.addFields({ name: 'Quantity', value: `${item.quantity}`, inline: true });
        if (item.imageUrl) embed.setThumbnail(item.imageUrl);

        await channel.send({ embeds: [embed], components: [itemButtons(item, username)] });
    }
}

// ─── Item Removed ────────────────────────────────────────────────
async function postRemovedItemNotifications(channel, username, items) {
    const { displayName, avatarUrl, url } = await getProfileInfo(username);

    for (const item of items) {
        const embed = new EmbedBuilder()
            .setColor(0x6B7280)
            .setAuthor({ name: displayName, iconURL: avatarUrl, url })
            .setTitle('🗑️ Item Removed from Wishlist')
            .setDescription(`**${item.name}**`)
            .addFields({ name: 'Status', value: 'Removed or gifted', inline: true })
            .setTimestamp();

        await channel.send({ embeds: [embed], components: [wishlistButton(username)] });
    }
}

// ─── Gift Received ───────────────────────────────────────────────
async function postGiftNotifications(channel, username, gifts) {
    const { displayName, avatarUrl, url } = await getProfileInfo(username);

    for (const gift of gifts) {
        const gifterNames = gift.gifters.map(g => `**${g.username}**`).join(', ') || '**Anonymous**';

        const embed = new EmbedBuilder()
            .setColor(0x2ECC71)
            .setAuthor({ name: displayName, iconURL: avatarUrl, url })
            .setTitle('🎁 Gift Received!')
            .setDescription(`${gifterNames} gifted **${gift.name}**`)
            .addFields(
                { name: 'Value', value: gift.totalFormatted, inline: true },
                { name: 'Status', value: gift.status, inline: true },
            )
            .setTimestamp(gift.purchasedAt || new Date());

        if (gift.isCrowdfunded) {
            embed.addFields({ name: 'Crowdfunded', value: `${gift.contributorCount} contributor${gift.contributorCount !== 1 ? 's' : ''}`, inline: true });
        }
        if (gift.imageUrl) embed.setThumbnail(gift.imageUrl);

        await channel.send({ embeds: [embed], components: [wishlistButton(username)] });
    }
}

// ─── Contribution ────────────────────────────────────────────────
async function postContributionNotifications(channel, username, updates) {
    const { displayName, avatarUrl, url } = await getProfileInfo(username);

    for (const u of updates) {
        const embed = new EmbedBuilder()
            .setColor(0xF59E0B)
            .setAuthor({ name: displayName, iconURL: avatarUrl, url })
            .setTitle('💰 New Contribution')
            .setDescription(`**${u.name}**`)
            .setURL(`https://throne.com/${username.toLowerCase()}/item/${u.id || ''}`)
            .addFields(
                { name: 'Contributors', value: `${u.previousContributorCount} → ${u.contributorCount}`, inline: true },
                { name: 'Value', value: u.totalFormatted, inline: true },
                { name: 'Status', value: u.status, inline: true },
            )
            .setTimestamp();

        if (u.imageUrl) embed.setThumbnail(u.imageUrl);

        await channel.send({ embeds: [embed], components: [u.id ? itemButtons(u, username) : wishlistButton(username)] });
    }
}

// ─── Price Change ────────────────────────────────────────────────
async function postPriceChangeNotifications(channel, username, changes, threshold) {
    const { displayName, avatarUrl, url } = await getProfileInfo(username);

    const significant = changes.filter(c => c.changePct >= threshold);
    if (significant.length === 0) return;

    for (const item of significant) {
        const arrow = item.direction === 'up' ? '📈' : '📉';
        const color = item.direction === 'up' ? 0xEF4444 : 0x22C55E;
        const oldFormatted = (item.oldPrice / 100).toLocaleString('en-US', { style: 'currency', currency: item.currency || 'USD' });

        const embed = new EmbedBuilder()
            .setColor(color)
            .setAuthor({ name: displayName, iconURL: avatarUrl, url })
            .setTitle(`${arrow} Price ${item.direction === 'up' ? 'Increased' : 'Decreased'}`)
            .setDescription(`**${item.name}**`)
            .setURL(`https://throne.com/${username.toLowerCase()}/item/${item.id}`)
            .addFields(
                { name: 'Old Price', value: oldFormatted, inline: true },
                { name: 'New Price', value: item.priceFormatted, inline: true },
                { name: 'Change', value: `${item.direction === 'up' ? '+' : '-'}${item.changePct}%`, inline: true },
            )
            .setTimestamp();

        if (item.imageUrl) embed.setThumbnail(item.imageUrl);

        await channel.send({ embeds: [embed], components: [itemButtons(item, username)] });
    }
}

// ─── Milestone ───────────────────────────────────────────────────
async function postMilestoneNotifications(channel, username, milestones) {
    const { displayName, avatarUrl, url } = await getProfileInfo(username);

    for (const milestone of milestones) {
        const embed = new EmbedBuilder()
            .setColor(0xFFD700)
            .setAuthor({ name: displayName, iconURL: avatarUrl, url })
            .setTimestamp();

        if (milestone.type === 'item_funded') {
            embed.setTitle('🎉 Fully Funded! 🏆')
                .setDescription(`**${milestone.value}** has been **100% funded**!`)
                .addFields({ name: 'Progress', value: '██████████ **100%**', inline: true });
        } else {
            embed.setTitle('🎉 Milestone!')
                .setDescription(`**${displayName}** ${milestone.message}`);
        }

        await channel.send({ embeds: [embed], components: [wishlistButton(username)] });
    }
}
