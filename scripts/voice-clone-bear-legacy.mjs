/*
 * One-off (2026-11-21): put Bear's existing voice under the own-voice rules (core/voice-clone/legacy.js).
 *
 *   tar -cf - consent/*.jpg dataset/wavs/*.wav dataset/metadata.csv | node scripts/voice-clone-bear-legacy.mjs
 *
 * Reads the tar from stdin into memory (nothing is written to disk here in plain form) and, as the owner (BOT_OWNER_ID):
 *   1. creates the voice record for piper voice "bear" (invites Bear if needed), espeak en-gb-x-rp, slower / clean;
 *   2. stores Bear's written consent on file: his own DM words verbatim, the date, the channel, the screenshots (SHA-256);
 *   3. imports Bear's real script readings (never the Chatterbox synthetic clips) as encrypted recordings;
 *   4. sets "I said" on, as Bear asked on 2026-11-14 (recorded as set by the owner on his request);
 *   5. asks to queue retraining, which stays held until the owner attests 18+ and US residence for Bear.
 * Safe to re-run: steps already done are skipped.
 */
import 'dotenv/config';
import { getVoiceClone } from '../core/voice-clone/index.js';

const BEAR = '685127470625980501';
const OWNER = String(process.env.BOT_OWNER_ID || '');
if (!/^\d{15,20}$/.test(OWNER)) { console.error('BOT_OWNER_ID missing'); process.exit(2); }

const CONSENT_TEXT = [
    '[2026-10-13 03:51, Bear, Discord DM to the owner] Remind me; what\'s the default TTS voice for the channel reader?',
    'lulul, someone wants me to train a Piper TTS voice model with my voice and whack it into CFM.',
    'I\'m not sure how I feel about this',
    '[2026-10-13 03:58, Bear] I\'ll train the models and send \'em',
    '[2026-10-13 04:00, Bear] "Texty McSpeechy" https://github.com/domesticatedviking/TextyMcSpeechy',
    '[2026-11-14 08:17, Bear] Oddly-specific feature request that would almost entirely for me.',
    'CFM; TTS channel reader.',
    'If the bot\'s configured to use specifically my voice, and it\'s reading a message I sent, can we get it to just say "I said", instead of "[user] says"? >:]',
].join('\n');
const NOTE = 'Recorded by the owner on 2026-11-21 from three Discord DM screenshots (SHA-256 in evidence); times as shown on the owner\'s phone. '
    + 'The words show Bear agreed to a Piper voice of himself in CFM and asked for the "I said" reader feature; CertiFried trained the live voice from his readings of a script it gave him. '
    + 'They do not state his age or where he lives: 18+ and US residence must be attested by the owner on Bear\'s behalf before retraining (training is held until then). '
    + 'Deletion and withdrawal rights apply as for any voice.';

function untar(buf) {
    const out = new Map();
    let off = 0;
    while (off + 512 <= buf.length) {
        const h = buf.subarray(off, off + 512);
        if (h.every((b) => b === 0)) break;
        const name = h.toString('ascii', 0, 100).replace(/\0.*$/s, '');
        const prefix = h.toString('ascii', 345, 500).replace(/\0.*$/s, '');
        const size = parseInt(h.toString('ascii', 124, 136).replace(/\0.*$/s, '').trim() || '0', 8);
        const type = String.fromCharCode(h[156] || 48);
        const full = (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, '');
        if (type === '0' || type === '\0') out.set(full, buf.subarray(off + 512, off + 512 + size));
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const entries = untar(Buffer.concat(chunks));
const vc = await getVoiceClone();
if (!vc) { console.error('voice-clone tables missing'); process.exit(2); }
const { legacy, store, service } = vc;

let v = await store.voiceByLegacy('bear');
if (!v) {
    const r = await legacy.createLegacyVoice(OWNER, { userId: BEAR, legacyVoiceId: 'bear', displayName: 'Bear', espeakVoice: 'en-gb-x-rp', tuning: { speed: 'slower', clarity: 'clean' } });
    v = await store.voiceById(r.voiceId);
    console.log('voice record created', v.id);
} else console.log('voice record exists', v.id, v.status);

const c = await store.consentById(v.consent_id);
if (!c.verified_at) {
    const evidence = [...entries].filter(([k]) => k.startsWith('consent/')).map(([k, buf]) => ({ name: k.slice(8), buf }));
    const r = await legacy.recordWrittenConsent(OWNER, v.id, { text: CONSENT_TEXT, givenAt: '2026-10-13 03:51 to 2026-11-14 08:17 (as shown on the owner\'s phone)', channel: 'Discord DM to the owner', evidence, note: NOTE });
    console.log('written consent stored; evidence', r.evidence.map((e) => `${e.original} ${e.sha256}`).join(', '));
} else console.log('written consent already stored');

const sum = await store.sampleSummary(v.id);
if (sum.count === 0) {
    const meta = (entries.get('dataset/metadata.csv') || Buffer.alloc(0)).toString('utf8').split('\n').filter(Boolean);
    const items = [];
    for (const line of meta) {
        const [id, text] = line.split('|');
        const wav = entries.get(`dataset/wavs/${id}.wav`);
        if (wav && text) items.push({ name: `${id}.wav`, wav, text });
    }
    const r = await legacy.importLegacySamples(OWNER, v.id, items);
    console.log(`recordings imported: ${r.kept} kept (${r.minutes} min) of ${items.length}; rejected ${r.rejected.length}`, JSON.stringify(r.rejected.slice(0, 10)));
} else console.log('recordings already imported', sum.count);

if (!v.features?.iSaid) {
    await service.setOptIn({ userId: OWNER, role: 'admin' }, v.id, 'iSaid', true);
    console.log('"I said" on (set by the owner on Bear\'s 2026-11-14 request); other people\'s messages: off');
}
const q = await legacy.queueLegacyTraining(OWNER, v.id);
console.log('retraining:', q.queued ? `queued (job ${q.jobId})` : `held, waiting for: ${q.waitingFor.join('; ')}`);
process.exit(0);
