// Discord embed builders for sprite-tracker integration.
//
// Two public functions:
//   buildCollectionEmbed(state) — sprite grid summary (families collected, tiers, dust, etc.)
//   buildBuybackEmbed(state, buybackList) — buy-back list with dust budget
//
// Both consume the same `state` object that renderCollection uses, plus for
// buyback the current buyback rows from epic_sprite_buyback.

import { EmbedBuilder } from 'discord.js';

// Rarity colors — align with the trading-card frames on the web tracker.
const RARITY_COLOR = {
  Mythic: 0xff6cc4,
  Legendary: 0xffcf3a,
  Epic: 0xc084fc,
  Rare: 0x5bf0ff,
};

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function rarityFor(cost) {
  if (cost >= 15000) return 'Mythic';
  if (cost >= 7500) return 'Legendary';
  if (cost >= 5000) return 'Epic';
  return 'Rare';
}

// Pick the visually-loudest owned variant to use as the embed's thumbnail:
// prefer mastered → highest tier (Mythic → Legendary → Epic → Rare) → any
// owned. Returns the imgId (used to build the URL) or null if nothing owned.
function pickHeroSprite(state) {
  let best = null;
  const tierRank = { holofoil: 6, cube: 6, quack: 6, gem: 5, galaxy: 4, gold: 3, gummy: 2, basic: 1 };
  for (const g of state.groups || []) {
    for (const v of Object.values(g.variants || {})) {
      if (!v.owned || !v.imgId) continue;
      const rank = (v.mastered ? 100 : 0)
                 + (v.summonCost || 0) / 100
                 + (tierRank[v.tierKey] || 0);
      if (!best || rank > best.rank) best = { rank, imgId: v.imgId };
    }
  }
  return best?.imgId || null;
}

/**
 * Sprite collection summary embed.
 * @param {object} state - the parsed state_json (same shape renderCollection consumes)
 * @param {object} opts - { player, syncedAt, publicUrl }
 */
export function buildCollectionEmbed(state, opts = {}) {
  const s = state.summary || {};
  const player = opts.player || state.player || 'Unknown';
  const publicUrl = opts.publicUrl || null;
  const syncedAt = opts.syncedAt || state.syncedAt || new Date().toISOString();

  const owned = s.owned ?? 0;
  const total = s.total ?? 0;
  const obtainable = s.obtainable ?? total;
  const mastered = s.mastered ?? 0;
  const future = s.future ?? 0;
  const vaulted = s.vaulted ?? 0;
  const dust = s.dust ?? 0;
  const families = s.families ?? (state.groups || []).length;
  const level = s.level ?? Math.floor(owned / 10);
  const pct = obtainable > 0 ? Math.round((owned / obtainable) * 100) : 0;

  // Per-tier progress
  const tierStats = {};
  for (const g of state.groups || []) {
    for (const v of Object.values(g.variants || {})) {
      const key = v.tierKey || v.tierLabel;
      if (!tierStats[key]) tierStats[key] = { owned: 0, total: 0, label: v.tierLabel || key, color: v.tierColor };
      tierStats[key].total++;
      if (v.owned) tierStats[key].owned++;
    }
  }
  const tierOrder = ['basic', 'gold', 'gummy', 'galaxy', 'gem', 'holofoil', 'cube', 'quack'];
  const tierLines = tierOrder
    .filter((k) => tierStats[k])
    .map((k) => `${tierStats[k].label}: **${tierStats[k].owned}/${tierStats[k].total}**`)
    .join('\n');

  // Recent activity: fully-collected families vs closest-to-completion
  const groupProgress = (state.groups || []).map((g) => {
    const vs = Object.values(g.variants || {});
    const ownedCt = vs.filter((v) => v.owned).length;
    const obtainCt = vs.filter((v) => !v.future && !v.vaulted).length;
    return { label: g.label, owned: ownedCt, obtainable: obtainCt, complete: ownedCt === obtainCt && obtainCt > 0 };
  });
  const complete = groupProgress.filter((g) => g.complete).map((g) => g.label);
  const closest = groupProgress
    .filter((g) => !g.complete && g.obtainable - g.owned <= 2 && g.obtainable > 0)
    .sort((a, b) => (a.obtainable - a.owned) - (b.obtainable - b.owned))
    .slice(0, 5)
    .map((g) => `${g.label} (${g.owned}/${g.obtainable})`);

  const embed = new EmbedBuilder()
    .setColor(pct === 100 ? 0x3ad07a : 0x7b5cff)
    .setTitle(`🎯 ${player}'s Sprite Collection`)
    .setDescription(
      `**${owned} of ${obtainable}** collected · **${pct}%** complete\n` +
      `**${mastered}** mastered ✦ · **${fmt(dust)}** dust ✦ · Level **${level}**`
    )
    .addFields(
      {
        name: '📊 By tier',
        value: tierLines || '_No tiers yet_',
        inline: true,
      },
      {
        name: '🏆 Fully collected',
        value: complete.length
          ? complete.slice(0, 12).join(', ') + (complete.length > 12 ? ` +${complete.length - 12} more` : '')
          : '_None yet — get grinding!_',
        inline: false,
      },
    );
  if (closest.length) {
    embed.addFields({
      name: '🎯 Closest to done',
      value: closest.join('\n'),
      inline: false,
    });
  }
  if (future || vaulted) {
    embed.addFields({
      name: 'ℹ️ Not obtainable',
      value: `${future ? `${future} awaiting release` : ''}${future && vaulted ? ' · ' : ''}${vaulted ? `${vaulted} vaulted` : ''}`,
      inline: false,
    });
  }
  if (publicUrl) {
    embed.setURL(publicUrl);
    embed.setFooter({ text: `certifriedmultitool.com · Auto-updates on sync` });
    // Attach the rendered collection PNG (auto-composited grid) as the embed
    // image. Cache-bust via syncedAt so Discord re-fetches on every state change.
    const cacheBust = Date.parse(syncedAt) || Date.now();
    embed.setImage(`${publicUrl}/discord-export?v=${cacheBust}`);
    // Small thumbnail — the user's visually-loudest owned sprite.
    const hero = pickHeroSprite(state);
    if (hero) {
      embed.setThumbnail(`https://certifriedmultitool.com/sprites/img/${encodeURIComponent(hero)}.png?v=${cacheBust}`);
    }
  } else {
    embed.setFooter({ text: `Auto-updates on sync` });
  }
  embed.setTimestamp(new Date(syncedAt));
  return embed;
}

