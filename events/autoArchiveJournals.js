/**
 * Auto-Archive for Grow Journals
 * Archives inactive journal threads after extended periods of inactivity
 */

import logger from '../utils/logger.js';

// Channels that contain grow journals
const JOURNAL_CHANNEL_KEYWORDS = [
    'grow-journal',
    'grow-log',
    'plant-journal',
    'my-grow'
];

// Archive threads inactive for 30 days
const INACTIVE_DAYS = 30;
const INACTIVE_MS = INACTIVE_DAYS * 24 * 60 * 60 * 1000;

// Warning message days before archive
const WARNING_DAYS = 25;
const WARNING_MS = WARNING_DAYS * 24 * 60 * 60 * 1000;

// Track warned threads to avoid duplicate warnings
const warnedThreads = new Set();

export default {
    name: 'ready',
    once: true,
    async execute(client) {
        // Check threads every 6 hours
        setInterval(() => checkAllThreads(client), 6 * 60 * 60 * 1000);

        // Initial check after 15 minutes
        setTimeout(() => checkAllThreads(client), 15 * 60 * 1000);

        logger.info('[AutoArchive] Journal auto-archive system initialized');
    }
};

async function checkAllThreads(client) {
    for (const guild of client.guilds.cache.values()) {
        try {
            await checkGuildThreads(guild);
        } catch (error) {
            logger.error(`[AutoArchive] Error checking threads in ${guild.name}:`, error);
        }
    }
}

async function checkGuildThreads(guild) {
    // Find journal channels
    const journalChannels = guild.channels.cache.filter(c =>
        JOURNAL_CHANNEL_KEYWORDS.some(keyword => c.name?.toLowerCase().includes(keyword))
    );

    for (const channel of journalChannels.values()) {
        if (!channel.threads) continue;

        try {
            // Fetch active threads
            const activeThreads = await channel.threads.fetchActive();

            for (const thread of activeThreads.threads.values()) {
                await checkThread(thread);
            }
        } catch (error) {
            logger.debug(`[AutoArchive] Could not check threads in ${channel.name}: ${error.message}`);
        }
    }
}

async function checkThread(thread) {
    // Don't archive pinned threads
    if (thread.archived) return;

    // Get last message time
    let lastActivity;

    try {
        const messages = await thread.messages.fetch({ limit: 1 });
        if (messages.size > 0) {
            lastActivity = messages.first().createdTimestamp;
        } else {
            lastActivity = thread.createdTimestamp;
        }
    } catch {
        lastActivity = thread.createdTimestamp;
    }

    const timeSinceActivity = Date.now() - lastActivity;

    // Check if thread should be archived
    if (timeSinceActivity >= INACTIVE_MS) {
        await archiveThread(thread, lastActivity);
        return;
    }

    // Check if we should send a warning
    if (timeSinceActivity >= WARNING_MS && !warnedThreads.has(thread.id)) {
        await warnThread(thread, lastActivity);
    }
}

async function warnThread(thread, lastActivity) {
    try {
        const daysInactive = Math.floor((Date.now() - lastActivity) / (24 * 60 * 60 * 1000));
        const daysUntilArchive = INACTIVE_DAYS - daysInactive;

        await thread.send({
            content: `⚠️ **Inactivity Notice**\n\nThis grow journal has been inactive for **${daysInactive} days**.\n\nIt will be automatically archived in **${daysUntilArchive} days** if there's no new activity.\n\n*Post an update to keep your journal active!*`
        });

        warnedThreads.add(thread.id);

        // Clean up warned threads set after 10 days
        setTimeout(() => warnedThreads.delete(thread.id), 10 * 24 * 60 * 60 * 1000);

        logger.info(`[AutoArchive] Sent warning to thread "${thread.name}" in ${thread.guild.name}`);

    } catch (error) {
        logger.debug(`[AutoArchive] Could not warn thread ${thread.name}: ${error.message}`);
    }
}

async function archiveThread(thread, lastActivity) {
    try {
        const daysInactive = Math.floor((Date.now() - lastActivity) / (24 * 60 * 60 * 1000));

        // Send final message before archiving
        await thread.send({
            content: `📦 **Auto-Archived**\n\nThis grow journal has been archived after **${daysInactive} days** of inactivity.\n\n*The thread can be unarchived by sending a new message.*`
        });

        // Archive the thread
        await thread.setArchived(true, `Auto-archived after ${daysInactive} days of inactivity`);

        logger.info(`[AutoArchive] Archived thread "${thread.name}" in ${thread.guild.name} (${daysInactive} days inactive)`);

    } catch (error) {
        logger.error(`[AutoArchive] Failed to archive thread ${thread.name}:`, error);
    }
}

// Export function for manual archive check
export async function checkInactiveJournals(guild) {
    const results = {
        checked: 0,
        warned: 0,
        archived: 0
    };

    const journalChannels = guild.channels.cache.filter(c =>
        JOURNAL_CHANNEL_KEYWORDS.some(keyword => c.name?.toLowerCase().includes(keyword))
    );

    for (const channel of journalChannels.values()) {
        if (!channel.threads) continue;

        try {
            const activeThreads = await channel.threads.fetchActive();

            for (const thread of activeThreads.threads.values()) {
                results.checked++;

                const messages = await thread.messages.fetch({ limit: 1 });
                const lastActivity = messages.size > 0 ? messages.first().createdTimestamp : thread.createdTimestamp;
                const timeSinceActivity = Date.now() - lastActivity;

                if (timeSinceActivity >= INACTIVE_MS) {
                    results.archived++;
                } else if (timeSinceActivity >= WARNING_MS) {
                    results.warned++;
                }
            }
        } catch {
            // Skip channels we can't access
        }
    }

    return results;
}
