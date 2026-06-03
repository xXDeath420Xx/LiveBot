import { query as queryDefault } from '../../../utils/db.js';
import { accountStore as defaultStore } from './accounts.js';
import { getAdapter as defaultGetAdapter } from './registry.js';
import loggerDefault from '../../../utils/logger.js';

// ctx allows dependency injection for tests; defaults wire the real services.
export async function resolveDestinations(ctx, streamKey) {
  const db = ctx.db || { query: queryDefault };
  const accountStore = ctx.accountStore || defaultStore;
  const getAdapter = ctx.getAdapter || defaultGetAdapter;
  const logger = ctx.logger || loggerDefault;

  const keyRows = await db.query('SELECT id FROM stream_keys WHERE stream_key = ? AND enabled = 1 LIMIT 1', [streamKey]);
  if (!keyRows[0]) return [];
  const destinations = await db.query(
    'SELECT * FROM stream_destinations WHERE stream_key_id = ? AND enabled = 1 ORDER BY priority ASC',
    [keyRows[0].id]
  );

  const out = [];
  for (const d of destinations) {
    if (d.resolution !== 'dynamic') {
      out.push({ name: d.name, platform: d.platform, rtmp_url: d.rtmp_url, dest_stream_key: d.dest_stream_key || '' });
      continue;
    }
    try {
      const account = await accountStore.getAccountById(d.account_id);
      if (!account) throw new Error('no linked account');
      const cfg = d.config_json ? (typeof d.config_json === 'string' ? JSON.parse(d.config_json) : d.config_json) : {};
      const r = await getAdapter(d.platform).resolveAtGoLive(account, cfg);
      out.push({ name: d.name, platform: d.platform, rtmp_url: r.rtmp_url, dest_stream_key: r.key || '' });
    } catch (err) {
      logger.error(`[resolver] dynamic resolve failed for ${d.platform} (${d.name}): ${err.message}`);
      // isolation: skip this destination, keep the rest
    }
  }
  return out;
}
