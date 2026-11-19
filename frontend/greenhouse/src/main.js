// Greenhouse Tycoon: one app for the website (/greenhouse) and the Twitch panel.
//
// Start-up
//   1. GET /catalog (names and rules). If the API cannot be reached: the "not answering" screen, which
//      retries by itself.
//   2. Sign in.
//      Website: a one-time ticket in the address (#gh_ticket=..., from the Twitch or Kick sign-in page),
//               ?signin=discord (back from the dashboard's Discord login), a stored refresh token, or the
//               sign-in screen.
//      Panel:   Twitch.ext.onAuthorized -> POST /auth/twitch-ext, every time it fires. A logged-out viewer
//               sees "Log in to Twitch to play"; no answer from Twitch within 10 s shows the timeout screen.
//   3. GET /state, then keep it fresh (lib/sync.js: polling with ETag, WebSocket hints).
// Phase 4: the cards in the tabs' slots (phase4.js), the notifications bell in the top bar, and in the panel
// the review-save switch for Twitch reviewers (see "the review save" below).
// Every action answers the new state, which replaces the old one and re-renders the open tab and dialogs.
import { h, fill } from './lib/dom.js';
import { TARGET, IS_PANEL, API_BASE, DISCORD_SESSION_PATH, AUTH_TIMEOUT_MS } from './config.js';
import { UI } from './copy.js';
import { createApi, isTransient } from './lib/api.js';
import { createSession, SignedOutError } from './lib/session.js';
import { createSync } from './lib/sync.js';
import { connectTwitch } from './lib/twitch.js';
import { money, exactMoney, duration } from './lib/format.js';
import { icon } from './art/icons.js';
import { mountToasts, toast } from './ui/toast.js';
import { setDialogHost, keepFocus, refreshDialogs, closeDialogs } from './ui/dialog.js';
import { notice, progress } from './ui/widgets.js';
import * as screens from './ui/screens.js';
import * as growView from './views/greenhouse.js';
import * as marketView from './views/market.js';
import * as breedView from './views/breeding.js';
import * as upgradesView from './views/upgrades.js';
import * as profileView from './views/profile.js';
import { notificationsButton } from './ui/notifications.js';
import './phase4.js';

const TABS = [
    ['grow', growView, 'grow'],
    ['market', marketView, 'market'],
    ['breed', breedView, 'breed'],
    ['upgrades', upgradesView, 'upgrades'],
    ['profile', profileView, 'profile']
];

// ------------------------------------------------------------------ the page skeleton

const root = document.getElementById('gh-app');
root.dataset.target = TARGET;
const screenHost = h('div', { class: 'screen-host' });
const header = h('header', { class: 'topbar' });
const banners = h('div', { class: 'banners' });
const main = h('main', { class: 'view', id: 'gh-main', 'aria-labelledby': 'gh-view-title' });
const nav = h('nav', { class: 'tabbar', 'aria-label': UI.navLabel });
const game = h('div', { class: 'game', hidden: true }, header, banners, main, nav);
fill(root, screenHost, game);
mountToasts(root);
setDialogHost(root);

// ------------------------------------------------------------------ app state shared with the views

const app = {
    target: TARGET,
    catalog: null,
    state: null,
    tab: 'grow',
    mem: {},
    twitch: null,
    notices: [],
    status: { online: true, live: false },
    pollFailures: 0,
    startedAt: 0,
    toast,
    now: () => sync.now()
};

const api = createApi({
    getToken: () => session.token(),
    renew: (reason) => session.renew(reason)
});

// ---- the review save (Twitch panel, phase 4)
// Reviewers get a "Try the review save" card in Profile only when the panel runs in a test or review state
// (Twitch's `state` query parameter) AND the server says the review save is open (GET /review). It switches
// this panel's session to the shared, sandboxed example save; "Back to my save" signs in normally again.
// The server decides what the review save may do; this only hides controls it refuses anyway.
const REVIEW_STATES = new Set(['testing', 'hosted_test', 'ready_for_review', 'in_review']);
const panelState = IS_PANEL ? new URLSearchParams(location.search).get('state') : null;
app.review = { eligible: IS_PANEL && REVIEW_STATES.has(panelState), checked: false, offered: false, active: false, switchTo: () => switchToReview(), back: () => backFromReview() };

