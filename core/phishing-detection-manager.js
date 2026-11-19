import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import configCache from '../utils/configCache.js';
import { isProtectedFromBanCommands } from '../utils/owner-protection.js';
import {
    REPORT_PATTERNS,
    EVIDENCE_POST_PATTERNS,
    EVIDENCE_CHANNEL_PATTERNS,
    USER_ID_REGEX
} from '../utils/report-patterns.js';
import { isWhitelisted } from '../utils/automod-whitelist.js';
import { scanImages } from './scam-image-ocr.js';
import { hasImageAttachment, imageAttachments } from './message-images.js';
import { learnScamImages } from './image-blocklist.js';
import { imageStage as nsfwImageStage } from './nsfw-protection.js';
import { protectionHold, isIgnoredChannel } from './protection-exempt.js';
import {
    getSettings as getThreatSettings, loadOcrRules, obfuscationStage, qrStage, imageRulesStage, aiScamTextReview,
} from './message-threats.js';
import { textOpinion } from './ai-judge.js';
import { whyCannot, whyFailed, reportManualAction } from './manual-action.js';
import { mightContainLink } from './obfuscated-url.js';
import { scoreScamText, MATCH_THRESHOLD } from './scam-text-classifier.js';
import { themeColor } from './guild-theme.js';
import { isSafeDomain, normalizeHost, setOverrideSafeDomains } from './safe-domains.js';

/**
 * Phishing Detection Manager - Checks messages against known phishing domains
 * Maintains an in-memory Set of domains for O(1) lookups on every message.
 * Domain list is synced from community GitHub lists every 4 hours.
 *
 * The never-flag list lives in core/safe-domains.js, shared with the Kick
 * defender — see the rationale there for why embed fixers are on it.
 *
 * checkMessage is also the message-threat pipeline (core/message-threats.js, migration 327): the
 * obfuscated-URL scam stage, QR codes and per-server image-text rules run here, each behind its own
 * switch on the same phishing_config row, so a message's images are read once (scanImages: OCR + QR)
 * and the hosts an obfuscated link or a QR code was hiding go through the same phishing list.
 */

/**
 * The phishing domain list, shared by every bot in the process.
 *
 * initializeManagers() runs once per bot client, so this manager is constructed
 * 41 times. When the Set lived on the instance, each of those 41 copies held
 * ~390,000 domain strings — the same 390,000 strings, loaded 41 times, from the
 * same table. That is the single largest avoidable allocation in a process
 * sitting at ~2.5GB RSS.
 *
 * The list is global threat intelligence, not per-guild state: there is no
 * version of it that differs between bots. So it belongs to the module, and the
 * instances share it.
 *
 * Load is idempotent and guarded, so the 41 constructor calls result in one
 * query rather than 41 racing ones.
 */
let sharedDomainSet = new Set();
let domainLoadPromise = null;
let domainsLoadedAt = 0;

/** How long a freshly-loaded list is considered current. */
const DOMAIN_TTL_MS = 30 * 60 * 1000;

/**
 * The listed domain a host falls under — itself, or a parent domain (login.evil.example → evil.example) —
 * or null. Never-flag domains are never listed (they are skipped at load). Used by the message-threat QR
 * stage and /tools checkurl; message scanning itself keeps its exact-host lookup.
 */
export function phishingLookup(host) {
    const h = normalizeHost(host);
    if (!h || isSafeDomain(h)) return null;
    if (sharedDomainSet.has(h)) return h;
    const parts = h.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join('.');
        if (sharedDomainSet.has(parent)) return parent;
    }
    return null;
}

/** How many domains the shared list holds right now (0 = not loaded in this process). */
export function phishingListSize() {
    return sharedDomainSet.size;
}

/**
 * A domain-report decision (core/domain-reports.js), applied to the in-memory list at once — the full
 * reload that follows can take a while on 390k rows. block: add it; allow: drop it (and any listed
 * subdomain is left to the reload, which now skips it as safe).
 */
