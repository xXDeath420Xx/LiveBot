/*
 * Throwaway stream bot tables for tests: the real DDL (migrations/454_stream_bot.js streamBotDdl) under a random
 * prefix, a store on them, and a reversible fake encryption. Every test file drops its tables in test.after.
 */
import crypto from 'node:crypto';
import { streamBotDdl, STREAM_BOT_TABLES } from '../../migrations/454_stream_bot.js';
import { createStore } from '../../core/stream-bot/store.js';

export const fakeEncryption = {
    encrypt: (s) => ({ v: Buffer.from(String(s), 'utf8').toString('base64'), t: 'test' }),
    decrypt: (o) => Buffer.from(o.v, 'base64').toString('utf8'),
};

export async function makeTables(pool, tag = 'x') {
    const prefix = `sbt${tag}${crypto.randomBytes(3).toString('hex')}_`;
    for (const sql of streamBotDdl(prefix)) await pool.query(sql);
    const store = createStore({ db: pool, prefix, encryption: fakeEncryption });
    return {
        prefix, store,
        async drop() {
            for (const t of [...STREAM_BOT_TABLES].reverse()) await pool.query(`DROP TABLE IF EXISTS \`${prefix}${t}\``);
        },
    };
}

/** A profile with a Twitch and a Kick channel linked. */
export async function makeProfile(store, owner = `sbtest-${crypto.randomBytes(3).toString('hex')}`) {
    const profile = await store.ensureProfile(owner, 'Maple Hollow');
    await store.linkChannel(profile.id, { platform: 'twitch', platformUserId: '900000001', login: 'maplehollow_tv', displayName: 'MapleHollow_TV', verifiedVia: 'stream_bot_grant' });
    await store.linkChannel(profile.id, { platform: 'kick', platformUserId: '800000001', login: 'maplehollow', displayName: 'maplehollow', verifiedVia: 'stream_platform_accounts' });
    return store.getProfile(profile.id);
}
