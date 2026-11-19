/*
 * Modmail: members DM the bot, staff answer from a private channel in the server.
 *
 * Flow
 *   1. A member DMs the bot (events/messageCreate.js → handleModmailDM).
 *      - If they already have an open thread with a server this bot serves, the message is relayed
 *        straight into that thread's staff channel.
 *      - Otherwise, if they share one or more servers that have modmail enabled (and they are not
 *        blocked there), the bot asks first — a button for one server, a picker for several. Asking
 *        stops a DM meant for something else (a form reply, a game prompt, a stray "hi") from
 *        landing in front of a whole staff team, and lets the member choose when several servers
 *        qualify. Messages sent while the question is on screen are carried along when they answer.
 *      - With no qualifying server the DM is not consumed, and the existing DM handlers run.
 *   2. Opening creates a private text channel under the configured category (staff role + bot
 *      only), pins a header with Close / Block buttons, pings the staff role, and posts a notice to
 *      the configured log channel. One open thread per member per server.
 *   3. Staff messages in that channel are relayed to the member's DMs (anonymously when the server
 *      has that on). Messages starting with `//` stay in the channel as staff-only notes. Only staff
 *      (the staff role, Manage Server or Administrator) are relayed; bot messages never are.
 *   4. Closing (button, or the dashboard) marks the thread closed, posts the transcript to the log
 *      channel, tells the member, and deletes the channel. Every message is kept in
 *      modmail_messages, so the transcript stays readable from the dashboard afterwards.
 *
 * Everything that matters is in the database (modmail_threads / modmail_messages /
 * modmail_blocked_users / modmail_config). The in-memory bits — which channels are open threads,
 * a pending "contact staff?" prompt per member, the last server a member routed to — are caches
 * that rebuild themselves after a restart.
 *
 * Multi-bot: a server served by a custom bot is ignored by the default bot (guild_bot_mapping), so
 * the DM side only offers servers the receiving bot actually serves, and the staff side runs after
 * messageCreate's shouldIgnoreGuild() check. The same client therefore owns both ends of a thread.
 */
import {
    ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder,
    MessageType, OverwriteType, PermissionFlagsBits, StringSelectMenuBuilder,
} from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { shouldIgnoreGuild } from '../utils/custom-bot-check.js';
import { themeColor } from './guild-theme.js';
import {
    IDS, channelNameFor, formatTranscript, isInternalNote, serialiseAttachments, truncate,
} from './modmail-format.js';

const DEFAULT_GREETING = 'Thank you for contacting the staff team. Please describe your issue.';
const DEFAULT_CLOSE = 'This modmail thread has been closed. Thank you for contacting us.';

const PROMPT_TTL_MS = 10 * 60_000;   // one "contact staff?" question on screen per member at a time
const ROUTE_TTL_MS = 30 * 60_000;    // remember which server a member with several threads is talking to
const MAX_CARRIED_MESSAGES = 50;     // DMs sent while the question was on screen, carried on open

// Keyed per bot client as well as per member: the module is shared by every bot in the process,
// and a question asked by one bot must not silence another.
const pendingPrompts = new Map();    // `${botUserId}:${userId}` -> { at }
const lastRoute = new Map();         // `${botUserId}:${userId}` -> { guildId, at }
const keyFor = (client, userId) => `${client?.user?.id || 'bot'}:${userId}`;
const openLocks = new Set();         // `${guildId}:${userId}` while a thread is being created

// ── Open-thread channel index ────────────────────────────────────────────────────────────────
// Every guild message asks "is this a modmail channel?", so the answer has to be a Map lookup.
let channelIndex = null;             // Map<channelId, threadId>
let channelIndexLoading = null;

async function ensureIndex() {
    if (channelIndex) return channelIndex;
    if (!channelIndexLoading) {
        channelIndexLoading = (async () => {
            const [rows] = await pool.execute("SELECT id, channel_id FROM modmail_threads WHERE status = 'open'");
            channelIndex = new Map(rows.map(r => [String(r.channel_id), Number(r.id)]));
            return channelIndex;
        })().catch(err => {
            channelIndexLoading = null;
            throw err;
        });
    }
    return channelIndexLoading;
}

function indexAdd(channelId, threadId) {
    if (channelIndex) channelIndex.set(String(channelId), Number(threadId));
    else channelIndexLoading?.then(m => m.set(String(channelId), Number(threadId))).catch(() => {});
}

function indexRemove(channelId) {
    if (channelIndex) channelIndex.delete(String(channelId));
    else channelIndexLoading?.then(m => m.delete(String(channelId))).catch(() => {});
}

/** Drop stale entries so the per-member caches cannot grow without bound. */
function remember(map, key, value, ttlMs) {
    if (map.size > 2000) {
        const cutoff = Date.now() - ttlMs;
        for (const [k, v] of map) if (v.at < cutoff) map.delete(k);
    }
    map.set(key, value);
}

export async function isModmailChannel(channelId) {
    try {
        return (await ensureIndex()).has(String(channelId));
    } catch (err) {
        logger.error('[Modmail] Could not load the open-thread index', { error: err.message });
        return false;
    }
}

// ── Data access ──────────────────────────────────────────────────────────────────────────────

const THREAD_COLS = 'id, guild_id, user_id, channel_id, status, created_at, closed_at, closed_by, close_reason, last_activity_at';

