// In-app dialogs (never the browser's native alert or confirm boxes, which may do nothing in Twitch's sandboxed frame). The native
// <dialog> opened with showModal() makes the rest of the page inert, so focus stays inside; Escape closes it;
// focus goes back to the control that opened it.
import { h, fill } from '../lib/dom.js';
import { icon } from '../art/icons.js';
import { UI } from '../copy.js';

const open = new Set();
let seq = 0;
let host = null;

export function setDialogHost(el) { host = el; }

/** Re-render the content of a container, keeping focus on the element with the same data-key. */
export function keepFocus(container, render) {
    const active = document.activeElement;
    const key = active && container.contains(active) && active.dataset ? active.dataset.key : null;
    const selection = key && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
    render();
    if (!key) return;
    const next = container.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (next && !next.disabled) {
        next.focus({ preventScroll: true });
        if (selection && typeof next.setSelectionRange === 'function') {
            try { next.setSelectionRange(selection[0], selection[1]); } catch { /* number inputs */ }
        }
    } else if (next || active === document.body || !document.contains(active)) {
        const fallback = container.querySelector('[data-focus-fallback]') || container.querySelector('h1, h2');
        if (fallback) { if (!fallback.hasAttribute('tabindex')) fallback.setAttribute('tabindex', '-1'); fallback.focus({ preventScroll: true }); }
    }
}

/**
 * openDialog({ title, render(close) -> Node | null }). render runs again on every state change (refreshDialogs);
 * returning null closes the dialog (what it was about is gone).
 */
export function openDialog({ title, render, onClose = null, className = '' }) {
    const opener = document.activeElement;
    const titleId = `gh-dialog-${++seq}`;
    const body = h('div', { class: 'dialog-body' });
    const dlg = h('dialog', { class: ['dialog', className], 'aria-labelledby': titleId },
        h('div', { class: 'dialog-head' },
            h('h2', { id: titleId, class: 'dialog-title' }, title),
            h('button', { type: 'button', class: 'icon-btn', 'aria-label': UI.close, on: { click: () => close() } }, icon('close'))),
        body);
    let closed = false;
    const entry = { refresh, close };

    function close() {
        if (closed) return;
        closed = true;
        if (dlg.open) dlg.close();
        finish();
    }
    function finish() {
        open.delete(entry);
        dlg.remove();
        if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
        if (onClose) onClose();
    }
    function refresh() {
        if (closed) return;
        let content;
        keepFocus(body, () => {
            content = render(close);
            if (content) fill(body, content);
        });
        if (!content) close();
    }

    dlg.addEventListener('close', () => { if (!closed) { closed = true; finish(); } });
    (host || document.body).appendChild(dlg);
    open.add(entry);
    refresh();
    if (closed) return entry;
    dlg.showModal();
    const first = body.querySelector('button:not([disabled]), input:not([disabled]), select:not([disabled]), [href]');
    if (first) first.focus();
    return entry;
}

export function refreshDialogs() {
    for (const d of [...open]) d.refresh();
}

export function closeDialogs() {
    for (const d of [...open]) d.close();
}

/** A yes/no question. Resolves true when the player confirms. */
export function confirmDialog({ title, text, confirmText = UI.confirm, danger = false }) {
    return new Promise((resolve) => {
        let answered = false;
        openDialog({
            title,
            onClose: () => { if (!answered) resolve(false); },
            render: (close) => h('div', { class: 'stack' },
                h('p', { class: 'dialog-text' }, text),
                h('div', { class: 'row-actions' },
                    h('button', { type: 'button', class: 'btn btn-secondary', on: { click: () => close() } }, UI.cancel),
                    h('button', {
                        type: 'button', class: ['btn', danger ? 'btn-danger' : 'btn-primary'],
                        on: { click: () => { answered = true; resolve(true); close(); } }
                    }, confirmText)))
        });
    });
}
