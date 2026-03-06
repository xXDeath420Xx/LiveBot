import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * RPG Shop Manager - Handles shop and trading
 */
class RPGShopManager {
    constructor(client, characterManager) {
        this.client = client;
        this.characterManager = characterManager;
    }

    /**
     * Get shop items for a zone
     */
    async getShopItems(zoneName = 'town') {
        try {
            const [items] = await pool.execute(
                `SELECT i.*, s.stock, s.price
                 FROM dnd_shops s
                 JOIN dnd_items i ON s.item_id = i.item_id
                 WHERE s.zone = ? AND (s.stock > 0 OR s.stock = -1)
                 ORDER BY i.item_type, i.rarity DESC, i.item_name`,
                [zoneName]
            );

            return items;
        } catch (error) {
            logger.error(`[RPGShopManager] Error getting shop items: ${error.message}`);
            return [];
        }
    }

    /**
     * Get all available zones with shops
     */
    async getShopZones() {
        try {
            const [zones] = await pool.execute(
                'SELECT DISTINCT zone FROM dnd_shops ORDER BY zone'
            );

            return zones.map(z => z.zone);
        } catch (error) {
            logger.error(`[RPGShopManager] Error getting shop zones: ${error.message}`);
            return [];
        }
    }

    /**
     * Get item price from shop
     */
    async getItemPrice(itemId, zoneName) {
        try {
            const [items] = await pool.execute(
                'SELECT price FROM dnd_shops WHERE item_id = ? AND zone = ?',
                [itemId, zoneName]
            );

            if (items.length === 0) {
                // If not in specific zone shop, check default price from items table
                const [defaultItems] = await pool.execute(
                    'SELECT value FROM dnd_items WHERE item_id = ?',
                    [itemId]
                );

                return defaultItems[0]?.value || 0;
            }

            return items[0].price;

        } catch (error) {
            logger.error(`[RPGShopManager] Error getting item price: ${error.message}`);
            return 0;
        }
    }

    /**
     * Buy an item from shop
     */
    async buyItem(characterId, itemId, quantity = 1, zoneName = 'town') {
        try {
            // Get character info
            const [chars] = await pool.execute(
                'SELECT gold, current_zone FROM dnd_characters WHERE character_id = ?',
                [characterId]
            );

            if (chars.length === 0) {
                throw new Error('Character not found');
            }

            const character = chars[0];

            // Use character's current zone if not specified
            const shopZone = zoneName || character.current_zone;

            // Get shop item info
            const [shopItems] = await pool.execute(
                `SELECT s.*, i.item_name, i.item_type
                 FROM dnd_shops s
                 JOIN dnd_items i ON s.item_id = i.item_id
                 WHERE s.item_id = ? AND s.zone = ?`,
                [itemId, shopZone]
            );

            if (shopItems.length === 0) {
                throw new Error('Item not available in this shop');
            }

            const shopItem = shopItems[0];

            // Check stock (if limited)
            if (shopItem.stock !== -1 && shopItem.stock < quantity) {
                throw new Error(`Not enough stock. Available: ${shopItem.stock}`);
            }

            // Calculate total cost
            const totalCost = shopItem.price * quantity;

            // Check if character has enough gold
            if (character.gold < totalCost) {
                throw new Error(`Not enough gold. Need ${totalCost}, have ${character.gold}`);
            }

            // Deduct gold
            await this.characterManager.removeGold(characterId, totalCost);

            // Add item to inventory
            await this.characterManager.addItem(characterId, itemId, quantity);

            // Update shop stock (if limited)
            if (shopItem.stock !== -1) {
                await pool.execute(
                    'UPDATE dnd_shops SET stock = stock - ? WHERE shop_id = ?',
                    [quantity, shopItem.shop_id]
                );
            }

            logger.info(`[RPGShopManager] Character ${characterId} bought ${quantity}x ${shopItem.item_name} for ${totalCost} gold`);

            return {
                itemName: shopItem.item_name,
                quantity,
                totalCost,
                remainingGold: character.gold - totalCost
            };

        } catch (error) {
            logger.error(`[RPGShopManager] Error buying item: ${error.message}`);
            throw error;
        }
    }

