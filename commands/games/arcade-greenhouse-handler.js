/**
 * /arcade greenhouse status | daily | link [code] — Greenhouse Tycoon (the v2 game, phase 4).
 *
 * Text commands (arcade is text only, core/command-registration.js): typed as `/arcade greenhouse status`
 * or, through the chat bridge's bare group name, `/greenhouse status`. The old game's `/arcade cfx ...` group
 * was removed (H-650); typed anyway it answers with this game's link (core/retired-commands.js).
 *
 * How it reaches the game: services/cfx/integrations/bot.js runs the game's own store and rules on the
 * bot's database pool. The bot never calls the game's HTTP service, so these commands work while the game's
 * pm2 app is down, and the daily reward uses the same ledger and UNIQUE rows as the website and the Twitch
 * panel (one daily per account per day on every surface). The bridge is imported lazily and guarded: if
 * the import fails or the gh_ tables do not exist yet (migration 437), every reply says the game is not
 * open yet instead of failing.
 *
 * Link codes are private: `link` replies ephemerally (by DM when typed as text: PRIVATE_TEXT_PATHS), and a
 * message that carries a code is deleted where the bot may, so a live code does not sit in the channel.
 */
import { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const COLOR = 0x8bbf3f;
const DAY_MS = 86_400_000;

let bridgePromise = null;

/** The game bridge, or null when it cannot be loaded. Created once. */
export async function getBridge() {
    if (!bridgePromise) {
        bridgePromise = import('../../services/cfx/integrations/bot.js')
            .then(m => m.createGreenhouseBridge({ db: pool, logger }))
            .catch((err) => {
                logger.warn('[Greenhouse] game bridge could not be loaded', { error: err.message });
                bridgePromise = null;
                return null;
            });
    }
    return bridgePromise;
}

/** Tests: use this bridge (or null to reset). */
export function setBridgeForTests(bridge) {
    bridgePromise = bridge ? Promise.resolve(bridge) : null;
}

const NOT_OPEN = 'Greenhouse Tycoon is not open yet. It will be announced here when it is.';

// Friendly text for every game error these commands can get back.
export const ERROR_TEXT = Object.freeze({
    DAILY_ALREADY_CLAIMED: null, // built in handleDaily (needs the time of the next reward)
    LINK_CODE_INVALID: 'That link code is wrong or has expired. Codes work once, for 10 minutes. Make a new one and try again.',
    LINK_COOLDOWN: 'Your Discord account was linked or unlinked in the last 7 days, so it cannot move yet.',
    SOURCE_HAS_PROGRESS: 'Your Discord account already has its own greenhouse with progress, so it cannot join another one. Saves are never merged.',
    PLATFORM_ALREADY_LINKED: 'That greenhouse already has a Discord account linked. Unlink it first on the website (Profile).',
    LINK_CODE_LIMIT: 'You already have three link codes waiting. Use one or wait 10 minutes for them to expire.',
    LINK_TOO_MANY_ATTEMPTS: 'Too many wrong link codes in the last hour. Try again later.',
    IDENTITY_NOT_ON_ACCOUNT: 'Your Discord account is not on that greenhouse any more. Run the command again.',
    ACCOUNT_INACTIVE: 'This greenhouse is not active.',
    REVIEW_ACCOUNT: 'That is turned off for this account.',
    RATE_LIMITED: 'Slow down a little and try again.',
    SERVICE_DISABLED: 'The game is paused for maintenance. Try again later.'
});

const num = (n) => Number(n || 0).toLocaleString('en-US');
const money = (n) => `$${num(n)}`;
const rel = (ms) => `<t:${Math.floor(ms / 1000)}:R>`;
const nextDayMs = (now = Date.now()) => (Math.floor(now / DAY_MS) + 1) * DAY_MS;

function playRow(url) {
    if (!url) return [];
    return [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url).setLabel('Open the game'))];
}

function nameOf(user) {
    return user?.globalName || user?.username || null;
}

