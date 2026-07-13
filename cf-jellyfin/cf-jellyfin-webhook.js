// ============================================================================
// CertiFried Jellyfin — webhook ingest + per-guild channel router
// ----------------------------------------------------------------------------
// Receives events from Jellyfin's Webhook plugin and fans them out to
// per-guild Discord channels based on the config table populated by
// /jellyfin config. Guilds that haven't opted in get nothing. Guilds that
// have opted in but haven't mapped a relevant channel for an event type
// also get nothing — silent drop is the safe default.
//
// AUTH: shared secret in the X-Webhook-Secret header (or ?secret= query),
// matched against opts.webhookSecret. Constant-time compare. If no secret is
// configured, the endpoint is open — fine for localhost/dev, not production.
//
// PAYLOAD SHAPE: assumes the standard Jellyfin Webhook plugin payload
// (PascalCase, nested Item / User / Session). If you customize the
// plugin's Handlebars template, adjust the field paths in `handlers`.
//
// EVENTS HANDLED:
//   ItemAdded                → new_media_channel
//   PlaybackStart            → now_playing_channel
//   PlaybackStop             → now_playing_channel
//   UserCreated              → audit_channel
//   UserDeleted              → audit_channel
//   SubtitleDownloadFailure  → audit_channel
//   PluginInstallationFailed → audit_channel
//
// EXTENDING: pass `extraHandlers` in opts — a map of NotificationType to a
// function `(payload) => { channelKey, embed }`. Custom handlers override
// built-ins of the same name.
// ============================================================================

import express from 'express';
import { EmbedBuilder } from 'discord.js';
import crypto from 'crypto';

const PURPLE = 0xa78bfa;
const GREEN  = 0x34d399;
const RED    = 0xf87171;
const BLUE   = 0x60a5fa;
const GRAY   = 0x6b7280;

