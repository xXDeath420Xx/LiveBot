/*
 * Ko-fi webhook receiver.
 *
 * Ko-fi POSTs `application/x-www-form-urlencoded` with a single `data` field containing a
 * JSON string. Unlike Fourthwall there is **no signature header** — the only secret is the
 * `verification_token` inside the payload. So we require two independent secrets:
 *
 *   1. an unguessable per-guild token in the URL, which also tells us which guild this is
 *      (Ko-fi never sends a guild id), and
 *   2. the `verification_token`, compared in constant time.
 *
 * Always answer 200 once the payload is authentic and stored. Ko-fi retries on any non-2xx,
 * and `processPayment` is idempotent on `message_id`, but a 500 on an already-recorded
 * payment would still spam the endpoint.
 */
import express from 'express';
import logger from '../../../utils/logger.js';
import {
  getConfigByToken, decryptVerificationToken, tokensMatch, parsePayload, processPayment,
} from '../../../core/kofi-manager.js';

const router = express.Router();

router.post(
  '/:token',
  // Mounted before the global body parser, so parse our own body here.
  express.urlencoded({ extended: false, limit: '256kb' }),
  async (req, res) => {
    const { token } = req.params;

    let config;
    try {
      config = await getConfigByToken(token);
    } catch (err) {
      logger.error(`[Kofi Webhook] db lookup failed: ${err.message}`);
      return res.status(500).end();
    }
    // Unknown URL token: say nothing useful.
    if (!config) return res.status(404).end();
    if (!config.enabled) return res.status(200).end();

    const payload = parsePayload(req.body?.data);
    if (!payload) {
      logger.warn(`[Kofi Webhook] unparseable payload for guild ${config.guild_id}`);
      return res.status(400).end();
    }

    const expected = decryptVerificationToken(config);
    if (expected && !tokensMatch(payload.verificationToken, expected)) {
      logger.warn(`[Kofi Webhook] bad verification token for guild ${config.guild_id}`);
      return res.status(401).end();
    }
    if (!expected) {
      // The URL token alone got them here. Accept, but make the weaker posture visible.
      logger.warn(`[Kofi Webhook] guild ${config.guild_id} has no verification token set`);
    }

    let result;
    try {
      result = await processPayment(config.guild_id, payload, null);
    } catch (err) {
      logger.error(`[Kofi Webhook] processing failed for ${config.guild_id}: ${err.message}`, { stack: err.stack });
      return res.status(500).end();
    }

    // Ko-fi only needs a 2xx; do the announcing after we have answered.
    res.status(200).end();

    if (result.status === 'duplicate') return;
    announce(config, payload, result).catch(err =>
      logger.error(`[Kofi Webhook] announce failed: ${err.message}`));
  }
);

/** Post the thank-you message, if the guild configured a channel. */
async function announce(config, payload, result) {
  if (!config.announce_channel_id) return;

  const client = global.botManager?.getClientForGuild?.(config.guild_id) || global.client;
  const channel = await client?.channels?.fetch(config.announce_channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) return;

  // `is_public` false means the supporter asked to stay private.
  const who = payload.isPublic
    ? (result.userId ? `<@${result.userId}>` : (payload.fromName || 'Someone'))
    : 'Someone';

  const amount = payload.amount
    ? `**${payload.currency ? `${payload.currency} ` : ''}${payload.amount.toFixed(2)}**`
    : '';
  const what = payload.isSubscription
    ? (payload.isFirst ? 'started a monthly membership' : 'renewed their membership')
    : 'sent a tip';
  const tier = payload.tierName ? ` (${payload.tierName})` : '';

  const template = config.thank_you_message;
  const content = template
    ? template
      .replace(/{user}/g, who)
      .replace(/{amount}/g, amount)
      .replace(/{tier}/g, payload.tierName || '')
    : `☕ ${who} ${what}${tier}${amount ? ` — ${amount}` : ''}. Thank you!`;

  await channel.send({
    content,
    allowedMentions: { users: result.userId ? [result.userId] : [] },
  }).catch(() => {});

  if (payload.isPublic && payload.message && !payload.message.match(/\bCF-[A-Z2-9]{6}\b/i)) {
    await channel.send({
      content: `> ${payload.message.slice(0, 500).replace(/\n/g, '\n> ')}`,
      allowedMentions: { parse: [] },
    }).catch(() => {});
  }
}

export default router;
