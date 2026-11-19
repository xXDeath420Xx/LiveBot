// Profile tab: name (rename once a week), progress and numbers, the season and achievements (phase 4, through
// the slots), and then: on the website the linked sign-ins with link codes and sign out; in the Twitch panel
// only the optional "share your Twitch identity" card (link codes are website-only, owner decision), and the
// review-save switch for reviewers (main.js app.review). Wide screens show two columns.
import { h } from '../lib/dom.js';
import { money, count, date } from '../lib/format.js';
import { UI } from '../copy.js';
import { confirmDialog } from '../ui/dialog.js';
import { actionButton, section, progress, countdown } from '../ui/widgets.js';
import { renderSlot } from '../slots.js';
import { IS_PANEL } from '../config.js';

const T = UI.profile;

function mem(app) {
    if (!app.mem.profile) app.mem.profile = { account: null, stats: null, loadedFor: null, loading: false, code: null, codeInput: '', nameInput: null };
    return app.mem.profile;
}

function load(app) {
    const m = mem(app);
    const version = app.state.version;
    if (m.loading || m.loadedFor === version) return;
    m.loading = true;
    Promise.all([IS_PANEL ? Promise.resolve({ account: null }) : app.api.get('/account'), app.api.get('/stats')])
        .then(([acc, st]) => { m.account = acc.account; m.stats = st.stats; m.loadedFor = version; })
        .catch((err) => { m.loadedFor = version; app.reportError(err); })
        .finally(() => { m.loading = false; if (app.tab === 'profile') app.render(); });
}

function nameCard(app) {
    const m = mem(app);
    const a = app.state.account;
    const rules = app.catalog.rules.names || { minLength: 2, maxLength: 24 };
    const now = app.now();
    const waitUntil = a.renameAvailableAtMs && a.renameAvailableAtMs > now ? a.renameAvailableAtMs : null;
    const locked = !!waitUntil || !!a.review;
    const value = m.nameInput ?? a.displayName;
    const save = async () => {
        const name = (m.nameInput ?? a.displayName).trim();
        const r = await app.request(() => app.api.post('/account/name', { name }));
        if (!r) return;
        m.nameInput = null;
        app.toast(r.changed ? T.saved : T.unchanged);
        await app.refresh();
    };
    return h('form', { class: 'card stack-sm', on: { submit: (e) => { e.preventDefault(); } } },
        h('label', { for: 'gh-name', class: 'field-label' }, T.name),
        h('div', { class: 'input-row' },
            h('input', {
                id: 'gh-name', class: 'input', type: 'text', value, maxlength: String(rules.maxLength), minlength: String(rules.minLength),
                autocomplete: 'nickname', spellcheck: 'false', disabled: locked, 'aria-describedby': 'gh-name-help', dataset: { key: 'name-input' },
                on: { input: (e) => { m.nameInput = e.target.value; } }
            }),
            actionButton(T.save, save, { key: 'name-save', disabled: locked })),
        h('p', { id: 'gh-name-help', class: 'muted small' },
            a.review ? UI.review.locked : waitUntil ? countdown(waitUntil, now, { format: T.nameWait, done: T.nameHelp(rules.minLength, rules.maxLength) }) : T.nameHelp(rules.minLength, rules.maxLength)));
}

function progressCard(app) {
    const a = app.state.account;
    const m = mem(app);
    const span = a.nextLevelXp ? a.nextLevelXp - a.levelStartXp : 1;
    const into = a.xp - a.levelStartXp;
    const s = m.stats;
    const rows = s ? [
        [T.stats.harvests, count(s.harvests)],
        [T.stats.unitsSold, count(s.unitsSold)],
        [T.stats.cashEarned, money(s.cashEarned)],
        [T.stats.ordersFilled, count(s.ordersFilled)],
        [T.stats.varietiesDiscovered, count(s.varietiesDiscovered)],
        [T.stats.hybridsBred, count(s.hybridsBred)],
        [T.stats.playingSince, date(s.playingSince)]
    ] : null;
    return h('div', { class: 'card stack-sm' },
        h('p', { class: 'strong' }, UI.level(a.level)),
        a.nextLevelXp ? progress(into / span, { label: UI.xpLine(into, span) }) : null,
        a.nextLevelXp ? h('p', { class: 'muted small' }, UI.xpLine(count(into), count(span))) : null,
        rows ? h('dl', { class: 'stats' }, rows.map(([k, v]) => h('div', { class: 'stat' }, h('dt', null, k), h('dd', null, v))))
            : h('p', { class: 'muted small' }, T.statsLoading));
}

function twitchCard(app) {
    const tw = app.twitch;
    if (!tw || app.state.account.review) return null;
    if (tw.role === 'broadcaster') return h('div', { class: 'card' }, h('p', { class: 'small' }, UI.panel.broadcaster));
    if (tw.shared) return h('div', { class: 'card' }, h('p', { class: 'small' }, UI.panel.shared));
    return h('div', { class: 'card stack-sm' },
        h('h2', { class: 'card-title' }, UI.panel.shareTitle),
        h('p', { class: 'small' }, UI.panel.shareBody),
        h('div', null, h('button', { type: 'button', class: 'btn btn-secondary', dataset: { key: 'id-share' }, on: { click: () => tw.requestIdShare() } }, UI.panel.shareAction)));
}

