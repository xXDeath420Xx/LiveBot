// CertiFried's Discord Activity (docs/activities.md): sign in through Discord, then the launcher — Watch Together or
// Greenhouse Tycoon. /movie can launch the Activity with a title already picked (the "intent" the token answer carries).
//
// Sign-in: sdk.ready() -> sdk.commands.authorize (scope identify, no prompt after the first time) -> POST api/token
// (the server trades the code, checks the Activity instance with Discord and returns our session and Discord's access
// token) -> sdk.commands.authenticate. Our session is a bearer token kept in memory only.
import { DiscordSDK } from '@discord/embedded-app-sdk';
import { h, fill, avatarUrl, initials, icon } from './dom.js';
import { createApi } from './api.js';
import { openWatch } from './watch.js';
import { openGreenhouse } from './greenhouse.js';

const root = document.getElementById('cf-activity');
const appId = (document.querySelector('meta[name="cf-activity-app"]')?.getAttribute('content') || '').trim();
const SITE = 'https://certifriedmultitool.com';

try { if (window.matchMedia?.('(prefers-color-scheme: light)').matches) document.documentElement.dataset.theme = 'light'; } catch { /* default dark */ }

function screen(title, text, ...actions) {
    fill(root, h('div', { class: 'screen' }, h('div', { class: 'mark', 'aria-hidden': 'true' }), h('h1', null, title), text ? h('p', { class: 'muted' }, text) : null, actions.length ? h('div', { class: 'actions' }, actions) : null));
}

function readDemo() {
    const el = document.getElementById('cf-activity-demo');
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch { return null; }
}

function launcher(ctx, me) {
    const avatar = avatarUrl(ctx.user, 64);
    const tile = ({ key, title, text, glyph, available, reason, onOpen }) => h('button', {
        type: 'button', class: ['tile', `tile-${key}`], disabled: !available, 'aria-describedby': reason ? `why-${key}` : null, on: { click: onOpen },
    }, h('span', { class: 'tile-icon', 'aria-hidden': 'true' }, typeof glyph === 'string' ? icon(glyph, 24) : null), h('span', { class: 'tile-title' }, title), h('span', { class: 'tile-text' }, text),
    reason ? h('span', { class: 'tile-why', id: `why-${key}` }, reason) : null);
    fill(root, h('div', { class: 'launcher' },
        h('header', { class: 'l-head' },
            avatar ? h('img', { class: 'avatar', src: avatar, alt: '', width: '32', height: '32' }) : h('span', { class: 'avatar avatar-blank', 'aria-hidden': 'true' }, initials(ctx.user.name)),
            h('div', null, h('p', { class: 'l-hello' }, `Hi ${ctx.user.name}`), h('p', { class: 'muted small' }, 'CertiFried in this channel'))),
        h('div', { class: 'tiles' },
            tile({ key: 'watch', title: 'Watch Together', glyph: 'film', text: 'Films and shows from this server\'s library, in sync for everyone in the channel.',
                available: me.watch.available, reason: me.watch.available ? (me.watch.active ? 'A film is playing now.' : null) : me.watch.reason, onOpen: () => ctx.open('watch') }),
            tile({ key: 'greenhouse', title: 'Greenhouse Tycoon', glyph: 'sprout', text: 'Grow plants, cross new varieties and fill orders. Same save as the website.',
                available: true, reason: null, onOpen: () => ctx.open('greenhouse') })),
        h('footer', { class: 'l-foot muted small' },
            h('button', { type: 'button', class: 'link', on: { click: () => ctx.openExternal(`${SITE}/privacy#activities`) } }, 'Privacy'),
            ' · ',
            h('button', { type: 'button', class: 'link', on: { click: () => ctx.openExternal(`${SITE}/docs/guides/watch-together`) } }, 'How it works'))));
}

async function boot() {
    const demo = readDemo();
    if (demo) return runDemo(demo);
    const q = new URLSearchParams(location.search);
    if (!q.get('frame_id') || !q.get('instance_id')) {
        return screen('Open this from Discord', 'This is CertiFried\'s Discord Activity. Join a voice channel, open the Activities menu (the rocket) and pick CertiFried, or use /movie in a server.');
    }
    if (!/^\d{17,20}$/.test(appId)) return screen('Not set up yet', 'This Activity has no Discord application id.');
    let sdk;
    try {
        sdk = new DiscordSDK(appId, { disableConsoleLogOverride: true });
        await sdk.ready();
    } catch {
        return screen('Discord did not answer', 'Close the Activity and open it again.');
    }
    screen('Signing in…', null);
    let code;
    try {
        ({ code } = await sdk.commands.authorize({ client_id: appId, response_type: 'code', state: '', prompt: 'none', scope: ['identify'] }));
    } catch {
        return screen('CertiFried needs to know who you are', 'Discord asks once. Without it the Activity cannot tell the host from the viewers.',
            h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => location.reload() } }, 'Ask again'));
    }
    let r;
    try {
        const res = await fetch('api/token', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ code, instanceId: sdk.instanceId }) });
        r = await res.json().catch(() => null);
        if (!res.ok) throw new Error(r?.error?.message || 'Sign-in did not work.');
    } catch (e) {
        return screen('Could not sign in', e.message || 'Sign-in did not work.', h('button', { type: 'button', class: 'btn btn-primary', on: { click: () => location.reload() } }, 'Try again'));
    }
    try { await sdk.commands.authenticate({ access_token: r.access_token }); } catch { /* the session works without it */ }
    r.access_token = null;

    const ctx = {
        sdk,
        user: r.user,
        where: r.where,
        session: () => r.session,
        reload: () => location.reload(),
        openExternal: (url) => { sdk.commands.openExternalLink({ url }).catch(() => {}); },
    };
    ctx.api = createApi(ctx.session, { onSignedOut: () => location.reload() });
    // For the Greenhouse frame (same origin): its sign-in reads the session here, and it opens links through Discord.
    window.__CF_ACTIVITY__ = Object.freeze({ session: ctx.session, openExternal: ctx.openExternal, siteUrl: SITE });

    let me;
    try { me = await ctx.api.get('api/me'); } catch (e) { return screen('Something went wrong', e.message); }
    let closeView = null;
    const back = () => { closeView?.(); closeView = null; launcher(ctx, me); refreshMe(); };
    async function refreshMe() { try { me = await ctx.api.get('api/me'); launcher(ctx, me); } catch { /* keep the old one */ } }
    ctx.open = (what, intent = null) => {
        closeView?.();
        if (what === 'watch') closeView = openWatch(root, ctx, { back, intent });
        else closeView = openGreenhouse(root, { back });
    };
    if (r.intent?.kind === 'watch' && me.watch.available) return ctx.open('watch', r.intent);
    if (r.intent?.kind === 'greenhouse') return ctx.open('greenhouse');
    if (me.watch.available && me.watch.active) return ctx.open('watch');
    launcher(ctx, me);
}

/** The guide screenshots (scripts/site-shots): invented data, no Discord, no network. */
function runDemo(demo) {
    const ctx = { user: demo.user, session: () => '', reload: () => {}, openExternal: () => {}, api: null, open: () => {} };
    if (demo.view === 'launcher') return launcher(ctx, demo.me);
    openWatch(root, ctx, { back: () => {}, demo });
}

boot().catch(() => screen('Something went wrong', 'Close the Activity and open it again.'));
