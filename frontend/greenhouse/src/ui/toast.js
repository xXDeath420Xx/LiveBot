// Short notices. Polite ones are read out when the reader is idle; errors interrupt (role="alert").
import { h } from '../lib/dom.js';
import { icon } from '../art/icons.js';
import { UI } from '../copy.js';

let politeList = null;
let alertList = null;

export function mountToasts(root) {
    politeList = h('div', { class: 'toast-list', role: 'status', 'aria-live': 'polite' });
    alertList = h('div', { class: 'toast-list', role: 'alert', 'aria-live': 'assertive' });
    root.appendChild(h('div', { class: 'toasts' }, alertList, politeList));
}

export function toast(text, kind = 'info') {
    const list = kind === 'error' ? alertList : politeList;
    if (!list) return;
    while (list.children.length >= 3) list.firstChild.remove();
    const item = h('div', { class: ['toast', `toast-${kind}`] },
        kind === 'error' ? icon('alert', { size: 16 }) : null,
        h('span', { class: 'toast-text' }, text),
        h('button', { type: 'button', class: 'toast-close', 'aria-label': UI.dismiss, on: { click: () => item.remove() } }, icon('close', { size: 14 })));
    list.appendChild(item);
    setTimeout(() => item.remove(), kind === 'error' ? 7000 : 4000);
}
