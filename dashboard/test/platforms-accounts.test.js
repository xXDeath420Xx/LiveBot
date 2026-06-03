import { test } from 'node:test';
import assert from 'node:assert';
import { makeAccountStore } from '../services/platforms/accounts.js';

// Fake encryption: reversible, deterministic, JSON-shaped like the real one.
const fakeEnc = {
  encrypt: (s) => ({ iv: 'x', encryptedData: Buffer.from(s).toString('base64'), authTag: 't' }),
  decrypt: (o) => Buffer.from(o.encryptedData, 'base64').toString('utf8'),
};

function fakeDb() {
  const rows = [];
  return {
    rows,
    query: async (sql, params) => {
      if (/^INSERT INTO stream_platform_accounts/i.test(sql)) {
        rows.push({ id: rows.length + 1, owner_discord_id: params[0], platform: params[1],
          platform_user_id: params[2], platform_username: params[3],
          access_token: params[4], refresh_token: params[5], expires_at: params[6], scopes: params[7] });
        return { insertId: rows.length };
      }
      if (/^SELECT \* FROM stream_platform_accounts/i.test(sql)) {
        return rows.filter(r => r.owner_discord_id === params[0] && (params[1] ? r.platform === params[1] : true));
      }
      return {};
    },
  };
}

test('saveAccount encrypts tokens before storing', async () => {
  const db = fakeDb();
  const store = makeAccountStore(db, fakeEnc);
  await store.saveAccount({ ownerDiscordId: '1', platform: 'twitch', platformUserId: 'tw1',
    platformUsername: 'bob', accessToken: 'AT', refreshToken: 'RT', expiresAt: null, scopes: 'a b' });
  const raw = db.rows[0].access_token;
  assert.ok(!raw.includes('AT'), 'token must not be stored in plaintext');
  assert.ok(JSON.parse(raw).encryptedData, 'stored as JSON of encrypted object');
});

test('getAccount returns decrypted tokens', async () => {
  const db = fakeDb();
  const store = makeAccountStore(db, fakeEnc);
  await store.saveAccount({ ownerDiscordId: '1', platform: 'twitch', platformUserId: 'tw1',
    platformUsername: 'bob', accessToken: 'AT', refreshToken: 'RT', expiresAt: null, scopes: '' });
  const acct = await store.getAccount('1', 'twitch');
  assert.strictEqual(acct.accessToken, 'AT');
  assert.strictEqual(acct.refreshToken, 'RT');
  assert.strictEqual(acct.platform, 'twitch');
});

test('getAccount returns null when absent', async () => {
  const store = makeAccountStore(fakeDb(), fakeEnc);
  assert.strictEqual(await store.getAccount('nope', 'twitch'), null);
});