export function applyDomainDecision(domain, kind) {
    const h = normalizeHost(domain);
    if (!h) return;
    if (kind === 'block') sharedDomainSet.add(h);
    else sharedDomainSet.delete(h);
}

/** Reload the shared list now (after a domain-report decision). */
export async function reloadPhishingList() {
    return new PhishingDetectionManager(null).loadDomains({ force: true });
}

class PhishingDetectionManager {
    constructor(client) {
        this.client = client;
    }

    /** Shared across every bot in this process — see sharedDomainSet above. */
    get domainSet() {
        return sharedDomainSet;
    }

    /**
     * Load all known phishing domains from DB into the shared in-memory Set.
     * Excludes SAFE_DOMAINS to prevent false positives from community lists.
     *
     * Concurrent callers await the same promise rather than each issuing their
     * own 390k-row SELECT.
     */
    async loadDomains({ force = false } = {}) {
        // Bots start in sequence, so each of the 41 calls this — but the promise
        // guard only collapses *concurrent* callers. Without a freshness check
        // the list would still be re-fetched once per bot, 41 times, seconds
        // apart, for data that changes daily.
        if (!force && sharedDomainSet.size && Date.now() - domainsLoadedAt < DOMAIN_TTL_MS) {
            return sharedDomainSet;
        }
        if (domainLoadPromise) return domainLoadPromise;

        domainLoadPromise = this._loadDomains().finally(() => { domainLoadPromise = null; });
        return domainLoadPromise;
    }

    async _loadDomains() {
        try {
            // Approved disputes first (core/domain-reports.js): the global allow list overrides the feeds.
            try {
                const [allow] = await pool.execute("SELECT domain FROM link_policy_domains WHERE guild_id = '0' AND kind = 'allow'");
                setOverrideSafeDomains(allow.map(r => r.domain));
            } catch (error) {
                logger.warn('[PhishingDetection] Could not load the global allow list, keeping the previous one', { error: error.message });
            }
            const [rows] = await pool.execute('SELECT domain FROM phishing_domains');

            // Build a replacement and swap it in, rather than clearing the live
            // Set and refilling it. The old code left a window — the length of a
            // 390k-row loop — during which every other bot sharing this Set saw
            // it empty and would have waved phishing links straight through.
            const next = new Set();
            let skipped = 0;
            for (const row of rows) {
                const domain = normalizeHost(row.domain);
                if (!domain) continue;
                if (isSafeDomain(domain)) { skipped++; continue; }
                next.add(domain);
            }

            sharedDomainSet = next;
            domainsLoadedAt = Date.now();

            logger.info(`[PhishingDetection] Loaded ${next.size} domains into memory${skipped ? ` (skipped ${skipped} safe domains)` : ''}`);
            return next;
        } catch (error) {
            // Keep serving the previous list rather than dropping protection.
            logger.error('[PhishingDetection] Failed to load domains, keeping previous list', { error: error.message });
            return sharedDomainSet;
        }
    }

    /**
     * Get guild config from cache
     */
    async getConfig(guildId) {
        return configCache.get('phishing_config', guildId, async () => {
            const [rows] = await pool.execute(
                'SELECT * FROM phishing_config WHERE guild_id = ? AND enabled = 1',
                [guildId]
            );
            return rows[0] || null;
        });
    }

    /**
     * Extract unique domains from message content
     * @param {string} content - Message content
     * @returns {Array<{domain: string, url: string}>} Extracted domains with their full URLs
     */
    extractDomains(content) {
        const urlRegex = /https?:\/\/[^\s<>]+/gi;
        const matches = content.match(urlRegex);
        if (!matches) return [];

        const seen = new Set();
        const results = [];

        for (const rawUrl of matches) {
            try {
                const url = new URL(rawUrl);
                let domain = url.hostname.toLowerCase();
                if (domain.startsWith('www.')) {
                    domain = domain.slice(4);
                }
                if (!seen.has(domain)) {
                    seen.add(domain);
                    results.push({ domain, url: rawUrl });
                }
            } catch {
                // Malformed URL — skip
            }
        }

        return results;
    }

