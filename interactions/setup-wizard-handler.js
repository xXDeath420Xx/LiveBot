/**
 * /setup wizard interaction handlers. The step index lives in the component customId
 * (setup_enable_<i> / setup_skip_<i> / setup_back_<i> / setup_chan_<i>), so there's no
 * server-side session — each click applies its effect and re-renders the next step in
 * place via interaction.update on the (ephemeral) wizard message.
 */
import { PermissionFlagsBits } from 'discord.js';
import { renderStep, applyEnable, STEP_COUNT } from '../core/setup-wizard.js';
import logger from '../utils/logger.js';

function parse(customId) {
  const parts = customId.split('_'); // setup_<action>_<index>
  return { action: parts[1], index: Number(parts[2]) };
}

async function guard(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Use this in a server.', ephemeral: true }).catch(() => {});
    return false;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: '🚫 You need **Manage Server** to use the setup wizard.', ephemeral: true }).catch(() => {});
    return false;
  }
  return true;
}

export async function handleSetupButton(interaction) {
  try {
    if (!(await guard(interaction))) return;
    const { action, index } = parse(interaction.customId);
    const g = interaction.guildId;
    let next = index;
    if (action === 'enable') { await applyEnable(g, index, {}); next = index + 1; }
    else if (action === 'skip') { next = index + 1; }
    else if (action === 'back') { next = Math.max(0, index - 1); }
    await interaction.update(await renderStep(g, Math.min(next, STEP_COUNT)));
  } catch (err) {
    logger.error('[setup] button failed', { err: err.message, customId: interaction.customId });
    await interaction.reply({ content: `Setup hit an error: ${err.message}`, ephemeral: true }).catch(() => {});
  }
}

export async function handleSetupChannelSelect(interaction) {
  try {
    if (!(await guard(interaction))) return;
    const { index } = parse(interaction.customId);
    const channelId = interaction.values?.[0];
    await applyEnable(interaction.guildId, index, { channelId });
    await interaction.update(await renderStep(interaction.guildId, index + 1));
  } catch (err) {
    logger.error('[setup] channel select failed', { err: err.message, customId: interaction.customId });
    await interaction.reply({ content: `Setup hit an error: ${err.message}`, ephemeral: true }).catch(() => {});
  }
}
