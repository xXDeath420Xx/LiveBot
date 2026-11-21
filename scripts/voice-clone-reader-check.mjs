/*
 * Which voice the Discord channel reader would use in a server, for its own owner's message and for another member's
 * (core/voice-reader-manager.js rules, with the real reader config and the voice records). Read-only.
 *   node scripts/voice-clone-reader-check.mjs <guildId> [...]
 */
import 'dotenv/config';
import { getReaderConfig, ownVoiceUsable, introFor } from '../core/voice-reader-manager.js';
import { getVoiceInfo } from '../utils/piper-tts.js';

for (const gid of process.argv.slice(2)) {
    const config = await getReaderConfig(gid);
    const voice = config.voice;
    const ownerId = getVoiceInfo(voice)?.ownerId || null;
    const guild = { id: gid, ownerId: null, members: { cache: new Map(), fetch: async () => null } };
    const member = { author: { id: '100000000000000001' }, guild, member: { displayName: 'A member' } };
    const own = { author: { id: ownerId || '0' }, guild, member: { displayName: 'Owner' } };
    const memberOk = await ownVoiceUsable(member, voice);
    console.log(gid, JSON.stringify({ enabled: !!config.enabled, readerVoice: voice, voiceOwner: ownerId,
        memberMessageVoice: memberOk ? voice : 'falls back to the server default', ownerMessageVoice: (await ownVoiceUsable(own, voice)) ? voice : 'fallback',
        ownerIntro: ownerId ? await introFor(own, voice) : null }));
}
process.exit(0);
