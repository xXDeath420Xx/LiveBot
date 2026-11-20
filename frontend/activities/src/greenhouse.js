// Greenhouse Tycoon inside the Activity: the game's own Activity build (frontend/greenhouse, `build.mjs --activity`)
// in a same-origin frame at greenhouse/ (the site's /activity/greenhouse/). The frame signs in with this page's
// session (window.__CF_ACTIVITY__, read by frontend/greenhouse/src/activity-host.js) and talks to the game API at
// /gh-api through Discord's second URL mapping. Same game, same save as the website and the Twitch panel.
import { h, fill } from './dom.js';

export function openGreenhouse(root, { back }) {
    const frame = h('iframe', {
        class: 'gh-frame', src: 'greenhouse/?signin=discord', title: 'Greenhouse Tycoon',
        allow: 'clipboard-write', referrerpolicy: 'no-referrer',
    });
    fill(root, h('div', { class: 'gh-wrap' },
        h('div', { class: 'gh-bar' },
            h('button', { type: 'button', class: 'btn btn-ghost btn-sm', on: { click: back } }, '← Activities'),
            h('span', { class: 'gh-title' }, 'Greenhouse Tycoon')),
        frame));
    return () => frame.remove();
}
