// Phase 4 notifications: a bell in the top bar with the unread count from the state, and a dialog that
// lists them (newest first, 20 at a time) with "Mark all as read" and "Show older".
import { h } from '../lib/dom.js';
import { UI } from '../copy.js';
import { icon } from '../art/icons.js';
import { openDialog } from './dialog.js';
import { actionButton } from './widgets.js';

const N = UI.notifications;

function when(ms) {
    try {
        return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch {
        return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    }
}

function openList(app) {
    const m = { items: [], nextBefore: null, loading: false, loaded: false };
    let entry = null;
    function load(before = null) {
        m.loading = true;
        app.api.get(`/notifications${before ? `?before=${before}` : ''}`)
            .then((d) => {
                m.items = before ? m.items.concat(d.notifications) : d.notifications;
                m.nextBefore = d.nextBefore;
                m.loaded = true;
            })
            .catch((err) => app.reportError(err))
            .finally(() => { m.loading = false; if (entry) entry.refresh(); });
    }
    entry = openDialog({
        title: N.title,
        className: 'dialog-wide',
        render: () => {
            const unread = app.state && app.state.notifications ? app.state.notifications.unread : 0;
            if (!m.loaded) return h('p', { class: 'muted small', role: 'status' }, N.loading);
            return h('div', { class: 'stack' },
                m.items.length ? h('ul', { class: 'notes', role: 'list' }, m.items.map(n => h('li', { class: ['note', !n.read && 'note-new'] },
                    h('p', null, n.text),
                    h('p', { class: 'muted small' }, when(n.createdAtMs), n.read ? null : [' ', h('span', { class: 'chip chip-accent' }, N.unread)])))) : h('p', { class: 'muted small' }, N.none),
                h('div', { class: 'row-actions' },
                    m.nextBefore ? h('button', { type: 'button', class: 'btn btn-secondary btn-sm', disabled: m.loading, dataset: { key: 'notes-older' }, on: { click: () => load(m.nextBefore) } }, N.older) : null,
                    unread ? actionButton(N.markAll, () => app.act('/notifications/read', {}, {
                        done: () => { m.items = m.items.map(n => ({ ...n, read: true })); if (entry) entry.refresh(); }
                    }), { small: true, key: 'notes-read' }) : null));
        }
    });
    load();
}

/** The bell button for the top bar. */
export function notificationsButton(app) {
    const n = app.state.notifications ? app.state.notifications.unread : 0;
    const shown = app.state.notifications && app.state.notifications.more ? '99+' : String(n);
    return h('button', {
        type: 'button', class: 'icon-btn bell', 'aria-label': N.button(n ? shown : 0), dataset: { key: 'notifications' },
        on: { click: () => openList(app) }
    }, icon('bell', { size: 20 }), n ? h('span', { class: 'bell-count', 'aria-hidden': 'true' }, shown) : null);
}
