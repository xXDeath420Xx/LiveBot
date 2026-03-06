/**
 * Vault Routes
 * Secure storage for cash and items protected from raids
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { VAULT_CAPACITY } from '../game/raid-system.js';

const router = Router();

/**
 * Get or create player vault
 */
async function getOrCreateVault(playerId) {
    const [[vault]] = await pool.execute(
        'SELECT * FROM cfx_player_vault WHERE player_id = ?',
        [playerId]
    );

    if (!vault) {
        await pool.execute(
            'INSERT INTO cfx_player_vault (player_id, vault_level, vault_cash) VALUES (?, 0, 0)',
            [playerId]
        );
        return { player_id: playerId, vault_level: 0, vault_cash: 0 };
    }

    return vault;
}

/**
 * GET /vault
 * Get vault status and contents
 */
router.get('/', async (req, res) => {
    try {
        const vault = await getOrCreateVault(req.player.id);
        const capacity = VAULT_CAPACITY[vault.vault_level] || VAULT_CAPACITY[0];

        // Get vault inventory
        const [inventory] = await pool.execute(
            `SELECT vi.*, s.name as strain_name, s.slug, s.rarity
             FROM cfx_vault_inventory vi
             JOIN cfx_strains s ON vi.strain_id = s.id
             WHERE vi.player_id = ? AND vi.quantity > 0
             ORDER BY vi.stored_at DESC`,
            [req.player.id]
        );

        // Get vault seeds
        const [seeds] = await pool.execute(
            `SELECT vs.*, s.name as strain_name, s.rarity
             FROM cfx_vault_seeds vs
             JOIN cfx_strains s ON vs.strain_id = s.id
             WHERE vs.player_id = ? AND vs.quantity > 0
             ORDER BY s.rarity DESC, s.name`,
            [req.player.id]
        );

        // Calculate used slots (items + seeds/10)
        const itemSlots = inventory.reduce((sum, i) => sum + 1, 0);
        const seedSlots = Math.ceil(seeds.reduce((sum, s) => sum + s.quantity, 0) / 10);
        const usedSlots = itemSlots + seedSlots;

        // Get next upgrade cost
        const nextLevel = vault.vault_level + 1;
        const nextUpgrade = vault.vault_level < 10 ? VAULT_CAPACITY[nextLevel] : null;

        res.json({
            success: true,
            vault: {
                level: vault.vault_level,
                cash: parseFloat(vault.vault_cash),
                maxCash: capacity.cash,
                usedSlots: usedSlots,
                maxSlots: capacity.slots,
                inventory: inventory.map(i => ({
                    id: i.id,
                    strainId: i.strain_id,
                    strainName: i.strain_name,
                    strainSlug: i.slug,
                    rarity: i.rarity,
                    quantity: i.quantity,
                    quality: i.quality,
                    storedAt: i.stored_at
                })),
                seeds: seeds.map(s => ({
                    id: s.id,
                    strainId: s.strain_id,
                    strainName: s.strain_name,
                    rarity: s.rarity,
                    quantity: s.quantity
                })),
                nextUpgrade: nextUpgrade ? {
                    level: nextLevel,
                    cost: nextUpgrade.cost,
                    cashCapacity: nextUpgrade.cash,
                    slotCapacity: nextUpgrade.slots
                } : null
            }
        });

    } catch (error) {
        logger.error('[Vault] Get failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to get vault', code: 'ERROR' });
    }
});

/**
 * POST /vault/upgrade
 * Purchase vault upgrade
 */
router.post('/upgrade', async (req, res) => {
    try {
        const vault = await getOrCreateVault(req.player.id);

        if (vault.vault_level >= 10) {
            return res.status(400).json({ error: 'Vault at maximum level', code: 'MAX_LEVEL' });
        }

        const nextLevel = vault.vault_level + 1;
        const upgradeCost = VAULT_CAPACITY[nextLevel].cost;

        // Check player cash
        const [[player]] = await pool.execute(
            'SELECT cash FROM cfx_players WHERE id = ?',
            [req.player.id]
        );

        if (parseFloat(player.cash) < upgradeCost) {
            return res.status(400).json({ error: 'Insufficient cash', code: 'INSUFFICIENT_FUNDS' });
        }

        // Deduct cash and upgrade vault atomically
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.execute(
                'UPDATE cfx_players SET cash = cash - ? WHERE id = ?',
                [upgradeCost, req.player.id]
            );
            await conn.execute(
                'UPDATE cfx_player_vault SET vault_level = ? WHERE player_id = ?',
                [nextLevel, req.player.id]
            );
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }

        const newCapacity = VAULT_CAPACITY[nextLevel];

        logger.info('[Vault] Upgraded', {
            playerId: req.player.id,
            newLevel: nextLevel,
            cost: upgradeCost
        });

        res.json({
            success: true,
            newLevel: nextLevel,
            cashCapacity: newCapacity.cash,
            slotCapacity: newCapacity.slots,
            cost: upgradeCost
        });

    } catch (error) {
        logger.error('[Vault] Upgrade failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to upgrade vault', code: 'ERROR' });
    }
});

