/**
 * Composition root for the Kick Defender. Wires the real collaborators into
 * the enforcer. Import { enforcer } and call enforcer.check(event) from the
 * chat pipeline.
 */
import { createEnforcer } from './enforcer.js';
import { isOnBanlist, isOnUnbanlist } from './banlist.js';
import { resolveChannel } from './channel-tokens.js';
import { banUser, deleteMessage } from './kick-moderation.js';
import { log } from './enforcement-log.js';
import { findPhishingDomain, startDomainRefresh } from './phishing-domains.js';
import { recordOffense } from './link-offenses.js';

// Begin loading the phishing-domain set into memory (refreshes every 4h).
startDomainRefresh();

export const enforcer = createEnforcer({
    isOnBanlist,
    isOnUnbanlist,
    resolveChannel,
    banUser: (broadcasterId, userId, opts, token) => banUser(broadcasterId, userId, opts, token),
    deleteMessage: (messageId, token) => deleteMessage(messageId, token),
    log,
    findPhishingDomain,
    recordOffense
});