async function checkReviewOffer() {
    if (!app.review.eligible || app.review.checked) return;
    app.review.checked = true;
    try {
        const { data } = await api.raw('GET', '/review');
        app.review.offered = !!(data && data.review && data.review.enabled);
    } catch {
        app.review.offered = false;
    }
    if (app.review.offered && app.state) render();
}

async function reviewSignIn() {
    if (!latestTwitchAuth) throw new SignedOutError(UI.panel.signedOutTitle, 'TWITCH_SIGNED_OUT');
    return (await api.raw('POST', '/auth/review', { body: { token: latestTwitchAuth.token } })).data;
}

/** Sign in for the panel: the review save while it is chosen (falling back to the viewer's own), else their own. */
async function currentPanelSignIn() {
    if (!app.review.active) return panelSignIn();
    try {
        return await reviewSignIn();
    } catch (err) {
        // Only a closed review save sends the reviewer back to their own save; anything else is retried as usual.
        if (err.code !== 'REVIEW_UNAVAILABLE') throw err;
        app.review.active = false;
        toast(UI.review.unavailable, 'warn');
        return panelSignIn();
    }
}

async function switchSave(signIn, message) {
    const data = await signIn();
    session.set(data);
    app.mem = {};
    closeDialogs();
    const { data: fresh } = await api.call('GET', '/state');
    sync.accept(fresh.state);
    sync.reconnect();
    app.tab = 'grow';
    render({ focus: 'tab-grow' });
    toast(message);
}

async function switchToReview() {
    try {
        app.review.active = true;
        await switchSave(reviewSignIn, UI.review.switched);
    } catch (err) {
        app.review.active = false;
        app.reportError(err.code === 'REVIEW_UNAVAILABLE' ? { message: UI.review.unavailable } : err);
    }
}

async function backFromReview() {
    app.review.active = false;
    try { await switchSave(panelSignIn, UI.review.backDone); } catch (err) { app.reportError(err); }
}

let latestTwitchAuth = null;
async function panelSignIn() {
    if (!latestTwitchAuth) throw new SignedOutError(UI.panel.signedOutTitle, 'TWITCH_SIGNED_OUT');
    try {
        return (await api.raw('POST', '/auth/twitch-ext', { body: { token: latestTwitchAuth.token } })).data;
    } catch (err) {
        if (err.code === 'TWITCH_SIGNED_OUT' || err.code === 'UNAUTHORIZED') throw new SignedOutError(UI.panel.signedOutTitle, err.code);
        throw err;
    }
}

const session = createSession({
    api,
    persist: !IS_PANEL,
    reauth: IS_PANEL ? () => currentPanelSignIn() : null,
    onSignedIn: (cur, accountChanged) => {
        if (accountChanged && app.state) { app.mem = {}; closeDialogs(); }
    },
    onSignedOut: (reason) => signedOut(reason)
});

const sync = createSync({
    api,
    session,
    onState: (s) => {
        const first = !app.state;
        app.state = s;
        app.pollFailures = 0;
        if (!first) render();
    },
    onStatus: (st) => { app.status = st; renderBanners(); },
    onError: (err) => {
        if (err instanceof SignedOutError) return;
        if (err.code === 'SERVICE_DISABLED') return showDown({ maintenance: true, retry: () => startGame() });
        if (err.code === 'NETWORK' || err.code === 'TIMEOUT' || isTransient(err)) {
            app.pollFailures++;
            if (navigator.onLine === false) sync.markOffline();
            renderBanners();
        }
    }
});
app.api = api;
app.session = session;

/** Run a gameplay action: the answer's state replaces the old one; errors become a short notice. */
app.act = async (path, body = {}, { done = null } = {}) => {
    try {
        const data = await api.action(path, body);
        if (data && data.state) sync.accept(data.state);
        if (done) done(data.result, data.state);
        return data.result;
    } catch (err) {
        app.reportError(err);
        if (!(err instanceof SignedOutError) && app.state) sync.poll();
        return null;
    }
};

/** Run any other request; errors become a short notice and the answer is null. */
app.request = async (fn) => {
    try { return await fn(); } catch (err) { app.reportError(err); return null; }
};

