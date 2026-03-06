import { Events, EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { saveAuditLog } from '../core/log-manager.js';

export default {
    name: Events.EntitlementDelete,
    async execute(entitlement) {
        try {
            logger.info(`[Entitlement] Entitlement deleted`, {
                entitlementId: entitlement.id,
                userId: entitlement.userId,
                category: 'entitlement'
            });

            if (entitlement.guildId) {
                await saveAuditLog(
                    entitlement.guildId,
                    'ENTITLEMENT_DELETE',
                    entitlement.userId,
                    entitlement.id,
                    null,
                    null,
                    'Entitlement/subscription ended',
                    null,
                    null,
                    null,
                    { skuId: entitlement.skuId }
                );
            }
        } catch (error) {
            logger.error('[Entitlement] Error logging entitlement delete:', { error: error.message });
        }
    }
};
