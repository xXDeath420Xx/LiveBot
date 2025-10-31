import { Events, GuildAuditLogsEntry, Guild } from 'discord.js';

// Import anti-nuke module - check if TypeScript version exists
let antiNuke: any;
try {
    // Try importing TypeScript version first
    antiNuke = require('../core/anti-nuke');
} catch {
    // Fall back to JavaScript version if TypeScript doesn't exist
    antiNuke = require('../core/anti-nuke.js');
}

interface AntiNukeModule {
    processAuditLog: (auditLogEntry: GuildAuditLogsEntry, guild: Guild) => Promise<void>;
}

interface EventModule {
    name: string;
    once?: boolean;
    execute: (...args: any[]) => Promise<void>;
}

const guildAuditLogEntryCreateEvent: EventModule = {
    name: Events.GuildAuditLogEntryCreate,
    once: false,

    async execute(auditLogEntry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
        // The antiNuke module and its processAuditLog function are now correctly referenced
        if (antiNuke && typeof antiNuke.processAuditLog === 'function') {
            await (antiNuke as AntiNukeModule).processAuditLog(auditLogEntry, guild);
        }
    },
};

// Export using CommonJS for compatibility
module.exports = guildAuditLogEntryCreateEvent;
export default guildAuditLogEntryCreateEvent;