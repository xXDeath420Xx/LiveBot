/*
 * The bugnet and the baskets.
 *
 *   gat_net:<encounterId>            — swing the net at a bug
 *   gat_basket:<encounterId>:<n>     — hold out basket n for falling fruit
 *
 * Everything that decides a winner happens in core/growtree/critters.js#claim, in one conditional
 * UPDATE. This file only renders the outcome.
 *
 * Losing is public, winning is public, and being too slow is told to you privately — nobody needs a
 * channel full of "you were too slow" for one bug.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { claim, lookup, BASKETS } from '../../core/growtree/critters.js';
import logger from '../../utils/logger.js';

const EPHEMERAL = { flags: 64 };

const RARITY_COLOUR = {
  common: 0x9BA3AF, uncommon: 0x57C97E, rare: 0x4EA1F2, epic: 0xA97BF0, legendary: 0xF0B23B,
};

export async function handleTreeCatch(interaction) {
  const [kind, idRaw, basketRaw] = interaction.customId.split(':');
  const encounterId = Number(idRaw);
  if (!Number.isInteger(encounterId)) return;

  try {
    const res = await claim(
      interaction.guildId,
      encounterId,
      interaction.user.id,
      kind === 'gat_basket' ? Number(basketRaw) : null);

    if (!res.ok) {
      const said = {
        gone: 'That one is long gone.',
        expired: kind === 'gat_net' ? 'It flew off before you got there. 🍃' : 'It hit the ground. 🍂',
        taken: 'Someone got there first — by a hair.',
        'wrong-basket': 'Wrong basket! It went past you. 🍂',
      }[res.reason] ?? 'Too late.';
      return interaction.reply({ content: said, ...EPHEMERAL });
    }

    const t = res.thing;

    if (res.kind === 'bug') {
      const embed = new EmbedBuilder()
        .setColor(RARITY_COLOUR[t.rarity] ?? 0x57C97E)
        .setTitle(`${t.emoji} Caught — ${t.name}!`)
        .setDescription(
          `**${interaction.user.username}** swung the net and got it.\n`
          + `${res.isNew ? '✨ **New sticker!** It goes in the book.\n' : 'Another one for the pile.\n'}`
          + `**+${t.coins}** 🪙`)
        .setFooter({ text: `${t.rarity}${res.isNew ? ' · first time' : ''}` });

      // The bug is caught — the net button must not linger, or people keep clicking a dead race.
      await interaction.update({ embeds: [embed], components: [] });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0xE8A33D)
      .setTitle(`${t.emoji} Caught — ${t.name}!`)
      .setDescription(`**${interaction.user.username}** guessed the right basket.\n**+${t.coins}** 🪙`)
      .setFooter({ text: 'Spend coins with /tree compost to grow the tree faster' });

    await interaction.update({ embeds: [embed], components: [] });
  } catch (err) {
    logger.error(`[GrowTree] catch failed: ${err.message}`, { stack: err.stack });
    if (!interaction.replied) {
      await interaction.reply({ content: 'Something went wrong.', ...EPHEMERAL }).catch(() => {});
    }
  }
}

/** The message a spawn posts. */
export function encounterMessage(spawn) {
  const t = spawn.thing;

  if (spawn.kind === 'bug') {
    const embed = new EmbedBuilder()
      .setColor(RARITY_COLOUR[t.rarity] ?? 0x57C97E)
      .setTitle(`${t.emoji} A ${t.name} landed on the tree!`)
      .setDescription('**First to swing the net keeps it.**')
      .setFooter({ text: `${t.rarity} · it will not wait long` });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`gat_net:${spawn.id}`)
        .setLabel('Swing the net!')
        .setEmoji('🥅')
        .setStyle(ButtonStyle.Success));

    return { embeds: [embed], components: [row] };
  }

  const embed = new EmbedBuilder()
    .setColor(0xE8A33D)
    .setTitle(`${t.emoji} ${t.name} is falling!`)
    .setDescription('**Which basket does it land in?** Pick one — you only get the one guess.')
    .setFooter({ text: 'Guess right and the coins are yours' });

  // Which basket is correct is NOT encoded in any customId — the client never learns the answer, so
  // nobody can read it off the buttons. It lives in the row, and claim() checks it server-side.
  const row = new ActionRowBuilder().addComponents(
    ...Array.from({ length: BASKETS }, (_, i) =>
      new ButtonBuilder()
        .setCustomId(`gat_basket:${spawn.id}:${i}`)
        .setLabel(`${i + 1}`)
        .setEmoji('🧺')
        .setStyle(ButtonStyle.Secondary)));

  return { embeds: [embed], components: [row] };
}

/** What the message becomes when nobody got there in time. */
export function missedMessage(row) {
  const t = lookup(row.code);
  return {
    embeds: [new EmbedBuilder()
      .setColor(0x4A4F58)
      .setTitle(row.kind === 'bug' ? `${t?.emoji ?? '🦋'} It flew away…` : `${t?.emoji ?? '🍎'} It hit the ground.`)
      .setDescription(row.kind === 'bug'
        ? `The ${t?.name ?? 'bug'} got bored of waiting. Nobody swung in time.`
        : `The ${t?.name ?? 'fruit'} splatted. Basket **${Number(row.answer) + 1}** was the one.`)],
    components: [],
  };
}

export default handleTreeCatch;