/**
 * Buy-back list embed. Shows every entry with rarity, dust cost, funded pct.
 * @param {object} state - state_json
 * @param {Array} buybackList - rows from epic_sprite_buyback
 * @param {object} opts - { player, syncedAt, publicUrl }
 */
export function buildBuybackEmbed(state, buybackList, opts = {}) {
  const s = state.summary || {};
  const player = opts.player || state.player || 'Unknown';
  const publicUrl = opts.publicUrl || null;
  const syncedAt = opts.syncedAt || state.syncedAt || new Date().toISOString();
  const wallet = s.dust ?? 0;

  // Resolve each buyback entry to catalog data
  const catalog = new Map();
  for (const g of state.groups || []) {
    for (const v of Object.values(g.variants || {})) {
      catalog.set(v.name, { ...v, familyLabel: g.label });
    }
  }

  const rows = (buybackList || []).map((bb) => {
    const cat = catalog.get(bb.variant_name);
    if (!cat) return null;
    return {
      familyLabel: cat.familyLabel,
      tierLabel: cat.tierLabel,
      tierKey: cat.tierKey,
      cost: cat.summonCost ?? 0,
      rarity: rarityFor(cat.summonCost ?? 0),
    };
  }).filter(Boolean);

  const totalNeeded = rows.reduce((sum, r) => sum + r.cost, 0);
  const pct = totalNeeded > 0 ? Math.min(100, Math.round((wallet / totalNeeded) * 100)) : 100;
  const surplus = wallet - totalNeeded;

  // Group by rarity for readable field layout
  const byRarity = { Mythic: [], Legendary: [], Epic: [], Rare: [] };
  for (const r of rows) byRarity[r.rarity].push(r);

  const embed = new EmbedBuilder()
    .setColor(pct === 100 ? 0x3ad07a : 0xffcf3a)
    .setTitle(`🎯 ${player}'s Buy-back List`)
    .setDescription(
      rows.length === 0
        ? '_List is empty. Add variants via the tracker._'
        : `**${rows.length}** items on list · Need **${fmt(totalNeeded)} ✦** · Wallet **${fmt(wallet)} ✦**\n` +
          `${pct}% funded ${surplus >= 0 ? `· **${fmt(surplus)} ✦** surplus 🎉` : `· need **${fmt(-surplus)} ✦** more`}`
    );

  for (const [rarity, arr] of Object.entries(byRarity)) {
    if (!arr.length) continue;
    const sorted = arr.sort((a, b) => b.cost - a.cost);
    const value = sorted
      .slice(0, 15)
      .map((r) => `**${r.familyLabel}** · ${r.tierLabel} — ${fmt(r.cost)} ✦`)
      .join('\n');
    const cost = arr.reduce((s, r) => s + r.cost, 0);
    embed.addFields({
      name: `${rarity === 'Mythic' ? '💎' : rarity === 'Legendary' ? '⭐' : rarity === 'Epic' ? '🟣' : '🔵'} ${rarity} · ${arr.length} · ${fmt(cost)} ✦`,
      value: value + (arr.length > 15 ? `\n_+${arr.length - 15} more_` : ''),
      inline: false,
    });
  }

  if (publicUrl) {
    embed.setURL(publicUrl);
    embed.setFooter({ text: `certifriedmultitool.com · Auto-updates on sync` });
    // Attach the rendered buy-back list PNG as the embed image.
    // publicUrl for buyback is already .../u/:shareId/buyback — we want its
    // sibling /buyback-export route (state PNG endpoint). Strip trailing
    // /buyback if present.
    const cacheBust = Date.parse(syncedAt) || Date.now();
    const exportBase = publicUrl.replace(/\/buyback\/?$/, '');
    embed.setImage(`${exportBase}/buyback-export?v=${cacheBust}`);
  } else {
    embed.setFooter({ text: `Auto-updates on sync` });
  }
  embed.setTimestamp(new Date(syncedAt));
  return embed;
}