/**
 * POST /vault/deposit-cash
 * Deposit cash into vault
 */
router.post('/deposit-cash', async (req, res) => {
    try {
        const { amount } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount', code: 'INVALID_AMOUNT' });
        }

        const vault = await getOrCreateVault(req.player.id);
        const capacity = VAULT_CAPACITY[vault.vault_level] || VAULT_CAPACITY[0];

        if (capacity.cash === 0) {
            return res.status(400).json({ error: 'No vault purchased', code: 'NO_VAULT' });
        }

        const currentVaultCash = parseFloat(vault.vault_cash);
        const availableSpace = capacity.cash - currentVaultCash;

        if (amount > availableSpace) {
            return res.status(400).json({
                error: 'Exceeds vault capacity',
                code: 'CAPACITY_EXCEEDED',
                availableSpace
            });
        }

        // Check player has enough cash
        const [[player]] = await pool.execute(
            'SELECT cash FROM cfx_players WHERE id = ?',
            [req.player.id]
        );

        if (parseFloat(player.cash) < amount) {
            return res.status(400).json({ error: 'Insufficient cash', code: 'INSUFFICIENT_FUNDS' });
        }

        // Transfer cash atomically
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            await conn.execute(
                'UPDATE cfx_players SET cash = cash - ? WHERE id = ?',
                [amount, req.player.id]
            );
            await conn.execute(
                'UPDATE cfx_player_vault SET vault_cash = vault_cash + ? WHERE player_id = ?',
                [amount, req.player.id]
            );
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }

        res.json({
            success: true,
            deposited: amount,
            newVaultCash: currentVaultCash + amount,
            newPlayerCash: parseFloat(player.cash) - amount
        });

    } catch (error) {
        logger.error('[Vault] Deposit cash failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to deposit cash', code: 'ERROR' });
    }
});

/**
 * POST /vault/withdraw-cash
 * Withdraw cash from vault
 */
router.post('/withdraw-cash', async (req, res) => {
    try {
        const { amount } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid amount', code: 'INVALID_AMOUNT' });
        }

        const vault = await getOrCreateVault(req.player.id);
        const vaultCash = parseFloat(vault.vault_cash);

        if (amount > vaultCash) {
            return res.status(400).json({ error: 'Insufficient vault cash', code: 'INSUFFICIENT_FUNDS' });
        }

        // Transfer cash atomically
        const conn = await pool.getConnection();
        let newPlayerCash;
        try {
            await conn.beginTransaction();
            await conn.execute(
                'UPDATE cfx_player_vault SET vault_cash = vault_cash - ? WHERE player_id = ?',
                [amount, req.player.id]
            );
            await conn.execute(
                'UPDATE cfx_players SET cash = cash + ? WHERE id = ?',
                [amount, req.player.id]
            );
            const [[player]] = await conn.execute(
                'SELECT cash FROM cfx_players WHERE id = ?',
                [req.player.id]
            );
            newPlayerCash = parseFloat(player.cash);
            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }

        res.json({
            success: true,
            withdrawn: amount,
            newVaultCash: vaultCash - amount,
            newPlayerCash
        });

    } catch (error) {
        logger.error('[Vault] Withdraw cash failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to withdraw cash', code: 'ERROR' });
    }
});

/**
 * POST /vault/deposit-item
 * Deposit inventory item into vault
 */