export async function getModmailConfig(guildId) {
    const [rows] = await pool.execute(
        `SELECT guild_id, enabled, category_id, log_channel_id, staff_role_id, greeting_message,
                close_message, anonymous_replies
           FROM modmail_config WHERE guild_id = ?`,
        [guildId]
    );
    return rows[0] || null;
}

export async function getThread(threadId) {
    const [rows] = await pool.execute(`SELECT ${THREAD_COLS} FROM modmail_threads WHERE id = ?`, [threadId]);
    return rows[0] || null;
}

async function getOpenThread(guildId, userId) {
    const [rows] = await pool.execute(
        `SELECT ${THREAD_COLS} FROM modmail_threads
          WHERE guild_id = ? AND user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1`,
        [guildId, userId]
    );
    return rows[0] || null;
}

async function getOpenThreadByChannel(channelId) {
    const [rows] = await pool.execute(
        `SELECT ${THREAD_COLS} FROM modmail_threads WHERE channel_id = ? AND status = 'open' LIMIT 1`,
        [channelId]
    );
    return rows[0] || null;
}

async function getOpenThreadsForUser(userId) {
    const [rows] = await pool.execute(
        `SELECT ${THREAD_COLS} FROM modmail_threads WHERE user_id = ? AND status = 'open' ORDER BY id`,
        [userId]
    );
    return rows;
}

export async function isBlocked(guildId, userId) {
    const [rows] = await pool.execute(
        'SELECT 1 FROM modmail_blocked_users WHERE guild_id = ? AND user_id = ? LIMIT 1',
        [guildId, userId]
    );
    return rows.length > 0;
}

async function insertMessage(threadId, authorId, authorType, content, attachments = null, opts = {}) {
    await pool.execute(
        `INSERT INTO modmail_messages
            (thread_id, author_id, author_type, message_content, attachments, is_internal, is_anonymous, source_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            threadId, authorId, authorType, String(content ?? ''), attachments,
            opts.internal ? 1 : 0, opts.anonymous ? 1 : 0, opts.sourceMessageId || null,
        ]
    );
    // Track Awaiting Response state: only user/staff replies move the needle, system messages
    // and internal mod notes don't (migration 348 added the thread-level timestamps).
    if (!opts.internal && (authorType === 'user' || authorType === 'staff')) {
        const col = authorType === 'user' ? 'last_user_reply_at' : 'last_staff_reply_at';
        pool.execute(`UPDATE modmail_threads SET ${col} = NOW() WHERE id = ?`, [threadId])
            .catch(() => { /* non-fatal */ });
    }
}

async function touchThread(threadId) {
    await pool.execute('UPDATE modmail_threads SET last_activity_at = NOW() WHERE id = ?', [threadId]);
}

async function alreadyRelayed(threadId, sourceMessageId) {
    const [rows] = await pool.execute(
        'SELECT 1 FROM modmail_messages WHERE thread_id = ? AND source_message_id = ? LIMIT 1',
        [threadId, sourceMessageId]
    );
    return rows.length > 0;
}

export async function blockUser(guildId, userId, blockedBy, reason = null) {
    await pool.execute(
        `INSERT INTO modmail_blocked_users (guild_id, user_id, reason, blocked_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE reason = VALUES(reason), blocked_by = VALUES(blocked_by), blocked_at = CURRENT_TIMESTAMP`,
        [guildId, userId, reason ? String(reason).slice(0, 1000) : null, blockedBy || null]
    );
}

export async function unblockUser(guildId, userId) {
    const [res] = await pool.execute(
        'DELETE FROM modmail_blocked_users WHERE guild_id = ? AND user_id = ?',
        [guildId, userId]
    );
    return res.affectedRows > 0;
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

/** Does this client serve this guild (the default bot stands aside for a custom bot)? */
async function clientServesGuild(client, guildId) {
    if (!client.guilds.cache.has(guildId)) return false;
    if (client.isDefaultBot && await shouldIgnoreGuild(guildId)) return false;
    return true;
}

export function isStaff(member, cfg) {
    if (!member) return false;
    const perms = member.permissions;
    if (perms?.has?.(PermissionFlagsBits.Administrator) || perms?.has?.(PermissionFlagsBits.ManageGuild)) return true;
    return !!(cfg?.staff_role_id && member.roles?.cache?.has(cfg.staff_role_id));
}

function attachmentList(message) {
    return [...(message.attachments?.values?.() || [])].map(a => ({
        name: a.name || 'file', url: a.url, size: a.size, contentType: a.contentType,
    }));
}

function stickerNote(message) {
    const stickers = [...(message.stickers?.values?.() || [])];
    return stickers.length ? `[sticker: ${stickers.map(s => s.name).join(', ')}]` : '';
}

/**
 * Send with the attachments re-uploaded (Discord's CDN links on the original expire), falling back
 * to plain links when a file is too large to re-upload — nothing a member or staff sent is lost.
 */
async function sendWithFiles(target, embed, attachments, extra = {}) {
    const files = attachments.slice(0, 10).map(a => ({ attachment: a.url, name: a.name }));
    try {
        return await target.send({ ...extra, embeds: [embed], files });
    } catch (err) {
        if (!files.length) throw err;
        logger.warn('[Modmail] Re-uploading attachments failed; sending links instead', { error: err.message, code: err.code });
        const withLinks = EmbedBuilder.from(embed).addFields({
            name: 'Attachments',
            value: truncate(attachments.map(a => `[${a.name}](${a.url})`).join('\n'), 1024),
        });
        return target.send({ ...extra, embeds: [withLinks] });
    }
}

async function postToLogChannel(guild, cfg, payload) {
    if (!guild || !cfg?.log_channel_id) return;
    try {
        const channel = await guild.channels.fetch(cfg.log_channel_id).catch(() => null);
        if (!channel?.isTextBased()) {
            logger.warn('[Modmail] Log channel missing or not text-based', { guildId: guild.id, channelId: cfg.log_channel_id });
            return;
        }
        await channel.send({ allowedMentions: { parse: [] }, ...payload });
    } catch (err) {
        logger.error('[Modmail] Could not post to the modmail log channel', { guildId: guild.id, error: err.message });
    }
}

function nameResolver(client, guild) {
    return (id) => {
        if (!id) return null;
        const m = guild?.members?.cache?.get(String(id));
        if (m) return m.user?.tag || m.displayName;
        const u = client?.users?.cache?.get(String(id));
        return u ? u.tag : null;
    };
}

// ── DM side ──────────────────────────────────────────────────────────────────────────────────

/**
 * Entry point for every non-bot DM. Returns true when modmail took the message (so messageCreate
 * stops), false when it has nothing to do with modmail.
 */
export async function handleModmailDM(message) {
    if (message.guild || message.author?.bot) return false;
    if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return false;

    const client = message.client;
    const user = message.author;

    try {
        // 1. Conversations already open with servers this bot serves.
        const open = [];
        for (const t of await getOpenThreadsForUser(user.id)) {
            if (await clientServesGuild(client, t.guild_id)) open.push(t);
        }

        if (open.length === 1) {
            await relayMemberMessage(client, open[0], message);
            return true;
        }
        if (open.length > 1) {
            const recent = lastRoute.get(keyFor(client, user.id));
            const routed = recent && Date.now() - recent.at < ROUTE_TTL_MS
                ? open.find(t => t.guild_id === recent.guildId) : null;
            if (routed) {
                remember(lastRoute, keyFor(client, user.id), { guildId: routed.guild_id, at: Date.now() }, ROUTE_TTL_MS);
                await relayMemberMessage(client, routed, message);
            } else {
                await sendRoutePrompt(client, message, open);
            }
            return true;
        }

        // 2. No open conversation: which servers could they contact?
        const { candidates, blocked } = await findCandidateGuilds(client, user.id);
        if (!candidates.length && !blocked.length) return false;

        if (!candidates.length) {
            await message.reply({
                content: `You can't contact the staff of ${blocked.map(g => `**${g.name}**`).join(', ')} through modmail.`,
                allowedMentions: { repliedUser: false },
            }).catch(() => {});
            return true;
        }

        const pending = pendingPrompts.get(keyFor(client, user.id));
        if (pending && Date.now() - pending.at < PROMPT_TTL_MS) {
            // The question is already on screen. This message is carried along when they answer.
            return true;
        }

        await sendOpenPrompt(message, candidates);
        remember(pendingPrompts, keyFor(client, user.id), { at: Date.now() }, PROMPT_TTL_MS);
        return true;
    } catch (err) {
        logger.error('[Modmail] DM handling failed', { userId: user.id, error: err.message, stack: err.stack });
        await message.reply({
            content: 'Something went wrong forwarding your message to staff. Please try again in a moment.',
            allowedMentions: { repliedUser: false },
        }).catch(() => {});
        return true;
    }
}

