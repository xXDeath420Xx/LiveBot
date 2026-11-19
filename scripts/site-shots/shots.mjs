/*
 * The guide screenshots: what each one shows, how it is rendered, its alt text and the guides that use
 * it. run.mjs takes them. Three kinds:
 *
 *   manage   a dashboard page: manage-tailwind.ejs with the page's partial and Maple Hollow's locals,
 *            the way the /manage/:guildId route renders it (same view engine, same nav, same help)
 *   page     any other template (server picker, public schedule page, Kick defender)
 *   discord  a Discord channel with one or more messages drawn by /js/cf-msgpreview.js, the dashboard's
 *            own message preview; images the bot attaches come from the bot's renderers (assets.mjs)
 *
 * Sizes: dashboard pages are taken at 1200 px wide (1x); Discord crops at 2x and written at 1200 px or
 * less. Alt text says what the picture shows, in the words a reader would use.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as demo from './demo-data.mjs';
import { makeAvatars, rankCard, streamCard, welcomePost, artwork, calendarPoster } from './assets.mjs';
import { scenes } from './scenes.mjs';

const { guild, user, roles, role, channels, channel, voiceChannels, categories, member: M, D } = demo;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function buildShots({ root, views, publicDir, tmp }) {
    const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);
    const [{ createViewEngine }, { manageTemplateFor }, nav, spec, prefs, checklist, settingsIndex, help] = await Promise.all([
        imp('dashboard/services/view-engine.js'),
        imp('dashboard/services/classic-style.js'),
        imp('core/manage-nav.js'),
        imp('core/feature-config-spec.js'),
        imp('core/user-preferences.js'),
        imp('core/setup-checklist.js'),
        imp('core/settings-index.js'),
        imp('core/page-help.js'),
    ]);
    const engine = createViewEngine({ viewsDir: views, publicDir, cache: true });
    const avatars = makeAvatars(tmp);
    let base = '';
    const av = (key) => `${base}/__demo/${key}.png`;
    const asset = (name, buf) => { fs.writeFileSync(path.join(tmp, name), buf); return () => `${base}/__demo/${name}`; };

    const style = 'cards', theme = 'dark';
    const common = {
        user, uiTheme: theme, uiStyle: style, uiDensity: 'comfortable', uiLayout: 'grid',
        userPrefs: { pinnedPages: [], recentPages: ['leveling', 'streamers', 'welcome'], siteStyle: style, theme, dashboardLayout: 'grid', density: 'comfortable' },
        csrfToken: 'site-shots', clientId: demo.BOT_ID,
    };
    const manageNav = nav.buildManageNav(spec.FEATURE_SPECS);
    const render = (template, locals) => engine.renderFile(path.join(views, `${template}.ejs`), { ...common, ...locals, settings: locals.settings || {}, _locals: {} });
    const manageLocals = (page, extra = {}) => {
        const template = manageTemplateFor(style);
        return {
            template,
            locals: {
                classicCss: template === 'manage-classic',
                siteStyles: prefs.STYLES.map((s) => ({ value: s.value, label: s.label })),
                guild, page, manageNav,
                relatedPages: page === 'overview' ? [] : nav.relatedPages(page, manageNav),
                settingsIndexVersion: 1,
                featureConfigKeys: spec.FEATURE_KEYS,
                featureConfigSpecs: spec.FEATURE_SPECS,
                roles, channels, voiceChannels, categories,
                prefixConfig: {}, antiRaidConfig: {}, antiNukeConfig: {}, quarantineConfig: {},
                moderationConfig: {}, recentInfractions: [], escalationRules: [],
                pageHelp: help.pageHelp(page),
                ...extra,
            },
        };
    };

    // ── shot builders ──
    const shots = [];
    /** A dashboard page. `scrollTo` puts that element near the top of the 1200x{height} window. */
    const manage = (id, page, extra, { alt, guides, height = 760, scrollTo = null, clip = null, prepare = null }) => shots.push({
        id, kind: 'manage', alt, guides, width: 1200, height, dpr: 1, clip,
        html: () => { const { template, locals } = manageLocals(page, typeof extra === 'function' ? extra() : extra); return render(template, locals); },
        prepare: prepare || (scrollTo ? { fn: scrollIntoViewTop, arg: scrollTo } : { fn: hideNoise }),
    });
    const page = (id, template, locals, { alt, guides, width = 1200, height = 760, dpr = 1, clip = null, prepare = null, outWidth = null }) => shots.push({
        id, kind: 'page', alt, guides, width, height, dpr, clip, outWidth,
        html: () => render(template, typeof locals === 'function' ? locals() : locals),
        prepare: prepare || { fn: hideNoise },
    });
    /** Discord messages in a channel window `width` CSS px wide, taken at 2x and written at outWidth. */
    const discord = (id, sceneFn, { alt, guides, width = 600, outWidth = null }) => shots.push({
        id, kind: 'discord', alt, guides, width: width + 48, height: 1600, dpr: 2, clip: '#shot', outWidth: outWidth || Math.min(1200, width * 2),
        html: async () => discordHtml(await sceneFn(), width),
    });
    /** A picture the bot draws (rank card, poster), shown on its own. */
    const image = (id, makeBuffer, { alt, guides, outWidth = 1200, format = 'webp' }) => shots.push({
        id, kind: 'image', alt, guides, width: 1300, height: 900, dpr: 1, clip: '#shot', outWidth, format,
        html: async () => {
            const name = `${id}.png`;
            fs.writeFileSync(path.join(tmp, name), await makeBuffer());
            return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#0b0d10}#shot{display:inline-block}#shot img{display:block;max-width:1280px}</style></head><body><div id="shot"><img src="${base}/__demo/${name}" alt=""></div></body></html>`;
        },
    });

    // Extra API answers a scene needs (a page that loads its data after rendering).
    const stubs = [];
    const stub = (re, fn) => stubs.push([re, fn]);
    /** Write bytes as a demo asset now; returns a function giving its URL once the server runs. */
    const file = async (name, make) => { fs.writeFileSync(path.join(tmp, name), await make()); return () => `${base}/__demo/${name}`; };
    const ctx = { demo, av, asset, file, avatars, rankCard, streamCard, welcomePost, artwork, calendarPoster, root, D, stub };
    await scenes({ manage, page, discord, image, ctx, demo });

    // ── API stubs the manage pages call on load (navigation search, setup checklist, generated pages) ──
    const grid = [
        { key: 'raid', label: 'Raid detection', page: 'advanced-protection', on: true },
        { key: 'antiNuke', label: 'Anti-nuke', page: 'security', on: true },
        { key: 'spammer', label: 'Discord spammer check', page: 'security', on: true },
        { key: 'verification', label: 'Verification', page: 'verification', on: true },
        { key: 'phishing', label: 'Phishing links', page: 'phishing', on: true },
        { key: 'globalBan', label: 'Global ban network', page: 'global-ban', on: false },
    ];
    const index = settingsIndex.getSettingsIndex({ viewsDir: views, nav: manageNav, specs: spec.FEATURE_SPECS, generation: 1 });
    const titles = {};
    for (const sec of manageNav) for (const it of sec.items) if (index[it.page]) titles[it.page] = it.title;
    const api = (pathname, req) => {
        for (const [re, fn] of stubs) if (re.test(pathname)) return fn(pathname, req);
        if (pathname === '/api/me/servers') return { servers: [{ id: guild.id, name: guild.name, icon: null }, ...demo.otherGuilds.map((name, i) => ({ id: `10000000000000010${i}`, name, icon: null }))] };
        if (/^\/api\/guilds\/\d+\/insight\/checklist$/.test(pathname)) {
            return { ...checklist.buildChecklist({ grid, basics: { modLog: true, serverLog: true, welcome: true, automod: false } }), hidden: false };
        }
        if (pathname === '/api/settings-index') return { generation: 1, pages: index, titles };
        if (/^\/api\/guilds\/\d+\/insight\/overview$/.test(pathname)) {
            const day = (n) => new Date(Date.UTC(2026, 10, 18 - n)).toISOString();
            return {
                score: { level: 'Good', percent: 83, on: 5, total: 6 },
                protections: grid.map((g) => ({ label: g.label, page: g.page, on: g.on, detail: null })),
                threats: { total: 41, byProtection: [{ label: 'Scam links', n: 27 }, { label: 'Raid detection', n: 11 }, { label: 'Discord spammer check', n: 3 }] },
                bans30d: { automated: 9, manual: 2 },
                banChart: Array.from({ length: 30 }, (_, i) => ({ day: day(29 - i), automated: [0, 0, 1, 0, 2, 0, 0, 1][i % 8], manual: i % 13 === 0 ? 1 : 0 })),
                topRules: [{ label: 'Scam link removed', n: 27 }, { label: 'Spam: too many messages', n: 6 }],
                recentBans: [], lockdowns: [{ status: 'ended', action: 'lockdown', trigger_kind: 'raid', joins_blocked: 23, started_at: day(16) }],
                lastScans: [],
            };
        }
        const fc = pathname.match(/^\/api\/guilds\/\d+\/feature-config\/([a-z-]+)$/);
        if (fc && spec.FEATURE_SPECS[fc[1]] && (!req || req.method === 'GET')) {
            const s = spec.FEATURE_SPECS[fc[1]];
            const config = Object.fromEntries(s.fields.map((f) => [f.key, f.default ?? null]));
            return {
                success: true, config, rows: [],
                spec: { key: fc[1], label: s.label, icon: s.icon, iconPack: s.iconPack || 'fas', colour: s.colour, blurb: s.blurb, commands: s.commands || [], category: s.category || null, note: s.note || null, unwired: s.unwired || null,
                    fields: s.fields.map((f) => ({ ...f, wired: f.wired !== false })), hasList: !!s.list, listTitle: s.list?.title || null, listLabels: s.list?.labels || null },
            };
        }
        if (/^\/api\/guilds\/\d+\/users\/resolve$/.test(pathname)) return { users: {} };
        return null;
    };
    return { shots, api, avatars, setBase: (b) => { base = b; } };
}

