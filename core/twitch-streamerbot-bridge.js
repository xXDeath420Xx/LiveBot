/**
 * Streamer.bot WebSocket bridge — pushes analytics events to broadcasters' Streamer.bot
 * instances so they can trigger OBS scenes, DMX lights, sound effects on hype trains,
 * big subs, raids, record-peak-viewer moments.
 *
 * Streamer.bot exposes a WebSocket server (default ws://127.0.0.1:8080) that accepts
 * events as JSON. Each broadcaster configures their Streamer.bot URL in the alert config
 * (`streamerbot_bridge_url`) and we POST this shape over an outbound WebSocket connection:
 *
 *   { "action": "ExecuteCode", "data": { "source": "CertiFried", "event": "hype_train.begin", ... } }
 *
 * Connections are opened lazily per-broadcaster and cached. If a WebSocket drops, we
 * reconnect on next event (fire-and-forget, non-blocking).
 */
import { WebSocket } from 'ws';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const LOG = '[StreamerBotBridge]';
const connections = new Map(); // broadcaster_id → { ws, url, lastActivity }

function connectIfNeeded(url, broadcasterId) {
    const existing = connections.get(broadcasterId);
    if (existing && existing.ws.readyState === WebSocket.OPEN) return existing;

    try {
        const ws = new WebSocket(url, { handshakeTimeout: 5000 });
        const entry = { ws, url, lastActivity: Date.now() };
        connections.set(broadcasterId, entry);
        ws.on('error', e => logger.warn(`${LOG} ws error for ${broadcasterId}: ${e.message}`));
        ws.on('close', () => {
            logger.info(`${LOG} ws closed for ${broadcasterId}`);
            if (connections.get(broadcasterId) === entry) connections.delete(broadcasterId);
        });
        return entry;
    } catch (e) {
        logger.warn(`${LOG} ws connect to ${url} failed: ${e.message}`);
        return null;
    }
}

/**
 * Push an analytics event to every broadcaster-opted-in Streamer.bot instance for this
 * broadcaster. Fire-and-forget — never blocks caller.
 */
export async function pushEvent(broadcasterId, eventName, payload) {
    try {
        const [cfgs] = await pool.execute(
            `SELECT streamerbot_bridge_url FROM twitch_analytics_alerts_config
              WHERE broadcaster_id = ? AND streamerbot_bridge_enabled = 1
                AND streamerbot_bridge_url IS NOT NULL`,
            [String(broadcasterId)]);
        if (!cfgs.length) return;
        for (const cfg of cfgs) {
            const entry = connectIfNeeded(cfg.streamerbot_bridge_url, broadcasterId);
            if (!entry) continue;
            const send = () => {
                try {
                    entry.ws.send(JSON.stringify({
                        source: 'CertiFried',
                        broadcaster_id: String(broadcasterId),
                        event: eventName,
                        at: new Date().toISOString(),
                        payload: payload || {},
                    }));
                    entry.lastActivity = Date.now();
                } catch (e) {
                    logger.warn(`${LOG} send failed for ${broadcasterId}: ${e.message}`);
                }
            };
            if (entry.ws.readyState === WebSocket.OPEN) send();
            else entry.ws.once('open', send);
        }
    } catch (e) {
        logger.warn(`${LOG} dispatch failed: ${e.message}`);
    }
}
