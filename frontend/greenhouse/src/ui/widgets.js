// Small building blocks shared by the views.
import { h, setVar } from '../lib/dom.js';
import { icon } from '../art/icons.js';
import { duration } from '../lib/format.js';

/**
 * A button that runs an async action: while it runs the button is disabled and marked busy, so a double
 * click cannot send a second request (and the server pays once anyway).
 */
export function actionButton(label, run, { cls = 'btn-primary', key = null, disabled = false, small = false, title = null, describedBy = null } = {}) {
    const btn = h('button', {
        type: 'button',
        class: ['btn', cls, small && 'btn-sm'],
        disabled,
        title,
        'aria-describedby': describedBy,
        dataset: key ? { key } : null,
        on: {
            click: async (e) => {
                const b = e.currentTarget;
                if (b.disabled || b.getAttribute('aria-busy') === 'true') return;
                b.setAttribute('aria-busy', 'true');
                b.disabled = true;
                try { await run(e); } finally {
                    if (document.contains(b)) { b.removeAttribute('aria-busy'); b.disabled = disabled; }
                }
            }
        }
    }, label);
    return btn;
}

export function section(title, { count = null, actions = null, id = null } = {}) {
    return h('div', { class: 'section-head' },
        h('h2', { class: 'section-title', id }, title, count != null ? h('span', { class: 'section-count' }, count) : null),
        actions ? h('div', { class: 'section-actions' }, actions) : null);
}

export function emptyState(text, action = null) {
    return h('div', { class: 'empty' }, icon('leaf', { size: 22 }), h('p', null, text), action);
}

export function progress(value, { label, cls = '' } = {}) {
    const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
    const bar = h('div', { class: ['progress', cls], role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': label },
        h('div', { class: 'progress-fill' }));
    setVar(bar, '--pct', `${pct}%`);
    return bar;
}

/**
 * Text that counts down to a server time. The app's ticker updates every [data-until] once a second;
 * `format(text)` wraps the remaining time ("Ready in 4 m"); `done` is shown at zero.
 */
export function countdown(untilMs, now, { format = (t) => t, done = '' } = {}) {
    const el = h('span', { class: 'countdown', dataset: { until: untilMs } });
    el._format = format;
    el._done = done;
    if (untilMs - now > 0) el.textContent = format(duration(untilMs - now));
    else { el.textContent = done; el.dataset.crossed = '1'; }
    return el;
}

/** Buttons that switch between parts of a view (Orders / Sell / Shop). */
export function segmented(label, options, current, onPick) {
    return h('div', { class: 'segmented', role: 'group', 'aria-label': label },
        options.map(([value, text]) => h('button', {
            type: 'button',
            class: ['seg', value === current && 'is-current'],
            'aria-pressed': value === current ? 'true' : 'false',
            dataset: { key: `seg-${label}-${value}` },
            on: { click: () => onPick(value) }
        }, text)));
}

/** A − n + number picker with a real labelled input in the middle. */
export function stepper({ id, label, value, min = 1, max = 999, onChange, key }) {
    const clamp = (n) => Math.max(min, Math.min(max, Math.floor(Number(n) || min)));
    const input = h('input', {
        id, type: 'number', inputmode: 'numeric', min: String(min), max: String(max), value: String(value),
        class: 'stepper-input', dataset: { key },
        on: {
            input: (e) => { if (e.target.value !== '') onChange(clamp(e.target.value), false); },
            change: (e) => { e.target.value = String(clamp(e.target.value)); onChange(clamp(e.target.value), true); }
        }
    });
    const bump = (d) => () => { const n = clamp(Number(input.value) + d); input.value = String(n); onChange(n, true); };
    return h('div', { class: 'stepper' },
        h('label', { class: 'sr-only', for: id }, label),
        h('button', { type: 'button', class: 'stepper-btn', 'aria-label': `${label}: one less`, disabled: value <= min, dataset: { key: `${key}-minus` }, on: { click: bump(-1) } }, icon('minus', { size: 16 })),
        input,
        h('button', { type: 'button', class: 'stepper-btn', 'aria-label': `${label}: one more`, disabled: value >= max, dataset: { key: `${key}-plus` }, on: { click: bump(1) } }, icon('plus', { size: 16 })));
}

export function notice(text, { kind = 'info', onDismiss = null, dismissLabel = 'Dismiss' } = {}) {
    return h('div', { class: ['notice', `notice-${kind}`], role: kind === 'error' ? 'alert' : null },
        icon(kind === 'error' || kind === 'warn' ? 'alert' : 'info', { size: 16 }),
        h('p', null, text),
        onDismiss ? h('button', { type: 'button', class: 'notice-close', 'aria-label': dismissLabel, on: { click: onDismiss } }, icon('close', { size: 14 })) : null);
}
