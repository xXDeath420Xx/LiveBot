import db from '../utils/db.js';
import logger from '../utils/logger.js';
import { getOrCreateUserEconomy, getEconomyConfig, formatMoney, logTransaction } from './economy-manager.js';

// ============================================
// SHOP ITEM OPERATIONS
// ============================================

/**
 * Get all shop items for a guild
 * @param {string} guildId - Guild ID
 * @param {string} category - Item category filter
 * @param {number} limit - Maximum items to return
 * @returns {Promise<Array>} Shop items
 */
export async function getShopItems(guildId, category = 'all', limit = 25) {
    let query = `
        SELECT s.*,
               COALESCE((SELECT SUM(quantity) FROM user_inventory WHERE item_id = s.id AND guild_id = ?), 0) as total_owned
        FROM shop_items s
        WHERE (s.guild_id = ? OR s.guild_id IS NULL) AND s.is_active = TRUE
    `;
    const params = [guildId, guildId];

    if (category !== 'all') {
        query += ' AND s.item_type = ?';
        params.push(category);
    }

    query += ' ORDER BY s.item_type, s.price ASC LIMIT ?';
    params.push(limit);

    const [items] = await db.execute(query, params);
    return items;
}

/**
 * Get a specific shop item
 * @param {number} itemId - Item ID
 * @param {string} guildId - Guild ID
 * @returns {Promise<Object|null>} Shop item
 */
export async function getShopItem(itemId, guildId) {
    const [rows] = await db.execute(
        `SELECT s.*,
                COALESCE((SELECT SUM(quantity) FROM user_inventory WHERE item_id = s.id AND guild_id = ?), 0) as total_owned
         FROM shop_items s
         WHERE s.id = ? AND (s.guild_id = ? OR s.guild_id IS NULL)`,
        [guildId, itemId, guildId]
    );

    return rows && rows.length > 0 ? rows[0] : null;
}

/**
 * Create a new shop item
 * @param {string} guildId - Guild ID
 * @param {Object} itemData - Item data
 * @returns {Promise<Object>} Created item
 */
export async function createShopItem(guildId, itemData) {
    const {
        name,
        description,
        emoji,
        type,
        price,
        sellValue = 0,
        stock = -1,
        maxPerUser = -1,
        requiredLevel = 0,
        roleId = null,
        usable = false,
        tradeable = true,
        sellable = true
    } = itemData;

    const [result] = await db.execute(
        `INSERT INTO shop_items (guild_id, item_name, item_description, item_emoji, item_type, price, sell_value, stock, max_per_user, required_level, role_id, usable, tradeable, sellable, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE)`,
        [guildId, name, description, emoji, type, price, sellValue, stock, maxPerUser, requiredLevel, roleId, usable, tradeable, sellable]
    );

    return await getShopItem(result.insertId, guildId);
}

/**
 * Update a shop item
 * @param {number} itemId - Item ID
 * @param {string} guildId - Guild ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated item
 */
export async function updateShopItem(itemId, guildId, updates) {
    const allowedFields = ['item_name', 'item_description', 'item_emoji', 'price', 'sell_value', 'stock', 'max_per_user', 'required_level', 'role_id', 'usable', 'tradeable', 'sellable', 'is_active'];

    const updateFields = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
            updateFields.push(`${key} = ?`);
            values.push(value);
        }
    }

    if (updateFields.length === 0) {
        throw new Error('No valid fields to update');
    }

    values.push(itemId, guildId);

    await db.execute(
        `UPDATE shop_items SET ${updateFields.join(', ')} WHERE id = ? AND guild_id = ?`,
        values
    );

    return await getShopItem(itemId, guildId);
}

/**
 * Delete a shop item
 * @param {number} itemId - Item ID
 * @param {string} guildId - Guild ID
 * @returns {Promise<boolean>} Success status
 */
export async function deleteShopItem(itemId, guildId) {
    await db.execute(
        'UPDATE shop_items SET is_active = FALSE WHERE id = ? AND guild_id = ?',
        [itemId, guildId]
    );

    return true;
}

// ============================================
// INVENTORY OPERATIONS
// ============================================

/**
 * Get user's inventory
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Inventory items
 */
export async function getUserInventory(guildId, userId) {
    const [items] = await db.execute(
        `SELECT ui.*, si.item_name, si.item_description, si.item_emoji, si.item_type, si.sell_value, si.usable, si.tradeable, si.sellable
         FROM user_inventory ui
         JOIN shop_items si ON ui.item_id = si.id
         WHERE ui.guild_id = ? AND ui.user_id = ?
         ORDER BY si.item_type, si.item_name`,
        [guildId, userId]
    );

    return items;
}

/**
 * Get user's quantity of a specific item
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} itemId - Item ID
 * @returns {Promise<number>} Quantity owned
 */
