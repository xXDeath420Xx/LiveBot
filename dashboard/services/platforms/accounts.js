// Encrypted CRUD for stream_platform_accounts. Inject db + encryption for testability.
import { query as queryDefault } from '../../../utils/db.js';

const enc = (encryption, s) => (s == null ? null : JSON.stringify(encryption.encrypt(s)));
const dec = (encryption, s) => (s == null ? null : encryption.decrypt(JSON.parse(s)));

export function makeAccountStore(db, encryption) {
  return {
    async saveAccount(a) {
      await db.query(
        `INSERT INTO stream_platform_accounts
           (owner_discord_id, platform, platform_user_id, platform_username, access_token, refresh_token, expires_at, scopes, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE
           platform_user_id=VALUES(platform_user_id), platform_username=VALUES(platform_username),
           access_token=VALUES(access_token), refresh_token=VALUES(refresh_token),
           expires_at=VALUES(expires_at), scopes=VALUES(scopes), status='active'`,
        [a.ownerDiscordId, a.platform, a.platformUserId, a.platformUsername,
         enc(encryption, a.accessToken), enc(encryption, a.refreshToken), a.expiresAt, a.scopes]
      );
    },
    async getAccount(ownerDiscordId, platform) {
      const rows = await db.query(
        'SELECT * FROM stream_platform_accounts WHERE owner_discord_id = ? AND platform = ? LIMIT 1',
        [ownerDiscordId, platform]
      );
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id, platform: r.platform, ownerDiscordId: r.owner_discord_id,
        platformUserId: r.platform_user_id, platformUsername: r.platform_username,
        accessToken: dec(encryption, r.access_token), refreshToken: dec(encryption, r.refresh_token),
        expiresAt: r.expires_at, scopes: r.scopes, status: r.status,
      };
    },
    async getAccountById(id) {
      if (!id) return null;
      const rows = await db.query('SELECT * FROM stream_platform_accounts WHERE id = ? LIMIT 1', [id]);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id, platform: r.platform, ownerDiscordId: r.owner_discord_id,
        platformUserId: r.platform_user_id, platformUsername: r.platform_username,
        accessToken: dec(encryption, r.access_token), refreshToken: dec(encryption, r.refresh_token),
        expiresAt: r.expires_at, scopes: r.scopes, status: r.status,
      };
    },
    async listAccounts(ownerDiscordId) {
      const rows = await db.query(
        'SELECT id, platform, platform_username, status, created_at FROM stream_platform_accounts WHERE owner_discord_id = ?',
        [ownerDiscordId]
      );
      return rows;
    },
    async deleteAccount(ownerDiscordId, platform) {
      await db.query('DELETE FROM stream_platform_accounts WHERE owner_discord_id = ? AND platform = ?',
        [ownerDiscordId, platform]);
    },
    async markStatus(id, status) {
      await db.query('UPDATE stream_platform_accounts SET status = ? WHERE id = ?', [status, id]);
    },
  };
}

// Default singleton wired to the real db + encryption.
// Lazy-loaded so tests can import this module without BOT_ENCRYPTION_KEY being set.
let _accountStore = null;
async function getDefaultEncryption() {
  const m = await import('../../../utils/encryption.js');
  return m.default;
}

export const accountStore = {
  async saveAccount(a) {
    if (!_accountStore) _accountStore = makeAccountStore({ query: queryDefault }, await getDefaultEncryption());
    return _accountStore.saveAccount(a);
  },
  async getAccount(ownerDiscordId, platform) {
    if (!_accountStore) _accountStore = makeAccountStore({ query: queryDefault }, await getDefaultEncryption());
    return _accountStore.getAccount(ownerDiscordId, platform);
  },
  async getAccountById(id) {
    if (!_accountStore) _accountStore = makeAccountStore({ query: queryDefault }, await getDefaultEncryption());
    return _accountStore.getAccountById(id);
  },
  async listAccounts(ownerDiscordId) {
    if (!_accountStore) _accountStore = makeAccountStore({ query: queryDefault }, await getDefaultEncryption());
    return _accountStore.listAccounts(ownerDiscordId);
  },
  async deleteAccount(ownerDiscordId, platform) {
    if (!_accountStore) _accountStore = makeAccountStore({ query: queryDefault }, await getDefaultEncryption());
    return _accountStore.deleteAccount(ownerDiscordId, platform);
  },
  async markStatus(id, status) {
    if (!_accountStore) _accountStore = makeAccountStore({ query: queryDefault }, await getDefaultEncryption());
    return _accountStore.markStatus(id, status);
  },
};
