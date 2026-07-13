// Builds the remaining self-role panels + rules verify for the Forsaken Warriors.
// Run after setup-forsaken-warriors-features.js. Idempotent.
import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { Routes, ButtonStyle } from 'discord-api-types/v10';
import pool from '../utils/db.js';

const GUILD_ID = '1469931133981687873';
const TOKEN = process.env.DISCORD_TOKEN;
const rest = new REST({ version: '10' }).setToken(TOKEN);

const CH = {
  rules:    '1469931510088859730',  // #📒𝒞𝑜𝒹𝑒-𝒪𝒻-𝒞𝑜𝓃𝒹𝓊𝒸𝓉  (rules acceptance)
  selfRole: '1470817784471621868',  // #𝒮𝑒𝓁𝒻-𝑅𝑜𝓁𝑒  (gaming + 18+ panels go here)
  songs18:  '1471936549460639967',  // #𝟣𝟪-𝑜𝓋𝑒𝓇-𝓈𝑜𝓃𝑔𝓈  (gated by 18+ role)
};

const log = (...a) => console.log('[panels]', ...a);

async function ensureRole(name, color, opts = {}) {
  const roles = await rest.get(Routes.guildRoles(GUILD_ID));
  const existing = roles.find(r => r.name === name);
  if (existing) {
    if ((opts.mentionable && !existing.mentionable) || (opts.hoist && !existing.hoist)) {
      await rest.patch(Routes.guildRole(GUILD_ID, existing.id), {
        body: { mentionable: opts.mentionable ?? existing.mentionable, hoist: opts.hoist ?? existing.hoist }
      });
    }
    log(`role "${name}" exists → ${existing.id}`);
    return existing.id;
  }
  const created = await rest.post(Routes.guildRoles(GUILD_ID), {
    body: {
      name, color,
      mentionable: opts.mentionable ?? false,
      hoist: opts.hoist ?? false,
      permissions: '0'
    }
  });
  log(`role "${name}" created → ${created.id}`);
  return created.id;
}

async function postOrEditPanel(panelName, channelId, embed, components) {
  const [existing] = await pool.execute(
    'SELECT * FROM reaction_role_panels WHERE guild_id = ? AND panel_name = ? LIMIT 1',
    [GUILD_ID, panelName]
  );

  let messageId, panelId;
  if (existing.length) {
    panelId = existing[0].id;
    try {
      await rest.patch(Routes.channelMessage(existing[0].channel_id, existing[0].message_id), {
        body: { embeds: [embed], components }
      });
      messageId = existing[0].message_id;
      log(`panel "${panelName}" updated in place → message ${messageId}`);
    } catch {
      const sent = await rest.post(Routes.channelMessages(channelId), { body: { embeds: [embed], components } });
      messageId = sent.id;
      await pool.execute('UPDATE reaction_role_panels SET message_id = ?, channel_id = ? WHERE id = ?', [messageId, channelId, panelId]);
      log(`panel "${panelName}" reposted (old message lost) → ${messageId}`);
    }
    await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [panelId]);
  } else {
    const sent = await rest.post(Routes.channelMessages(channelId), { body: { embeds: [embed], components } });
    messageId = sent.id;
    const [ins] = await pool.execute(
      `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, panel_mode, interaction_type, max_selections, placeholder_text)
       VALUES (?, ?, ?, ?, ?, ?, 'standard', 'button', 10, ?)`,
      [GUILD_ID, channelId, messageId, panelName, embed.description || '', embed.color ? '#' + embed.color.toString(16).padStart(6, '0') : '#5865F2', 'Choose your roles']
    );
    panelId = ins.insertId;
    log(`panel "${panelName}" posted → message ${messageId}, panel ${panelId}`);
  }
  return { panelId, messageId };
}

async function wireMappings(panelId, mappings) {
  for (const m of mappings) {
    await pool.execute(
      'INSERT INTO reaction_role_mappings (panel_id, emoji_id, label, button_style, role_id) VALUES (?, ?, ?, ?, ?)',
      [panelId, m.emoji, m.label, m.style, m.roleId]
    );
  }
}

async function buildRulesVerify() {
  const verifiedId = await ensureRole('Verified', 0x57F287, { hoist: false, mentionable: false });

  const embed = {
    title: '✅ Read the rules? Hit the button.',
    description:
      'Clicking below confirms you\'ve read the **Code of Conduct** above. You\'ll be tagged with the **Verified** badge so the team knows you\'re on board.\n\n' +
      '*This doesn\'t lock you out of anything today — it\'s a record. Anti-raid measures may be tightened later, and Verified is what unlocks them in advance.*',
    color: 0x57F287
  };

  const components = [{
    type: 1,
    components: [{
      type: 2,
      style: ButtonStyle.Success,
      label: 'I\'ve read the rules',
      emoji: { name: '✅' },
      custom_id: 'rr_' + verifiedId
    }]
  }];

  const { panelId } = await postOrEditPanel('Rules Verify', CH.rules, embed, components);
  await wireMappings(panelId, [{ emoji: '✅', label: 'Verified', style: 'success', roleId: verifiedId }]);
  return verifiedId;
}

