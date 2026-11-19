/*
 * The how-to guides at /docs/guides and /docs/guides/<slug> (dashboard/views/docs-guides.ejs, one
 * template for the index and every guide). Each guide is a data file next to this one; adding a guide
 * means adding a file and a line to ORDER, never a new template or route.
 *
 * A guide: { slug, title, summary, area, result: { image, caption }, before?: [text], steps: [{ title,
 * text: [text], command?, image? }], notes: [text], related: [slug] }.
 *   image   an id from dashboard/public/img/guides/manifest.json (scripts/site-shots/run.mjs makes it)
 *   area    the docs hub section the guide belongs to (AREAS below)
 *   text    plain text with three inline marks: `code`, **bold** and [label](/path or https://...)
 *
 * Every claim in a guide was checked against the code (command definitions, dashboard routes and
 * templates, feature code). Keep it that way: change the guide when the feature changes.
 * Checked by tests/docs-guides.test.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import gettingStarted from './getting-started.js';
import goLiveAlerts from './go-live-alerts.js';
import socialFeeds from './social-feeds.js';
import levels from './levels.js';
import welcome from './welcome.js';
import reactionRoles from './reaction-roles.js';
import moderation from './moderation.js';
import raidProtection from './raid-protection.js';
import supportTickets from './support-tickets.js';
import music from './music.js';
import economy from './economy.js';
import schedules from './schedules.js';
import community from './community.js';
import kickDefender from './kick-defender.js';
import greenhouse from './greenhouse.js';
import privacy from './privacy.js';
import streamBot from './stream-bot.js';

/** Docs hub sections (the feature areas on /docs), in page order. */
export const AREAS = Object.freeze([
    { id: 'start', title: 'Getting started' },
    { id: 'moderation', title: 'Moderation and protection' },
    { id: 'streams', title: 'Stream alerts and feeds' },
    { id: 'community', title: 'Levels, roles and community' },
    { id: 'music', title: 'Music and voice' },
    { id: 'games', title: 'Games and economy' },
    { id: 'kick', title: 'Kick Defender' },
    { id: 'privacy', title: 'Your data' },
]);

const ORDER = [
    gettingStarted, moderation, raidProtection, supportTickets, goLiveAlerts, socialFeeds, schedules, streamBot,
    levels, welcome, reactionRoles, community, music, economy, greenhouse, kickDefender, privacy,
];

export const GUIDES = Object.freeze(ORDER.map((g) => Object.freeze(g)));
const BY_SLUG = new Map(GUIDES.map((g) => [g.slug, g]));
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The guide for a slug from a URL, or null. The slug is only ever a key into the list above. */
export function getGuide(slug) {
    if (typeof slug !== 'string' || slug.length > 64 || !SLUG_RE.test(slug)) return null;
    return BY_SLUG.get(slug) || null;
}

export function guidesInArea(area) {
    return GUIDES.filter((g) => g.area === area);
}

// ── screenshots ──
const MANIFEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/img/guides/manifest.json');
let cache = { mtime: -1, byId: new Map() };

/** The manifest's images by id, re-read when the file changes (the screenshot run rewrites it). */
export function imageMap() {
    let mtime = 0;
    try { mtime = fs.statSync(MANIFEST).mtimeMs; } catch { return new Map(); }
    if (mtime !== cache.mtime) {
        try {
            const list = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).images || [];
            cache = { mtime, byId: new Map(list.map((i) => [i.id, { ...i, src: `/img/guides/${i.file}`, thumb: i.thumb ? { ...i.thumb, src: `/img/guides/${i.thumb.file}` } : null }])) };
        } catch {
            cache = { mtime, byId: new Map() };
        }
    }
    return cache.byId;
}

/** { src, alt, width, height, thumb: { src, width, height } } for an image id, or null when the manifest has no such image. */
export function guideImage(id) {
    return (id && imageMap().get(id)) || null;
}

// ── text ──
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeHref = (h) => (/^\/(?!\/)[\w\-./?#=&%:]*$/.test(h) || /^https:\/\/[\w.-]+(\/[\w\-./?#=&%:@]*)?$/.test(h) ? h : null);

/**
 * Guide text as HTML: everything escaped, then `code`, **bold** and [label](href) applied. Hrefs must
 * be site paths or https links; anything else is left as plain text.
 */
export function inline(text) {
    const parts = String(text ?? '').split(/(`[^`]+`)/g);
    return parts.map((part) => {
        if (/^`[^`]+`$/.test(part)) return `<code>${esc(part.slice(1, -1))}</code>`;
        let h = esc(part);
        h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label, href) => {
            const raw = href.replace(/&amp;/g, '&');
            const ok = safeHref(raw);
            return ok ? `<a href="${esc(ok)}">${label}</a>` : label;
        });
        return h;
    }).join('');
}

/** Site paths a guide links to (for tests): every [label](/path) in its text. */
export function linksIn(guide) {
    const texts = [guide.summary, guide.result?.caption, ...(guide.before || []), ...(guide.notes || []),
        ...guide.steps.flatMap((s) => [s.title, ...(s.text || [])])];
    return texts.flatMap((t) => [...String(t || '').matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]));
}

/** Every image id a guide uses. */
export function imagesIn(guide) {
    return [guide.result?.image, ...guide.steps.map((s) => s.image)].filter(Boolean);
}
