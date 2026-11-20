// Tiny DOM builder. Text always goes in as text (textContent), never as HTML.
export function h(tag, attrs = null, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
            else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
            else if (k === 'dataset') Object.assign(el.dataset, v);
            else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
            else if (k in el && typeof v !== 'string') el[k] = v;
            else el.setAttribute(k, v === true ? '' : String(v));
        }
    }
    append(el, children);
    return el;
}

function append(el, children) {
    for (const c of children.flat(Infinity)) {
        if (c === null || c === undefined || c === false) continue;
        el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
}

export function fill(el, ...children) {
    el.replaceChildren();
    append(el, children);
    return el;
}

export function fmtTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Discord avatar (allowed by the Activity's CSP: cdn.discordapp.com/avatars/), or the default one. */
export function avatarUrl(user, size = 64) {
    if (user?.avatar && /^\d{17,20}$/.test(String(user.id))) return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=${size}`;
    return null;
}

export function initials(name) {
    return String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
}

// Small line icons (24 px grid, currentColor). Built with createElementNS: no markup strings.
const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
    play: [['path', { d: 'M7 4.5v15l12.5-7.5z', fill: 'currentColor', stroke: 'none' }]],
    pause: [['path', { d: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z', fill: 'currentColor', stroke: 'none' }]],
    next: [['path', { d: 'M5 5.5v13l9.5-6.5z', fill: 'currentColor', stroke: 'none' }], ['path', { d: 'M17.5 5.5v13' }]],
    fullscreen: [['path', { d: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5' }]],
    volume: [['path', { d: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z', fill: 'currentColor', stroke: 'none' }], ['path', { d: 'M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11' }]],
    film: [['rect', { x: '3.5', y: '5', width: '17', height: '14', rx: '2' }], ['path', { d: 'M3.5 9.5h17M3.5 14.5h17M8 5v14M16 5v14' }]],
    sprout: [['path', { d: 'M12 20v-8' }], ['path', { d: 'M12 12c0-4-2.8-6.5-7-6.5 0 4 2.8 6.5 7 6.5zM12 10.5c0-3.6 2.7-6 6.8-6 0 3.6-2.7 6-6.8 6z' }]],
};
export function icon(name, size = 18) {
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: String(size), height: String(size), fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
    for (const [tag, attrs] of ICONS[name] || []) {
        const el = document.createElementNS(NS, tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        svg.append(el);
    }
    return svg;
}
