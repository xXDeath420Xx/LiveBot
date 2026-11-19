/**
 * Log colours per ACTION.
 *
 * The Logging page used to offer one colour per category, which cannot describe a category whose actions
 * are coloured differently (voice Join green / Leave red / Move blurple), and the bot never applied it.
 * Here every action that posts a log has a key, a label and the colour the bot gives it when the server has
 * not picked one: a fixed hex, or a slot of the server's theme (core/guild-theme.js) where the code uses
 * themeColor(). Only colours an admin changes are stored (log_action_colors); sendLogEmbed applies them.
 *
 * A category with one action uses the category key as its action key, so its call sites pass nothing.
 * A category with several uses `<category>.<action>`, and each of its call sites passes its action.
 */
import { themeColor } from './guild-theme.js';

const hex = (value) => ({ hex: value });
const slot = (name) => ({ slot: name });
const one = (key, label, color) => [{ key, label, color }];

export const LOG_ACTIONS = Object.freeze({
    messageDelete: one('messageDelete', 'Deleted', slot('danger')),
    messageUpdate: one('messageUpdate', 'Edited', hex('#FEE75C')),
    channelPinsUpdate: one('channelPinsUpdate', 'Pins changed', hex('#FEE75C')),
    reactionAdd: one('reactionAdd', 'Added', hex('#57F287')),
    reactionRemove: one('reactionRemove', 'Removed', hex('#ED4245')),
    reactionRemoveAll: one('reactionRemoveAll', 'All cleared', slot('danger')),
    reactionRemoveEmoji: one('reactionRemoveEmoji', 'Emoji cleared', hex('#ED4245')),
    pollVoteAdd: one('pollVoteAdd', 'Vote added', slot('success')),
    pollVoteRemove: one('pollVoteRemove', 'Vote removed', slot('danger')),

    memberJoin: [
        { key: 'memberJoin.joined', label: 'Joined', color: slot('success') },
        { key: 'memberJoin.noApplication', label: 'Joined without application', color: slot('danger') },
        { key: 'memberJoin.approved', label: 'Application approved', color: slot('success') },
        { key: 'memberJoin.rejected', label: 'Application rejected', color: slot('danger') },
    ],
    memberUpdate: [
        { key: 'memberUpdate.rolesAdded', label: 'Roles added', color: slot('success') },
        { key: 'memberUpdate.rolesRemoved', label: 'Roles removed', color: slot('danger') },
        { key: 'memberUpdate.nickname', label: 'Nickname', color: slot('primary') },
        { key: 'memberUpdate.avatar', label: 'Server avatar', color: hex('#5865F2') },
        { key: 'memberUpdate.profile', label: 'Profile (avatar, name, banner)', color: hex('#5865F2') },
    ],
    memberLeave: one('memberLeave', 'Left', hex('#FEE75C')),
    memberKick: one('memberKick', 'Kicked', slot('danger')),
    memberTimeout: [
        { key: 'memberTimeout.applied', label: 'Timed out', color: hex('#FEE75C') },
        { key: 'memberTimeout.removed', label: 'Timeout removed', color: hex('#57F287') },
    ],

    voiceUpdate: [
        { key: 'voiceUpdate.join', label: 'Join', color: hex('#57F287') },
        { key: 'voiceUpdate.leave', label: 'Leave', color: slot('danger') },
        { key: 'voiceUpdate.move', label: 'Move', color: hex('#5865F2') },
    ],
    voiceServerMute: [
        { key: 'voiceServerMute.on', label: 'Muted', color: hex('#ED4245') },
        { key: 'voiceServerMute.off', label: 'Unmuted', color: hex('#57F287') },
    ],
    voiceServerDeaf: [
        { key: 'voiceServerDeaf.on', label: 'Deafened', color: hex('#ED4245') },
        { key: 'voiceServerDeaf.off', label: 'Undeafened', color: hex('#57F287') },
    ],
    voiceSelfMute: one('voiceSelfMute', 'Changed', hex('#5865F2')),
    voiceStream: [
        { key: 'voiceStream.start', label: 'Started', color: hex('#593695') },
        { key: 'voiceStream.stop', label: 'Stopped', color: hex('#5865F2') },
    ],
    voiceVideo: [
        { key: 'voiceVideo.on', label: 'On', color: hex('#57F287') },
        { key: 'voiceVideo.off', label: 'Off', color: hex('#FEE75C') },
    ],
    voiceChannelEffect: one('voiceChannelEffect', 'Effect sent', slot('accent')),
    stageInstanceCreate: one('stageInstanceCreate', 'Started', slot('success')),
    stageInstanceUpdate: one('stageInstanceUpdate', 'Updated', slot('primary')),
    stageInstanceDelete: one('stageInstanceDelete', 'Ended', slot('danger')),

    channelCreate: one('channelCreate', 'Created', slot('success')),   // events/channelCreate.js
    channelDelete: one('channelDelete', 'Deleted', slot('danger')),    // events/channelDelete.js
    channelUpdate: one('channelUpdate', 'Updated', hex('#5865F2')),
    threadCreate: one('threadCreate', 'Created', hex('#57F287')),
    threadDelete: one('threadDelete', 'Deleted', hex('#ED4245')),
    threadUpdate: one('threadUpdate', 'Updated', hex('#5865F2')),
    threadMembersUpdate: [
        { key: 'threadMembersUpdate.added', label: 'Added', color: hex('#57F287') },
        { key: 'threadMembersUpdate.removed', label: 'Removed', color: hex('#ED4245') },
    ],
    guildUpdate: one('guildUpdate', 'Updated', hex('#5865F2')),
    scheduledEventCreate: one('scheduledEventCreate', 'Created', slot('success')),
    scheduledEventUpdate: one('scheduledEventUpdate', 'Updated', slot('primary')),
    scheduledEventDelete: one('scheduledEventDelete', 'Deleted', slot('danger')),
    scheduledEventUserAdd: one('scheduledEventUserAdd', 'Interested', slot('success')),
    scheduledEventUserRemove: one('scheduledEventUserRemove', 'No longer interested', slot('danger')),
    automod: [
        { key: 'automod.removed', label: 'Kick / ban', color: slot('danger') },
        { key: 'automod.muted', label: 'Mute', color: slot('warning') },
        { key: 'automod.other', label: 'Other', color: slot('primary') },
        // Message threats (core/message-threats.js): obfuscated-URL scam, AutoMod escalation, anti-everyone,
        // QR codes and image-text rules.
        { key: 'automod.threatBanned', label: 'Message threat: banned', color: hex('#C0392B') },
        { key: 'automod.threatRemoved', label: 'Message threat: removed / timed out', color: hex('#E67E22') },
        { key: 'automod.threatFlagged', label: 'Message threat: flagged for review', color: hex('#E8A33D') },
        { key: 'automod.threatLogged', label: 'Message threat: logged / dismissed', color: hex('#95A5A6') },
        { key: 'automod.everyone', label: 'Webhook @everyone', color: hex('#E67E22') },
        { key: 'automod.manualAction', label: 'Manual action needed', color: slot('danger') },
        { key: 'automod.circuitBreaker', label: 'Circuit breaker tripped / reset', color: hex('#C0392B') },
        { key: 'automod.threatSettings', label: 'Message threat settings changed', color: hex('#3498DB') },
        // AI second opinion (core/ai-judge.js) and domain reports / disputes (core/domain-reports.js).
        { key: 'automod.aiVerdict', label: 'AI second opinion', color: hex('#8E44AD') },
        { key: 'automod.aiSettings', label: 'AI second opinion settings changed', color: hex('#3498DB') },
        { key: 'automod.domainReport', label: 'Domain report / dispute', color: hex('#16A085') },
    ],
    automodAction: one('automodAction', 'Action taken', slot('danger')),
    automodRuleCreate: one('automodRuleCreate', 'Created', slot('success')),
    automodRuleUpdate: one('automodRuleUpdate', 'Updated', slot('primary')),
    automodRuleDelete: one('automodRuleDelete', 'Deleted', slot('danger')),
    commandUsage: one('commandUsage', 'Used', slot('primary')),
    ban: one('ban', 'Banned', hex('#ED4245')),
    unban: one('unban', 'Unbanned', hex('#57F287')),
    roleCreate: one('roleCreate', 'Created', hex('#57F287')),
    roleDelete: one('roleDelete', 'Deleted', hex('#ED4245')),
    roleUpdate: one('roleUpdate', 'Updated', hex('#5865F2')),

    owoRareCatch: [
        { key: 'owoRareCatch.epic', label: 'Epic', color: hex('#9C27B0') },
        { key: 'owoRareCatch.mythical', label: 'Mythical', color: hex('#FF9800') },
        { key: 'owoRareCatch.legendary', label: 'Legendary', color: hex('#F44336') },
        { key: 'owoRareCatch.fabled', label: 'Fabled', color: hex('#E91E63') },
        { key: 'owoRareCatch.hidden', label: 'Hidden', color: hex('#673AB7') },
    ],
    owoAdminAction: [
        { key: 'owoAdminAction.reset', label: 'Reset', color: hex('#F44336') },
        { key: 'owoAdminAction.granted', label: 'Granted', color: hex('#4CAF50') },
        { key: 'owoAdminAction.removed', label: 'Removed', color: hex('#FF9800') },
    ],

    inviteCreate: one('inviteCreate', 'Created', hex('#57F287')),
    inviteDelete: one('inviteDelete', 'Deleted', hex('#ED4245')),
    webhookUpdate: [
        { key: 'webhookUpdate.created', label: 'Created', color: slot('success') },
        { key: 'webhookUpdate.modified', label: 'Modified', color: hex('#FEE75C') },
        { key: 'webhookUpdate.deleted', label: 'Deleted', color: slot('danger') },
    ],

    // Emoji / Sticker / Soundboard: listed in NOT_POSTED below. They became actions on 2026-10-14, but
    // sendLogEmbed (core/log-manager.js) drops them by the owner's decision, so the page must not offer them.
    // Only "bot added" is logged (events/guildAuditLogEntryCreate.js); log-manager's logIntegrationUpdate is never called.
    integrationUpdate: one('integrationUpdate', 'Bot added', slot('primary')),
    'sticky-roles': [
        { key: 'sticky-roles.restored', label: 'Restored', color: slot('primary') },
        { key: 'sticky-roles.failed', label: 'Failed', color: slot('danger') },
    ],

    // ── Bot features, wired 2026-10-06 (posted through core/feature-log.js logFeatureEvent) ──
    moderation: [
        { key: 'moderation.warn', label: 'Warned', color: hex('#E67E22') },
        { key: 'moderation.mute', label: 'Timed out', color: hex('#F1C40F') },
        { key: 'moderation.unmute', label: 'Timeout removed', color: hex('#2ECC71') },
        { key: 'moderation.kick', label: 'Kicked', color: hex('#E74C3C') },
        { key: 'moderation.ban', label: 'Banned', color: hex('#C0392B') },
        { key: 'moderation.unban', label: 'Unbanned', color: hex('#2ECC71') },
        { key: 'moderation.banTimer', label: 'Ban timer changed', color: hex('#E67E22') },
        { key: 'moderation.clearInfractions', label: 'History cleared', color: hex('#95A5A6') },
        { key: 'moderation.escalation', label: 'Auto escalation', color: slot('danger') },
        { key: 'moderation.purge', label: 'Purged', color: slot('warning') },
        { key: 'moderation.quarantine', label: 'Quarantined', color: hex('#C0392B') },
        { key: 'moderation.release', label: 'Released', color: hex('#2ECC71') },
        { key: 'moderation.slowmodeOn', label: 'Slowmode on', color: hex('#E67E22') },
        { key: 'moderation.slowmodeOff', label: 'Slowmode off', color: hex('#2ECC71') },
        { key: 'moderation.lock', label: 'Locked', color: hex('#C0392B') },
        { key: 'moderation.unlock', label: 'Unlocked', color: hex('#2ECC71') },
        { key: 'moderation.tempRole', label: 'Temp role given', color: hex('#3498DB') },
        { key: 'moderation.tempRoleEnded', label: 'Temp role ended', color: hex('#95A5A6') },
        { key: 'moderation.banRequest', label: 'Ban requested', color: hex('#E8A33D') },
        { key: 'moderation.banRequestDenied', label: 'Request declined', color: hex('#5B9E6A') },
        { key: 'moderation.timerFailed', label: 'Timer failed', color: hex('#E67E22') },
        { key: 'moderation.protectionHeld', label: 'Protection held back', color: hex('#95A5A6') },
        { key: 'moderation.protectionPaused', label: 'Protections paused', color: hex('#E67E22') },
        { key: 'moderation.protectionResumed', label: 'Protections resumed', color: hex('#2ECC71') },
        { key: 'moderation.protectionLists', label: 'Allowlist / managers changed', color: hex('#3498DB') },
        { key: 'moderation.raidLockdown', label: 'Raid lockdown started / ended', color: hex('#C0392B') },
        { key: 'moderation.lockdownJoin', label: 'Join blocked by lockdown', color: hex('#E67E22') },
        { key: 'moderation.sameNameFlood', label: 'Same-name join flood', color: hex('#8E44AD') },
        { key: 'moderation.incidentActions', label: 'Invite / DM pause changed', color: hex('#3498DB') },
        { key: 'moderation.globalBanSettings', label: 'Global ban mode changed', color: hex('#3498DB') },
    ],
    'join-gate': [
        { key: 'join-gate.removedNew', label: 'Too new', color: hex('#E67E22') },
        { key: 'join-gate.removedApply', label: 'Needs application', color: hex('#E67E22') },
        { key: 'join-gate.banned', label: 'Banned', color: hex('#C0392B') },
        { key: 'join-gate.rejoinLimit', label: 'Repeated joins', color: hex('#8E44AD') },
        { key: 'join-gate.spammer', label: 'Discord-flagged spammer', color: hex('#C0392B') },
        { key: 'join-gate.nameFilter', label: 'Name filter acted', color: hex('#C0392B') },
        { key: 'join-gate.nameObserved', label: 'Name filter (log only)', color: slot('info') },
        { key: 'join-gate.nameCleanse', label: 'Name cleanse / review', color: hex('#8E44AD') },
        { key: 'join-gate.nameSettings', label: 'Name filters changed', color: hex('#3498DB') },
        { key: 'join-gate.avatarFilter', label: 'Avatar protection acted', color: hex('#C0392B') },
        { key: 'join-gate.avatarReview', label: 'Avatar sent to review', color: hex('#E67E22') },
        { key: 'join-gate.avatarObserved', label: 'Avatar protection (log only)', color: slot('info') },
        { key: 'join-gate.avatarCleanse', label: 'Avatar scan / review', color: hex('#8E44AD') },
        { key: 'join-gate.avatarSettings', label: 'Avatar protection changed', color: hex('#3498DB') },
        // NSFW avatars (core/nsfw-protection.js). Chat images log through the automod.threat* actions.
        { key: 'join-gate.nsfwAvatar', label: 'NSFW avatar acted', color: hex('#C0392B') },
        { key: 'join-gate.nsfwReview', label: 'NSFW avatar sent to review', color: hex('#E67E22') },
        { key: 'join-gate.nsfwOverturned', label: 'NSFW review decision / overturn', color: hex('#8E44AD') },
        { key: 'join-gate.observed', label: 'Observed only', color: slot('info') },
        { key: 'join-gate.passedApproved', label: 'Passed (approved)', color: hex('#2ECC71') },
        { key: 'join-gate.failed', label: 'Could not act', color: slot('danger') },
        { key: 'join-gate.applied', label: 'Applied', color: hex('#3498DB') },
        { key: 'join-gate.approved', label: 'Approved', color: hex('#2ECC71') },
        { key: 'join-gate.declined', label: 'Declined', color: hex('#C0392B') },
        { key: 'join-gate.verified', label: 'Verified', color: slot('success') },
        { key: 'join-gate.unverifiedKicked', label: 'Unverified removed', color: hex('#E67E22') },
        { key: 'join-gate.verifyFailed', label: 'Verification failed', color: hex('#C0392B') },
        { key: 'join-gate.verifySetup', label: 'Verification setup / undo', color: hex('#8E44AD') },
        { key: 'join-gate.verifySettings', label: 'Verification settings changed', color: hex('#3498DB') },
        { key: 'join-gate.autoPruned', label: 'Auto-pruned', color: hex('#E67E22') },
        { key: 'join-gate.pruneSettings', label: 'Auto-prune settings changed', color: hex('#3498DB') },
        { key: 'join-gate.inactivityPrune', label: 'Inactivity prune (removed / warned / logged)', color: hex('#E67E22') },
        { key: 'join-gate.inactivitySettings', label: 'Inactivity prune settings changed', color: hex('#3498DB') },
        // Network intel on join (core/network-gate.js).
        { key: 'join-gate.networkBlacklist', label: 'Network blacklist', color: hex('#C0392B') },
        { key: 'join-gate.networkLurker', label: 'Cross-server lurker', color: hex('#E67E22') },
    ],
    autorole: [
        { key: 'autorole.assigned', label: 'Given', color: slot('success') },
        { key: 'autorole.failed', label: 'Failed', color: slot('danger') },
        { key: 'autorole.backfill', label: 'Given to existing members', color: slot('primary') },
    ],
    'temp-channels': [
        { key: 'temp-channels.created', label: 'Created', color: slot('success') },
        { key: 'temp-channels.deleted', label: 'Deleted', color: slot('danger') },
        { key: 'temp-channels.transferred', label: 'Owner changed', color: slot('primary') },
        { key: 'temp-channels.blocked', label: 'Blocked', color: slot('warning') },
    ],
    'auto-publisher': [
        { key: 'auto-publisher.published', label: 'Published', color: slot('success') },
        { key: 'auto-publisher.failed', label: 'Failed', color: slot('danger') },
    ],
    xp: [
        { key: 'xp.levelUp', label: 'Level up', color: slot('warning') },
        { key: 'xp.roleReward', label: 'Role reward', color: slot('success') },
        { key: 'xp.adjusted', label: 'XP adjusted', color: slot('primary') },
        { key: 'xp.reset', label: 'Reset', color: slot('danger') },
    ],
    giveaway: [
        { key: 'giveaway.started', label: 'Started', color: slot('primary') },
        { key: 'giveaway.ended', label: 'Ended', color: slot('success') },
        { key: 'giveaway.noEntries', label: 'No entries', color: hex('#95A5A6') },
        { key: 'giveaway.rerolled', label: 'Rerolled', color: slot('info') },
        { key: 'giveaway.cancelled', label: 'Cancelled', color: slot('danger') },
        { key: 'giveaway.deleted', label: 'Deleted', color: slot('danger') },
    ],
    poll: [
        { key: 'poll.created', label: 'Created', color: slot('primary') },
        { key: 'poll.ended', label: 'Ended', color: slot('success') },
        { key: 'poll.edited', label: 'Edited', color: hex('#FEE75C') },
        { key: 'poll.deleted', label: 'Deleted', color: slot('danger') },
    ],
    starboard: [
        { key: 'starboard.posted', label: 'Starred', color: slot('warning') },
        { key: 'starboard.removed', label: 'Removed', color: slot('danger') },
    ],
    system: [
        { key: 'system.rejoined', label: 'Bot rejoined', color: slot('success') },
        { key: 'system.permissionProblem', label: 'Missing permission', color: slot('danger') },
        { key: 'system.featureDisabled', label: 'Feature disabled', color: slot('warning') },
        { key: 'system.commandsFailed', label: 'Commands failed', color: slot('danger') },
        { key: 'system.setupApplied', label: 'Setup applied', color: slot('primary') },
        { key: 'system.customApiFailed', label: 'Custom command API failed', color: slot('warning') },
        { key: 'system.insultFiltered', label: 'Insult filtered', color: slot('info') },
    ],
    'twitch-schedule': [
        { key: 'twitch-schedule.posted', label: 'Posted', color: slot('success') },
        { key: 'twitch-schedule.updated', label: 'Updated', color: slot('primary') },
        { key: 'twitch-schedule.weekly', label: 'Weekly refresh', color: slot('info') },
        { key: 'twitch-schedule.added', label: 'Sync added', color: slot('success') },
        { key: 'twitch-schedule.removed', label: 'Sync removed', color: slot('danger') },
        { key: 'twitch-schedule.failed', label: 'Failed', color: slot('warning') },
    ],
    backup: [
        { key: 'backup.created', label: 'Created', color: slot('success') },
        { key: 'backup.autoCreated', label: 'Auto backup', color: slot('info') },
        { key: 'backup.restoreStarted', label: 'Restore started', color: slot('warning') },
        { key: 'backup.restored', label: 'Restored', color: slot('primary') },
        { key: 'backup.deleted', label: 'Deleted', color: slot('danger') },
        { key: 'backup.pruned', label: 'Pruned', color: hex('#95A5A6') },
        { key: 'backup.failed', label: 'Failed', color: slot('danger') },
    ],
    'team-sync': [
        { key: 'team-sync.added', label: 'Members added', color: slot('success') },
        { key: 'team-sync.removed', label: 'Members removed', color: slot('danger') },
        { key: 'team-sync.excluded', label: 'Excluded', color: slot('warning') },
        { key: 'team-sync.linked', label: 'Accounts linked', color: slot('info') },
        { key: 'team-sync.failed', label: 'Failed', color: slot('danger') },
    ],
    http: [
        { key: 'http.settingsChanged', label: 'Settings changed', color: slot('primary') },
        { key: 'http.itemDeleted', label: 'Deleted', color: slot('danger') },
        { key: 'http.staffAction', label: 'Staff action', color: hex('#95A5A6') },
    ],
    tickets: [
        { key: 'tickets.opened', label: 'Opened', color: slot('success') },
        { key: 'tickets.claimed', label: 'Claimed', color: slot('warning') },
        { key: 'tickets.unclaimed', label: 'Unclaimed', color: slot('warning') },
        { key: 'tickets.transferred', label: 'Transferred', color: slot('primary') },
        { key: 'tickets.memberAdded', label: 'Member added', color: slot('success') },
        { key: 'tickets.memberRemoved', label: 'Member removed', color: slot('danger') },
        { key: 'tickets.closed', label: 'Closed', color: slot('danger') },
        { key: 'tickets.feedback', label: 'Rated', color: slot('primary') },
    ],
});

