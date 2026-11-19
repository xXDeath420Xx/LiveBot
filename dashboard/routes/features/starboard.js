/**
 * Starboard JSON API (mounted under /api/guilds by dashboard/routes/guilds.js).
 *
 *   GET    /:guildId/starboard                 the first board (what single-board callers expect) plus `boards`
 *   GET    /:guildId/starboard/boards          every board
 *   POST   /:guildId/starboard/boards          create a board
 *   PUT    /:guildId/starboard                 update a board: `board_id` in the body, or the first board
 *   PUT    /:guildId/starboard/boards/:boardId update a board
 *   DELETE /:guildId/starboard/boards/:boardId delete a board
 *
 * Bodies use the starboard_config column names (channel_id, star_threshold, emoji, self_star,
 * ignore_bots, watch_channels, ignore_channels, channel_thresholds, min_age_minutes,
 * max_age_minutes, remove_below_threshold, remove_on_delete, name, enabled). An update starts from
 * the stored board, so a body may carry only the fields it changes. Validation and storage live in
 * core/starboard-manager.js, shared with the dashboard form (POST /manage/:guildId/starboard/config).
 */
import express from 'express';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';
import {
  listBoards, validateBoardInput, saveBoard, deleteBoard, parseJsonList, parseThresholds, emojiList, MAX_BOARDS,
} from '../../../core/starboard-manager.js';

const router = express.Router();

function guildFor(req) {
  const { guildId } = req.params;
  return global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId) || req.guildObject || null;
}

/** A board row as the API returns it (JSON columns decoded). */
export function boardView(row) {
  return {
    ...row,
    emoji_list: emojiList(row),
    watch_channels: parseJsonList(row.watch_channels),
    ignore_channels: parseJsonList(row.ignore_channels),
    channel_thresholds: parseThresholds(row.channel_thresholds),
  };
}

/** The stored board as validateBoardInput input, so a partial body only changes what it names. */
function asInput(row) {
  if (!row) return { enabled: 1, star_threshold: 3, remove_below_threshold: 1, remove_on_delete: 1 };
  const v = boardView(row);
  return { ...row, emoji: v.emoji_list, watch_channels: v.watch_channels, ignore_channels: v.ignore_channels, channel_thresholds: v.channel_thresholds };
}

async function update(req, res, boardId) {
  const boards = await listBoards(req.guildId);
  const current = boardId ? boards.find((b) => String(b.id) === String(boardId)) : boards[0];
  if (boardId && !current) return res.status(404).json({ error: 'Starboard not found' });
  const result = validateBoardInput({ ...asInput(current), ...req.body }, guildFor(req));
  if (!result.ok) return res.status(400).json({ error: result.error });
  const saved = await saveBoard(req.guildId, current ? current.id : null, result.board);
  if (!saved.ok) return res.status(400).json({ error: saved.error });
  const fresh = (await listBoards(req.guildId)).find((b) => Number(b.id) === Number(saved.id));
  return res.json({ success: true, message: 'Starboard saved', config: fresh ? boardView(fresh) : null });
}

// Get starboard configuration (first board, plus every board)
router.get('/:guildId/starboard', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const boards = (await listBoards(req.guildId)).map(boardView);
    if (boards.length === 0) {
      return res.json({ guild_id: req.guildId, channel_id: null, star_threshold: 3, boards: [], max_boards: MAX_BOARDS });
    }
    res.json({ ...boards[0], boards, max_boards: MAX_BOARDS });
  } catch (error) {
    logger.error('[Starboard] Get starboard config error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch starboard configuration' });
  }
});

router.get('/:guildId/starboard/boards', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    res.json({ boards: (await listBoards(req.guildId)).map(boardView), max_boards: MAX_BOARDS });
  } catch (error) {
    logger.error('[Starboard] List boards error', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch starboards' });
  }
});

router.post('/:guildId/starboard/boards', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const result = validateBoardInput({ ...asInput(null), ...req.body }, guildFor(req));
    if (!result.ok) return res.status(400).json({ error: result.error });
    const saved = await saveBoard(req.guildId, null, result.board);
    if (!saved.ok) return res.status(400).json({ error: saved.error });
    const fresh = (await listBoards(req.guildId)).find((b) => Number(b.id) === Number(saved.id));
    res.status(201).json({ success: true, message: 'Starboard created', config: fresh ? boardView(fresh) : null });
  } catch (error) {
    logger.error('[Starboard] Create board error', { error: error.message });
    res.status(500).json({ error: 'Failed to create the starboard' });
  }
});

// Update starboard configuration (board_id in the body, or the first board; creates one when there is none)
router.put('/:guildId/starboard', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const boardId = req.body?.board_id ? Number.parseInt(req.body.board_id, 10) : null;
    await update(req, res, boardId);
  } catch (error) {
    logger.error('[Starboard] Update starboard config error', { error: error.message });
    res.status(500).json({ error: 'Failed to update starboard configuration' });
  }
});

router.put('/:guildId/starboard/boards/:boardId', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const boardId = Number.parseInt(req.params.boardId, 10);
    if (!Number.isInteger(boardId) || boardId < 1) return res.status(400).json({ error: 'Invalid starboard id' });
    await update(req, res, boardId);
  } catch (error) {
    logger.error('[Starboard] Update board error', { error: error.message });
    res.status(500).json({ error: 'Failed to update the starboard' });
  }
});

router.delete('/:guildId/starboard/boards/:boardId', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const boardId = Number.parseInt(req.params.boardId, 10);
    if (!Number.isInteger(boardId) || boardId < 1) return res.status(400).json({ error: 'Invalid starboard id' });
    const ok = await deleteBoard(req.guildId, boardId);
    if (!ok) return res.status(404).json({ error: 'Starboard not found' });
    res.json({ success: true, message: 'Starboard deleted' });
  } catch (error) {
    logger.error('[Starboard] Delete board error', { error: error.message });
    res.status(500).json({ error: 'Failed to delete the starboard' });
  }
});

export default router;
