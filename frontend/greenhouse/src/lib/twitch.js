// The Twitch panel side: the extension helper (loaded first by panel.html from extension-files.twitch.tv).
//
//   onAuthorized   fires at load and again whenever Twitch renews the token or the viewer shares their
//                  identity. Every time, the token is exchanged at POST /auth/twitch-ext, which answers a
//                  game session (or TWITCH_SIGNED_OUT for a logged-out viewer, whose id must not be kept).
//   onContext      the viewer's Twitch theme (light or dark) for the panel colours.
//   onVisibilityChanged   the panel scrolled out of view: poll less.
// Identity sharing is optional: the panel save works on the viewer's opaque id. Sharing joins it to their
// real Twitch account so the website's Twitch sign-in opens the same save. The broadcaster on their own
// channel plays under their Twitch id with no prompt (requestIdShare does nothing there anyway).

/** The payload of an extension JWT, for display decisions only (the server verifies the signature). */
export function decodeExtToken(token) {
    try {
        const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const json = atob(part + '='.repeat((4 - (part.length % 4)) % 4));
        return JSON.parse(json);
    } catch {
        return null;
    }
}

export function twitchHelper() {
    const ext = window.Twitch && window.Twitch.ext;
    return ext && typeof ext.onAuthorized === 'function' ? ext : null;
}

/**
 * Wire the helper. Callbacks: authorized(auth, claims), context(ctx), visible(bool).
 * Returns { requestIdShare, isLinked } or null when the helper is missing.
 */
export function connectTwitch({ authorized, context, visible }) {
    const ext = twitchHelper();
    if (!ext) return null;
    ext.onAuthorized((auth) => authorized(auth, decodeExtToken(auth && auth.token)));
    if (typeof ext.onContext === 'function') ext.onContext((ctx) => context(ctx || {}));
    if (typeof ext.onVisibilityChanged === 'function') ext.onVisibilityChanged((isVisible) => visible(!!isVisible));
    if (typeof ext.onError === 'function') ext.onError(() => { /* the auth timeout screen covers a helper that gives up */ });
    return {
        requestIdShare() {
            if (ext.actions && typeof ext.actions.requestIdShare === 'function') ext.actions.requestIdShare();
        },
        isLinked: () => !!(ext.viewer && ext.viewer.isLinked)
    };
}
