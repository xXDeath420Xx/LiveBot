// REST-only transfer of guild 1469931133981687873 from default CertiFried Utility to Kitsune (1498486251576229958).
// Re-posts all reaction-role panels under Kitsune's authorship, updates DB message_ids, deletes the old
// (default-bot-authored) messages, positions Kitsune's bot role for management, then kicks the default bot.
import 'dotenv/config';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD = '1469931133981687873';
const KITSUNE_ID = '1498486251576229958';
const DEFAULT_BOT_ID = '1409904443125665875';

const log = (...a) => console.log('[transfer]', ...a);

async function getKitsuneToken() {
  const [rows] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [KITSUNE_ID]);
  if (!rows.length) throw new Error('Kitsune row missing');
  return encryption.decrypt(JSON.parse(rows[0].bot_token));
}

const BASE = 'https://discord.com/api/v10';
function makeFetcher(token) {
  return async (method, path, body) => {
    const init = { method, headers: { 'Authorization': 'Bot ' + token } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const r = await fetch(BASE + path, init);
    if (r.status === 204) return null;
    if (!r.ok) {
      const txt = await r.text();
      throw new Error(`${method} ${path} → ${r.status} ${txt}`);
    }
    return r.json();
  };
}

async function positionKitsuneRole(asKitsune, asDefault) {
  // Find Kitsune's bot-managed role (the auto-created managed role for the bot user)
  const roles = await asDefault('GET', `/guilds/${GUILD}/roles`);
  const kitsuneBotRole = roles.find(r => r.tags?.bot_id === KITSUNE_ID);
  if (!kitsuneBotRole) {
    log('WARN: no managed Kitsune role found — Discord may not have surfaced it yet');
    return null;
  }
  // Target: just below the highest non-managed role under @everyone's tier — pos 29 like default CertiFried
  // Actually, position it as high as we can. Find the highest position the default bot has ever held.
  const defaultBotRole = roles.find(r => r.tags?.bot_id === DEFAULT_BOT_ID);
  const targetPos = defaultBotRole?.position ?? 29;
  if (kitsuneBotRole.position >= targetPos) {
    log(`Kitsune role already at position ${kitsuneBotRole.position} (≥ target ${targetPos})`);
    return kitsuneBotRole.id;
  }
  log(`moving Kitsune role from pos ${kitsuneBotRole.position} → ${targetPos}`);
  // PATCH guild roles list — Discord requires the full ordered list
  const newOrder = roles
    .filter(r => r.id !== '@everyone' && r.id !== GUILD)
    .map(r => ({ id: r.id, position: r.id === kitsuneBotRole.id ? targetPos : r.position }));
  await asDefault('PATCH', `/guilds/${GUILD}/roles`, newOrder);
  log(`Kitsune role positioned`);
  return kitsuneBotRole.id;
}

async function transferPanels(asKitsune, asDefault) {
  const [panels] = await pool.execute(
    'SELECT id, channel_id, message_id, panel_name FROM reaction_role_panels WHERE guild_id = ?',
    [GUILD]
  );
  log(`found ${panels.length} reaction-role panels to transfer`);

  for (const p of panels) {
    log(`--- ${p.panel_name} (panel #${p.id}, msg ${p.message_id}) ---`);
    let original;
    try {
      original = await asDefault('GET', `/channels/${p.channel_id}/messages/${p.message_id}`);
    } catch (e) {
      log(`  could not fetch original message (${e.message}) — skipping (panel may already be transferred)`);
      continue;
    }
    if (original.author?.id === KITSUNE_ID) {
      log(`  already authored by Kitsune — skipping`);
      continue;
    }

    // Re-post under Kitsune with same embed + components
    const body = {
      embeds: original.embeds || [],
      components: original.components || [],
    };
    const newMsg = await asKitsune('POST', `/channels/${p.channel_id}/messages`, body);
    log(`  posted under Kitsune → new msg ${newMsg.id}`);

    // Update DB
    await pool.execute('UPDATE reaction_role_panels SET message_id = ? WHERE id = ?', [newMsg.id, p.id]);

    // Delete old message
    try {
      await asDefault('DELETE', `/channels/${p.channel_id}/messages/${p.message_id}`);
      log(`  deleted old default-bot message ${p.message_id}`);
    } catch (e) {
      log(`  could not delete old message: ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 600));
  }
}

async function kickDefaultBot(asKitsune) {
  log(`removing default CertiFried Utility (${DEFAULT_BOT_ID}) from guild...`);
  try {
    await asKitsune('DELETE', `/guilds/${GUILD}/members/${DEFAULT_BOT_ID}`);
    log(`  ✓ default bot removed`);
  } catch (e) {
    log(`  ✗ could not kick default bot: ${e.message}`);
  }
}

async function postTransferAudit(asKitsune) {
  const [panels] = await pool.execute(
    'SELECT id, panel_name, channel_id, message_id FROM reaction_role_panels WHERE guild_id = ?',
    [GUILD]
  );
  console.log('\n=== POST-TRANSFER PANEL AUDIT ===');
  for (const p of panels) {
    try {
      const msg = await asKitsune('GET', `/channels/${p.channel_id}/messages/${p.message_id}`);
      const ok = msg.author?.id === KITSUNE_ID;
      console.log(`  ${ok ? '✓' : '✗'} ${p.panel_name.padEnd(22)} msg ${p.message_id} author=${msg.author?.username}`);
    } catch (e) {
      console.log(`  ✗ ${p.panel_name.padEnd(22)} msg ${p.message_id} fetch failed: ${e.message}`);
    }
  }

  const integrations = await asKitsune('GET', `/guilds/${GUILD}/integrations`);
  console.log('\n=== INTEGRATIONS ===');
  for (const i of integrations) {
    console.log(`  ${i.type.padEnd(10)} ${(i.name || i.application?.name || '?').padEnd(28)}`);
  }
}

(async () => {
  if (!process.env.DISCORD_TOKEN) throw new Error('DISCORD_TOKEN missing');
  const kitsuneToken = await getKitsuneToken();
  const asKitsune = makeFetcher(kitsuneToken);
  const asDefault = makeFetcher(process.env.DISCORD_TOKEN);

  log(`transfer: guild ${GUILD}, default ${DEFAULT_BOT_ID} → Kitsune ${KITSUNE_ID}`);

  await positionKitsuneRole(asKitsune, asDefault);
  await transferPanels(asKitsune, asDefault);
  await kickDefaultBot(asKitsune);
  await postTransferAudit(asKitsune);

  await pool.end();
  log('done.');
})().catch(async e => {
  console.error('FAIL', e.stack || e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
