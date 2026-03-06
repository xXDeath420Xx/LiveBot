/**
 * Settings Routes
 * Player settings and preferences
 */

import { Router } from 'express';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = Router();

const DEFAULT_SETTINGS = {
    notifications: true,
    sound: true,
    autoHarvest: false,
    autoReplant: false,
    autoSell: false,
    autoBreed: false,
    autoCollect: false,
    workersEnabled: true,
    compactView: false,
    theme: 'dark',
    // Offline automation settings
    offlineHarvestEnabled: true,
    offlineSellEnabled: false,
    offlinePlantEnabled: false,
    offlineSellMinQuality: 0,
    offlinePlantStrainId: null
};

/**
 * GET /settings
 * Get player settings
 */
router.get('/', async (req, res) => {
    try {
        const playerId = req.player.id;

        // Query actual columns from cfx_player_settings table
        const [[settings]] = await pool.execute(
            `SELECT notifications_enabled, sound_enabled, offline_harvest_enabled,
                    offline_sell_enabled, offline_plant_enabled, offline_sell_min_quality,
                    offline_plant_strain_id, auto_replant_enabled, auto_replant_strain_id,
                    auto_replant_use_favorite, auto_harvest_enabled, auto_sell_enabled,
                    auto_breed_enabled, auto_collect_enabled,
                    auto_buy_seeds_enabled, auto_buy_seeds_threshold, auto_buy_seeds_max_price
             FROM cfx_player_settings WHERE player_id = ?`,
            [playerId]
        );

        // Map database columns to frontend setting names
        let playerSettings = { ...DEFAULT_SETTINGS };
        if (settings) {
            playerSettings = {
                ...playerSettings,
                notifications: !!(settings.notifications_enabled ?? true),
                sound: !!(settings.sound_enabled ?? true),
                offlineHarvestEnabled: !!(settings.offline_harvest_enabled ?? true),
                offlineSellEnabled: !!(settings.offline_sell_enabled),
                offlinePlantEnabled: !!(settings.offline_plant_enabled),
                offlineSellMinQuality: settings.offline_sell_min_quality ?? 0,
                offlinePlantStrainId: settings.offline_plant_strain_id,
                autoReplant: !!(settings.auto_replant_enabled),
                autoReplantStrainId: settings.auto_replant_strain_id,
                autoReplantUseFavorite: !!(settings.auto_replant_use_favorite),
                autoHarvest: !!(settings.auto_harvest_enabled),
                autoSell: !!(settings.auto_sell_enabled),
                autoBreed: !!(settings.auto_breed_enabled),
                autoCollect: !!(settings.auto_collect_enabled),
                autoBuySeeds: !!(settings.auto_buy_seeds_enabled),
                autoBuySeedsThreshold: settings.auto_buy_seeds_threshold ?? 5,
                autoBuySeedsMaxPrice: settings.auto_buy_seeds_max_price ?? 500
            };
        }

        res.json({
            success: true,
            settings: playerSettings
        });

    } catch (error) {
        logger.error('[Settings] Get failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

/**
 * PUT /settings
 * Update player settings
 */
router.put('/', async (req, res) => {
    try {
        const playerId = req.player.id;
        const updates = req.body;

        // Map frontend keys to database columns
        const keyToColumn = {
            notifications: 'notifications_enabled',
            sound: 'sound_enabled',
            offlineHarvestEnabled: 'offline_harvest_enabled',
            offlineSellEnabled: 'offline_sell_enabled',
            offlinePlantEnabled: 'offline_plant_enabled',
            offlineSellMinQuality: 'offline_sell_min_quality',
            offlinePlantStrainId: 'offline_plant_strain_id',
            autoReplant: 'auto_replant_enabled',
            autoReplantStrainId: 'auto_replant_strain_id',
            autoReplantUseFavorite: 'auto_replant_use_favorite',
            autoHarvest: 'auto_harvest_enabled',
            autoSell: 'auto_sell_enabled',
            autoBreed: 'auto_breed_enabled',
            autoCollect: 'auto_collect_enabled',
            autoBuySeeds: 'auto_buy_seeds_enabled',
            autoBuySeedsThreshold: 'auto_buy_seeds_threshold',
            autoBuySeedsMaxPrice: 'auto_buy_seeds_max_price'
        };

        // Build update fields
        const updateFields = [];
        const updateValues = [];

        for (const [frontendKey, value] of Object.entries(updates)) {
            const dbColumn = keyToColumn[frontendKey];
            if (dbColumn) {
                updateFields.push(`${dbColumn} = ?`);
                updateValues.push(value);
            }
        }

        if (updateFields.length === 0) {
            return res.json({ success: true, settings: updates, message: 'No valid settings to update' });
        }

        // Check if row exists
        const [[existing]] = await pool.execute(
            'SELECT player_id FROM cfx_player_settings WHERE player_id = ?',
            [playerId]
        );

        if (existing) {
            // Update existing row
            await pool.execute(
                `UPDATE cfx_player_settings SET ${updateFields.join(', ')}, updated_at = NOW() WHERE player_id = ?`,
                [...updateValues, playerId]
            );
        } else {
            // Insert new row with defaults
            const insertColumns = ['player_id', ...updateFields.map(f => f.split(' = ')[0])];
            const insertPlaceholders = insertColumns.map(() => '?').join(', ');
            await pool.execute(
                `INSERT INTO cfx_player_settings (${insertColumns.join(', ')}) VALUES (${insertPlaceholders})`,
                [playerId, ...updateValues]
            );
        }

        // Return updated settings
        const [[newSettings]] = await pool.execute(
            `SELECT notifications_enabled, sound_enabled, offline_harvest_enabled,
                    offline_sell_enabled, offline_plant_enabled, offline_sell_min_quality,
                    offline_plant_strain_id, auto_replant_enabled, auto_replant_strain_id,
                    auto_replant_use_favorite, auto_harvest_enabled, auto_sell_enabled,
                    auto_breed_enabled, auto_collect_enabled,
                    auto_buy_seeds_enabled, auto_buy_seeds_threshold, auto_buy_seeds_max_price
             FROM cfx_player_settings WHERE player_id = ?`,
            [playerId]
        );

        res.json({
            success: true,
            settings: {
                notifications: !!(newSettings?.notifications_enabled ?? true),
                sound: !!(newSettings?.sound_enabled ?? true),
                offlineHarvestEnabled: !!(newSettings?.offline_harvest_enabled ?? true),
                offlineSellEnabled: !!(newSettings?.offline_sell_enabled),
                offlinePlantEnabled: !!(newSettings?.offline_plant_enabled),
                offlineSellMinQuality: newSettings?.offline_sell_min_quality ?? 0,
                offlinePlantStrainId: newSettings?.offline_plant_strain_id,
                autoReplant: !!(newSettings?.auto_replant_enabled),
                autoReplantStrainId: newSettings?.auto_replant_strain_id,
                autoReplantUseFavorite: !!(newSettings?.auto_replant_use_favorite),
                autoHarvest: !!(newSettings?.auto_harvest_enabled),
                autoSell: !!(newSettings?.auto_sell_enabled),
                autoBreed: !!(newSettings?.auto_breed_enabled),
                autoCollect: !!(newSettings?.auto_collect_enabled),
                autoBuySeeds: !!(newSettings?.auto_buy_seeds_enabled),
                autoBuySeedsThreshold: newSettings?.auto_buy_seeds_threshold ?? 5,
                autoBuySeedsMaxPrice: newSettings?.auto_buy_seeds_max_price ?? 500
            }
        });

    } catch (error) {
        logger.error('[Settings] Update failed', { error: error.message });
        res.status(500).json({ error: 'Failed', code: 'ERROR' });
    }
});

export default router;