async function send(interaction, payload, { ephemeral = false } = {}) {
    const body = { ...payload, allowedMentions: { parse: [] } };
    if (ephemeral) body.flags = MessageFlags.Ephemeral;
    if (interaction.deferred || interaction.replied) return interaction.editReply(body);
    return interaction.reply(body);
}

const note = (text) => new EmbedBuilder().setColor(COLOR).setDescription(text);

function errorText(err) {
    return ERROR_TEXT[err?.code] || err?.message || 'Something went wrong in the game. Try again in a moment.';
}

async function withBridge(interaction, fn, { ephemeral = false } = {}) {
    const bridge = await getBridge();
    if (!bridge) return send(interaction, { embeds: [note(NOT_OPEN)] }, { ephemeral });
    try {
        return await fn(bridge);
    } catch (err) {
        logger.error('[Greenhouse] command failed', { error: err.message, userId: interaction.user?.id });
        return send(interaction, { embeds: [note('Something went wrong in the game. Try again in a moment.')] }, { ephemeral });
    }
}

// ---------------------------------------------------------------- status

export async function handleStatus(interaction) {
    return withBridge(interaction, async (bridge) => {
        const s = await bridge.status(interaction.user.id);
        if (!s.ready) return send(interaction, { embeds: [note(NOT_OPEN)] });
        if (s.error) return send(interaction, { embeds: [note(errorText(s.error))] });
        if (!s.linked) {
            return send(interaction, {
                embeds: [new EmbedBuilder().setColor(COLOR).setTitle('No greenhouse yet')
                    .setDescription([
                        '`/arcade greenhouse daily` starts one with your Discord account and collects the first daily reward.',
                        'Already playing with Twitch or Kick? Make a link code on the website (Profile, Link another sign-in), then use `/arcade greenhouse link <code>` here.'
                    ].join('\n\n'))],
                components: playRow(s.gameUrl)
            });
        }
        const a = s.account;
        const fields = [
            { name: 'Level', value: a.prestige ? `${a.level} (replanted ${a.prestige}x)` : String(a.level), inline: true },
            { name: 'Cash', value: money(a.cash), inline: true },
            {
                name: 'Benches',
                value: s.plots.ready
                    ? `${s.plots.ready} ready to harvest`
                    : s.plots.growing ? `${s.plots.growing} growing, next ${rel(s.plots.nextReadyAtMs)}` : `${s.plots.owned} empty`,
                inline: true
            },
            {
                name: 'Daily reward',
                value: s.daily.claimedToday ? `Collected (streak ${s.daily.streak}). Next ${rel(s.daily.nextDayAtMs)}` : `Ready: ${money(s.daily.nextReward?.cash)} (day ${s.daily.streak})`,
                inline: true
            },
            {
                name: 'Quests',
                value: `${s.quests.done} of ${s.quests.total} done${s.quests.toCollect ? `, ${s.quests.toCollect} to collect in the game` : ''}`,
                inline: true
            }
        ];
        if (s.season) {
            fields.push({
                name: `Season ${s.season.number}`,
                value: `${num(s.season.score)} points${s.season.rank ? `, rank ${s.season.rank}` : ''}. Ends ${rel(s.season.endsAtMs)}`,
                inline: true
            });
            const c = s.season.challenge;
            if (c) {
                const state = c.status === 'skipped' ? 'not running this week (too few players)' : c.completed ? 'finished' : `${num(c.progress)} of ${num(c.target)}`;
                fields.push({ name: `Week ${c.week} challenge`, value: `${c.title}: ${state}`, inline: false });
            }
        }
        if (s.notifications?.unread) fields.push({ name: 'Unread', value: `${s.notifications.more ? '99+' : s.notifications.unread} notifications in the game`, inline: true });
        const embed = new EmbedBuilder().setColor(COLOR).setTitle(`${a.displayName}'s greenhouse`).addFields(fields);
        if (a.review) embed.setFooter({ text: 'Shared review save: not ranked.' });
        return send(interaction, { embeds: [embed], components: playRow(s.gameUrl) });
    });
}