    /**
     * Check if a domain is whitelisted for the guild
     */
    isWhitelisted(domain, config) {
        if (!config.whitelist_domains) return false;

        let whitelist;
        try {
            whitelist = JSON.parse(config.whitelist_domains);
        } catch {
            return false;
        }

        if (!Array.isArray(whitelist)) return false;

        // Entries are normalised on the way in, because what an admin actually
        // pastes into the allowlist box is the address bar contents. Comparing
        // the raw entry meant "https://www.kkinstagram.com/" never equalled the
        // extracted host "kkinstagram.com", so the allowlist looked correct in
        // the dashboard and did nothing at all.
        return whitelist.some(safe => {
            const safeHost = normalizeHost(safe);
            return !!safeHost && (domain === safeHost || domain.endsWith('.' + safeHost));
        });
    }

    /**
     * Check if a channel is exempt from phishing detection.
     * Layer 1: explicit exempt list OR channel name pattern match.
     */
    isExemptChannel(channel, config) {
        if (config.exempt_channels) {
            try {
                const exemptList = JSON.parse(config.exempt_channels);
                if (Array.isArray(exemptList) && exemptList.includes(channel.id)) {
                    return true;
                }
            } catch {
                // Malformed JSON — skip
            }
        }

        const name = channel.name?.toLowerCase() || '';
        return EVIDENCE_CHANNEL_PATTERNS.some(pattern => name.includes(pattern));
    }

    /**
     * Check if a message looks like someone reporting/sharing evidence
     * rather than posting a scam. Layer 2 heuristic.
     * Returns true if ANY evidence signal matches (boolean, not scored).
     */
    looksLikeEvidencePost(message) {
        const content = message.content || '';

        if (EVIDENCE_POST_PATTERNS.some(p => p.test(content))) return true;
        if (REPORT_PATTERNS.some(p => p.test(content))) return true;

        const hasUserId = USER_ID_REGEX.test(content);
        const hasImages = hasImageAttachment(message);
        if (hasUserId && hasImages) return true;

        if (message.member) {
            const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
            const isMod = message.member.permissions.has(PermissionFlagsBits.ModerateMembers);
            if (isAdmin || isMod) return true;
        }

        return false;
    }

