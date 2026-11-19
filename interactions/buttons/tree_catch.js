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
import { claim, BASKETS, clearEncounterMessage } from '../../core/growtree/critters.js';
import logger from '../../utils/logger.js';
import { displayNameFor } from '../../utils/display-name.js';

const EPHEMERAL = { flags: 64 };

// How long the "caught it!" result stays up before the message removes itself. Long enough that the
// channel sees who won, short enough that the tree is the only thing left standing.
const LINGER_MS = 8000;

/**
 * Show the outcome, then take the message away again.
 *
 * The tree message is the point of the channel; every encounter is transient by design, so it cleans
 * up after itself rather than leaving a stack of "Caught — Ladybird!" embeds above the tree. The DB's
 * message_id is cleared alongside, which both stops the reaper re-visiting it and lets the reaper
 * find this message if a restart kills the timer below before it fires.
 */
function vanish(interaction, encounterId) {
  setTimeout(() => {
    interaction.message.delete()
      .then(() => clearEncounterMessage(encounterId))
      .catch(() => clearEncounterMessage(encounterId).catch(() => {}));
  }, LINGER_MS);
}

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
          `**${displayNameFor(interaction.user, interaction.guild)}** swung the net and got it.\n`
          + `${res.isNew ? '✨ **New sticker!** It goes in the book.\n' : 'Another one for the pile.\n'}`
          + `**+${t.coins}** 🪙`)
        .setFooter({ text: `${t.rarity}${res.isNew ? ' · first time' : ''}` });

      // The bug is caught — the net button must not linger, or people keep clicking a dead race.
      await interaction.update({ embeds: [embed], components: [] });
      vanish(interaction, encounterId);
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0xE8A33D)
      .setTitle(`${t.emoji} Caught — ${t.name}!`)
      .setDescription(`**${displayNameFor(interaction.user, interaction.guild)}** guessed the right basket.\n**+${t.coins}** 🪙`)
      .setFooter({ text: 'Spend coins with /tree compost to grow the tree faster' });

    await interaction.update({ embeds: [embed], components: [] });
    vanish(interaction, encounterId);
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

// A missed encounter used to be edited into an "it flew away…" embed. It is now simply deleted by
// jobs/growtree-reaper.js — the tree is the only thing that stays in the channel.

export default handleTreeCatch;