export async function getUserItemQuantity(guildId, userId, itemId) {
    const [rows] = await db.execute(
        'SELECT quantity FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?',
        [guildId, userId, itemId]
    );

    return rows && rows.length > 0 ? rows[0].quantity : 0;
}

/**
 * Add item to user's inventory
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} itemId - Item ID
 * @param {number} quantity - Quantity to add
 * @returns {Promise<boolean>} Success status
 */
export async function addItemToInventory(guildId, userId, itemId, quantity = 1) {
    const [existing] = await db.execute(
        'SELECT * FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?',
        [guildId, userId, itemId]
    );

    if (existing && existing.length > 0) {
        await db.execute(
            'UPDATE user_inventory SET quantity = quantity + ? WHERE guild_id = ? AND user_id = ? AND item_id = ?',
            [quantity, guildId, userId, itemId]
        );
    } else {
        await db.execute(
            'INSERT INTO user_inventory (guild_id, user_id, item_id, quantity) VALUES (?, ?, ?, ?)',
            [guildId, userId, itemId, quantity]
        );
    }

    return true;
}

/**
 * Remove item from user's inventory
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} itemId - Item ID
 * @param {number} quantity - Quantity to remove
 * @returns {Promise<boolean>} Success status
 */
export async function removeItemFromInventory(guildId, userId, itemId, quantity = 1) {
    const currentQuantity = await getUserItemQuantity(guildId, userId, itemId);

    if (currentQuantity < quantity) {
        throw new Error('Insufficient item quantity');
    }

    if (currentQuantity === quantity) {
        await db.execute(
            'DELETE FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?',
            [guildId, userId, itemId]
        );
    } else {
        await db.execute(
            'UPDATE user_inventory SET quantity = quantity - ? WHERE guild_id = ? AND user_id = ? AND item_id = ?',
            [quantity, guildId, userId, itemId]
        );
    }

    return true;
}

// ============================================
// PURCHASE & SELL OPERATIONS
// ============================================

/**
 * Purchase an item from the shop
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} itemId - Item ID
 * @param {number} quantity - Quantity to purchase
 * @returns {Promise<Object>} Purchase result
 */
export async function purchaseItem(guildId, userId, itemId, quantity = 1) {
    const config = await getEconomyConfig(guildId);
    const item = await getShopItem(itemId, guildId);

    if (!item) {
        throw new Error('Item not found or is not available for purchase');
    }

    // Check level requirement
    if (item.required_level > 0) {
        const [levelRows] = await db.execute(
            'SELECT level FROM user_levels WHERE guild_id = ? AND user_id = ?',
            [guildId, userId]
        );

        if (!levelRows || levelRows.length === 0 || levelRows[0].level < item.required_level) {
            throw new Error(`You need to be level ${item.required_level} to purchase this item`);
        }
    }

    // Check prerequisite item
    if (item.required_item_id) {
        const hasRequired = await getUserItemQuantity(guildId, userId, item.required_item_id);
        if (hasRequired === 0) {
            throw new Error('You need to own a prerequisite item to purchase this');
        }
    }

    // Check stock
    if (item.stock !== -1 && item.stock < quantity) {
        throw new Error(`Not enough stock available. Only ${item.stock} left in stock`);
    }

    // Check max per user
    if (item.max_per_user !== -1) {
        const currentOwned = await getUserItemQuantity(guildId, userId, itemId);
        if (currentOwned + quantity > item.max_per_user) {
            throw new Error(`You can only own a maximum of ${item.max_per_user} of this item. You currently own ${currentOwned}`);
        }
    }

    // Get user economy
    const userEconomy = await getOrCreateUserEconomy(guildId, userId, config);
    const totalCost = item.price * quantity;

    if (userEconomy.wallet < totalCost) {
        throw new Error(`You don't have enough ${config.currency_name}! You need ${formatMoney(totalCost, config)} but only have ${formatMoney(userEconomy.wallet, config)}`);
    }

    // Process purchase using transaction
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // Deduct money
        await connection.execute(
            'UPDATE user_economy SET wallet = wallet - ?, total_spent = total_spent + ? WHERE guild_id = ? AND user_id = ?',
            [totalCost, totalCost, guildId, userId]
        );

        // Add item to inventory
        const [existingItem] = await connection.execute(
            'SELECT * FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?',
            [guildId, userId, itemId]
        );

        if (existingItem && existingItem.length > 0) {
            await connection.execute(
                'UPDATE user_inventory SET quantity = quantity + ? WHERE guild_id = ? AND user_id = ? AND item_id = ?',
                [quantity, guildId, userId, itemId]
            );
        } else {
            await connection.execute(
                'INSERT INTO user_inventory (guild_id, user_id, item_id, quantity) VALUES (?, ?, ?, ?)',
                [guildId, userId, itemId, quantity]
            );
        }

        // Update stock if not unlimited
        if (item.stock !== -1) {
            await connection.execute(
                'UPDATE shop_items SET stock = stock - ? WHERE id = ?',
                [quantity, itemId]
            );
        }

        await connection.commit();

        // Log transaction (outside of transaction)
        await logTransaction(
            guildId,
            userId,
            'shop_buy',
            -totalCost,
            userEconomy.wallet,
            userEconomy.wallet - totalCost,
            `Purchased ${quantity}x ${item.item_name}`,
            null,
            itemId
        );

        return {
            item,
            quantity,
            totalCost,
            newBalance: userEconomy.wallet - totalCost
        };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Sell an item back to the shop
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} itemId - Item ID
 * @param {number} quantity - Quantity to sell
 * @returns {Promise<Object>} Sell result
 */
