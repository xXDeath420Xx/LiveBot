/*
 * Stream bot community features (Wave 2 group B; docs/superpowers/specs/2026-11-19-stream-bot-design.md §15; migration 475):
 * text to speech, quotes, chat games on points, the loyalty store and media share. Module map:
 *
 *   settings.js  the Community settings and the games' maths (pure)    speech.js  profanity mask, speakable text, voices
 *   store.js     quotes, store items, redemptions, media requests      quotes.js  !quote, !addquote, !delquote
 *   games.js     slots, duels, heists, the line-up, raffles            shop.js    !store, !redeem, refunds
 *   media.js     the CertiFried Media Share page: speech and muted video, media share requests through the VOD-safe
 *                song request queue
 *   register.js  the actions, the "item redeemed" trigger and its variables       seed.js  the chat commands (off)
 *   privacy.js   /privacy export and delete
 *
 *   attachCommunity(box) → { cstore, quotes, games, shop, media, ref }
 *     Called once from core/stream-bot/index.js build(), after viewers, music and overlays. Nothing is wrapped: the
 *     features only register with the engine's hooks and read box.viewers (points) and box.music (the VOD-safe audio path).
 */
import { createCommunityStore } from './store.js';
import { createQuotes } from './quotes.js';
import { createGames } from './games.js';
import { createShop } from './shop.js';
import { createMediaShare } from './media.js';
import { registerCommunity, setVoiceOptions } from './register.js';
import { ttsVoices, speechSynthesizer } from './speech.js';

export async function attachCommunity(box) {
    const { store, logger, pool } = box;
    const [actions, events, render, encryption] = await Promise.all([
        import('../actions.js'), import('../events.js'), import('../render.js'), import('../../../utils/encryption.js').then((m) => m.default),
    ]);
    const cstore = createCommunityStore({ db: pool, prefix: store.prefix || 'stream_bot_' });
    const viewersRef = { get current() { return box.viewers || null; } };
    const musicRef = { get current() { return box.music || null; } };
    const engineRef = { get current() { return box.engine || null; } };
    const quotes = createQuotes({ cstore, io: box.io });
    const games = createGames({ store, viewersRef, io: box.io, logger });
    const shop = createShop({ cstore, store, viewersRef, engineRef, ingest: box.ingest, logger });
    const media = createMediaShare({
        store, db: pool, cstore, musicRef, viewersRef, encryption, synthesize: speechSynthesizer(logger), logger,
        baseUrl: process.env.DASHBOARD_URL || 'https://certifriedmultitool.com',
    });
    const ref = { current: { quotes, games, shop, media } };
    const reg = registerCommunity({ ref, actions, events, render });
    // The voice picker of "Speak text on stream": the English voices on this server, without anyone's custom voice.
    ttsVoices(null).then((v) => setVoiceOptions(reg.tts, v)).catch(() => {});
    return { cstore, quotes, games, shop, media, ref };
}

export default { attachCommunity };
