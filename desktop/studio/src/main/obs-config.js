'use strict';
/*
 * "Use my OBS settings": read obs-websocket's own settings so the person does not have to copy the port and password.
 * Only ever read when the person clicks the button; the file's existence alone may be checked to offer the button.
 *
 *   obsConfigPath(env)         %APPDATA%\obs-studio\plugin_config\obs-websocket\config.json
 *                              (CF_STUDIO_OBS_CONFIG points elsewhere, for tests and unusual installs)
 *   obsConfigExists(file)
 *   readObsConfig(file)        → { enabled, port, authRequired, password }   (obs-websocket 5 keys: server_enabled,
 *                              server_port, auth_required, server_password)
 *                              errors (err.code): not_found, unreadable, bad_format
 *
 * The password is returned to the caller only, which stores it with the secrets scheme. Never logged or shown.
 */
const fs = require('node:fs');
const path = require('node:path');

function obsConfigPath(env = process.env) {
    if (env.CF_STUDIO_OBS_CONFIG) return path.resolve(env.CF_STUDIO_OBS_CONFIG);
    return path.join(env.APPDATA || '', 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json');
}

function obsConfigExists(file = obsConfigPath()) {
    try { return fs.statSync(file).isFile(); } catch { return false; }
}

function fail(code, message) { const e = new Error(message); e.code = code; return e; }

function readObsConfig(file = obsConfigPath()) {
    let text;
    try {
        if (fs.statSync(file).size > 64 * 1024) throw fail('bad_format', 'The OBS WebSocket settings file is not in the expected format.');
        text = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e.code === 'bad_format') throw e;
        if (e.code === 'ENOENT') throw fail('not_found', 'OBS WebSocket settings were not found on this PC. Is OBS 28 or newer installed, and has it been opened once?');
        throw fail('unreadable', 'The OBS WebSocket settings could not be read.');
    }
    let j;
    try { j = JSON.parse(text.replace(/^﻿/, '')); } catch { throw fail('bad_format', 'The OBS WebSocket settings file is not in the expected format.'); }
    if (!j || typeof j !== 'object' || typeof j.server_enabled !== 'boolean') throw fail('bad_format', 'The OBS WebSocket settings file is not in the expected format.');
    const port = Number(j.server_port ?? 4455);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('bad_format', 'The port in the OBS WebSocket settings is not valid.');
    const authRequired = j.auth_required !== false;
    const password = typeof j.server_password === 'string' ? j.server_password : '';
    if (authRequired && !password) throw fail('bad_format', 'OBS asks for a password but none is saved in its settings. Set one in OBS under Tools, WebSocket Server Settings.');
    return { enabled: j.server_enabled, port, authRequired, password: authRequired ? password : '' };
}

module.exports = { obsConfigPath, obsConfigExists, readObsConfig };