export async function sellItem(guildId, userId, itemId, quantity = 1) {
    const config = await getEconomyConfig(guildId);
    const item = await getShopItem(itemId, guildId);

    if (!item) {
        throw new Error('Item not found');
    }

    if (!item.sellable) {
        throw new Error(`${item.item_name} cannot be sold back to the shop`);
    }

    if (item.sell_value <= 0) {
        throw new Error(`${item.item_name} has no sell value`);
    }

    // Check user inventory
    const currentQuantity = await getUserItemQuantity(guildId, userId, itemId);

    if (currentQuantity < quantity) {
        throw new Error(`You don't have enough of this item to sell. You own: ${currentQuantity}`);
    }

    // Get user economy
    const userEconomy = await getOrCreateUserEconomy(guildId, userId, config);
    const totalValue = item.sell_value * quantity;

    // Process sale using transaction
    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        // Add money
        await connection.execute(
            'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
            [totalValue, totalValue, guildId, userId]
        );

        // Remove item from inventory
        if (currentQuantity === quantity) {
            await connection.execute(
                'DELETE FROM user_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?',
                [guildId, userId, itemId]
            );
        } else {
            await connection.execute(
                'UPDATE user_inventory SET quantity = quantity - ? WHERE guild_id = ? AND user_id = ? AND item_id = ?',
                [quantity, guildId, userId, itemId]
            );
        }

        // Restore stock if not unlimited
        if (item.stock !== -1) {
            await connection.execute(
                'UPDATE shop_items SET stock = stock + ? WHERE id = ?',
                [quantity, itemId]
            );
        }

        await connection.commit();

        // Log transaction (outside of transaction)
        await logTransaction(
            guildId,
            userId,
            'shop_sell',
            totalValue,
            userEconomy.wallet,
            userEconomy.wallet + totalValue,
            `Sold ${quantity}x ${item.item_name}`,
            null,
            itemId
        );

        return {
            item,
            quantity,
            totalValue,
            newBalance: userEconomy.wallet + totalValue
        };
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

/**
 * Use a consumable item
 * @param {string} guildId - Guild ID
 * @param {string} userId - User ID
 * @param {number} itemId - Item ID
 * @returns {Promise<Object>} Use result
 */
export async function useItem(guildId, userId, itemId) {
    const item = await getShopItem(itemId, guildId);

    if (!item) {
        throw new Error('Item not found');
    }

    if (!item.usable) {
        throw new Error(`${item.item_name} is not usable`);
    }

    const currentQuantity = await getUserItemQuantity(guildId, userId, itemId);

    if (currentQuantity === 0) {
        throw new Error('You don\'t own this item');
    }

    // Remove one from inventory
    await removeItemFromInventory(guildId, userId, itemId, 1);

    // Return the item for custom effects to be handled by the command
    return {
        item,
        remainingQuantity: currentQuantity - 1
    };
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get category display name
 * @param {string} type - Category type
 * @returns {string} Display name
 */
export function getCategoryName(type) {
    const categories = {
        'role': 'Roles',
        'consumable': 'Consumables',
        'collectible': 'Collectibles',
        'tool': 'Tools',
        'decoration': 'Decorations'
    };
    return categories[type] || type;
}

/**
 * Get category emoji
 * @param {string} type - Category type
 * @returns {string} Emoji
 */
export function getTypeEmoji(type) {
    const emojis = {
        'role': '👑',
        'consumable': '🍕',
        'collectible': '💎',
        'tool': '🔧',
        'decoration': '🎨'
    };
    return emojis[type] || '📦';
}

// ============================================
// EXPORTS
// ============================================

export default {
    getShopItems,
    getShopItem,
    createShopItem,
    updateShopItem,
    deleteShopItem,
    getUserInventory,
    getUserItemQuantity,
    addItemToInventory,
    removeItemFromInventory,
    purchaseItem,
    sellItem,
    useItem,
    getCategoryName,
    getTypeEmoji
};