// ---------------------------------------------------------------- daily

export async function handleDaily(interaction) {
    return withBridge(interaction, async (bridge) => {
        const r = await bridge.daily(interaction.user.id, nameOf(interaction.user));
        if (!r.ready) return send(interaction, { embeds: [note(NOT_OPEN)] });
        if (r.error) {
            if (r.error.code === 'DAILY_ALREADY_CLAIMED') {
                return send(interaction, {
                    embeds: [new EmbedBuilder().setColor(COLOR).setTitle('Already collected today')
                        .setDescription(`One daily reward a day, wherever you collect it: here, on the website or in the Twitch panel. The next one is ready ${rel(nextDayMs())}.`)]
                });
            }
            return send(interaction, { embeds: [note(errorText(r.error))] });
        }
        const c = r.claim;
        const lines = [`${money(c.cash)} collected. Streak: day ${c.streak}.`];
        const seeds = (c.items || []).filter(i => i.kind === 'seed').reduce((n, i) => n + i.quantity, 0);
        if (seeds) lines.push(`Streak bonus: ${seeds} seeds.`);
        lines.push(`Cash now: ${money(r.cash)}.`);
        if (r.createdAccount) lines.unshift(r.starterGranted ? 'Your greenhouse is ready, with a starter kit of seeds and two benches.' : 'Your greenhouse is ready.');
        return send(interaction, {
            embeds: [new EmbedBuilder().setColor(COLOR).setTitle('Daily reward').setDescription(lines.join('\n'))],
            components: playRow(r.gameUrl)
        });
    });
}

// ---------------------------------------------------------------- link

export async function handleLink(interaction) {
    const raw = interaction.options.getString('code');
    const code = typeof raw === 'string' ? raw.trim() : '';
    // Typed as a chat message, the code is visible in the channel: remove that message where we may.
    if (code && interaction.message && typeof interaction.message.delete === 'function') {
        interaction.message.delete().catch(() => {});
    }
    return withBridge(interaction, async (bridge) => {
        if (!code) {
            const r = await bridge.linkCode(interaction.user.id);
            if (!r.ready) return send(interaction, { embeds: [note(NOT_OPEN)] }, { ephemeral: true });
            if (r.error) return send(interaction, { embeds: [note(errorText(r.error))] }, { ephemeral: true });
            if (!r.linked) {
                return send(interaction, {
                    embeds: [note('Your Discord account has no greenhouse yet. To join the greenhouse you play with Twitch or Kick, make a link code on the website (Profile, Link another sign-in) and use `/arcade greenhouse link <code>` here.')]
                }, { ephemeral: true });
            }
            return send(interaction, {
                embeds: [new EmbedBuilder().setColor(COLOR).setTitle('Your link code')
                    .setDescription([
                        `**${r.code}**`,
                        `It works once and expires ${rel(r.expiresAt)}. Keep it to yourself.`,
                        'On the website, sign in with Twitch or Kick, open Profile, and enter it under Link another sign-in. That sign-in then plays this greenhouse.'
                    ].join('\n'))],
                components: playRow(r.gameUrl)
            }, { ephemeral: true });
        }
        if (code.length > 32) return send(interaction, { embeds: [note(ERROR_TEXT.LINK_CODE_INVALID)] }, { ephemeral: true });
        const r = await bridge.redeem(interaction.user.id, code, nameOf(interaction.user));
        if (!r.ready) return send(interaction, { embeds: [note(NOT_OPEN)] }, { ephemeral: true });
        if (r.error) return send(interaction, { embeds: [note(errorText(r.error))] }, { ephemeral: true });
        return send(interaction, {
            embeds: [note(r.changed
                ? 'Done. Your Discord account now plays that greenhouse: `/arcade greenhouse status` and `daily` use it.'
                : 'Your Discord account was already on that greenhouse.')],
            components: playRow(r.gameUrl)
        }, { ephemeral: true });
    }, { ephemeral: true });
}
