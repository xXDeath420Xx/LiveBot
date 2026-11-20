/*
 * Entry point (bundled to com.certifried.studio.sdPlugin/bin/plugin.js): wires the Stream Deck SDK to the controller.
 *
 * One SingletonAction per action UUID forwards willAppear, willDisappear, keyDown, didReceiveSettings and sendToPlugin
 * to src/controller.js. Global settings ({ port, token }) are read once at start and again whenever the property
 * inspector changes them (SDK 3: onDidReceiveGlobalSettings fires only for property inspector changes).
 * Network: only ws://127.0.0.1:<port> (src/studio-client.js). No telemetry. The token is never logged.
 */
import streamDeck, { SingletonAction } from '@elgato/streamdeck';
import { createStudioClient } from './studio-client.js';
import { createController, ACTIONS, PREFIX } from './controller.js';

const VERSION = '0.2.6';
const logger = streamDeck.logger.createScope('CertiFried');
const log = (level, msg) => { try { logger[level]?.(msg); } catch { /* ignore */ } };

const client = createStudioClient({ log, pluginVersion: VERSION });
const controller = createController({
    client,
    log,
    ui: { sendToPropertyInspector: (payload) => streamDeck.ui.sendToPropertyInspector(payload) },
});
client.on('status', (status) => log('info', `Studio connection: ${status}`));

/** The parts of an SDK action the controller uses (keys only; dials and Neo infobars are not offered). */
function wrap(action) {
    const isKey = typeof action.isKey === 'function' ? action.isKey() : true;
    return {
        id: action.id,
        manifestId: action.manifestId,
        setState: (s) => (isKey ? action.setState(s) : Promise.resolve()),
        setTitle: (t) => (isKey ? action.setTitle(t) : Promise.resolve()),
        showAlert: () => action.showAlert(),
        showOk: () => (isKey ? action.showOk() : Promise.resolve()),
    };
}

class CertiFriedAction extends SingletonAction {
    constructor(uuid) {
        super();
        this.manifestId = uuid;
    }

    onWillAppear(ev) { controller.appear(wrap(ev.action), ev.payload.settings); }

    onWillDisappear(ev) { controller.disappear(ev.action.id); }

    onDidReceiveSettings(ev) { controller.settingsChanged(wrap(ev.action), ev.payload.settings); }

    async onKeyDown(ev) { await controller.keyDown(wrap(ev.action), ev.payload.settings); }

    async onSendToPlugin(ev) { await controller.fromPropertyInspector(wrap(ev.action), ev.payload); }
}

for (const name of ACTIONS) streamDeck.actions.registerAction(new CertiFriedAction(`${PREFIX}${name}`));

streamDeck.settings.onDidReceiveGlobalSettings((ev) => controller.globalSettings(ev.settings));

await streamDeck.connect();
try {
    controller.globalSettings(await streamDeck.settings.getGlobalSettings());
} catch (e) {
    log('warn', `could not read global settings: ${e?.message}`);
}