async function findCandidateGuilds(client, userId) {
    const [configs] = await pool.execute('SELECT guild_id FROM modmail_config WHERE enabled = 1');
    const [blockRows] = await pool.execute('SELECT guild_id FROM modmail_blocked_users WHERE user_id = ?', [userId]);
    const blockedIds = new Set(blockRows.map(r => String(r.guild_id)));

    const candidates = [];
    const blocked = [];
    for (const { guild_id: guildId } of configs) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild || !(await clientServesGuild(client, guildId))) continue;
        const member = await guild.members.fetch(userId).catch(() => null);
        if (!member) continue;
        (blockedIds.has(guildId) ? blocked : candidates).push(guild);
    }
    return { candidates: candidates.slice(0, 25), blocked };
}

async function sendOpenPrompt(message, guilds) {
    const one = guilds.length === 1;
    const embed = new EmbedBuilder()
        .setColor(themeColor(one ? guilds[0].id : null, 'primary'))
        .setTitle('Contact server staff?')
        .setDescription(one
            ? `Your message will be sent privately to the staff of **${guilds[0].name}**, and their replies will come back here.\n\nOpen a conversation?`
            : 'You share several servers that take messages for their staff here. Pick which one this is for — their replies will come back to this DM.')
        .setFooter({ text: 'Anything you send before choosing is included.' });

    const rows = [];
    if (one) {
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`${IDS.open}${guilds[0].id}:${message.id}`)
                .setLabel('Open conversation')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('📨'),
            new ButtonBuilder().setCustomId(IDS.cancel).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        ));
    } else {
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${IDS.pick}${message.id}`)
                .setPlaceholder('Choose a server')
                .addOptions(guilds.map(g => ({ label: truncate(g.name, 100), value: g.id }))),
        ));
        rows.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(IDS.cancel).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
        ));
    }

    await message.reply({ embeds: [embed], components: rows, allowedMentions: { repliedUser: false } });
}

async function sendRoutePrompt(client, message, threads) {
    const options = [];
    for (const t of threads.slice(0, 25)) {
        const guild = client.guilds.cache.get(t.guild_id);
        options.push({ label: truncate(guild?.name || t.guild_id, 100), value: String(t.id), description: `Conversation #${t.id}` });
    }
    await message.reply({
        content: 'You have open conversations with more than one server. Which one is this message for?',
        components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`${IDS.route}${message.id}`).setPlaceholder('Choose a server').addOptions(options),
        )],
        allowedMentions: { repliedUser: false },
    });
}

