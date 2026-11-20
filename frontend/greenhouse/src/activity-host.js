// Activity host mode (build.mjs --activity; docs/activities.md): the game inside CertiFried's Discord Activity.
//
// The game runs exactly as on the website (main.js, target "activity"), in a same-origin frame of the Activity page on
// <app id>.discordsays.com. Discord's URL mappings send /gh-api to the game API and everything else to the site's
// /activity, so the game's own addresses work unchanged. What differs is sign-in and links:
//   - Sign-in is Discord only, with the person already signed in to the Activity: the page opens with ?signin=discord,
//     and the game's request for its Discord assertion (/greenhouse/session/discord) carries the Activity session as a
//     bearer token (Discord's frame has no site cookie). Twitch and Kick buttons are hidden (activity.css): they
//     would leave Discord.
//   - Links (Privacy, Terms) open in the browser through Discord (the Activity's openExternalLink), because the
//     Activity frame cannot navigate away.
// Must run before main.js (activity-entry.js imports it first).
const host = (() => {
    try { return window.parent !== window ? window.parent.__CF_ACTIVITY__ || null : null; } catch { return null; }
})();
const SESSION_PATH = '/greenhouse/session/discord';
const SITE = (host && host.siteUrl) || 'https://certifriedmultitool.com';

if (host) {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : input && input.url;
        let path = null;
        try { const u = new URL(url, location.href); path = u.origin === location.origin ? u.pathname : null; } catch { path = null; }
        if (path === SESSION_PATH) {
            const headers = new Headers(init.headers || {});
            headers.set('Authorization', `Bearer ${host.session()}`);
            return nativeFetch(input, { ...init, headers, credentials: 'omit' });
        }
        return nativeFetch(input, init);
    };

    document.addEventListener('click', (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
        if (!a || a.hasAttribute('download') || e.defaultPrevented) return;
        const href = a.getAttribute('href') || '';
        if (href.startsWith('#') || href.startsWith('blob:') || href.startsWith('data:')) return;
        e.preventDefault();
        let target;
        try {
            const u = new URL(href, location.href);
            target = u.origin === location.origin ? SITE + u.pathname + u.search + u.hash : u.href;
        } catch { return; }
        if (/^https:\/\//.test(target)) host.openExternal(target);
    }, true);
}

document.documentElement.dataset.activity = host ? 'discord' : 'none';