app.refresh = async ({ reconnect = false } = {}) => {
    if (reconnect) sync.reconnect();
    await sync.poll();
};

app.reportError = (err) => {
    if (err instanceof SignedOutError) return;
    if (!err) return;
    if (err.code === 'SERVICE_DISABLED') return showDown({ maintenance: true, retry: () => startGame() });
    if (err.code === 'RATE_LIMITED') return toast(UI.rateLimited, 'warn');
    if (err.code === 'NETWORK' && navigator.onLine === false) { sync.markOffline(); return; }
    toast(err.message || UI.errors.generic, 'error');
};

app.go = (tab, opts = {}) => {
    if (!TABS.some(([name]) => name === tab)) return;
    if (opts.section) {
        if (!app.mem[tab]) app.mem[tab] = {};
        app.mem[tab].section = opts.section;
    }
    app.tab = tab;
    main.scrollTop = 0;
    render({ focus: `tab-${tab}` });
};

app.signOut = async () => {
    await session.signOut();
};

// ------------------------------------------------------------------ rendering

function showScreen(node) {
    game.hidden = true;
    fill(screenHost, node);
    const title = screenHost.querySelector('.screen-title');
    if (title && root.contains(document.activeElement)) title.focus({ preventScroll: true });
}

function renderHeader() {
    const a = app.state.account;
    const span = a.nextLevelXp ? a.nextLevelXp - a.levelStartXp : 1;
    fill(header,
        IS_PANEL ? null : h('div', { class: 'brand' },
            h('span', { class: 'brand-title' }, app.catalog.title),
            h('span', { class: 'brand-by' }, `by ${UI.brand}`)),
        h('div', { class: 'who' },
            h('span', { class: 'level-chip' }, UI.levelShort(a.level)),
            h('span', { class: 'who-name' }, a.displayName),
            a.nextLevelXp ? progress((a.xp - a.levelStartXp) / span, { label: UI.xpLine(a.xp - a.levelStartXp, span), cls: 'progress-xp' }) : null),
        h('p', { class: 'cash' }, h('span', { class: 'sr-only' }, `${UI.cashLabel}: `), h('span', { title: exactMoney(a.cash) }, money(a.cash))),
        notificationsButton(app));
}