/** The DM channel an interaction came from, even when it is not cached. */
async function dmChannelOf(interaction) {
    return interaction.channel ?? await interaction.user.createDM();
}

/** The original DM plus everything the member sent after it, oldest first. */
async function collectCarriedMessages(dm, originId, userId) {
    const out = [];
    const origin = await dm.messages.fetch(originId).catch(() => null);
    if (origin && origin.author?.id === userId) out.push(origin);
    const later = await dm.messages.fetch({ after: originId, limit: MAX_CARRIED_MESSAGES }).catch(() => null);
    if (later) {
        for (const m of [...later.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp)) {
            if (m.author?.id === userId && (m.type === MessageType.Default || m.type === MessageType.Reply)) out.push(m);
        }
    }
    return out;
}

/**
 * The member chose a server (button or picker). Opens the thread (or reuses the open one) and
 * relays the original DM plus anything sent since.
 */
export async function openFromPrompt(interaction, guildId, originMessageId) {
    const client = interaction.client;
    const user = interaction.user;
    pendingPrompts.delete(keyFor(client, user.id));

    const fail = (text) => interaction.editReply({
        embeds: [new EmbedBuilder().setColor(themeColor(null, 'danger')).setDescription(text)],
        components: [],
    }).catch(() => {});

    const guild = client.guilds.cache.get(guildId);
    if (!guild || !(await clientServesGuild(client, guildId))) return fail("That server isn't available any more.");

    const cfg = await getModmailConfig(guildId);
    if (!cfg || !Number(cfg.enabled)) return fail(`**${guild.name}** isn't taking modmail right now.`);
    if (await isBlocked(guildId, user.id)) return fail(`You can't contact the staff of **${guild.name}** through modmail.`);

    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return fail(`You're no longer a member of **${guild.name}**.`);

    let thread = await getOpenThread(guildId, user.id);
    const isNew = !thread;
    if (!thread) {
        try {
            thread = await openThread(client, guild, cfg, member);
        } catch (err) {
            if (err.code === 'MODMAIL_BUSY') return fail('Your conversation is already being opened — give it a second.');
            if (err.code === 'MODMAIL_NO_PERMS') {
                return fail(`**${guild.name}** has modmail switched on, but the bot can't create its staff channel. The server's admins have been told.`);
            }
            logger.error('[Modmail] Opening a thread failed', { guildId, userId: user.id, error: err.message, code: err.code, stack: err.stack });
            return fail('Something went wrong opening your conversation. Please try again later.');
        }
    }

    const dm = await dmChannelOf(interaction);
    const carried = originMessageId ? await collectCarriedMessages(dm, originMessageId, user.id) : [];
    let relayed = 0;
    for (const m of carried) {
        if (await relayMemberMessage(client, thread, m, { quiet: true })) relayed++;
    }
    remember(lastRoute, keyFor(client, user.id), { guildId, at: Date.now() }, ROUTE_TTL_MS);

    const greeting = new EmbedBuilder()
        .setColor(themeColor(guildId, 'success'))
        .setAuthor({ name: guild.name, iconURL: guild.iconURL() ?? undefined })
        .setTitle(isNew ? 'Conversation opened' : 'Added to your open conversation')
        .setDescription(
            (isNew ? `${cfg.greeting_message || DEFAULT_GREETING}\n\n` : '') +
            `${relayed ? `${relayed} message${relayed === 1 ? ' has' : 's have'} been sent to the staff of **${guild.name}**.` : `You're connected to the staff of **${guild.name}**.`} ` +
            'Keep writing here to add more; their replies will arrive in this DM.'
        )
        .setFooter({ text: 'Only server staff can read this conversation.' });
    await interaction.editReply({ embeds: [greeting], components: [] }).catch(() => {});
    return true;
}

/** Relay one member DM into the thread. Returns true when it was delivered (or already had been). */
async function relayMemberMessage(client, thread, message, { quiet = false } = {}) {
    const guild = client.guilds.cache.get(thread.guild_id);
    if (!guild) {
        // Guild outage or the bot was removed — never close a thread on missing data.
        if (!quiet) {
            await message.reply({ content: "I can't reach that server right now. Please try again later.", allowedMentions: { repliedUser: false } }).catch(() => {});
        }
        return false;
    }
    const channel = await guild.channels.fetch(thread.channel_id).catch(err => {
        if (err.code === 10003) return null; // Unknown Channel — deleted by hand
        throw err;
    });

    if (!channel) {
        // The staff channel was deleted while the thread was open. Close it so the next DM starts
        // a fresh conversation, and tell the member rather than swallowing what they wrote.
        await closeThread({
            client, thread, closedBy: client.user, reason: 'The staff channel was deleted', notifyMember: false,
        }).catch(err => logger.error('[Modmail] Closing an orphaned thread failed', { threadId: thread.id, error: err.message }));
        if (!quiet) {
            await message.reply({
                content: `Your conversation with **${guild.name}** was closed on their side. Send your message again to start a new one.`,
                allowedMentions: { repliedUser: false },
            }).catch(() => {});
        }
        return false;
    }

    if (await alreadyRelayed(thread.id, message.id)) return true;

    if (await isBlocked(thread.guild_id, message.author.id)) {
        if (!quiet) {
            await message.reply({ content: `You can't contact the staff of **${guild.name}** through modmail.`, allowedMentions: { repliedUser: false } }).catch(() => {});
        }
        return false;
    }

    const attachments = attachmentList(message);
    const text = [message.content, stickerNote(message)].filter(Boolean).join('\n');
    const embed = new EmbedBuilder()
        .setColor(themeColor(guild.id, 'primary'))
        .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
        .setDescription(text ? truncate(text, 4096) : (attachments.length ? '*(attachment)*' : '*(no text)*'))
        .setFooter({ text: `Member ID ${message.author.id} · Thread #${thread.id}` })
        .setTimestamp(message.createdAt);

    await sendWithFiles(channel, embed, attachments);
    await insertMessage(thread.id, message.author.id, 'user', text, serialiseAttachments(attachments), { sourceMessageId: message.id });
    await touchThread(thread.id);
    await message.react('✅').catch(() => {});
    return true;
}

