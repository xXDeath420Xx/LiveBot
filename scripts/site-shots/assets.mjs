/*
 * Images the bot draws itself, rendered with the bot's own renderers and Maple Hollow's invented
 * members: avatars (plain initials, so no real picture is ever used), the rank card, the go-live card,
 * the welcome card (the real core/greeting-manager.js join handler, with the database stubbed by
 * stubs/hooks.mjs and the channel replaced by a recorder) and the schedule poster.
 *
 * Every function returns PNG bytes (or a { payload, files } record for the welcome message) and never
 * touches the network, the database or Discord.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Canvas from 'canvas';
import { members, guild, channel, D } from './demo-data.mjs';

const imp = (root, rel) => import(pathToFileURL(path.join(root, rel)).href);

/** One initials avatar per member, written to dir/<key>.png. Returns { key: file }. */
export function makeAvatars(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const out = {};
    for (const m of members) {
        const size = 256;
        const c = Canvas.createCanvas(size, size);
        const ctx = c.getContext('2d');
        ctx.fillStyle = m.colour;
        ctx.fillRect(0, 0, size, size);
        const initials = m.displayName.replace(/[^A-Za-z ]/g, ' ').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.font = `600 ${initials.length > 1 ? 100 : 120}px DejaVu Sans`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(initials, size / 2, size / 2 + 6);
        const file = path.join(dir, `${m.key}.png`);
        fs.writeFileSync(file, c.toBuffer('image/png'));
        out[m.key] = file;
    }
    return out;
}

/** A fake discord.js User for the renderers: displayAvatarURL() is a local file the canvas can load. */
export function fakeUser(m, avatars) {
    return {
        id: m.id, username: m.username, globalName: m.displayName, discriminator: '0', bot: false, tag: m.username,
        displayAvatarURL: () => avatars[m.key],
        avatarURL: () => avatars[m.key],
        toString: () => `<@${m.id}>`,
    };
}

/** utils/rank-card-generator.js generateRankCard with the default look. */
export async function rankCard(root, m, avatars, rankData, customization = null) {
    const { generateRankCard } = await imp(root, 'utils/rank-card-generator.js');
    const memberLike = { displayHexColor: '#000000', displayName: m.displayName };
    return generateRankCard(fakeUser(m, avatars), rankData, memberLike, customization);
}

/** utils/stream-card.js renderStreamCard (the image a go-live post carries). */
export async function streamCard(root, s, m, avatars, { startedMinutesAgo = 42 } = {}) {
    const { renderStreamCard } = await imp(root, 'utils/stream-card.js');
    return renderStreamCard({
        username: s.name, title: s.title, game: s.game, viewers: s.viewers, platform: s.platform,
        startedAt: new Date(Date.now() - startedMinutesAgo * 60000), avatarBuffer: fs.readFileSync(avatars[m.key]), showLiveStats: true,
    });
}

/**
 * The real welcome post: core/greeting-manager.js handleGuildMemberAdd for an invented member joining
 * Maple Hollow, with `welcomeRow` as the server's welcome_settings row. Returns what the bot would send
 * to the channel: { content, embeds (JSON), files: [{ name, buffer }] }.
 */
export async function welcomePost(root, m, avatars, welcomeRow) {
    globalThis.__siteShotsDb = async (sql) => (/FROM\s+welcome_settings/i.test(sql) ? [{ guild_id: guild.id, ...welcomeRow }] : []);
    const gm = await imp(root, 'core/greeting-manager.js');
    let sent = null;
    const ch = {
        id: channel.welcome.id, name: 'welcome', isTextBased: () => true,
        send: async (payload) => { sent = payload; return { id: '1', url: '' }; },
        permissionsFor: () => ({ has: () => true }),
    };
    const u = fakeUser(m, avatars);
    const g = {
        id: guild.id, name: guild.name, memberCount: guild.memberCount,
        channels: { cache: new Map([[ch.id, ch]]) },
        roles: { cache: new Map(), everyone: { id: guild.id } },
        members: { me: { permissions: { has: () => true }, roles: { highest: { position: 99 } } } },
        iconURL: () => null, toString: () => guild.name,
    };
    const mem = {
        id: m.id, user: u, guild: g, joinedAt: new Date(), displayName: m.displayName, nickname: null,
        client: { isDefaultBot: true, botId: 'demo', user: { id: '0' } },
        roles: { cache: new Map(), add: async () => {} },
        send: async () => ({}), toString: () => `<@${m.id}>`,
        displayAvatarURL: () => avatars[m.key],
    };
    await gm.handleGuildMemberAdd(mem);
    globalThis.__siteShotsDb = null;
    if (!sent) throw new Error('the welcome handler sent nothing (check the welcome_settings row)');
    const files = (sent.files || []).map((f) => ({ name: f.name || f.attachment?.name || 'image.png', buffer: f.attachment || f.buffer || f }));
    const embeds = (sent.embeds || []).map((e) => (typeof e.toJSON === 'function' ? e.toJSON() : e));
    return { content: sent.content || (typeof sent === 'string' ? sent : ''), embeds, files };
}

/**
 * A plain invented picture (a video thumbnail, an album cover): two-colour wash, a few soft shapes and
 * an optional caption. Stands in for media the bot would show from another site.
 */
export function artwork({ width = 1280, height = 720, from = '#2f5d4a', to = '#a2475e', caption = '', seed = 3 } = {}) {
    const c = Canvas.createCanvas(width, height);
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, width, height);
    g.addColorStop(0, from); g.addColorStop(1, to);
    ctx.fillStyle = g; ctx.fillRect(0, 0, width, height);
    let s = seed;
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    for (let i = 0; i < 7; i++) {
        ctx.beginPath();
        ctx.fillStyle = `rgba(255,255,255,${0.05 + rnd() * 0.08})`;
        ctx.arc(rnd() * width, rnd() * height, (0.1 + rnd() * 0.3) * height, 0, Math.PI * 2);
        ctx.fill();
    }
    if (caption) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fillRect(0, height * 0.68, width, height * 0.32);
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(height * 0.085)}px DejaVu Sans`;
        ctx.textBaseline = 'middle';
        ctx.fillText(caption, width * 0.05, height * 0.84, width * 0.9);
    }
    return c.toBuffer('image/png');
}

/** The month poster a Twitch schedule can be posted as (core/schedule-calendar.js + schedule-calendar-art.js). */
export async function calendarPoster(root, { year, month, title, streams, disclaimer }) {
    const { buildMonth } = await imp(root, 'core/schedule-calendar.js');
    const { drawCalendar } = await imp(root, 'core/schedule-calendar-art.js');
    const days = new Map();
    for (const [d, s] of Object.entries(streams)) {
        const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        days.set(key, { day: key, kind: 'stream', title: s.title, start_time: s.start, end_time: s.end || null, note: s.note || null });
    }
    const built = buildMonth({ year, month, source: 'custom', days, tz: 'UTC' });
    const list = Array.isArray(built) ? built : built.days;
    return drawCalendar({
        monthName: new Date(Date.UTC(year, month, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }),
        year, firstWeekday: new Date(Date.UTC(year, month, 1)).getUTCDay(), days: list, title, disclaimer,
    });
}

export { D };