function renderBanners() {
    if (!app.state) { fill(banners); return; }
    const items = [];
    if (app.state.account.review) {
        items.push(h('div', { class: 'notice notice-info review-banner' }, icon('info', { size: 16 }),
            h('p', { title: app.state.review && app.state.review.note ? app.state.review.note : null }, UI.review.banner),
            IS_PANEL ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', dataset: { key: 'review-back' }, on: { click: () => backFromReview() } }, UI.review.back) : null));
    }
    if (!app.status.online) items.push(notice(UI.offline, { kind: 'warn' }));
    else if (app.pollFailures >= 2) items.push(notice(UI.errors.network, { kind: 'warn' }));
    else if (!app.status.live && Date.now() - app.startedAt > 12_000) items.push(h('p', { class: 'quiet-line' }, UI.polling));
    for (const n of app.notices) {
        items.push(notice(UI.panel.notices[n], {
            kind: 'info', dismissLabel: UI.dismiss,
            onDismiss: () => { app.notices = app.notices.filter(x => x !== n); renderBanners(); }
        }));
    }
    fill(banners, items);
}

function renderNav() {
    fill(nav, TABS.map(([name, , iconName]) => h('button', {
        type: 'button', class: ['tab', app.tab === name && 'is-current'], 'aria-current': app.tab === name ? 'page' : null,
        dataset: { key: `tab-${name}` }, on: { click: () => app.go(name) }
    }, icon(iconName, { size: 22 }), h('span', { class: 'tab-label' }, UI.tabs[name]))));
}

function render({ focus = null } = {}) {
    if (!app.state || !app.catalog || game.hidden && screenHost.firstChild) return;
    const view = (TABS.find(([name]) => name === app.tab) || TABS[0])[1];
    keepFocus(game, () => {
        renderHeader();
        renderBanners();
        renderNav();
        fill(main,
            h('h1', { id: 'gh-view-title', class: 'view-title' }, UI.tabHeadings[app.tab]),
            view.render(app));
    });
    if (focus) {
        const el = root.querySelector(`[data-key="${CSS.escape(focus)}"]`);
        if (el) el.focus({ preventScroll: true });
    }
    refreshDialogs();
}
app.render = render;

function showGame() {
    fill(screenHost);
    game.hidden = false;
    app.startedAt = Date.now();
    render();
}

// Countdowns: every [data-until] shows the time left on the server clock; when one reaches zero (a plant
// is ready, a cross is done) the tab is drawn again.
setInterval(() => {
    if (!app.state || game.hidden) return;
    const now = app.now();
    let crossed = false;
    for (const el of root.querySelectorAll('[data-until]')) {
        const left = Number(el.dataset.until) - now;
        const text = left > 0 ? (el._format ? el._format(duration(left)) : duration(left)) : (el._done ?? '');
        if (el.textContent !== text) el.textContent = text;
        if (left <= 0 && !el.dataset.crossed) { el.dataset.crossed = '1'; crossed = true; }
    }
    if (crossed) render();
    if (!app.status.live && banners.childElementCount === 0 && Date.now() - app.startedAt > 12_000) renderBanners();
}, 1000);

// ------------------------------------------------------------------ the not-answering screen

let downTimer = null;
let downAttempt = 0;
function showDown({ maintenance = false, message = null, retry }) {
    clearInterval(downTimer);
    sync.stop();
    app.state = null;
    closeDialogs();
    const delays = [5, 10, 20, 30, 60];
    let left = delays[Math.min(downAttempt, delays.length - 1)];
    downAttempt++;
    const again = () => { clearInterval(downTimer); showScreen(screens.loadingScreen()); retry(); };
    showScreen(screens.downScreen({ onRetry: again, retryInSec: left, maintenance, message }));
    downTimer = setInterval(() => {
        left--;
        const el = screenHost.querySelector('.retry-in');
        if (el) el.textContent = UI.down.retryIn(Math.max(0, left));
        if (left <= 0) again();
    }, 1000);
}

// ------------------------------------------------------------------ start-up

let catalogReady = null;
function loadCatalog() {
    if (!catalogReady) {
        catalogReady = api.raw('GET', '/catalog').then(({ data }) => {
            app.catalog = data.catalog;
            document.title = IS_PANEL ? app.catalog.title : `${app.catalog.title} | ${UI.brand}`;
            downAttempt = 0;
            return true;
        }).catch((err) => {
            catalogReady = null;
            showDown({ maintenance: err.code === 'SERVICE_DISABLED', retry: boot });
            return false;
        });
    }
    return catalogReady;
}

async function startGame() {
    try {
        const { data } = await api.call('GET', '/state');
        app.state = null;
        sync.stop();
        sync.start(data.state);
        app.state = data.state;
        downAttempt = 0;
        showGame();
    } catch (err) {
        if (err instanceof SignedOutError) return;
        if (err.code === 'SERVICE_DISABLED' || isTransient(err) || err.code === 'SERVER') return showDown({ maintenance: err.code === 'SERVICE_DISABLED', retry: () => startGame() });
        signedOut(err.message);
    }
}

function signedOut(reason) {
    sync.stop();
    closeDialogs();
    app.state = null;
    app.mem = {};
    if (IS_PANEL) return showScreen(screens.panelSignedOutScreen());
    showSignIn({ error: reason });
}

// ---- website sign-in

function showSignIn({ error = null, busy = null } = {}) {
    showScreen(screens.signInScreen({
        title: app.catalog ? app.catalog.title : '',
        error,
        busy,
        onDiscord: () => discordSignIn(),
        onTwitch: () => oauthSignIn('twitch'),
        onKick: () => oauthSignIn('kick')
    }));
}

function oauthSignIn(provider) {
    showSignIn({ busy: provider });
    // The provider sends the player back to the game's sign-in page, which hands over a one-time ticket
    // in #gh_ticket=... (never the tokens themselves).
    location.assign(`${API_BASE}/auth/${provider}/start`);
}

async function exchange(run) {
    try {
        const { data } = await run();
        session.set(data);
        await startGame();
    } catch (err) {
        if (isTransient(err)) return showDown({ retry: boot });
        showSignIn({ error: err.message || UI.signIn.failed });
    }
}

async function discordSignIn() {
    showSignIn({ busy: 'discord' });
    let res;
    let data = null;
    try {
        res = await fetch(DISCORD_SESSION_PATH, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
        try { data = await res.json(); } catch { data = null; }
    } catch {
        return showSignIn({ error: UI.errors.network });
    }
    if (res.status === 401 && data && typeof data.loginUrl === 'string' && /^\/(?![/\\])/.test(data.loginUrl)) {
        location.assign(data.loginUrl); // the dashboard's Discord login, then back to /greenhouse?signin=discord
        return;
    }
    if (!res.ok || !data || typeof data.assertion !== 'string') {
        return showSignIn({ error: (data && data.error && data.error.message) || UI.signIn.failed });
    }
    await exchange(() => api.raw('POST', '/auth/discord', { body: { assertion: data.assertion } }));
}

async function bootWeb() {
    const hash = location.hash.match(/gh_ticket=([A-Za-z0-9_-]{32})/);
    const params = new URLSearchParams(location.search);
    const wantsDiscord = params.get('signin') === 'discord';
    if (hash || wantsDiscord) {
        params.delete('signin');
        const q = params.toString();
        history.replaceState(null, '', location.pathname + (q ? `?${q}` : ''));
    }
    if (hash) return exchange(() => api.raw('POST', '/auth/ticket', { body: { ticket: hash[1] } }));
    if (wantsDiscord) return discordSignIn();
    if (session.hasStoredRefresh()) {
        try {
            await session.renew('boot');
            return startGame();
        } catch (err) {
            if (err instanceof SignedOutError) return; // onSignedOut already showed the sign-in screen
            if (isTransient(err)) return showDown({ retry: boot });
            return showSignIn({ error: err.message });
        }
    }
    showSignIn();
}

// ---- Twitch panel sign-in

let twitch = null;
let authTimer = null;
function setTheme(theme) {
    if (theme === 'light') document.documentElement.dataset.theme = 'light';
    else delete document.documentElement.dataset.theme;
}

async function onTwitchAuthorized(auth, claims) {
    latestTwitchAuth = auth;
    if (app.twitch && claims) {
        app.twitch.role = claims.role || null;
        app.twitch.shared = !!claims.user_id;
    }
    if (!(await loadCatalog())) return;
    try {
        const data = await currentPanelSignIn();
        clearTimeout(authTimer);
        const before = session.current ? session.current.accountId : null;
        session.set(data);
        if (data.notice && UI.panel.notices[data.notice] && !app.notices.includes(data.notice)) app.notices.push(data.notice);
        checkReviewOffer();
        if (!app.state) await startGame();
        else {
            if (before !== data.accountId) app.mem = {};
            sync.reconnect();
            await sync.poll();
            render();
        }
    } catch (err) {
        clearTimeout(authTimer);
        if (err instanceof SignedOutError) return signedOut(err.message);
        showDown({ message: err.code === 'SIGNIN_UNAVAILABLE' ? err.message : null, retry: () => onTwitchAuthorized(latestTwitchAuth, claims) });
    }
}

async function bootPanel() {
    twitch = connectTwitch({
        authorized: (auth, claims) => { onTwitchAuthorized(auth, claims); },
        context: (ctx) => setTheme(ctx.theme),
        visible: (v) => sync.setPanelVisible(v)
    });
    if (!twitch) return showScreen(screens.authTimeoutScreen({ helperMissing: true, onRetry: () => location.reload() }));
    app.twitch = { role: null, shared: false, requestIdShare: () => twitch.requestIdShare() };
    clearTimeout(authTimer);
    authTimer = setTimeout(() => {
        if (!session.current) showScreen(screens.authTimeoutScreen({ onRetry: () => location.reload() }));
    }, AUTH_TIMEOUT_MS);
    await loadCatalog();
}

async function boot() {
    showScreen(screens.loadingScreen());
    if (IS_PANEL) {
        if (!twitch) return bootPanel();
        if (latestTwitchAuth) return onTwitchAuthorized(latestTwitchAuth, null);
        return loadCatalog();
    }
    if (!(await loadCatalog())) return;
    return bootWeb();
}

boot();
