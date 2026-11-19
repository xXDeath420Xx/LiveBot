// Whole-screen states: loading, signed out (website and panel), Twitch auth timeout, backend down,
// maintenance. Each has one sentence of explanation and at most one primary action.
import { h } from '../lib/dom.js';
import { UI } from '../copy.js';
import { icon } from '../art/icons.js';
import { plantSvg, artFor } from '../art/plant.js';

function frame(title, ...body) {
    return h('main', { class: 'screen', 'aria-labelledby': 'gh-screen-title' },
        h('div', { class: 'screen-inner' },
            h('h1', { id: 'gh-screen-title', class: 'screen-title', tabindex: '-1' }, title),
            body));
}

const heroArt = () => plantSvg(artFor({ id: 7, code: 'glasswing_orchid', hybrid: false }), { className: 'plant-art screen-art' });

export function loadingScreen() {
    return h('main', { class: 'screen', 'aria-busy': 'true', 'aria-labelledby': 'gh-screen-title' },
        h('div', { class: 'screen-inner' },
            plantSvg(artFor({ id: 1, code: 'sunmoss', hybrid: false }), { className: 'plant-art screen-art', stage: 0.5 }),
            h('p', { id: 'gh-screen-title', class: 'screen-sub', role: 'status' }, UI.loading),
            h('div', { class: 'loading-bar', 'aria-hidden': 'true' }, h('span'))));
}

/** Website sign-in. busy: which button is working; error: a sentence to show. */
export function signInScreen({ title, onDiscord, onTwitch, onKick, error = null, busy = null }) {
    const btn = (key, label, fn, cls) => h('button', {
        type: 'button', class: ['btn', 'btn-block', cls], disabled: !!busy, 'aria-busy': busy === key ? 'true' : null,
        dataset: { key: `signin-${key}` }, on: { click: fn }
    }, busy === key ? UI.signIn.working : label);
    return frame(UI.signIn.title,
        heroArt(),
        h('p', { class: 'screen-kicker' }, title),
        h('p', { class: 'screen-sub' }, UI.signIn.pitch),
        error ? h('p', { class: 'screen-error', role: 'alert' }, icon('alert', { size: 16 }), ' ', error) : null,
        h('div', { class: 'stack-sm screen-actions' },
            btn('discord', UI.signIn.discord, onDiscord, 'btn-primary'),
            btn('twitch', UI.signIn.twitch, onTwitch, 'btn-secondary'),
            btn('kick', UI.signIn.kick, onKick, 'btn-secondary')),
        h('p', { class: 'muted small' }, UI.signIn.shared));
}

/** Panel: a logged-out Twitch viewer. The action is shown but disabled: logging in happens on Twitch. */
export function panelSignedOutScreen() {
    return frame(UI.panel.signedOutTitle,
        heroArt(),
        h('p', { class: 'screen-sub' }, UI.panel.signedOutBody),
        h('button', { type: 'button', class: 'btn btn-primary btn-block', disabled: true, 'aria-disabled': 'true' }, UI.panel.signedOutAction));
}

export function authTimeoutScreen({ onRetry, helperMissing = false }) {
    return frame(UI.panel.timeoutTitle,
        h('p', { class: 'screen-sub' }, helperMissing ? UI.panel.helperMissing : UI.panel.timeoutBody),
        h('button', { type: 'button', class: 'btn btn-primary', dataset: { key: 'retry' }, on: { click: onRetry } }, UI.panel.timeoutAction));
}

/** The API cannot be reached. retryAt: when the next automatic try runs. */
export function downScreen({ onRetry, retryInSec = null, maintenance = false, message = null }) {
    return frame(UI.down.title,
        h('p', { class: 'screen-sub' }, maintenance ? UI.down.maintenance : (message || UI.down.body)),
        retryInSec != null ? h('p', { class: 'muted small', role: 'status' }, h('span', { class: 'retry-in' }, UI.down.retryIn(retryInSec))) : null,
        h('button', { type: 'button', class: 'btn btn-primary', dataset: { key: 'retry' }, on: { click: onRetry } }, UI.down.retryNow));
}