// ── Opening a thread ─────────────────────────────────────────────────────────────────────────

function overwriteBits(list, me) {
    // Only grant what the bot itself holds — Discord rejects a channel create that hands out
    // permissions the bot does not have.
    return list.filter(bit => me.permissions.has(bit));
}

function buildOverwrites(guild, parent, staffRoleId, me) {
    const everyoneId = guild.id;
    const map = new Map();

    // Start from the category's overwrites so roles the server already gave access to it (admins,
    // senior staff) keep it — then make sure the channel itself is private. Discord refuses a
    // channel create that sets bits the bot does not hold (and Manage Permissions unless the bot is
    // an administrator), so copied overwrites are masked to what the bot may set.
    if (parent) {
        let mask = me.permissions.bitfield;
        if (!me.permissions.has(PermissionFlagsBits.Administrator)) mask &= ~PermissionFlagsBits.ManageRoles;
        for (const ow of parent.permissionOverwrites.cache.values()) {
            map.set(ow.id, { id: ow.id, type: ow.type, allow: ow.allow.bitfield & mask, deny: ow.deny.bitfield & mask });
        }
    }

    const view = PermissionFlagsBits.ViewChannel;
    const everyone = map.get(everyoneId) || { id: everyoneId, type: OverwriteType.Role, allow: 0n, deny: 0n };
    everyone.allow &= ~view;
    everyone.deny |= view;
    map.set(everyoneId, everyone);

    const staffBits = overwriteBits([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AddReactions,
    ], me);
    if (staffRoleId && guild.roles.cache.has(staffRoleId)) {
        const prev = map.get(staffRoleId) || { id: staffRoleId, type: OverwriteType.Role, allow: 0n, deny: 0n };
        for (const bit of staffBits) { prev.allow |= bit; prev.deny &= ~bit; }
        map.set(staffRoleId, prev);
    }

    const botBits = overwriteBits([
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.ManageMessages,
    ], me);
    const botOw = map.get(me.id) || { id: me.id, type: OverwriteType.Member, allow: 0n, deny: 0n };
    for (const bit of botBits) { botOw.allow |= bit; botOw.deny &= ~bit; }
    map.set(me.id, botOw);

    return [...map.values()];
}

async function openThread(client, guild, cfg, member) {
    const lockKey = `${guild.id}:${member.id}`;
    if (openLocks.has(lockKey)) {
        const err = new Error('A thread for this member is already being opened');
        err.code = 'MODMAIL_BUSY';
        throw err;
    }
    openLocks.add(lockKey);
    try {
        const existing = await getOpenThread(guild.id, member.id);
        if (existing) return existing;

        const me = guild.members.me ?? await guild.members.fetchMe();
        if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
            logger.warn('[Modmail] Missing Manage Channels — cannot open a thread', { guildId: guild.id });
            await postToLogChannel(guild, cfg, {
                content: `⚠️ ${member.user.tag} tried to open a modmail conversation, but I need **Manage Channels** to create its private channel.`,
            });
            const err = new Error('Missing permissions to create the modmail channel');
            err.code = 'MODMAIL_NO_PERMS';
            throw err;
        }

        const category = cfg.category_id ? guild.channels.cache.get(cfg.category_id) : null;
        const parent = category?.type === ChannelType.GuildCategory ? category : null;
        if (cfg.category_id && !parent) {
            logger.warn('[Modmail] Configured category is missing or not a category; creating at the top level', {
                guildId: guild.id, categoryId: cfg.category_id,
            });
        }

        const channel = await guild.channels.create({
            name: channelNameFor(member.user.username),
            type: ChannelType.GuildText,
            parent: parent?.id ?? null,
            permissionOverwrites: buildOverwrites(guild, parent, cfg.staff_role_id, me),
            topic: truncate(`Modmail with ${member.user.tag} (${member.id}). Messages here are sent to them — start a message with // to keep it staff-only.`, 1024),
            reason: `Modmail opened by ${member.user.tag}`,
        });

        let threadId;
        try {
            const [res] = await pool.execute(
                "INSERT INTO modmail_threads (guild_id, user_id, channel_id, status, last_activity_at) VALUES (?, ?, ?, 'open', NOW())",
                [guild.id, member.id, channel.id]
            );
            threadId = res.insertId;
        } catch (err) {
            await channel.delete('Modmail: the thread could not be recorded').catch(e =>
                logger.error('[Modmail] Could not remove the channel of an unrecorded thread', { channelId: channel.id, error: e.message }));
            throw err;
        }
        indexAdd(channel.id, threadId);
        const thread = { id: threadId, guild_id: guild.id, user_id: member.id, channel_id: channel.id, status: 'open' };

        // The thread exists from here on; a failure dressing it up (header, pin, log post) must not
        // make the member think it failed — their messages still flow.
        try {
            await decorateNewThread(client, guild, cfg, member, channel, threadId);
        } catch (err) {
            logger.error('[Modmail] Thread opened but its header/log post failed', { guildId: guild.id, threadId, error: err.message });
        }

        logger.info('[Modmail] Thread opened', { guildId: guild.id, userId: member.id, threadId, channelId: channel.id });
        return thread;
    } finally {
        openLocks.delete(lockKey);
    }
}