    /**
     * Forward a suspected evidence post to the report channel and alert mods.
     * Deletes from original channel (still contains phishing link).
     */
    async forwardEvidencePost(message, matchedDomain, matchedUrl, config) {
        const { guild, author, channel } = message;

        const attachmentUrls = message.attachments.map(a => a.url);
        const originalContent = message.content || '(no text content)';

        try {
            await message.delete();
        } catch (error) {
            logger.error('[PhishingDetection] Failed to delete evidence post', { error: error.message });
        }

        if (config.report_channel_id) {
            try {
                const reportChannel = guild.channels.cache.get(config.report_channel_id);
                if (reportChannel) {
                    const embed = new EmbedBuilder()
                        .setColor(themeColor(message.guild?.id, 'warning'))
                        .setTitle('Possible Evidence Post Redirected')
                        .setDescription(
                            'This message was removed from its original channel because it contained a known phishing domain, ' +
                            'but it appears to be an evidence/report post. No action was taken against the user.'
                        )
                        .addFields(
                            { name: 'Author', value: `${author} (${author.tag})`, inline: true },
                            { name: 'Original Channel', value: `${channel}`, inline: true },
                            { name: 'Phishing Domain Found', value: `\`${matchedDomain}\``, inline: true },
                            { name: 'Original Message', value: originalContent.length > 1024 ? originalContent.substring(0, 1021) + '...' : originalContent, inline: false }
                        )
                        .setFooter({ text: `User ID: ${author.id} | Use this channel for evidence posts` })
                        .setTimestamp();

                    if (attachmentUrls.length > 0) {
                        embed.addFields({
                            name: 'Attachments',
                            value: attachmentUrls.map((url, i) => `[Attachment ${i + 1}](${url})`).join('\n'),
                            inline: false
                        });
                    }

                    await reportChannel.send({ embeds: [embed] });
                }
            } catch (error) {
                logger.error('[PhishingDetection] Failed to forward evidence post', { error: error.message });
            }
        }

        if (config.alert_channel_id) {
            try {
                const alertChannel = guild.channels.cache.get(config.alert_channel_id);
                if (alertChannel) {
                    const embed = new EmbedBuilder()
                        .setColor(themeColor(message.guild?.id, 'warning'))
                        .setTitle('Phishing Detection — Evidence Post Flagged')
                        .setDescription(
                            `A message in ${channel} contained phishing domain \`${matchedDomain}\` but appeared to be an evidence/report post. ` +
                            `Message was deleted and ${config.report_channel_id ? 'forwarded to <#' + config.report_channel_id + '>' : 'not forwarded (no report channel configured)'}. ` +
                            'No action taken against the user.'
                        )
                        .addFields(
                            { name: 'User', value: `${author} (${author.tag})`, inline: true },
                            { name: 'Channel', value: `${channel}`, inline: true }
                        )
                        .setFooter({ text: `User ID: ${author.id}` })
                        .setTimestamp();

                    await alertChannel.send({ embeds: [embed] });
                }
            } catch (error) {
                logger.error('[PhishingDetection] Failed to send evidence alert', { error: error.message });
            }
        }

        if (config.log_detections) {
            try {
                await pool.execute(
                    `INSERT INTO phishing_detections (guild_id, user_id, channel_id, matched_domain, matched_url, source, action_taken)
                     VALUES (?, ?, ?, ?, ?, 'evidence_flagged', 'flagged_evidence')`,
                    [guild.id, author.id, channel.id, matchedDomain, matchedUrl]
                );
            } catch (error) {
                logger.error('[PhishingDetection] Failed to log evidence detection', { error: error.message });
            }
        }

        logger.info('[PhishingDetection] Evidence post flagged — no action against user', {
            guildId: guild.id,
            userId: author.id,
            domain: matchedDomain,
            channelId: channel.id
        });
    }