function signinsCard(app) {
    const m = mem(app);
    const ids = m.account ? m.account.identities : [];
    const now = app.now();
    const linkCode = async () => {
        const r = await app.request(() => app.api.post('/account/link-code', {}));
        if (r) { m.code = r; app.render({ focus: 'link-code-made' }); }
    };
    const redeem = async () => {
        const code = m.codeInput.trim();
        if (!code) return;
        const r = await app.request(() => app.api.post('/account/link', { code }));
        if (!r) return;
        m.codeInput = '';
        app.session.set(r);
        app.toast(T.linked);
        m.loadedFor = null;
        await app.refresh({ reconnect: true });
    };
    return h('div', { class: 'card stack' },
        h('p', { class: 'muted small' }, T.signinsIntro),
        ids.length ? h('ul', { class: 'id-list', role: 'list' }, ids.map(i => h('li', { class: 'id-row' },
            h('span', null, h('span', { class: 'strong' }, T.platform[i.platform] || i.platform), i.displayName ? ` ${i.displayName}` : '', i.current ? h('span', { class: 'chip' }, T.thisOne) : null),
            i.current ? null : actionButton(T.unlink, async () => {
                const ok = await confirmDialog({ title: T.unlink, text: T.unlinkConfirm(T.platform[i.platform] || i.platform), confirmText: T.unlink, danger: true });
                if (!ok) return;
                const r = await app.request(() => app.api.post('/account/unlink', { identityId: i.id }));
                if (r) { app.toast(T.unlinked); m.loadedFor = null; await app.refresh(); }
            }, { cls: 'btn-ghost', small: true, key: `unlink-${i.id}` })))) : h('p', { class: 'muted small' }, T.statsLoading),
        h('h2', { class: 'card-title' }, T.linkTitle),
        h('p', { class: 'small' }, T.linkSteps),
        m.code && m.code.expiresAt > now
            ? h('div', { class: 'code-box', tabindex: '-1', dataset: { key: 'link-code-made' } },
                h('span', { class: 'muted small' }, T.codeIs),
                h('span', { class: 'code' }, m.code.code),
                h('span', { class: 'muted small' }, countdown(m.code.expiresAt, now, { format: T.codeExpires, done: '' })))
            : h('div', null, actionButton(T.makeCode, linkCode, { cls: 'btn-secondary', key: 'make-code' })),
        h('form', { class: 'stack-sm', on: { submit: (e) => { e.preventDefault(); redeem(); } } },
            h('label', { for: 'gh-code', class: 'field-label' }, T.enterCode),
            h('div', { class: 'input-row' },
                h('input', {
                    id: 'gh-code', class: 'input input-code', type: 'text', value: m.codeInput, maxlength: '16', autocomplete: 'off', spellcheck: 'false',
                    'aria-label': T.codeLabel, dataset: { key: 'code-input' }, on: { input: (e) => { m.codeInput = e.target.value; } }
                }),
                actionButton(T.link, redeem, { cls: 'btn-secondary', key: 'code-link' }))));
}

/** Panel, for reviewers: switch to the shared review save (shown only when main.js says it is on offer). */
function reviewCard(app) {
    const r = app.review;
    if (!r || !r.offered || app.state.account.review) return null;
    return h('div', { class: 'card stack-sm' },
        h('h2', { class: 'card-title' }, UI.review.offerTitle),
        h('p', { class: 'small' }, UI.review.offerBody),
        h('div', null, actionButton(UI.review.offerAction, () => r.switchTo(), { cls: 'btn-secondary', key: 'review-try' })));
}

export function render(app) {
    load(app);
    return h('div', { class: 'view-body profile-layout' },
        h('div', { class: 'profile-col stack' },
            nameCard(app),
            section(T.progress),
            progressCard(app),
            renderSlot('profile.season', app)),
        h('div', { class: 'profile-col stack' },
            renderSlot('profile.achievements', app),
            IS_PANEL ? twitchCard(app) : null,
            IS_PANEL ? reviewCard(app) : null,
            IS_PANEL ? null : section(T.signins),
            IS_PANEL ? null : signinsCard(app),
            IS_PANEL ? null : h('div', { class: 'card stack-sm' },
            h('p', { class: 'muted small' }, T.about(app.catalog.title, app.catalog.brand)),
            h('p', { class: 'small' }, h('a', { href: '/privacy' }, T.privacy), '  ', h('a', { href: '/terms' }, T.terms)),
            h('div', null, actionButton(T.signOut, () => app.signOut(), { cls: 'btn-secondary', key: 'sign-out' }))),
            IS_PANEL ? h('p', { class: 'muted small about' }, T.about(app.catalog.title, app.catalog.brand)) : null));
}