/* ── in-page helpers (run in the browser) ── */

/** Hide things that only make sense for a live session (toasts, cookie notes, reconnect banners). */
function hideNoise() {
    for (const sel of ['.cf-toasts', '#reconnectBanner', '.reconnect-banner', '.cf-unsaved', '#cfUnsaved']) {
        document.querySelectorAll(sel).forEach((n) => { n.style.display = 'none'; });
    }
}
function scrollIntoViewTop(sel) {
    for (const s of ['.cf-toasts', '#reconnectBanner', '.reconnect-banner', '.cf-unsaved', '#cfUnsaved']) {
        document.querySelectorAll(s).forEach((n) => { n.style.display = 'none'; });
    }
    const el = document.querySelector(sel);
    if (!el) throw new Error(`scrollTo: no ${sel}`);
    const top = el.getBoundingClientRect().top + window.scrollY - 76;
    window.scrollTo(0, Math.max(0, top));
}

/** A Discord channel window: header with the channel name, then the messages. */
function discordHtml(scene, width) {
    const data = JSON.stringify(scene).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css">
<link rel="stylesheet" href="/css/cf-msgpreview.css">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&display=swap">
<style>
html,body{margin:0;background:#0b0d10}
body{padding:0 24px 24px 24px;font-family:"Noto Sans",sans-serif}
#shot{width:${width}px;background:#313338;border-radius:8px;overflow:hidden;box-sizing:border-box}
.dc-chan{display:flex;align-items:center;gap:8px;height:48px;padding:0 16px;border-bottom:1px solid #26272b;color:#f2f3f5;font:600 15px "Noto Sans",sans-serif}
.dc-chan .h{color:#80848e;font-size:22px;font-weight:400;margin-top:-2px}
.dc-chan .topic{color:#949ba4;font-weight:400;font-size:13px;margin-left:8px;padding-left:12px;border-left:1px solid #3f4147;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dc-msgs{padding:8px 0 12px}
.cf-dc{border-radius:0;background:transparent;font-family:"Noto Sans",sans-serif}
.cf-dc-image.is-real{aspect-ratio:auto;object-fit:contain;max-width:100%;height:auto}
.dc-attach{display:block;max-width:min(100%,520px);border-radius:8px;margin-top:4px}
.dc-select{margin-top:6px;max-width:400px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;height:40px;border-radius:8px;background:#1e1f22;border:1px solid #1e1f22;color:#949ba4;font-size:14px}
.dc-select i{font-size:12px;color:#b5bac1}
.dc-ephemeral{margin-top:4px;font-size:12px;color:#949ba4}
.dc-ephemeral i{margin-right:4px}
.cf-dc-btn .em{font-size:15px;margin-right:2px}
</style></head><body>
<div id="shot"><div class="dc-chan"><span class="h">#</span><span>${esc(scene.channel || 'general')}</span>${scene.topic ? `<span class="topic">${esc(scene.topic)}</span>` : ''}</div><div class="dc-msgs" id="msgs"></div></div>
<script src="/js/cf-msgpreview.js"></script>
<script>
(function () {
  var data = ${data};
  var box = document.getElementById('msgs');
  data.messages.forEach(function (m) {
    var d = document.createElement('div');
    box.appendChild(d);
    CFMsgPreview.render(d, m, data.ctx || {});
    var root = d.firstChild;
    var t = root.querySelector('.cf-dc-time'); if (t) t.textContent = m.time || 'Today at 7:42 PM';
    root.querySelectorAll('.cf-dc-embed .cf-dc-footer').forEach(function (f) { f.textContent = f.textContent.replace(/Today at [0-9:]+\\s?[AP]M/, m.time || 'Today at 7:42 PM'); });
    root.querySelectorAll('.cf-dc-image').forEach(function (i) { if (i.tagName === 'IMG') i.classList.add('is-real'); });
    if (m.usedBy) {
      var u = document.createElement('div'); u.className = 'cf-dc-used';
      var b = document.createElement('b'); b.textContent = m.usedBy.name; u.appendChild(b);
      u.appendChild(document.createTextNode(' used '));
      var c = document.createElement('code'); c.textContent = m.usedBy.command; u.appendChild(c);
      root.insertBefore(u, root.firstChild);
    }
    if ((m.images || []).length) { var em = root.querySelector('.cf-dc-empty'); if (em) em.remove(); }
    (m.images || []).forEach(function (src) {
      var img = document.createElement('img'); img.className = 'dc-attach'; img.alt = ''; img.src = src;
      var after = root.querySelector('.cf-dc-buttons, .cf-dc-reacts');
      after ? root.insertBefore(img, after) : root.appendChild(img);
    });
    if (m.select) {
      var s = document.createElement('div'); s.className = 'dc-select';
      s.appendChild(document.createTextNode(m.select));
      var i = document.createElement('i'); i.className = 'fas fa-chevron-down'; s.appendChild(i);
      var r = root.querySelector('.cf-dc-buttons'); r ? root.insertBefore(s, r) : root.appendChild(s);
    }
    if (m.buttonEmoji) root.querySelectorAll('.cf-dc-btn').forEach(function (bt, k) {
      if (!m.buttonEmoji[k]) return; var e = document.createElement('span'); e.className = 'em'; e.textContent = m.buttonEmoji[k]; bt.insertBefore(e, bt.firstChild);
    });
    if (m.ephemeral) {
      var p = document.createElement('div'); p.className = 'dc-ephemeral';
      var ic = document.createElement('i'); ic.className = 'fas fa-eye'; p.appendChild(ic);
      p.appendChild(document.createTextNode('Only you can see this'));
      root.appendChild(p);
    }
  });
})();
</script></body></html>`;
}