    /**
     * Check a message for phishing links.
     * Three-layer filter: channel exemption -> evidence heuristic -> normal action.
     * @param {Message} message - Discord message to check
     * @returns {boolean} true if message was acted on
     */
    async checkMessage(message) {
        // Skip bots and DMs
        if (message.author.bot || !message.guild) return false;

        // Skip admins, owners, and whitelisted users
        if (message.member) {
            const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
            const isOwner = message.member.id === message.guild.ownerId;
            if (isAdmin || isOwner) return false;
        }
        if (await isWhitelisted(message.guild.id, message.author.id)) return false;

        // Fast bail: nothing to scan unless there's a URL in text, something that could be an
        // obfuscated link, OR an image attachment.
        //
        // What counts as an image is isImageAttachment's call, not a content-type prefix test — see
        // core/message-images.js. Reading the poster-supplied type here is what made the whole scan
        // skippable, and the skip was indistinguishable from a clean scan.
        const hasImages = hasImageAttachment(message);
        const hasUrlInText = /https?:\/\//i.test(message.content || '');
        const maybeObfuscated = mightContainLink(message.content || '');
        if (!hasImages && !hasUrlInText && !maybeObfuscated) return false;

        // Phishing detection itself (null when off), and the message-threat stages that share this row.
        const config = await this.getConfig(message.guild.id);
        const threats = await getThreatSettings(message.guild.id);
        const t = threats.settings;
        const ocrRules = hasImages && t.ocrRules.enabled ? await loadOcrRules(message.guild.id) : [];
        const anyThreatStage = t.obf.enabled || t.qr.enabled || ocrRules.length > 0 || (hasImages && t.nsfw.enabled);
        if (!config && !anyThreatStage) return false;

        // Layer 1: Channel exemption — skip entirely (covers reports/red-flags channels), and the
        // channels / categories on the message protections' ignore list.
        if (this.isExemptChannel(message.channel, config || threats.row || {})) return false;
        if (await isIgnoredChannel(message.channel)) return false;

        // Obfuscated-URL "fake support" scam. Runs on text only, before any image is downloaded.
        let obfuscation = null;
        if (maybeObfuscated) {
            const stage = await obfuscationStage(message, t);
            if (stage.acted) return true;
            obfuscation = stage.analysis;
        }

        // NSFW chat images (core/nsfw-protection.js): the local models, through the same shared download as
        // the scans below. Age-restricted channels are skipped there. Before OCR: a removed image needs no OCR.
        if (hasImages && t.nsfw.enabled && await nsfwImageStage(message, t)) return true;

        // Read each image once for every image check: OCR (phishing genre classifier, image-text rules)
        // and QR codes.
        let ocrText = '';
        const wantOcr = hasImages && ((config && config.scan_images) || ocrRules.length > 0);
        const wantQr = hasImages && t.qr.enabled;
        let qrScan = null;
        if (wantOcr || wantQr) {
            const scan = await scanImages(imageAttachments(message), { ocr: wantOcr, qr: wantQr });
            ocrText = scan.text;
            qrScan = scan.qr;
        }

        // QR codes: decoded links through the phishing list and the obfuscation check; strict mode
        // removes any QR image.
        if (qrScan?.codes && await qrStage(message, t, qrScan, (h) => (this.isWhitelisted(h, config || threats.row || {}) ? null : phishingLookup(h)))) {
            return true;
        }

        if (!config) {
            return ocrText ? imageRulesStage(message, t, ocrText) : false;
        }

        // Domains the user actually TYPED (vs. ones only read out of an image). The
        // distinction matters for the evidence exemption below: a typed link can be a
        // member pasting a scam URL to warn others, so it keeps the (softer) evidence
        // heuristic; a link that exists ONLY inside an image is image-derived and is
        // hardened — see the image-path note below.
        const textDomainSet = new Set(this.extractDomains(message.content || '').map(d => d.domain));
        const domains = this.extractDomains(`${message.content || ''}\n${ocrText}`);
        // Hosts an obfuscated link was hiding ("https://@evil。com") are typed links too.
        for (const host of obfuscation?.hiddenHosts || []) {
            if (domains.some(d => d.domain === host)) continue;
            domains.push({ domain: host, url: `(obfuscated) ${host}` });
            textDomainSet.add(host);
        }

        // Known phishing domain (in text OR image) — high confidence.
        for (const { domain, url } of domains) {
            // Re-checked here and not only at load: the in-memory list can be up
            // to 30 minutes stale, and a false positive that survives a sync is
            // a deleted message, not a slow lookup.
            if (isSafeDomain(domain)) continue;
            if (this.domainSet.has(domain) && !this.isWhitelisted(domain, config)) {
                const inText = textDomainSet.has(domain);
                // Image-path hardening: the evidence DOWNGRADE (delete-but-don't-punish)
                // is gated on a forgeable caption keyword, so we only honor it for TYPED
                // links. Links/scams that are image-only rely on the non-forgeable
                // exemptions already applied above (exempt channel, admin/owner, whitelist).
                if (inText && this.looksLikeEvidencePost(message)) {
                    await this.forwardEvidencePost(message, domain, url, config);
                    return true;
                }
                await this.takeAction(message, domain, url, config, inText ? 'auto-list' : 'image-domain');
                return true;
            }
        }

        // Scam-genre heuristic — runs ONLY on image-derived text (never plain chat).
        // Image-derived → no forgeable-caption downgrade; channel/admin/whitelist
        // exemptions (applied above) are the legitimate "this is a report" signals.
        if (ocrText) {
            const genre = scoreScamText(ocrText);
            if (genre.matched) {
                const reason = `image-scam (${genre.groups.join('+')})`;
                await this.takeAction(message, reason, '(text inside image)', config, 'image-genre');

                // Remember the picture, not the post. OCR costs seconds per image and runs behind a
                // process-wide mutex, so a burst across a dozen channels outruns it; the fingerprint
                // path in checkBlockedImage costs one download and runs BEFORE this one. Handing it
                // the images that just scored means copies two through nine die on arrival, and the
                // existing 3-channel auto-ban starts counting. Scoped to this guild: a hash learned
                // from one server's spam should not be able to delete another's posts.
                learnScamImages({
                    guildId: message.guild.id,
                    attachments: imageAttachments(message),
                    label: reason,
                }).catch(err => logger.warn('[PhishingDetection] could not learn scam image', { error: err.message }));

                return true;
            }

            // One group short of the bar: the AI second opinion (core/ai-judge.js), when the server has it on.
            // act + the AI agreeing at the server's confidence → this pipeline's own action; a scam verdict below
            // that (or advise mode) → a review alert with the verdict. No verdict → as before (nothing).
            if (genre.groups.length === MATCH_THRESHOLD - 1) {
                const ai = await textOpinion(message, {
                    text: [message.content, ocrText].filter(Boolean).join('\n'),
                    detector: 'Scam text in an image (one signal group short of the bar)', signals: genre.groups,
                });
                if (ai.decision === 'act') {
                    await this.takeAction(message, `image-scam-ai (${genre.groups.join('+')})`, '(text inside image)', config, 'image-genre-ai');
                    learnScamImages({ guildId: message.guild.id, attachments: imageAttachments(message), label: 'image-scam (AI confirmed)' })
                        .catch(err => logger.warn('[PhishingDetection] could not learn scam image', { error: err.message }));
                    return true;
                }
                if (ai.verdict?.positive && ai.decision === 'advise') {
                    await aiScamTextReview(message, { ocrText, groups: genre.groups, ai });
                }
            }

            // Below the bar, but the text WAS read. Logged because the alternative — the silence
            // that followed the 2026-09-13 wave — leaves no way to tell a clean scan from a scan
            // that never happened. Info level: debug is not written in production, which hid exactly this.
            logger.info('[PhishingDetection] image text scanned, below scam threshold', {
                guildId: message.guild.id, userId: message.author.id,
                groups: genre.groups, chars: ocrText.length,
            });
        } else if (hasImages && config.scan_images) {
            logger.info('[PhishingDetection] image post produced no readable text', {
                guildId: message.guild.id, userId: message.author.id,
            });
        }

        // The server's own rules for text inside images (message threats).
        if (ocrText && await imageRulesStage(message, t, ocrText)) return true;

        return false;
    }