router.post('/deposit-item', async (req, res) => {
    try {
        const { inventoryId, quantity } = req.body;

        if (!inventoryId) {
            return res.status(400).json({ error: 'Inventory ID required', code: 'NO_ID' });
        }

        const vault = await getOrCreateVault(req.player.id);
        const capacity = VAULT_CAPACITY[vault.vault_level] || VAULT_CAPACITY[0];

        if (capacity.slots === 0) {
            return res.status(400).json({ error: 'No vault purchased', code: 'NO_VAULT' });
        }

        // Get inventory item
        const [[item]] = await pool.execute(
            'SELECT * FROM cfx_inventory WHERE id = ? AND player_id = ?',
            [inventoryId, req.player.id]
        );

        if (!item) {
            return res.status(404).json({ error: 'Item not found', code: 'NOT_FOUND' });
        }

        const depositQty = quantity || item.quantity;
        if (depositQty > item.quantity) {
            return res.status(400).json({ error: 'Insufficient quantity', code: 'INSUFFICIENT' });
        }

        // Check vault slot capacity
        const [[slotCount]] = await pool.execute(
            'SELECT COUNT(*) as count FROM cfx_vault_inventory WHERE player_id = ?',
            [req.player.id]
        );

        // Use transaction with FOR UPDATE locks to prevent duplication exploits
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Re-verify item with lock
            const [[lockedItem]] = await conn.execute(
                'SELECT * FROM cfx_inventory WHERE id = ? AND player_id = ? FOR UPDATE',
                [inventoryId, req.player.id]
            );

            if (!lockedItem || lockedItem.quantity < depositQty) {
                await conn.rollback();
                return res.status(400).json({ error: 'Insufficient quantity', code: 'INSUFFICIENT' });
            }

            // Check if item already exists in vault with same quality
            const [[existingVault]] = await conn.execute(
                'SELECT * FROM cfx_vault_inventory WHERE player_id = ? AND strain_id = ? AND quality = ? FOR UPDATE',
                [req.player.id, lockedItem.strain_id, lockedItem.quality]
            );

            if (!existingVault && slotCount.count >= capacity.slots) {
                await conn.rollback();
                return res.status(400).json({ error: 'Vault slots full', code: 'SLOTS_FULL' });
            }

            // Remove from inventory
            if (depositQty >= lockedItem.quantity) {
                await conn.execute('DELETE FROM cfx_inventory WHERE id = ?', [inventoryId]);
            } else {
                await conn.execute(
                    'UPDATE cfx_inventory SET quantity = quantity - ? WHERE id = ?',
                    [depositQty, inventoryId]
                );
            }

            // Add to vault
            if (existingVault) {
                await conn.execute(
                    'UPDATE cfx_vault_inventory SET quantity = quantity + ? WHERE id = ?',
                    [depositQty, existingVault.id]
                );
            } else {
                await conn.execute(
                    `INSERT INTO cfx_vault_inventory (player_id, strain_id, quantity, quality)
                     VALUES (?, ?, ?, ?)`,
                    [req.player.id, lockedItem.strain_id, depositQty, lockedItem.quality]
                );
            }

            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }

        res.json({
            success: true,
            deposited: depositQty,
            strainId: item.strain_id,
            quality: item.quality
        });

    } catch (error) {
        logger.error('[Vault] Deposit item failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to deposit item', code: 'ERROR' });
    }
});

/**
 * POST /vault/withdraw-item
 * Withdraw item from vault to inventory
 */
router.post('/withdraw-item', async (req, res) => {
    try {
        const { vaultItemId, quantity } = req.body;

        if (!vaultItemId) {
            return res.status(400).json({ error: 'Vault item ID required', code: 'NO_ID' });
        }

        // Get vault item
        const [[vaultItem]] = await pool.execute(
            'SELECT * FROM cfx_vault_inventory WHERE id = ? AND player_id = ?',
            [vaultItemId, req.player.id]
        );

        if (!vaultItem) {
            return res.status(404).json({ error: 'Vault item not found', code: 'NOT_FOUND' });
        }

        const withdrawQty = quantity || vaultItem.quantity;
        if (withdrawQty > vaultItem.quantity) {
            return res.status(400).json({ error: 'Insufficient quantity', code: 'INSUFFICIENT' });
        }

        // Use transaction with FOR UPDATE locks to prevent duplication exploits
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Re-verify vault item with lock
            const [[lockedVaultItem]] = await conn.execute(
                'SELECT * FROM cfx_vault_inventory WHERE id = ? AND player_id = ? FOR UPDATE',
                [vaultItemId, req.player.id]
            );

            if (!lockedVaultItem || lockedVaultItem.quantity < withdrawQty) {
                await conn.rollback();
                return res.status(400).json({ error: 'Insufficient quantity', code: 'INSUFFICIENT' });
            }

            // Remove from vault
            if (withdrawQty >= lockedVaultItem.quantity) {
                await conn.execute('DELETE FROM cfx_vault_inventory WHERE id = ?', [vaultItemId]);
            } else {
                await conn.execute(
                    'UPDATE cfx_vault_inventory SET quantity = quantity - ? WHERE id = ?',
                    [withdrawQty, vaultItemId]
                );
            }

            // Add to inventory (check for existing stack with same quality)
            const [[existingInv]] = await conn.execute(
                'SELECT * FROM cfx_inventory WHERE player_id = ? AND strain_id = ? AND quality = ? FOR UPDATE',
                [req.player.id, lockedVaultItem.strain_id, lockedVaultItem.quality]
            );

            if (existingInv) {
                await conn.execute(
                    'UPDATE cfx_inventory SET quantity = quantity + ? WHERE id = ?',
                    [withdrawQty, existingInv.id]
                );
            } else {
                await conn.execute(
                    `INSERT INTO cfx_inventory (player_id, strain_id, quantity, quality, source)
                     VALUES (?, ?, ?, ?, 'vault')`,
                    [req.player.id, lockedVaultItem.strain_id, withdrawQty, lockedVaultItem.quality]
                );
            }

            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }

        res.json({
            success: true,
            withdrawn: withdrawQty,
            strainId: vaultItem.strain_id,
            quality: vaultItem.quality
        });

    } catch (error) {
        logger.error('[Vault] Withdraw item failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to withdraw item', code: 'ERROR' });
    }
});

