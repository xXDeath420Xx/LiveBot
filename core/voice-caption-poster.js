/*
 * Where live captions actually get posted, in one of two styles:
 *
 *   webhook  One message per phrase under the speaker's server name and avatar, so the channel reads
 *            like the people talking (the Scriptly look). One webhook per channel, found or created
 *            once and reused — creating one per session is how a channel hits Discord's 15-webhook
 *            cap, which is exactly the "error creating the Speech-To-Text webhook" Scriptly dies on.
 *   compact  The bot posts batched "**Name:** text" lines.
 *
 * Webhook mode degrades instead of failing: if the webhook can't be made or used (missing Manage
 * Webhooks, channel at the cap, webhook deleted mid-session) the poster switches itself to compact
 * for the rest of the session and says so once.
 *
 * Webhooks allow ~5 posts per 2 seconds per channel. A busy room outruns that, so the queue merges
 * consecutive phrases from the same speaker, and if it still backs up it posts the backlog as one
 * compact block rather than falling minutes behind the conversation.
 */

import { escapeMarkdown, PermissionFlagsBits } from 'discord.js';
import logger from '../utils/logger.js';

const WEBHOOK_NAME = 'CertiFried Captions';
const COMPACT_FLUSH_MS = 1_500;
const BACKLOG_COLLAPSE = 8;          // more than this many queued posts → one compact block
const MAX_CONTENT = 1_900;

// channelId -> Promise<Webhook|null>, shared by every session so a channel is only ever given one.
const webhookCache = new Map();

/** Discord rejects webhook usernames containing these, and caps the name at 80 characters. */
function webhookUsername(name) {
    const clean = String(name || 'Someone').replace(/discord|clyde/gi, m => m.split('').join('​')).trim();
    return `${clean.slice(0, 70)} (voice)`;
}

async function resolveWebhook(channel, client) {
    // Threads post through their parent's webhook with a thread_id.
    const host = channel.isThread?.() ? channel.parent : channel;
    if (!host?.fetchWebhooks) return null;
    const me = host.guild.members.me;
    if (!me || !host.permissionsFor(me)?.has(PermissionFlagsBits.ManageWebhooks)) return null;

    const hooks = await host.fetchWebhooks();
    const mine = hooks.find(h => h.owner?.id === client.user.id && h.name === WEBHOOK_NAME && h.token);
    if (mine) return mine;
    return host.createWebhook({ name: WEBHOOK_NAME, reason: 'Live voice captions' });
}

function webhookFor(channel, client) {
    const key = channel.isThread?.() ? channel.parentId : channel.id;
    if (!webhookCache.has(key)) {
        webhookCache.set(key, resolveWebhook(channel, client).catch(err => {
            logger.warn(`[Captions] Could not get a webhook in ${key}: ${err.message}`);
            return null;
        }));
    }
    return webhookCache.get(key);
}

export class CaptionPoster {
    /**
     * @param {object} opts
     * @param {import('discord.js').TextBasedChannel} opts.channel
     * @param {import('discord.js').Client} opts.client
     * @param {'webhook'|'compact'} opts.style
     */
    constructor({ channel, client, style }) {
        this.channel = channel;
        this.client = client;
        this.style = style === 'compact' ? 'compact' : 'webhook';
        this.queue = [];                 // { name, avatarURL, text }
        this.sending = false;
        this.compactTimer = null;
        this.closed = false;
    }

    /** Queue one caption. Never throws. */
    add({ name, avatarURL, text }) {
        if (this.closed) return;
        this.queue.push({ name, avatarURL, text });
        if (this.style === 'compact') {
            if (!this.compactTimer) this.compactTimer = setTimeout(() => this.pump(), COMPACT_FLUSH_MS);
        } else {
            this.pump();
        }
    }

    async fallBackToCompact(reason) {
        if (this.style === 'compact') return;
        this.style = 'compact';
        logger.warn(`[Captions] Webhook captions unavailable in ${this.channel.id} (${reason}); using compact captions`);
        await this.channel.send({
            content: '⚠️ I couldn\'t post captions under each speaker\'s name here (I need **Manage Webhooks** in this channel), so captions will come from me instead.',
            allowedMentions: { parse: [] },
        }).catch(() => {});
    }

    compactBlocks(items) {
        const blocks = [];
        let current = '';
        for (const item of items) {
            const line = `**${escapeMarkdown(item.name)}:** ${escapeMarkdown(item.text)}`.slice(0, MAX_CONTENT);
            if (current && current.length + line.length + 1 > MAX_CONTENT) {
                blocks.push(current);
                current = '';
            }
            current += (current ? '\n' : '') + line;
        }
        if (current) blocks.push(current);
        return blocks;
    }

    async sendCompact(items) {
        for (const content of this.compactBlocks(items)) {
            await this.channel.send({ content, allowedMentions: { parse: [] } })
                .catch(err => logger.warn(`[Captions] Compact post failed in ${this.channel.id}: ${err.message}`));
        }
    }

    async sendWebhook(item) {
        const hook = await webhookFor(this.channel, this.client);
        if (!hook) {
            await this.fallBackToCompact('no webhook');
            return this.sendCompact([item]);
        }
        try {
            await hook.send({
                content: escapeMarkdown(item.text).slice(0, MAX_CONTENT),
                username: webhookUsername(item.name),
                avatarURL: item.avatarURL || undefined,
                allowedMentions: { parse: [] },
                ...(this.channel.isThread?.() ? { threadId: this.channel.id } : {}),
            });
        } catch (err) {
            // 10015 Unknown Webhook: someone deleted it. Forget it so the next session makes a fresh one.
            if (err?.code === 10015) webhookCache.delete(this.channel.isThread?.() ? this.channel.parentId : this.channel.id);
            await this.fallBackToCompact(err.message);
            await this.sendCompact([item]);
        }
    }

    async pump() {
        clearTimeout(this.compactTimer);
        this.compactTimer = null;
        if (this.sending) return;
        this.sending = true;
        try {
            while (this.queue.length) {
                if (this.style === 'compact') {
                    const items = this.queue.splice(0);
                    await this.sendCompact(items);
                    continue;
                }
                if (this.queue.length > BACKLOG_COLLAPSE) {
                    // Falling behind the room: catch up in one block rather than trickle old lines.
                    await this.sendCompact(this.queue.splice(0));
                    continue;
                }
                // Merge consecutive phrases from the same speaker into one post.
                const item = this.queue.shift();
                while (this.queue.length && this.queue[0].name === item.name
                    && item.text.length + this.queue[0].text.length < MAX_CONTENT - 2) {
                    item.text += ` ${this.queue.shift().text}`;
                }
                await this.sendWebhook(item);
            }
        } finally {
            this.sending = false;
        }
    }

    /** Post anything still queued, then stop accepting captions. */
    async close() {
        this.closed = true;
        await this.pump();
        // A pump already in flight when close() was called still owns the queue; wait for it.
        for (let i = 0; i < 100 && (this.sending || this.queue.length); i++) {
            await new Promise(r => setTimeout(r, 100));
            if (!this.sending && this.queue.length) await this.pump();
        }
    }
}

export default CaptionPoster;
