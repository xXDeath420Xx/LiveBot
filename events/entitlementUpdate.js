import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { saveAuditLog } from '../core/log-manager.js';

export default {
    name: Events.EntitlementUpdate,
    async execute(oldEntitlement, newEntitlement) {
        try {
            logger.info(`[Entitlement] Entitlement updated`, {
                entitlementId: newEntitlement.id,
                userId: newEntitlement.userId,
                category: 'entitlement'
            });

            if (newEntitlement.guildId) {
                await saveAuditLog(
                    newEntitlement.guildId,
                    'ENTITLEMENT_UPDATE',
                    newEntitlement.userId,
                    newEntitlement.id,
                    null,
                    null,
                    'Entitlement/subscription updated',
                    null,
                    null,
                    null,
                    { skuId: newEntitlement.skuId }
                );
            }
        } catch (error) {
            logger.error('[Entitlement] Error logging entitlement update:', { error: error.message });
        }
    }
};