/**
 * POST /vault/deposit-seeds
 * Deposit seeds into vault
 */
router.post('/deposit-seeds', async (req, res) => {
    try {
        const { strainId, quantity } = req.body;

        if (!strainId || !quantity || quantity <= 0) {
            return res.status(400).json({ error: 'Strain ID and quantity required', code: 'INVALID_PARAMS' });
        }

        const vault = await getOrCreateVault(req.player.id);
        const capacity = VAULT_CAPACITY[vault.vault_level] || VAULT_CAPACITY[0];

        if (capacity.slots === 0) {
            return res.status(400).json({ error: 'No vault purchased', code: 'NO_VAULT' });
        }

        // Get player seeds
        const [[seeds]] = await pool.execute(
            'SELECT * FROM cfx_seed_inventory WHERE player_id = ? AND strain_id = ?',
            [req.player.id, strainId]
        );

        if (!seeds || seeds.quantity < quantity) {
            return res.status(400).json({ error: 'Insufficient seeds', code: 'INSUFFICIENT' });
        }

        // Use transaction to prevent duplication exploits
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Re-verify seeds with lock
            const [[lockedSeeds]] = await conn.execute(
                'SELECT * FROM cfx_seed_inventory WHERE player_id = ? AND strain_id = ? FOR UPDATE',
                [req.player.id, strainId]
            );

            if (!lockedSeeds || lockedSeeds.quantity < quantity) {
                await conn.rollback();
                return res.status(400).json({ error: 'Insufficient seeds', code: 'INSUFFICIENT' });
            }

            // Remove from seed inventory
            await conn.execute(
                'UPDATE cfx_seed_inventory SET quantity = quantity - ? WHERE player_id = ? AND strain_id = ?',
                [quantity, req.player.id, strainId]
            );

            // Add to vault seeds
            await conn.execute(
                `INSERT INTO cfx_vault_seeds (player_id, strain_id, quantity)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
                [req.player.id, strainId, quantity, quantity]
            );

            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }

        res.json({
            success: true,
            deposited: quantity,
            strainId
        });

    } catch (error) {
        logger.error('[Vault] Deposit seeds failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to deposit seeds', code: 'ERROR' });
    }
});

/**
 * POST /vault/withdraw-seeds
 * Withdraw seeds from vault
 */
router.post('/withdraw-seeds', async (req, res) => {
    try {
        const { strainId, quantity } = req.body;

        if (!strainId || !quantity || quantity <= 0) {
            return res.status(400).json({ error: 'Strain ID and quantity required', code: 'INVALID_PARAMS' });
        }

        // Get vault seeds
        const [[vaultSeeds]] = await pool.execute(
            'SELECT * FROM cfx_vault_seeds WHERE player_id = ? AND strain_id = ?',
            [req.player.id, strainId]
        );

        if (!vaultSeeds || vaultSeeds.quantity < quantity) {
            return res.status(400).json({ error: 'Insufficient vault seeds', code: 'INSUFFICIENT' });
        }

        // Use transaction to prevent duplication exploits
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            // Re-verify vault seeds with lock
            const [[lockedVaultSeeds]] = await conn.execute(
                'SELECT * FROM cfx_vault_seeds WHERE player_id = ? AND strain_id = ? FOR UPDATE',
                [req.player.id, strainId]
            );

            if (!lockedVaultSeeds || lockedVaultSeeds.quantity < quantity) {
                await conn.rollback();
                return res.status(400).json({ error: 'Insufficient vault seeds', code: 'INSUFFICIENT' });
            }

            // Remove from vault
            await conn.execute(
                'UPDATE cfx_vault_seeds SET quantity = quantity - ? WHERE player_id = ? AND strain_id = ?',
                [quantity, req.player.id, strainId]
            );

            // Add to seed inventory
            await conn.execute(
                `INSERT INTO cfx_seed_inventory (player_id, strain_id, quantity)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE quantity = quantity + ?`,
                [req.player.id, strainId, quantity, quantity]
            );

            await conn.commit();
        } catch (err) {
            await conn.rollback();
            throw err;
        } finally {
            conn.release();
        }

        res.json({
            success: true,
            withdrawn: quantity,
            strainId
        });

    } catch (error) {
        logger.error('[Vault] Withdraw seeds failed', {
            playerId: req.player.id,
            error: error.message
        });
        res.status(500).json({ error: 'Failed to withdraw seeds', code: 'ERROR' });
    }
});

export default router;