async function decorateNewThread(client, guild, cfg, member, channel, threadId) {
    await insertMessage(threadId, client.user.id, 'system', `Conversation opened by ${member.user.tag}`);

    const [[{ n: previous }]] = await pool.execute(
        'SELECT COUNT(*) AS n FROM modmail_threads WHERE guild_id = ? AND user_id = ? AND id <> ?',
        [guild.id, member.id, threadId]
    );

    const roles = [...member.roles.cache.values()]
        .filter(r => r.id !== guild.id)
        .sort((a, b) => b.position - a.position)
        .slice(0, 15)
        .map(r => `<@&${r.id}>`);
    const header = new EmbedBuilder()
        .setColor(themeColor(guild.id, 'primary'))
        .setAuthor({ name: `${member.user.tag} (${member.id})`, iconURL: member.user.displayAvatarURL() })
        .setTitle(`Modmail #${threadId}`)
        .setDescription(
            'Everything you write here is sent to the member by DM' +
            (Number(cfg.anonymous_replies) ? ' **anonymously** (as the server\'s staff team).' : ' under your name.') +
            '\nStart a message with `//` to keep it as a staff-only note.'
        )
        .addFields(
            { name: 'Member', value: `<@${member.id}>`, inline: true },
            { name: 'Account created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
            { name: 'Joined server', value: member.joinedTimestamp ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'unknown', inline: true },
            { name: 'Previous conversations', value: String(Number(previous) || 0), inline: true },
            { name: 'Roles', value: roles.length ? truncate(roles.join(' '), 1024) : 'none' },
        )
        .setTimestamp();
    const controls = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${IDS.close}${threadId}`).setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
        new ButtonBuilder().setCustomId(`${IDS.block}${threadId}`).setLabel('Block & close').setStyle(ButtonStyle.Secondary).setEmoji('⛔'),
    );
    const staffRole = cfg.staff_role_id && guild.roles.cache.has(cfg.staff_role_id) ? cfg.staff_role_id : null;
    const headerMsg = await channel.send({
        content: staffRole ? `<@&${staffRole}> — new modmail from ${member.user.tag}` : `New modmail from ${member.user.tag}`,
        embeds: [header],
        components: [controls],
        allowedMentions: { roles: staffRole ? [staffRole] : [], users: [] },
    });
    await headerMsg.pin('Modmail controls').catch(() => {});

    await postToLogChannel(guild, cfg, {
        embeds: [new EmbedBuilder()
            .setColor(themeColor(guild.id, 'primary'))
            .setTitle(`Modmail #${threadId} opened`)
            .addFields(
                { name: 'Member', value: `${member.user.tag} (${member.id})`, inline: true },
                { name: 'Channel', value: `<#${channel.id}>`, inline: true },
            )
            .setTimestamp()],
    });
}

// ── Staff side ───────────────────────────────────────────────────────────────────────────────

/**
 * Guild messages (events/messageCreate.js, after the bot/ignored-guild checks). Returns true when
 * the message was in an open modmail channel and has been handled.
 */
export async function handleModmailStaffMessage(message) {
    if (!message.guild || message.author?.bot) return false;
    if (!(await isModmailChannel(message.channel.id))) return false;

    try {
        const thread = await getOpenThreadByChannel(message.channel.id);
        if (!thread) {
            indexRemove(message.channel.id);
            return false;
        }
        if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return true;

        const cfg = await getModmailConfig(message.guild.id);
        const member = message.member ?? await message.guild.members.fetch(message.author.id).catch(() => null);
        if (!isStaff(member, cfg)) {
            logger.debug('[Modmail] Ignoring a non-staff message in a modmail channel', { channelId: message.channel.id, userId: message.author.id });
            return true;
        }

        const attachments = attachmentList(message);
        const text = [message.content, stickerNote(message)].filter(Boolean).join('\n');

        if (isInternalNote(message.content)) {
            await insertMessage(thread.id, message.author.id, 'staff', text, serialiseAttachments(attachments), {
                internal: true, sourceMessageId: message.id,
            });
            return true;
        }
        if (!text && !attachments.length) return true;

        const anonymous = !!Number(cfg?.anonymous_replies);
        const guild = message.guild;
        const embed = new EmbedBuilder()
            .setColor(themeColor(guild.id, 'success'))
            .setAuthor(anonymous
                ? { name: `${guild.name} Staff`, iconURL: guild.iconURL() ?? undefined }
                : { name: member.displayName || message.author.username, iconURL: message.author.displayAvatarURL() })
            .setDescription(text ? truncate(text, 4096) : '*(attachment)*')
            .setFooter({ text: `${guild.name} · reply to this DM to answer` })
            .setTimestamp(message.createdAt);

        let delivered = true;
        let failure = null;
        try {
            const user = await message.client.users.fetch(thread.user_id);
            await sendWithFiles(user, embed, attachments);
        } catch (err) {
            delivered = false;
            failure = err.code === 50007
                ? "the member isn't accepting DMs from the bot (DMs closed, or no shared server any more)"
                : err.message;
            logger.warn('[Modmail] Staff reply could not be delivered', { threadId: thread.id, error: err.message, code: err.code });
        }

        await insertMessage(thread.id, message.author.id, 'staff', text, serialiseAttachments(attachments), {
            anonymous, sourceMessageId: message.id,
        });
        await touchThread(thread.id);

        if (delivered) {
            await message.react('✅').catch(() => {});
        } else {
            await insertMessage(thread.id, message.client.user.id, 'system', `Delivery failed: ${failure}`);
            await message.react('⚠️').catch(() => {});
            await message.reply({ content: `⚠️ Not delivered — ${failure}.`, allowedMentions: { repliedUser: false } }).catch(() => {});
        }
        return true;
    } catch (err) {
        logger.error('[Modmail] Staff relay failed', { channelId: message.channel.id, error: err.message, stack: err.stack });
        await message.react('⚠️').catch(() => {});
        return true;
    }
}

