/*
 * Stream bot, YouTube Live (H-741, design §13). Module map:
 *
 *   config.js     the switch (GOOGLE_OAUTH_CLIENT_ID / _SECRET present, STREAM_BOT_YOUTUBE not '0'), scopes, quota prices
 *   quota.js      the daily quota guard (normal, slow, critical, exhausted) and its table stream_bot_youtube_quota
 *   api.js        YouTube Data API v3 calls, including the streamList HTTP stream parser
 *   auth.js       the streamer's Google token from stream_platform_accounts, refreshed before use
 *   normalise.js  liveChatMessage and broadcasts → stream bot events (pure)
 *   service.js    live detection, the chat reader, send / delete / time out / ban, status
 *   register.js   the engine hooks: chat.send to YouTube, chat.delete, chat.timeout and chat.ban, go-live hints
 *   privacy.js    /privacy export and delete for the two tables
 *
 *   attachYouTube(box) → { service, quota, config, serviceRef, forget(ownerId) } | { config, service: null, forget } when off
 *
 * The actions register either way (they answer "YouTube is not set up on this server" when it is off), so an automation that
 * uses them still validates; the service, the quota guard and the scheduler exist only when the feature is on.
 */
import { youtubeBotConfig } from './config.js';
import { createQuotaGuard, quotaTable } from './quota.js';
import { createYouTubeApi } from './api.js';
import { createYouTubeAuth } from './auth.js';
import { createYouTubeService } from './service.js';
import { registerYouTubeActions, wireYouTube, youtubeServiceRef } from './register.js';

export async function attachYouTube(box, { env = process.env, fetchImpl = null } = {}) {
    const config = youtubeBotConfig(env);
    // The one reference the registered actions read, whoever registered them first (the importer does too).
    const serviceRef = youtubeServiceRef;
    serviceRef.current = null;
    const actionsMod = await import('../actions.js');
    registerYouTubeActions(actionsMod, serviceRef);
    wireYouTube(box, serviceRef);
    const { default: encryption } = await import('../../../utils/encryption.js');
    const { youtubeAccountDelete } = await import('./privacy.js');
    // "Unlink" on Connections: drop the YouTube sign-in (revoked at Google) unless a multicast destination still uses it.
    const forget = (ownerId) => youtubeAccountDelete(box.pool, ownerId, { onlyUnused: true, revoke: true, encryption });
    if (!config.enabled) {
        box.logger?.info?.(`[StreamBotYouTube] off (${config.reason}); Connections explains it`);
        return { config, service: null, quota: null, serviceRef, forget };
    }
    const quota = createQuotaGuard({ dailyUnits: config.dailyUnits, persist: quotaTable(box.pool, box.store.prefix), logger: box.logger });
    const f = fetchImpl || ((...a) => globalThis.fetch(...a));
    const api = createYouTubeApi({ fetchImpl: f, quota });
    const auth = createYouTubeAuth({ db: box.pool, encryption, clientId: config.clientId, clientSecret: config.clientSecret, fetchImpl: f, logger: box.logger });
    const service = createYouTubeService({ db: box.pool, store: box.store, ingest: box.ingest, api, auth, quota, logger: box.logger });
    serviceRef.current = service;
    return { config, service, quota, serviceRef, auth, forget };
}

export default { attachYouTube };