/** Logging-page categories that never post a log, and why: the page shows this instead of pickers. */
const OFF_EVERYWHERE = 'Not logged in any server';
export const NOT_POSTED = Object.freeze({
    // sendLogEmbed returns before posting any of these (owner's decision: never logged in any server).
    emojiCreate: OFF_EVERYWHERE,
    emojiUpdate: OFF_EVERYWHERE,
    emojiDelete: OFF_EVERYWHERE,
    stickerCreate: OFF_EVERYWHERE,
    stickerUpdate: OFF_EVERYWHERE,
    stickerDelete: OFF_EVERYWHERE,
    soundboardSoundCreate: OFF_EVERYWHERE,
    soundboardSoundUpdate: OFF_EVERYWHERE,
    soundboardSoundDelete: OFF_EVERYWHERE,
});

/**
 * Categories that only started posting on 2026-10-06. Saved settings from before then had them ticked by the old
 * page's default rather than by choice, so they post only once the server has saved the Logging page since
 * (logging_config.events_saved_at is set) with them ticked; until then the page shows them unticked.
 */
export const OPT_IN_CATEGORIES = Object.freeze([
    'moderation', 'join-gate', 'system', 'xp', 'giveaway', 'poll', 'starboard', 'temp-channels',
    'twitch-schedule', 'auto-publisher', 'autorole', 'tickets', 'backup', 'team-sync', 'http',
]);
const OPT_IN = new Set(OPT_IN_CATEGORIES);
export const isOptInCategory = (category) => OPT_IN.has(category);

