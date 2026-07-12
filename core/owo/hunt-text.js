/*
 * OwO hunt message — CC-BY-NC-SA-4.0 derivative. See /LICENSE-OWO-NOTICE.md.
 *
 * The exact line the bot we replace prints, reproduced from real messages captured in the server:
 *
 *   **🌱 | karabi**, hunt is empowered by 🔴🔮`[24/100]` 🟢💠`[92/100]` 🍀`[84/100]`  !
 *   **▫️ |** You found: :bee: :bee: :beetle: … (16 of them)
 *   **▫️ |** :crocodile: :tiger2: :elephant: gained **489xp**!
 *   **📦 |** You found a **lootbox**! `[1/3] RESETS IN: 20H 40M 59S`
 *
 * Without gems it collapses to the plain single-catch line, which is what a hunt looks like
 * before anyone has opened a lootbox.
 *
 * `▫️` stands in for upstream's invisible `<:blank:>` spacer emoji, which lives on OwO's own
 * emoji server and is therefore unusable by us.
 */
import { empoweredBy } from './gems-service.js';

const BLANK = '▫️';
const BOX = '📦';
const SPROUT = '🌱';

/** The animals, flattened back out so duplicates repeat: ":bee: :bee: :beetle:". */
const animalLine = (caught) =>
  caught.flatMap(e => Array(e.count).fill(e.animal.emoji)).join(' ');

/**
 * @param {string} name    display name to address the hunter by
 * @param {object} result  what `hunt()` returned
 */
export function renderHunt(name, result) {
  const { caught, gems, animals, xp, team, lootbox, currencyEmoji } = result;
  const gemLine = empoweredBy(gems, animals);

  let text;
  if (gemLine) {
    text = `**${SPROUT} | ${name}**, hunt is empowered by ${gemLine} !`
      + `\n**${BLANK} |** You found: ${animalLine(caught)}`;
  } else {
    // No gems: one animal, named, the way upstream words it.
    const only = caught[0];
    const rank = only.rank;
    const article = /^[aeiou]/i.test(rank) ? 'an' : 'a';
    text = `**${SPROUT} | ${name}** caught ${article} **${rank}** ${only.animal.emoji}!`;
  }

  // Note the separator differs from the line above it: upstream bolds only the bar here, not the
  // spacer. Looks like a typo in their source, but it is what people see, so we keep it.
  if (team?.emojis?.length) {
    text += `\n${BLANK} **|** ${team.emojis.join(' ')} gained **${xp}xp**!`;
  }

  if (lootbox?.dropped) {
    text += `\n**${BOX} |** You found a **lootbox**! \`[${lootbox.count}/3] RESETS IN: ${lootbox.resets}\``;
  }

  return text;
}

/** `📦 | karabi, You found a **weapon crate**! [1/3] RESETS IN: 6H 7M 39S` — battle's drop. */
export function renderCrateDrop(name, crate) {
  if (!crate?.dropped) return null;
  return `**${BOX} | ${name}**, You found a **weapon crate**! `
    + `\`[${crate.count}/3] RESETS IN: ${crate.resets}\``;
}
