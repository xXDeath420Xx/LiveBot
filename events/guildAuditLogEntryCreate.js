const { Events } = require('discord.js');
const { processAuditLog } = require('../core/core/anti-nuke');

module.exports = {
    name: Events.GuildAuditLogEntryCreate,
    async execute(auditLog, guild) {
        try {
            await processAuditLog(auditLog, guild);
        } catch (error) {
            logger.error(`Error processing audit log for guild ${guild.id}:`, error);
        }
    },
};