export function createWebhookHandler(opts) {
    if (!opts || !opts.commandsModule || typeof opts.getClient !== 'function') {
        throw new Error('cf-webhook: commandsModule and getClient required');
    }
    const cmds      = opts.commandsModule;
    const getClient = opts.getClient;
    const secret    = opts.webhookSecret || '';
    const brand     = opts.brandName || 'CertiFried Movie Theatre';
    const jfUrl     = (opts.jellyfinUrl || 'https://jellyfin.certifriedmultitool.net').replace(/\/$/, '');
    const debugLog  = !!opts.debugLog;

    function verifySecret(req) {
        if (!secret) return true; // open (don't do this in production)
        const provided = req.header('X-Webhook-Secret') || req.query.secret;
        if (!provided) return false;
        try {
            const a = Buffer.from(String(provided));
            const b = Buffer.from(secret);
            if (a.length !== b.length) return false;
            return crypto.timingSafeEqual(a, b);
        } catch {
            return false;
        }
    }

    function itemImage(itemId) {
        return itemId ? jfUrl + '/Items/' + itemId + '/Images/Primary?maxHeight=300' : null;
    }

    function trim(s, n) {
        if (!s) return '';
        s = String(s);
        return s.length > n ? s.slice(0, n - 1) + '…' : s;
    }

    // ---- Event handlers (NotificationType -> { channelKey, embed }) -------

    const handlers = {
        ItemAdded: (p) => {
            const item = p.Item || {};
            const name = item.Name || item.SeriesName || 'New media';
            const year = item.Year || item.ProductionYear;
            const type = item.Type || '';
            const e = new EmbedBuilder()
                .setColor(PURPLE)
                .setTitle((type ? type + ': ' : '') + name + (year ? ' (' + year + ')' : ''))
                .setDescription(trim(item.Overview, 400) || '_No description available._')
                .setURL(jfUrl + '/web/#/details?id=' + (item.Id || ''))
                .setFooter({ text: brand })
                .setTimestamp();
            const img = itemImage(item.Id);
            if (img) e.setThumbnail(img);
            return { channelKey: 'new_media', embed: e };
        },

        PlaybackStart: (p) => {
            const item = p.Item || {};
            const user = p.User || {};
            const session = p.Session || {};
            const e = new EmbedBuilder()
                .setColor(BLUE)
                .setTitle('▶ Now playing')
                .setDescription('**' + (user.Name || 'Someone') + '** started **' + trim(item.Name, 100) + '**')
                .setFooter({ text: brand })
                .setTimestamp();
            const fields = [];
            if (item.Type)     fields.push({ name: 'Type', value: item.Type, inline: true });
            if (session.Client) fields.push({ name: 'Client', value: session.Client, inline: true });
            if (session.DeviceName) fields.push({ name: 'Device', value: session.DeviceName, inline: true });
            if (fields.length) e.addFields(fields);
            const img = itemImage(item.Id);
            if (img) e.setThumbnail(img);
            return { channelKey: 'now_playing', embed: e };
        },

        PlaybackStop: (p) => {
            const item = p.Item || {};
            const user = p.User || {};
            const completed = p.PlayedToCompletion === true || p.PlayedToCompletion === 'true';
            return {
                channelKey: 'now_playing',
                embed: new EmbedBuilder()
                    .setColor(GRAY)
                    .setTitle(completed ? '✓ Finished' : '⏹ Stopped')
                    .setDescription('**' + (user.Name || 'Someone') + '** ' +
                        (completed ? 'finished' : 'stopped') + ' **' + trim(item.Name, 100) + '**')
                    .setFooter({ text: brand })
                    .setTimestamp()
            };
        },

        UserCreated: (p) => {
            const user = p.User || {};
            return {
                channelKey: 'audit',
                embed: new EmbedBuilder()
                    .setColor(GREEN)
                    .setTitle('User created')
                    .setDescription('**' + (user.Name || 'unknown') + '** was added to ' + brand)
                    .setFooter({ text: brand })
                    .setTimestamp()
            };
        },

        UserDeleted: (p) => {
            const user = p.User || {};
            return {
                channelKey: 'audit',
                embed: new EmbedBuilder()
                    .setColor(RED)
                    .setTitle('User deleted')
                    .setDescription('**' + (user.Name || 'unknown') + '** was removed from ' + brand)
                    .setFooter({ text: brand })
                    .setTimestamp()
            };
        },

        SubtitleDownloadFailure: (p) => {
            const item = p.Item || {};
            return {
                channelKey: 'audit',
                embed: new EmbedBuilder()
                    .setColor(RED)
                    .setTitle('Subtitle download failed')
                    .setDescription('**' + trim(item.Name, 120) + '**')
                    .setFooter({ text: brand })
                    .setTimestamp()
            };
        },

        PluginInstallationFailed: (p) => {
            return {
                channelKey: 'audit',
                embed: new EmbedBuilder()
                    .setColor(RED)
                    .setTitle('Plugin installation failed')
                    .setDescription('**' + (p.Name || 'unknown plugin') + '** v' + (p.Version || '?'))
                    .setFooter({ text: brand })
                    .setTimestamp()
            };
        }
    };

    // Allow the bot owner to extend or override
    if (opts.extraHandlers) {
        for (const [k, v] of Object.entries(opts.extraHandlers)) {
            if (typeof v === 'function') handlers[k] = v;
        }
    }

    // ---- Fan-out per-guild ------------------------------------------------

    const channelKeyToColumn = {
        new_media:   'new_media_channel',
        now_playing: 'now_playing_channel',
        audit:       'audit_channel'
    };

    async function fanOut(channelKey, embed) {
        const client = getClient();
        if (!client || !client.isReady()) return;
        const column = channelKeyToColumn[channelKey];
        if (!column) return;

        // Walk every guild the bot is in, check per-guild config, post if mapped.
        // The cmds.getGuildConfig returns null for guilds that have never opted in.
        for (const [guildId] of client.guilds.cache) {
            const cfg = cmds.getGuildConfig(guildId);
            if (!cfg || !cfg.enabled) continue;
            const chId = cfg[column];
            if (!chId) continue;
            try {
                const channel = await client.channels.fetch(chId).catch(() => null);
                if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) continue;
                await channel.send({ embeds: [embed] });
            } catch (err) {
                console.error('[cf-webhook] send to ' + chId + ' (guild ' + guildId + ') failed:', err.message);
            }
        }
    }

    async function dispatch(payload) {
        const type = payload.NotificationType || payload.notification_type || payload.type;
        if (debugLog) console.log('[cf-webhook] event:', type);
        if (!type) return;
        const handler = handlers[type];
        if (!handler) {
            if (debugLog) console.log('[cf-webhook] no handler for:', type);
            return;
        }
        const result = handler(payload);
        if (!result || !result.embed) return;
        await fanOut(result.channelKey, result.embed);
    }

    // ---- Express router ---------------------------------------------------

    const router = express.Router();
    router.use(express.json({ limit: '256kb' }));

    router.post('/webhook/jellyfin', async (req, res) => {
        if (!verifySecret(req)) return res.status(401).json({ error: 'invalid webhook secret' });
        // Always ACK 2xx immediately so Jellyfin doesn't queue retries on slow handlers
        res.json({ ok: true });
        try {
            await dispatch(req.body || {});
        } catch (err) {
            console.error('[cf-webhook] dispatch error:', err.message);
        }
    });

    router.get('/webhook/jellyfin/health', (req, res) => {
        res.json({ ok: true, secret_configured: !!secret });
    });

    return { router, dispatch }; // dispatch exported for testing
}
