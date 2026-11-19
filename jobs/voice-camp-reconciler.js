/*
 * Keeps 24/7 camped bots actually sitting in their camp channel.
 *
 * The camp feature's recovery is entirely event-driven: a player 'disconnect', or a track error.
 * Those cover the cases discord-player knows about and nothing else. A voice websocket that dies,
 * a Discord voice-server migration, a gateway resume that loses the voice session — none of them
 * reliably raise an event, and when they don't, the bot is simply out of voice with no log line
 * and no recovery until somebody restarts the process.
 *
 * That is not hypothetical: guild 844406178799943730 dropped out of its camp on 2026-08-31 and was
 * still out two days later, across an entire log history containing no mention of it.
 *
 * Every two minutes is chosen to be well inside "somebody notices". Camp is a visible, ambient
 * thing — the bot is either in the channel or it isn't, and members see it — so a gap measured in
 * hours reads as broken even though it would eventually self-heal.
 */
import cron from 'node-cron';
import logger from '../utils/logger.js';
import { reconcileCamps } from '../core/voice-camp-manager.js';

let task = null;

export function startVoiceCampReconciler(player) {
  if (task) return task;
  if (!player) {
    logger.warn('[VoiceCamp] reconciler not started — no player instance');
    return null;
  }
  task = cron.schedule('*/2 * * * *', () => {
    reconcileCamps(player).catch(err =>
      logger.error(`[VoiceCamp] reconcile threw: ${err.message}`));
  });
  logger.info('[VoiceCamp] camp reconciler scheduled every 2 minutes');
  return task;
}

export function stopVoiceCampReconciler() {
  if (task) { task.stop(); task = null; }
}