    /**
     * Take action on a phishing message
     */
    async takeAction(message, matchedDomain, matchedUrl, config, source = null) {
        const { guild, author, channel, member } = message;

        // Unified allowlist / global pause: still recorded and alerted below, but the message stays
        // and nothing is done to the member (core/protection-exempt.js logs the skip).
        const held = member ? await protectionHold(member, 'delete', 'Phishing detection') : null;

        // Otherwise always try to delete the message
        if (!held) {
            try {
                await message.delete();
            } catch (error) {
                logger.error('[PhishingDetection] Failed to delete message', { error: error.message });
            }
        }

        // Never apply mute/kick/ban to the protected bot owner — just stop after the delete
        if (isProtectedFromBanCommands(author?.id)) {
            return;
        }

        // Log to database
        if (config.log_detections) {
            try {
                const detectionSource = source || (this.domainSet.has(matchedDomain) ? 'auto-list' : 'manual');
                await pool.execute(
                    `INSERT INTO phishing_detections (guild_id, user_id, channel_id, matched_domain, matched_url, source, action_taken)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [guild.id, author.id, channel.id, matchedDomain, matchedUrl, detectionSource, held ? 'none' : config.action]
                );
            } catch (error) {
                logger.error('[PhishingDetection] Failed to log detection', { error: error.message });
            }
        }

        // Apply secondary action. When the bot cannot (permission or role order) it says exactly why
        // ("Manual action needed", core/manual-action.js) instead of skipping silently.
        const verb = { mute: 'timeout', kick: 'kick', ban: 'ban' }[config.action];
        const cannot = !held && verb && member ? whyCannot(guild, verb, { member, channel }) : null;
        if (cannot) await reportManualAction(guild, { action: verb, member, channel, source: 'Phishing detection', problem: cannot });
        if (!held && !cannot) try {
            switch (config.action) {
                case 'mute':
                    if (member && member.moderatable) {
                        const duration = (config.mute_duration_minutes || 30) * 60 * 1000;
                        await member.timeout(duration, `Phishing link detected: ${matchedDomain}`);
                    }
                    break;
                case 'kick':
                    if (member && member.kickable) {
                        await member.kick(`Phishing link detected: ${matchedDomain}`);
                    }
                    break;
                case 'ban':
                    if (member && member.bannable) {
                        await member.ban({ reason: `Phishing link detected: ${matchedDomain}`, deleteMessageSeconds: 86400 });
                    }
                    break;
                case 'warn':
                    await channel.send({
                        content: `${author}, your message was removed because it contained a known phishing link. Please be careful with the links you share.`,
                    }).catch(() => {});
                    break;
                // 'delete' — already handled above
            }
        } catch (error) {
            logger.error('[PhishingDetection] Failed to apply action', {
                action: config.action,
                error: error.message
            });
            const cause = verb && member ? whyFailed(error, guild, verb, { member, channel }) : null;
            if (cause) await reportManualAction(guild, { action: verb, member, channel, source: 'Phishing detection', problem: cause });
        }

        // Send alert to configured channel
        if (config.alert_channel_id) {
            try {
                const alertChannel = guild.channels.cache.get(config.alert_channel_id);
                if (alertChannel) {
                    const accountAge = Math.floor(author.createdAt.getTime() / 1000);
                    const embed = new EmbedBuilder()
                        .setColor(themeColor(member.guild?.id, 'danger'))
                        .setTitle('Phishing Link Detected')
                        .setDescription(`A message in ${channel} contained a known phishing domain.`)
                        .addFields(
                            { name: 'User', value: `${author} (${author.tag})`, inline: true },
                            { name: 'Account Age', value: `<t:${accountAge}:R>`, inline: true },
                            { name: 'Action Taken', value: held ? `none — ${held.why === 'paused' ? 'protections paused' : 'member is exempt'}` : config.action, inline: true },
                            { name: 'Matched Domain', value: `\`${matchedDomain}\``, inline: true },
                            { name: 'Full URL', value: matchedUrl.length > 500 ? matchedUrl.substring(0, 500) + '...' : matchedUrl, inline: false },
                            { name: 'Channel', value: `${channel}`, inline: true }
                        )
                        .setFooter({ text: `User ID: ${author.id}` })
                        .setTimestamp();

                    await alertChannel.send({ embeds: [embed] });
                }
            } catch (error) {
                logger.error('[PhishingDetection] Failed to send alert', { error: error.message });
            }
        }

        logger.warn('[PhishingDetection] Phishing link blocked', {
            guildId: guild.id,
            userId: author.id,
            domain: matchedDomain,
            action: config.action
        });
    }
}

export default PhishingDetectionManager;
