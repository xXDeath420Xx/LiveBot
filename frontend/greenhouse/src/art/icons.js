// The game's small line icons (24 x 24, stroke = currentColor). Decorative: every icon sits next to a text
// label, so they are hidden from assistive technology.
import { s } from '../lib/dom.js';

const PATHS = Object.freeze({
    grow: 'M12 21v-9 M12 12c0-4.5-3.2-7-8-7 0 4.5 3.2 7 8 7z M12 10c0-4 3-6.5 7.5-6.5 0 4-3 6.5-7.5 6.5z',
    market: 'M4 9h16l-1.6 10.2a1.5 1.5 0 0 1-1.5 1.3H7.1a1.5 1.5 0 0 1-1.5-1.3L4 9z M8.5 9 12 4l3.5 5 M9.5 13v4 M14.5 13v4',
    breed: 'M3.5 12a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0z M9.5 12a5.5 5.5 0 1 0 11 0a5.5 5.5 0 1 0-11 0z',
    upgrades: 'M12 19V6 M6.5 11.5 12 6l5.5 5.5 M5 21h14',
    profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4.5 20.5c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5',
    water: 'M12 3.5s5.5 6 5.5 10.2a5.5 5.5 0 0 1-11 0C6.5 9.5 12 3.5 12 3.5z',
    close: 'M6 6l12 12 M18 6 6 18',
    plus: 'M12 5v14 M5 12h14',
    minus: 'M5 12h14',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2',
    lock: 'M7 11V8a5 5 0 0 1 10 0v3 M5.5 11h13v9.5h-13z',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    leaf: 'M5 19c0-8.5 5.5-14 15-14.5C19.5 14 14 19.5 5 19z M5 19l8-8',
    alert: 'M12 4 2.8 19.5h18.4L12 4z M12 10v4.5 M12 17.2v.3',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v5.5 M12 7.6v.3',
    bell: 'M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z M10 20.5a2 2 0 0 0 4 0',
    star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8z',
    flag: 'M5.5 21V4 M5.5 4.5h11l-2 4 2 4h-11',
    list: 'M9 6h11 M9 12h11 M9 18h11 M4.5 6h.5 M4.5 12h.5 M4.5 18h.5'
});

export function icon(name, { size = 20, className = 'icon' } = {}) {
    const svg = s('svg', {
        viewBox: '0 0 24 24', width: size, height: size, class: className, fill: 'none', stroke: 'currentColor',
        'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false'
    });
    svg.appendChild(s('path', { d: PATHS[name] || PATHS.leaf }));
    return svg;
}
