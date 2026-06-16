import express from 'express';
import rateLimit from 'express-rate-limit';
import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionsBitField
} from 'discord.js';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';
import { resolveStreamerIdentity } from '../../../utils/platforms/resolve-identity.js';

/**
 * PUBLIC Stream Team Signup API.
 *
 * Unlike the logged-in `/api/me/stream-team` router, this one is reachable
 * WITHOUT a Discord login — a Twitch streamer who isn't in our Discord can
 * still apply. Each submission still opens the SAME private "Stream Team
 * Signup" ticket the owner (panel.extra_viewer_id) reviews.
 *
 * Two flavors of submission:
 *   - LINKED: req.user is set AND is a member of the guild → the ticket is
 *     bound to their Discord id (user_id = their id, channel visible to them,
 *     they can chat in it).
 *   - ANONYMOUS: no session / not a guild member → user_id = '0' sentinel, the
 *     channel is owner-only (no per-applicant overwrite, owner reads it). We do
 *     NOT leak the channel id back to anonymous submitters.
 *
 * Anti-abuse (public endpoint that creates Discord channels = spam vector):
 *   1. HONEYPOT — a hidden `website` field; bots fill it, humans don't. Non-empty
 *      → pretend success, create nothing.
 *   2. RATE LIMIT — express-rate-limit, per source IP, 3 applications / 24h.
 *   3. TWITCH-RESOLVE GATE — the Twitch answer must resolve to a REAL channel via
 *      resolveStreamerIdentity('twitch', handle) or the request is rejected. This
 *      forces every application to correspond to an actual Twitch account and is
 *      the strongest barrier to drive-by channel-spam.
 *
 * Mounted BEFORE the global apiCheckAuth in routes/api/index.js so it stays
 * public; uses `if (req.user)` for optional auth (passport populates req.user
 * on any route when a session exists).
 */
const router = express.Router();

const GUILD_ID = '1342779579168981065';
const PANEL_NAME = 'Stream Team Signup';

// Per-IP rate limiter: 3 applications per 24h. Public channel-creating endpoint.
const applyLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip,
    message: { error: 'Too many applications from your network today — try again tomorrow.' }
});

/**
 * Resolve the active Stream Team Signup panel + its form questions.
 * Returns { panel, questions } or null if the panel doesn't exist / inactive.
 */
async function resolvePanel() {
    const [panels] = await pool.execute(
        "SELECT * FROM ticket_panels WHERE guild_id = ? AND panel_name = ? AND is_active = 1",
        [GUILD_ID, PANEL_NAME]
    );
    if (panels.length === 0) return null;
    const panel = panels[0];

    const [questions] = await pool.execute(
        "SELECT question_id, question_text, question_type FROM ticket_form_questions WHERE form_id = ? ORDER BY question_id",
        [panel.form_id]
    );
    return { panel, questions };
}

// Parse a Twitch handle from a URL or @name. Returns a clean login or ''.
function parseTwitchHandle(raw) {
    let s = String(raw || '').trim();
    if (!s) return '';
    // URL form: https://twitch.tv/<name> (optionally with www / query / trailing slash)
    const urlMatch = s.match(/(?:twitch\.tv\/)([A-Za-z0-9_]+)/i);
    if (urlMatch) return urlMatch[1];
    // @name or bare name
    s = s.replace(/^@/, '');
    // Keep only the first token, strip anything non-handle.
    const tokenMatch = s.match(/[A-Za-z0-9_]+/);
    return tokenMatch ? tokenMatch[0] : '';
}

// GET /panel (PUBLIC) → panel existence + the 3 questions + loggedIn flag.
router.get('/panel', async (req, res) => {
    try {
        const resolved = await resolvePanel();
        if (!resolved) {
            return res.json({ exists: false, loggedIn: !!req.user });
        }
        const { questions } = resolved;
        res.json({
            exists: true,
            questions: questions.map(q => ({
                question_id: q.question_id,
                question_text: q.question_text,
                question_type: q.question_type
            })),
            loggedIn: !!req.user
        });
    } catch (error) {
        logger.error('[API /public/stream-team GET /panel] Error', { error: error.message });
        res.status(500).json({ error: 'Failed to load the stream team signup form.' });
    }
});

