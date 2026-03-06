import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { saveAuditLog } from '../core/log-manager.js';

export default {
    name: Events.EntitlementCreate,
    async execute(entitlement) {
        try {
            logger.info(`[Entitlement] New entitlement created`, {
                entitlementId: entitlement.id,
                userId: entitlement.userId,
                skuId: entitlement.skuId,
                category: 'entitlement'
            });

            // Entitlements are typically for the application, not guilds
            // Log to database for tracking purchases/subscriptions
            if (entitlement.guildId) {
                await saveAuditLog(
                    entitlement.guildId,
                    'ENTITLEMENT_CREATE',
                    entitlement.userId,
                    entitlement.id,
                    null,
                    null,
                    'Entitlement/subscription created',
                    null,
                    null,
                    null,
                    { skuId: entitlement.skuId, type: entitlement.type }
                );
            }
        } catch (error) {
            logger.error('[Entitlement] Error logging entitlement create:', { error: error.message });
        }
    }
};