// ── Closing ──────────────────────────────────────────────────────────────────────────────────

export async function getTranscript(threadId, { client = null, guild = null } = {}) {
    const thread = await getThread(threadId);
    if (!thread) return null;
    const [messages] = await pool.execute(
        `SELECT id, author_id, author_type, message_content, attachments, timestamp, is_internal, is_anonymous
           FROM modmail_messages WHERE thread_id = ? ORDER BY id ASC`,
        [threadId]
    );
    const g = guild || client?.guilds?.cache?.get(thread.guild_id) || null;
    const text = formatTranscript(thread, messages, { guildName: g?.name || '', nameOf: nameResolver(client || g?.client, g) });
    return { thread, messages, text };
}

/**
 * Close a thread: record it, post the transcript to the log channel, tell the member, and delete
 * the staff channel. Safe to call twice — the second call finds the thread already closed.
 *
 * @param {object} p
 * @param {import('discord.js').Client} p.client
 * @param {object} p.thread           modmail_threads row
 * @param {{id:string, tag?:string}} p.closedBy
 * @param {string|null} [p.reason]
 * @param {boolean} [p.shareReason=true]   include the reason in the member's DM
 * @param {boolean} [p.notifyMember=true]
 * @param {boolean} [p.deleteChannel=true]
 */
export async function closeThread({ client, thread, closedBy, reason = null, shareReason = true, notifyMember = true, deleteChannel = true }) {
    const cleanReason = reason ? String(reason).trim().slice(0, 1000) || null : null;
    const [res] = await pool.execute(
        `UPDATE modmail_threads SET status = 'closed', closed_at = NOW(), closed_by = ?, close_reason = ?
          WHERE id = ? AND status = 'open'`,
        [closedBy?.id || null, cleanReason, thread.id]
    );
    if (!res.affectedRows) return { ok: false, error: 'This conversation is already closed.' };
    indexRemove(thread.channel_id);

    await insertMessage(thread.id, closedBy?.id || client.user.id, 'system',
        `Conversation closed by ${closedBy?.tag || closedBy?.id || 'staff'}${cleanReason ? `: ${cleanReason}` : ''}`)
        .catch(err => logger.error('[Modmail] Could not record the close message', { threadId: thread.id, error: err.message }));

    const guild = client.guilds.cache.get(thread.guild_id) || null;
    const cfg = await getModmailConfig(thread.guild_id).catch(() => null);

    // Encrypted transcript to the ticket_transcripts table — read via /transcripts/:guildId/modmail/:id.
    try {
        const t0 = await getTranscript(thread.id, { client, guild });
        if (t0 && Array.isArray(t0.messages)) {
            const { saveTranscript: saveEncryptedTranscript } = await import('./ticket-transcripts.js');
            await saveEncryptedTranscript({
                guildId: thread.guild_id, kind: 'modmail', sourceId: thread.id,
                channelId: thread.channel_id, userId: thread.user_id,
                transcript: { title: `Modmail #${thread.id}`, messages: t0.messages },
            });
        }
    } catch (err) {
        logger.warn('[Modmail] encrypted transcript save failed', { threadId: thread.id, error: err.message });
    }

    // Transcript to the log channel.
    try {
        const t = await getTranscript(thread.id, { client, guild });
        if (t && guild) {
            const file = new AttachmentBuilder(Buffer.from(t.text, 'utf8'), { name: `modmail-${thread.id}.txt` });
            const counts = t.messages.reduce((acc, m) => { acc[m.author_type] = (acc[m.author_type] || 0) + 1; return acc; }, {});
            await postToLogChannel(guild, cfg, {
                embeds: [new EmbedBuilder()
                    .setColor(themeColor(guild.id, 'warning'))
                    .setTitle(`Modmail #${thread.id} closed`)
                    .addFields(
                        { name: 'Member', value: `<@${thread.user_id}> (${thread.user_id})`, inline: true },
                        { name: 'Closed by', value: closedBy?.id ? `<@${closedBy.id}>` : 'staff', inline: true },
                        { name: 'Messages', value: `${counts.user || 0} from the member · ${counts.staff || 0} from staff`, inline: true },
                        { name: 'Reason', value: cleanReason ? truncate(cleanReason, 1024) : 'none given' },
                    )
                    .setTimestamp()],
                files: [file],
            });
        }
    } catch (err) {
        logger.error('[Modmail] Transcript post failed', { threadId: thread.id, error: err.message });
    }

    // Tell the member.
    if (notifyMember) {
        try {
            const user = await client.users.fetch(thread.user_id);
            const embed = new EmbedBuilder()
                .setColor(themeColor(thread.guild_id, 'warning'))
                .setAuthor({ name: guild?.name || 'Server staff', iconURL: guild?.iconURL() ?? undefined })
                .setTitle('Conversation closed')
                .setDescription(`${cfg?.close_message || DEFAULT_CLOSE}${shareReason && cleanReason ? `\n\n**Reason:** ${truncate(cleanReason, 1000)}` : ''}`)
                .setFooter({ text: 'Message here again any time to start a new conversation.' })
                .setTimestamp();
            await user.send({ embeds: [embed] });
        } catch (err) {
            logger.warn('[Modmail] Could not tell the member their thread closed', { threadId: thread.id, error: err.message, code: err.code });
        }
    }

    // Delete the staff channel. A short delay so the "closing" reply is seen; the hourly sweep in
    // jobs/timed-moderation-job.js removes any channel a restart left behind.
    if (deleteChannel && guild) {
        const channel = guild.channels.cache.get(thread.channel_id);
        if (channel) {
            const timer = setTimeout(() => {
                channel.delete(`Modmail #${thread.id} closed`).catch(err =>
                    logger.warn('[Modmail] Could not delete a closed thread channel', { threadId: thread.id, error: err.message }));
            }, 5_000);
            timer.unref?.();
        }
    }

    logger.info('[Modmail] Thread closed', { guildId: thread.guild_id, threadId: thread.id, closedBy: closedBy?.id });
    return { ok: true };
}