// POST /apply (PUBLIC, rate-limited) → create the ticket (linked or anonymous).
router.post('/apply', applyLimiter, async (req, res) => {
    try {
        const body = (req.body && typeof req.body === 'object') ? req.body : {};

        // a. HONEYPOT — bots fill the hidden `website` field. Pretend success.
        if (typeof body.website === 'string' && body.website.trim() !== '') {
            logger.warn('[Stream Team] Honeypot tripped — silently dropping application', { ip: req.ip });
            return res.json({ ok: true });
        }

        const answers = (body.answers && typeof body.answers === 'object') ? body.answers : {};

        // c. Resolve panel + questions.
        const resolved = await resolvePanel();
        if (!resolved) {
            return res.status(400).json({ error: 'The Stream Team Signup form is not available right now.' });
        }
        const { panel, questions } = resolved;
        const guildId = GUILD_ID;

        // b. Find + validate the Twitch answer (the question whose TEXT mentions Twitch).
        const twitchQ = questions.find(q => /twitch/i.test(q.question_text || ''));
        let twitchHandle = '';
        if (twitchQ) {
            twitchHandle = parseTwitchHandle(answers[twitchQ.question_id]);
        }
        if (!twitchHandle) {
            return res.status(400).json({ error: "We couldn't find that Twitch channel — double-check the URL." });
        }
        let identity = null;
        try {
            identity = await resolveStreamerIdentity('twitch', twitchHandle);
        } catch (e) {
            identity = null;
        }
        if (!identity || !identity.platformUserId) {
            return res.status(400).json({ error: "We couldn't find that Twitch channel — double-check the URL." });
        }
        // Use the canonical login for the channel name.
        const canonicalHandle = identity.canonicalUsername || twitchHandle;

        // Get the client for this guild + fetch the guild.
        const client = global.botManager?.getClientForGuild(guildId);
        if (!client) {
            return res.status(503).json({ error: 'The bot is not available right now. Try again shortly.' });
        }
        const guild = await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) {
            return res.status(503).json({ error: 'The bot is not available right now. Try again shortly.' });
        }

        // d. Build form_responses keyed by QUESTION TEXT (mirror ticket_create.js).
        const responses = {};
        for (const q of questions) {
            const raw = answers[q.question_id];
            const text = typeof raw === 'string' ? raw.trim() : '';
            if (!text) {
                return res.status(400).json({ error: `Please answer: ${q.question_text}` });
            }
            responses[q.question_text] = text;
        }
        // Append optional Discord username if the applicant provided one.
        if (typeof body.discord_username === 'string' && body.discord_username.trim()) {
            responses['Discord username'] = body.discord_username.trim().substring(0, 200);
        }
        const formResponses = JSON.stringify(responses);

        // e. Decide opener — LINKED only if logged in AND a member of the guild.
        let openerId = null;
        if (req.user?.id) {
            const member = await guild.members.fetch(req.user.id).catch(() => null);
            if (member) openerId = req.user.id;
        }

        // f. One-open-ticket guard ONLY for linked applicants (rate-limit covers anon).
        if (openerId) {
            const [existingTickets] = await pool.execute(
                "SELECT channel_id FROM tickets WHERE guild_id = ? AND user_id = ? AND status != 'closed'",
                [guildId, openerId]
            );
            if (existingTickets.length > 0) {
                return res.status(409).json({
                    error: 'You already have an open application.',
                    channelId: existingTickets[0].channel_id
                });
            }
        }

        // g. Build permission overwrites. Always: deny @everyone, allow owner.
        //    Linked: also allow the applicant.
        const permissionOverwrites = [
            { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] }
        ];
        if (panel.extra_viewer_id) {
            permissionOverwrites.push({
                id: panel.extra_viewer_id,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory
                ]
            });
        }
        // support_role_id is '' (empty) for this panel → skipped.
        if (panel.support_role_id) {
            permissionOverwrites.push({
                id: panel.support_role_id,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory
                ]
            });
        }
        if (openerId) {
            permissionOverwrites.push({
                id: openerId,
                allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory
                ]
            });
        }

        const channelName = `streamteam-${(canonicalHandle || 'applicant')}`
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '-')
            .substring(0, 100);

        const channel = await guild.channels.create({
            name: channelName,
            type: 0,
            parent: panel.ticket_category_id,
            permissionOverwrites
        });

        // h. INSERT into tickets — user_id = openerId || '0' (varchar NOT NULL sentinel).
        const [result] = await pool.execute(
            "INSERT INTO tickets (guild_id, panel_id, user_id, channel_id, status, form_id, form_responses) VALUES (?, ?, ?, ?, 'open', ?, ?)",
            [guildId, panel.panel_id, openerId || '0', channel.id, panel.form_id, formResponses]
        );
        const ticketId = result.insertId;

        const [ticketCount] = await pool.execute(
            "SELECT COUNT(*) as count FROM tickets WHERE guild_id = ?",
            [guildId]
        );
        const ticketNumber = ticketCount[0].count;

        // i. Welcome embed + form responses + close button.
        const embed = new EmbedBuilder()
            .setColor('#9146FF')
            .setTitle('Stream Team Application')
            .setDescription(
                openerId
                    ? `New application from <@${openerId}>. A staff member will review it shortly.`
                    : 'New application submitted via the website. A staff member will review it shortly.'
            )
            .setTimestamp();

        let responseText = '';
        for (const [question, answer] of Object.entries(responses)) {
            responseText += `**${question}**\n${answer}\n\n`;
        }
        embed.addFields({ name: 'Form Responses', value: responseText.substring(0, 1024) });
        if (!openerId) {
            embed.addFields({ name: 'Source', value: 'Submitted via the website — not linked to a Discord account.' });
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`ticket_close_${ticketId}`)
                .setLabel('Close Ticket')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🔒')
        );

        // Content pings the owner; if linked, also pings the applicant.
        let messageContent = `<@${panel.extra_viewer_id}>`;
        if (openerId) messageContent += ` <@${openerId}>`;

        await channel.send({
            content: messageContent,
            embeds: [embed],
            components: [row]
        });

        logger.info(`Stream Team application ticket #${ticketId} created (${openerId ? 'linked:' + openerId : 'anonymous'}) for twitch:${canonicalHandle}`, { guildId, category: 'tickets' });

        // Alert embed → panel.alert_channel_id (mirror ticket_create.js).
        if (panel.alert_channel_id) {
            try {
                const alertChannel = await guild.channels.fetch(panel.alert_channel_id).catch(() => null);
                if (alertChannel) {
                    const alertEmbed = new EmbedBuilder()
                        .setColor('#2ECC71')
                        .setTitle('🎫 New Stream Team Application')
                        .setDescription(`**${channelName}** with ID: ${ticketId} has been opened.`)
                        .addFields(
                            { name: '📨 Opened By', value: openerId ? `<@${openerId}>` : 'Website (anonymous)', inline: true },
                            { name: '📋 Panel', value: panel.panel_name || 'Default', inline: true },
                            { name: '📌 Channel', value: `<#${channel.id}>`, inline: true }
                        )
                        .setFooter({ text: `Ticket #${ticketId}` })
                        .setTimestamp();

                    const joinRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setStyle(ButtonStyle.Link)
                            .setLabel('Join Ticket')
                            .setEmoji('➕')
                            .setURL(`https://discord.com/channels/${guildId}/${channel.id}`)
                    );

                    await alertChannel.send({ embeds: [alertEmbed], components: [joinRow] });
                }
            } catch (alertErr) {
                logger.warn('[Stream Team Alert] Failed to send alert', { error: alertErr.message, guildId });
            }
        }

        // j. Respond. Do NOT leak the channel id to anonymous submitters.
        res.json({ ok: true, linked: !!openerId });
    } catch (error) {
        logger.error('[API /public/stream-team POST /apply] Error', { error: error.message });
        res.status(500).json({ error: 'An error occurred while submitting your application.' });
    }
});

export default router;