/** Whether an opt-in category may post for a guild: ticked, and the Logging page saved since it was wired. */
export function optInAllowed(category, enabledEvents, eventsSavedAt) {
    return !OPT_IN.has(category) || (!!eventsSavedAt && Array.isArray(enabledEvents) && enabledEvents.includes(category));
}

const ACTIONS = new Map(Object.values(LOG_ACTIONS).flat().map(a => [a.key, a]));
export const isLogAction = (key) => ACTIONS.has(key);

/** '#rrggbb' / 'rrggbb' / 0xRRGGBB -> '#RRGGBB', anything else -> null. */
export function normalizeHex(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xFFFFFF) {
        return `#${value.toString(16).padStart(6, '0').toUpperCase()}`;
    }
    if (typeof value !== 'string') return null;
    const m = value.trim().match(/^#?([0-9a-f]{6})$/i);
    return m ? `#${m[1].toUpperCase()}` : null;
}

/** The colour an action has when the server has not picked one (its theme slot, or the fixed hex). */
export function defaultActionColor(guildId, key, theme = themeColor) {
    const action = ACTIONS.get(key);
    if (!action) return null;
    return normalizeHex(action.color.hex ?? theme(guildId, action.color.slot));
}

/**
 * What saving the page changes. A picked colour that differs from the default is stored; a colour equal to
 * the default (or missing / invalid) removes any stored one, so the action follows the default again.
 * @param {Record<string, string>} submitted  action key -> colour from the form
 * @param {Record<string, string>} defaults   action key -> default colour, for every action on the page
 */
