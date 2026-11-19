// Subscribe Kick channels to the webhook events the bot uses, including chat.message.sent.
// Uses the CertiFried Kick app's own token (client credentials): Kick allows an app token to
// subscribe any channel by broadcaster_user_id (docs.kick.com/events/subscribe-to-events).
// Needs "Enable Webhooks" on the app with URL https://certifriedmultitool.com/kick/webhooks.
// Skips events a channel already has. The event list is the bot's own (KICK_EVENT_TYPES in
// services/certifried-bot/kick-event-subscriptions.js).
// Usage: node scripts/kick-subscribe-events.mjs <id> [...more ids]
//        node scripts/kick-subscribe-events.mjs --all     every channel that already has a subscription (reconcile
//                                                         after an event is added to KICK_EVENT_TYPES)
import '../utils/db.js';
import { getAccessToken } from '../utils/platforms/kick.js';
import { KICK_EVENT_TYPES } from '../services/certifried-bot/kick-event-subscriptions.js';

const EVENTS = KICK_EVENT_TYPES;
const API = 'https://api.kick.com/public/v1/events/subscriptions';
const say = (m) => process.stdout.write(m + '\n');

const all = process.argv.includes('--all');
let ids = process.argv.slice(2).filter((a) => a !== '--all');
if (!ids.length && !all) { say('usage: node scripts/kick-subscribe-events.mjs <id> [...] | --all'); process.exit(1); }
const token = await getAccessToken();
if (!token) { say('FAILED no Kick app token (KICK_CLIENT_ID / KICK_CLIENT_SECRET)'); process.exit(1); }
const auth = { Authorization: `Bearer ${token}` };

const listRes = await fetch(API, { headers: auth, signal: AbortSignal.timeout(20000) });
const list = await listRes.json().catch(() => ({}));
if (!listRes.ok) { say(`FAILED listing subscriptions: ${listRes.status} ${JSON.stringify(list).slice(0, 200)}`); process.exit(1); }
const have = new Map(); // broadcaster -> Set(event)
for (const s of list.data || []) {
    const b = String(s.broadcaster_user_id);
    if (!have.has(b)) have.set(b, new Set());
    have.get(b).add(s.event);
}
if (all) ids = [...new Set([...ids, ...have.keys()])];

for (const id of ids) {
    const missing = EVENTS.filter(e => !have.get(String(id))?.has(e.name));
    if (!missing.length) { say(`OK ${id}: already subscribed to all ${EVENTS.length}`); continue; }
    try {
        const r = await fetch(API, {
            method: 'POST', signal: AbortSignal.timeout(20000),
            headers: { ...auth, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ broadcaster_user_id: parseInt(id, 10), events: missing, method: 'webhook' }),
        });
        const j = await r.json().catch(() => ({}));
        const results = Array.isArray(j.data) ? j.data.map(x => `${x.name}:${x.error ? 'ERR ' + x.error : 'ok'}`).join(' ') : '';
        say(`${r.ok ? 'SUBSCRIBED' : 'FAILED'} ${id} status ${r.status} ${results || JSON.stringify(j).slice(0, 200)}`);
    } catch (e) {
        say(`FAILED ${id}: ${e.name} ${e.message}`);
    }
}
process.exit(0);
