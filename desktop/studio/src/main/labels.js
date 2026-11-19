'use strict';
/* Plain names for actions, events and statuses, shared by the Activity log and the tray. */

const ACTION_LABELS = Object.freeze({
    'obs.scene': 'Switch scene', 'obs.preview': 'Set preview scene', 'obs.transition': 'Transition to program',
    'obs.source': 'Show or hide source', 'obs.mute': 'Mute or unmute', 'obs.volume': 'Set volume', 'obs.filter': 'Turn filter on or off',
    'obs.stream': 'Streaming', 'obs.record': 'Recording', 'obs.replay': 'Replay buffer', 'obs.virtualcam': 'Virtual camera',
    'obs.screenshot': 'Screenshot', 'obs.text': 'Set text', 'obs.browser_url': 'Set browser source URL', 'obs.browser_refresh': 'Refresh browser source',
    'obs.hotkey': 'OBS hotkey', 'sound.play': 'Play sound', 'sound.stop': 'Stop all sounds', 'studio.hotkey': 'Press keys', 'light.set': 'Set a light',
});

const EVENT_LABELS = Object.freeze({
    'obs.scene_changed': 'Scene changed', 'obs.stream_started': 'Stream started', 'obs.stream_stopped': 'Stream stopped',
    'obs.recording_started': 'Recording started', 'obs.recording_stopped': 'Recording stopped', 'obs.recording_paused': 'Recording paused',
    'obs.recording_resumed': 'Recording resumed', 'obs.replay_saved': 'Replay saved', 'obs.virtualcam_started': 'Virtual camera on',
    'obs.virtualcam_stopped': 'Virtual camera off',
});

const ENGINE_STATUS = Object.freeze({
    idle: 'Not connected', connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting',
    auth_failed: 'Not paired', revoked: 'Removed on the dashboard', replaced: 'Connected from another copy of the app', stopped: 'Not connected',
});

const OBS_STATUS = Object.freeze({
    off: 'Off', connecting: 'Connecting', connected: 'Connected', unreachable: 'Not reachable',
    auth_failed: 'Wrong password', too_old: 'OBS WebSocket is too old (needs version 5)',
});

/** One short line describing the main parameter of an action. */
function summarise(action, p = {}) {
    const pick = (...keys) => keys.map((k) => p[k]).filter((v) => v != null && v !== '').join(' · ');
    switch (action) {
        case 'obs.scene': case 'obs.preview': return pick('scene');
        case 'obs.source': return pick('source', 'visible');
        case 'obs.mute': return pick('input', 'state');
        case 'obs.volume': return p.input ? `${p.input} · ${p.volume}%` : '';
        case 'obs.filter': return pick('source', 'filter', 'state');
        case 'obs.stream': case 'obs.record': case 'obs.replay': case 'obs.virtualcam': return pick('state');
        case 'obs.text': return pick('source');
        case 'obs.browser_url': case 'obs.browser_refresh': case 'obs.screenshot': return pick('source');
        case 'obs.hotkey': return pick('name');
        case 'sound.play': return pick('sound');
        case 'studio.hotkey': return pick('keys');
        default: return '';
    }
}

module.exports = { ACTION_LABELS, EVENT_LABELS, ENGINE_STATUS, OBS_STATUS, summarise };