/**
 * Housekeeping (hourly, jobs/timed-moderation-job.js):
 *   - delete channels of threads closed in the last two days that still exist (a restart between
 *     close and the delayed delete leaves one behind);
 *   - close open threads whose channel was deleted by hand, so the member is not left talking to
 *     nobody.
 */
export async function sweepModmailChannels() {
    const manager = global.botManager;
    if (!manager?.getClientForGuild) return;

    const [closed] = await pool.execute(
        `SELECT id, guild_id, channel_id FROM modmail_threads
          WHERE status = 'closed' AND closed_at >= NOW() - INTERVAL 2 DAY AND closed_at <= NOW() - INTERVAL 2 MINUTE`
    );
    for (const t of closed) {
        const client = manager.getClientForGuild(t.guild_id);
        const channel = client?.guilds.cache.get(t.guild_id)?.channels.cache.get(t.channel_id);
        if (!channel) continue;
        await channel.delete(`Modmail #${t.id} closed`).catch(err =>
            logger.warn('[Modmail] Sweep could not delete a closed thread channel', { threadId: t.id, error: err.message }));
    }

    const [open] = await pool.execute(`SELECT ${THREAD_COLS} FROM modmail_threads WHERE status = 'open'`);
    for (const t of open) {
        const client = manager.getClientForGuild(t.guild_id);
        const guild = client?.guilds.cache.get(t.guild_id);
        if (!guild || !client.isReady()) continue; // not ours / not ready — never close on missing data
        if (guild.channels.cache.has(t.channel_id)) continue;
        await closeThread({ client, thread: t, closedBy: client.user, reason: 'The staff channel was deleted', shareReason: false })
            .catch(err => logger.error('[Modmail] Sweep could not close an orphaned thread', { threadId: t.id, error: err.message }));
    }
}

// ── Interaction handlers (registered in interactions/handlerRegistry.js) ───────────────────────

export function clearPrompt(client, userId) {
    pendingPrompts.delete(keyFor(client, userId));
}

export function rememberRoute(client, userId, guildId) {
    remember(lastRoute, keyFor(client, userId), { guildId, at: Date.now() }, ROUTE_TTL_MS);
}

/** Relay one DM (by id) into a specific open thread — the "which server?" picker. */
export async function routeMessage(interaction, threadId, messageId) {
    const client = interaction.client;
    const thread = await getThread(threadId);
    if (!thread || thread.status !== 'open' || thread.user_id !== interaction.user.id) {
        return { ok: false, error: 'That conversation is closed. Send your message again to start a new one.' };
    }
    if (!(await clientServesGuild(client, thread.guild_id))) return { ok: false, error: "That server isn't available any more." };
    const dm = await dmChannelOf(interaction);
    const message = await dm.messages.fetch(messageId).catch(() => null);
    if (!message) return { ok: false, error: "I couldn't find that message any more — please send it again." };
    const ok = await relayMemberMessage(client, thread, message);
    if (!ok) return { ok: false, error: 'That message could not be delivered.' };
    rememberRoute(client, interaction.user.id, thread.guild_id);
    const guild = client.guilds.cache.get(thread.guild_id);
    return { ok: true, guildName: guild?.name || 'that server' };
}

export default {
    handleModmailDM, handleModmailStaffMessage, openFromPrompt, routeMessage, closeThread,
    getTranscript, getThread, getModmailConfig, blockUser, unblockUser, isBlocked, isStaff,
    isModmailChannel, sweepModmailChannels, clearPrompt,
};
