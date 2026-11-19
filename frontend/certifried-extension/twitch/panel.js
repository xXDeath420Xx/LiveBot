// Twitch panel bootstrap: switches between loading, identity prompt, error and the game.
// Loaded as a module after the Twitch helper, so window.Twitch.ext exists when app.js runs.
import { app, store } from './app.js';

const show = (id) => {
    for (const el of ['loading-screen', 'identity-screen', 'error-screen', 'frozen-screen']) {
        document.getElementById(el).classList.toggle('is-shown', el === id);
    }
    document.getElementById('app').classList.toggle('is-hidden', id !== 'app');
};

function update() {
    // Frozen until v2 (H-636): the message replaces the identity prompt and the game
    const frozen = store.get('ui.frozen');
    if (frozen) {
        document.getElementById('frozen-text').textContent = frozen;
        return show('frozen-screen');
    }
    if (store.get('auth.needsIdentity')) {
        // Signed-out viewers have no Twitch identity to share; Twitch would ignore the request.
        const btn = document.getElementById('share-identity');
        const out = !!store.get('auth.signedOut');
        btn.textContent = out ? 'Log in to Twitch to play' : 'Share my Twitch ID and play';
        btn.disabled = out;
        return show('identity-screen');
    }
    if (store.get('auth.isAuthenticated')) return show('app');
    const err = store.get('ui.connectionError');
    if (err) {
        document.getElementById('error-text').textContent = err;
        return show('error-screen');
    }
    return show('loading-screen');
}

document.getElementById('share-identity').addEventListener('click', () => {
    // Twitch shows its own consent dialog; onAuthorized fires again with the real user id
    window.Twitch?.ext?.actions?.requestIdShare?.();
});

store.subscribe('auth.needsIdentity', update);
store.subscribe('auth.signedOut', update);
store.subscribe('auth.isAuthenticated', update);
store.subscribe('ui.connectionError', update);
store.subscribe('ui.frozen', update);
document.addEventListener('cfx:ready', update);
show('loading-screen');

export { app };