    /**
     * Sell an item to shop
     */
    async sellItem(characterId, itemId, quantity = 1) {
        try {
            // Get item info from inventory
            const [inventoryItems] = await pool.execute(
                `SELECT i.*, inv.quantity, inv.equipped
                 FROM dnd_inventory inv
                 JOIN dnd_items i ON inv.item_id = i.item_id
                 WHERE inv.character_id = ? AND inv.item_id = ?`,
                [characterId, itemId]
            );

            if (inventoryItems.length === 0) {
                throw new Error('Item not found in inventory');
            }

            const item = inventoryItems[0];

            // Check if character has enough items
            if (item.quantity < quantity) {
                throw new Error(`Not enough items. You have ${item.quantity}, trying to sell ${quantity}`);
            }

            // Cannot sell equipped items
            if (item.equipped) {
                throw new Error('Cannot sell equipped items. Unequip it first.');
            }

            // Calculate sell price (usually 50% of value)
            const sellPrice = Math.floor(item.value * 0.5);
            const totalGold = sellPrice * quantity;

            // Remove item from inventory
            await this.characterManager.removeItem(characterId, itemId, quantity);

            // Add gold
            await this.characterManager.addGold(characterId, totalGold);

            logger.info(`[RPGShopManager] Character ${characterId} sold ${quantity}x ${item.item_name} for ${totalGold} gold`);

            return {
                itemName: item.item_name,
                quantity,
                totalGold,
                sellPrice
            };

        } catch (error) {
            logger.error(`[RPGShopManager] Error selling item: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get item details
     */
    async getItemDetails(itemId) {
        try {
            const [items] = await pool.execute(
                'SELECT * FROM dnd_items WHERE item_id = ?',
                [itemId]
            );

            return items[0] || null;
        } catch (error) {
            logger.error(`[RPGShopManager] Error getting item details: ${error.message}`);
            return null;
        }
    }

    /**
     * Search for items by name
     */
    async searchItems(searchTerm) {
        try {
            const [items] = await pool.execute(
                'SELECT * FROM dnd_items WHERE item_name LIKE ? ORDER BY item_type, rarity DESC',
                [`%${searchTerm}%`]
            );

            return items;
        } catch (error) {
            logger.error(`[RPGShopManager] Error searching items: ${error.message}`);
            return [];
        }
    }

    /**
     * Get items by type
     */
    async getItemsByType(itemType) {
        try {
            const [items] = await pool.execute(
                'SELECT * FROM dnd_items WHERE item_type = ? ORDER BY rarity DESC, item_name',
                [itemType]
            );

            return items;
        } catch (error) {
            logger.error(`[RPGShopManager] Error getting items by type: ${error.message}`);
            return [];
        }
    }

    /**
     * Get items by rarity
     */
    async getItemsByRarity(rarity) {
        try {
            const [items] = await pool.execute(
                'SELECT * FROM dnd_items WHERE rarity = ? ORDER BY item_type, item_name',
                [rarity]
            );

            return items;
        } catch (error) {
            logger.error(`[RPGShopManager] Error getting items by rarity: ${error.message}`);
            return [];
        }
    }

    /**
     * Restock shop (admin function)
     */
    async restockShop(zoneName = null) {
        try {
            if (zoneName) {
                // Restock specific zone
                await pool.execute(
                    `UPDATE dnd_shops
                     SET stock = CASE
                         WHEN stock = -1 THEN -1
                         ELSE 10
                     END
                     WHERE zone = ?`,
                    [zoneName]
                );
            } else {
                // Restock all zones
                await pool.execute(
                    `UPDATE dnd_shops
                     SET stock = CASE
                         WHEN stock = -1 THEN -1
                         ELSE 10
                     END`
                );
            }

            logger.info(`[RPGShopManager] Restocked shop${zoneName ? ` in ${zoneName}` : 's'}`);
            return true;

        } catch (error) {
            logger.error(`[RPGShopManager] Error restocking shop: ${error.message}`);
            return false;
        }
    }

    /**
     * Add item to shop (admin function)
     */
    async addItemToShop(itemId, zoneName, price, stock = -1) {
        try {
            // Check if item exists
            const item = await this.getItemDetails(itemId);

            if (!item) {
                throw new Error('Item not found');
            }

            // Check if item already in shop
            const [existing] = await pool.execute(
                'SELECT * FROM dnd_shops WHERE item_id = ? AND zone = ?',
                [itemId, zoneName]
            );

            if (existing.length > 0) {
                // Update existing
                await pool.execute(
                    'UPDATE dnd_shops SET price = ?, stock = ? WHERE item_id = ? AND zone = ?',
                    [price, stock, itemId, zoneName]
                );
            } else {
                // Add new
                await pool.execute(
                    'INSERT INTO dnd_shops (zone, item_id, price, stock) VALUES (?, ?, ?, ?)',
                    [zoneName, itemId, price, stock]
                );
            }

            logger.info(`[RPGShopManager] Added/updated item ${itemId} in ${zoneName} shop`);
            return true;

        } catch (error) {
            logger.error(`[RPGShopManager] Error adding item to shop: ${error.message}`);
            throw error;
        }
    }

    /**
     * Remove item from shop (admin function)
     */
    async removeItemFromShop(itemId, zoneName) {
        try {
            await pool.execute(
                'DELETE FROM dnd_shops WHERE item_id = ? AND zone = ?',
                [itemId, zoneName]
            );

            logger.info(`[RPGShopManager] Removed item ${itemId} from ${zoneName} shop`);
            return true;

        } catch (error) {
            logger.error(`[RPGShopManager] Error removing item from shop: ${error.message}`);
            return false;
        }
    }

    /**
     * Create a new item (admin function)
     */
    async createItem(itemData) {
        try {
            const {
                item_name,
                item_type,
                rarity,
                value,
                description,
                damage_bonus = 0,
                defense_bonus = 0,
                heal_amount = 0,
                mana_amount = 0,
                stat_bonuses = null
            } = itemData;

            const [result] = await pool.execute(
                `INSERT INTO dnd_items (item_name, item_type, rarity, value, description, damage_bonus, defense_bonus, heal_amount, mana_amount, stat_bonuses)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [item_name, item_type, rarity, value, description, damage_bonus, defense_bonus, heal_amount, mana_amount, stat_bonuses]
            );

            logger.info(`[RPGShopManager] Created new item: ${item_name} (ID: ${result.insertId})`);
            return result.insertId;

        } catch (error) {
            logger.error(`[RPGShopManager] Error creating item: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get shop statistics
     */
    async getShopStats(zoneName = null) {
        try {
            let query = `
                SELECT
                    COUNT(*) as total_items,
                    SUM(CASE WHEN stock > 0 OR stock = -1 THEN 1 ELSE 0 END) as available_items,
                    AVG(price) as avg_price,
                    MIN(price) as min_price,
                    MAX(price) as max_price
                FROM dnd_shops
            `;

            const params = [];

            if (zoneName) {
                query += ' WHERE zone = ?';
                params.push(zoneName);
            }

            const [stats] = await pool.execute(query, params);

            return stats[0] || {
                total_items: 0,
                available_items: 0,
                avg_price: 0,
                min_price: 0,
                max_price: 0
            };

        } catch (error) {
            logger.error(`[RPGShopManager] Error getting shop stats: ${error.message}`);
            return {
                total_items: 0,
                available_items: 0,
                avg_price: 0,
                min_price: 0,
                max_price: 0
            };
        }
    }
}

export default RPGShopManager;
