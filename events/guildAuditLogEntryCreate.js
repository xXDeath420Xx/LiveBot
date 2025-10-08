const { Events } = require('discord.js');
const antiNuke = require('../core/anti-nuke'); // Make sure this path is correct

module.exports = {
    name: Events.GuildAuditLogEntryCreate,
    async execute(auditLogEntry, guild) {
        // The antiNuke module and its processAuditLog function are now correctly referenced
        if (antiNuke && typeof antiNuke.processAuditLog === 'function') {
            await antiNuke.processAuditLog(auditLogEntry, guild);
        }
    },
};