export function planActionColorChanges(submitted, defaults) {
    const upsert = [];
    const remove = [];
    for (const [key, fallback] of Object.entries(defaults)) {
        const picked = normalizeHex(submitted?.[key]);
        if (picked && picked !== fallback) upsert.push([key, picked]);
        else remove.push(key);
    }
    return { upsert, remove };
}

/** Every action's default for a guild, keyed by action. */
export function defaultActionColors(guildId, theme = themeColor) {
    return Object.fromEntries([...ACTIONS.keys()].map(key => [key, defaultActionColor(guildId, key, theme)]));
}

/**
 * A category whose actions can be switched off one by one (log_action_disabled, migration 413). A category
 * with a single action is switched by its own category switch, so it has no per-action switch.
 */
export const isSwitchableCategory = (category) => (LOG_ACTIONS[category]?.length || 0) > 1;
const SWITCHABLE_ACTIONS = Object.entries(LOG_ACTIONS)
    .filter(([category]) => isSwitchableCategory(category))
    .flatMap(([, actions]) => actions.map(a => a.key));

/**
 * The actions to store as switched off after a save: every switchable action whose box was not ticked.
 * @param {string[] | string | object | undefined} onKeys  action keys submitted as on. A lone value arrives as a
 *        string; qs turns a long repeated field into an index-keyed object once it passes its arrayLimit.
 */
export function planDisabledActions(onKeys) {
    const list = Array.isArray(onKeys) ? onKeys
        : (onKeys && typeof onKeys === 'object') ? Object.values(onKeys)
        : (onKeys ? [onKeys] : []);
    const on = new Set(list.map(String));
    return SWITCHABLE_ACTIONS.filter(key => !on.has(key));
}

/**
 * Per Logging-page category: its action pickers (current colour, whether it is custom, whether it is on)
 * or why it has none. `disabled` holds the actions the server switched off.
 */
export function actionColorRows(guildId, custom = {}, theme = themeColor, disabled = new Set()) {
    const rows = {};
    for (const [category, actions] of Object.entries(LOG_ACTIONS)) {
        const switchable = isSwitchableCategory(category);
        rows[category] = {
            switchable,
            actions: actions.map(({ key, label }) => {
                const fallback = defaultActionColor(guildId, key, theme);
                const picked = normalizeHex(custom[key]);
                return {
                    key, label, value: picked || fallback, fallback, custom: !!picked && picked !== fallback,
                    on: !(switchable && disabled.has(key)),
                };
            }),
        };
    }
    for (const [category, reason] of Object.entries(NOT_POSTED)) rows[category] = { notPosted: reason };
    return rows;
}