async function buildAgeGate() {
  const adultId = await ensureRole('18+', 0xFF6B6B, { hoist: false, mentionable: false });

  const embed = {
    title: '🔞 18+ Access',
    description:
      'Toggle this on to unlock <#' + CH.songs18 + '> and any future adult-content channels.\n\n' +
      '**By opting in you confirm you are 18 years or older.** False claims are a moderation matter under the server\'s code of conduct.\n\n' +
      'Click again to remove the role.',
    color: 0xFF6B6B
  };

  const components = [{
    type: 1,
    components: [{
      type: 2,
      style: ButtonStyle.Danger,
      label: 'I am 18+',
      emoji: { name: '🔞' },
      custom_id: 'rr_' + adultId
    }]
  }];

  const { panelId } = await postOrEditPanel('18+ Age Gate', CH.selfRole, embed, components);
  await wireMappings(panelId, [{ emoji: '🔞', label: '18+', style: 'danger', roleId: adultId }]);

  // Gate the songs channel: deny @everyone view, allow 18+ view.
  // Only modify if not already gated to keep this idempotent.
  try {
    const channel = await rest.get(Routes.channel(CH.songs18));
    const existingEveryoneOw = (channel.permission_overwrites || []).find(o => o.id === GUILD_ID);
    const denyBits = BigInt(existingEveryoneOw?.deny ?? '0');
    const VIEW_CHANNEL_BIT = 1n << 10n;
    const alreadyGated = (denyBits & VIEW_CHANNEL_BIT) === VIEW_CHANNEL_BIT;
    if (!alreadyGated) {
      await rest.put(Routes.channelPermission(CH.songs18, GUILD_ID), {
        body: { type: 0, deny: String(VIEW_CHANNEL_BIT) }
      });
      log(`#18-over-songs: denied @everyone ViewChannel`);
    } else {
      log(`#18-over-songs: @everyone ViewChannel already denied`);
    }
    await rest.put(Routes.channelPermission(CH.songs18, adultId), {
      body: { type: 0, allow: String(VIEW_CHANNEL_BIT) }
    });
    log(`#18-over-songs: allowed 18+ role ViewChannel`);
  } catch (e) {
    log(`could not gate #18-over-songs: ${e.message}`);
  }

  return adultId;
}

async function buildGamingPrefs() {
  const cod    = await ensureRole('COD',          0xC72C41, { mentionable: true });
  const role   = await ensureRole('ROLE-Gaming',  0x8B4513, { mentionable: true });
  const fort   = await ensureRole('Fortnite',     0x9B59B6, { mentionable: true });
  const arc    = await ensureRole('ARC Raiders',  0x3498DB, { mentionable: true });

  const embed = {
    title: '🎮 Gaming Preferences',
    description:
      'Pick the games you play. These are mention-only roles — they don\'t hide channels, but anyone can `@COD` or `@Fortnite` to find a squad.\n\n' +
      '🔫 COD\n🏯 ROLE-Gaming\n🌀 Fortnite\n🏗️ ARC Raiders',
    color: 0x9B59B6
  };

  const components = [{
    type: 1,
    components: [
      { type: 2, style: ButtonStyle.Danger,    label: 'COD',         emoji: { name: '🔫' }, custom_id: 'rr_' + cod  },
      { type: 2, style: ButtonStyle.Secondary, label: 'ROLE-Gaming', emoji: { name: '🏯' }, custom_id: 'rr_' + role },
      { type: 2, style: ButtonStyle.Primary,   label: 'Fortnite',    emoji: { name: '🌀' }, custom_id: 'rr_' + fort },
      { type: 2, style: ButtonStyle.Success,   label: 'ARC Raiders', emoji: { name: '🏗️' }, custom_id: 'rr_' + arc  },
    ]
  }];

  const { panelId } = await postOrEditPanel('Gaming Preferences', CH.selfRole, embed, components);
  await wireMappings(panelId, [
    { emoji: '🔫',  label: 'COD',         style: 'danger',    roleId: cod  },
    { emoji: '🏯',  label: 'ROLE-Gaming', style: 'secondary', roleId: role },
    { emoji: '🌀',  label: 'Fortnite',    style: 'primary',   roleId: fort },
    { emoji: '🏗️', label: 'ARC Raiders', style: 'success',   roleId: arc  },
  ]);
  return { cod, role, fort, arc };
}

(async () => {
  if (!TOKEN) { console.error('DISCORD_TOKEN missing'); process.exit(1); }
  log(`Forsaken Warriors panel setup — guild ${GUILD_ID}`);
  await rest.get(Routes.guild(GUILD_ID));

  const verifiedId = await buildRulesVerify();
  const adultId    = await buildAgeGate();
  const games      = await buildGamingPrefs();

  console.log('\n=== summary ===');
  console.log('  Verified role:', verifiedId);
  console.log('  18+ role:     ', adultId);
  console.log('  COD:          ', games.cod);
  console.log('  ROLE-Gaming:  ', games.role);
  console.log('  Fortnite:     ', games.fort);
  console.log('  ARC Raiders:  ', games.arc);

  const [panels] = await pool.execute(
    'SELECT panel_name, channel_id, message_id FROM reaction_role_panels WHERE guild_id = ? ORDER BY id',
    [GUILD_ID]
  );
  console.log('\n=== panels live ===');
  for (const p of panels) console.log(`  ${p.panel_name.padEnd(22)} → <#${p.channel_id}>  msg ${p.message_id}`);

  console.log('\n=== next steps ===');
  console.log('  • TTL caches refresh in ~60s (or restart PM2 for instant pickup).');
  console.log('  • #18-over-songs is now gated: only members with 18+ role see it.');
  console.log('  • To bulk-grant Verified to all existing members (no surprise gating later), run:');
  console.log(`      node scripts/grant-existing-members-verified.js`);
  console.log('  • To turn Verified into a real channel gate (lock newcomers out until they click), say the word and I\'ll build the channel-permission migrator.');
  log('done.');
  await pool.end();
})().catch(async e => {
  console.error('FAIL', e.stack || e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
