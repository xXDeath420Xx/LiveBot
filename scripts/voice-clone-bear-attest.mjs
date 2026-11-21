/*
 * One-off (2026-11-21), the owner's confirmations in chat for Bear's voice (core/voice-clone/legacy.js):
 *   1. Bear is 18+: owner attestation on his consent record (attested_by, attested_at).
 *   2. Region: UK resident, an invite-only exception to the US-only rule approved by the owner; basis: explicit written
 *      consent (UK GDPR Art. 9(2)(a)). Recorded in the consent's region_exception fields and the audit trail.
 *   3. "Read other people's messages in my voice": on, set by the owner on Bear's 2026-11-14 request; the channel reader
 *      servers that used Bear's voice before (1535014964883099738, 901599353389596712) added for this voice, so they read
 *      members in Bear's voice again. "I said" stays on.
 *   4. Retraining queues for the next eligible window.
 */
import 'dotenv/config';
import { getVoiceClone } from '../core/voice-clone/index.js';

const OWNER = String(process.env.BOT_OWNER_ID || '');
const GUILDS = ['1535014964883099738', '901599353389596712'];
const vc = await getVoiceClone();
const v = await vc.store.voiceByLegacy('bear');
if (!v) { console.error('no record for bear'); process.exit(2); }
const q = await vc.legacy.attestLegacy(OWNER, v.id, { age18: true, regionException: { region: 'UK (exception approved by owner)', basis: 'explicit written consent (UK GDPR Art. 9(2)(a))' } });
const c = await vc.store.consentById(v.consent_id);
console.log('attested', { age: !!c.age_attested, by: c.attested_by === OWNER ? 'owner' : c.attested_by, at: c.attested_at, region: c.region_exception, basis: c.region_exception_basis });
await vc.service.setOptIn({ userId: OWNER, role: 'admin' }, v.id, 'viewerText', true);
await vc.legacy.setReaderGuilds(OWNER, v.id, GUILDS);
const f = (await vc.store.voiceById(v.id)).features;
console.log('opt-ins', { viewerText: f.viewerText, iSaid: f.iSaid, readerGuilds: f.readerGuilds?.ids });
console.log('retraining:', q.queued ? `queued (job ${q.jobId})` : `held: ${q.waitingFor.join('; ')}`);
process.exit(0);
