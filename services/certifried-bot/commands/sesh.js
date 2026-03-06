/**
 * Smoke Session Commands
 * !sesh / !circle - Start a session
 * !hit / !puff - Take a hit
 * !pass / !next - Pass to next person
 * !doused / !endsesh - End the session
 */

import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const PIECES = ['joint', 'blunt', 'bong', 'pipe', 'dab', 'vape', 'dabrig', 'rig', 'bowl', 'chillum', 'bubbler', 'spliff', 'edible', 'tincture'];
const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 minutes of inactivity

/**
 * Get active session for a channel
 */
async function getActiveSession(channelId) {
    const [rows] = await pool.execute(
        `SELECT * FROM tokes_sessions
         WHERE channel_id = ? AND status = 'active'
         ORDER BY started_at DESC LIMIT 1`,
        [channelId]
    );
    return rows[0] || null;
}

/**
 * Get session participants
 */
async function getParticipants(sessionId) {
    const [rows] = await pool.execute(
        `SELECT * FROM tokes_session_participants
         WHERE session_id = ?
         ORDER BY joined_at ASC`,
        [sessionId]
    );
    return rows;
}

/**
 * !sesh / !circle - Start a new smoke session
 */
export async function seshCommand(ctx) {
    const { channel, username, userId, reply, args, profile } = ctx;

    try {
        // Check for existing session
        const existing = await getActiveSession(channel.id);
        if (existing) {
            const participants = await getParticipants(existing.id);
            reply(`A session is already active! ${participants.length} in the circle. Join with !hit`);
            return;
        }

        // Parse piece type
        let piece = 'joint';
        if (args[0]) {
            const requestedPiece = args[0].toLowerCase();
            if (PIECES.includes(requestedPiece)) {
                piece = requestedPiece;
            }
        }

        // Parse optional strain
        const strain = args.slice(PIECES.includes(args[0]?.toLowerCase()) ? 1 : 0).join(' ') || null;

        // Create session
        const [result] = await pool.execute(
            `INSERT INTO tokes_sessions (channel_id, piece, strain_name, started_by, holder, max_participants)
             VALUES (?, ?, ?, ?, ?, 1)`,
            [channel.id, piece, strain, username, username]
        );

        const sessionId = result.insertId;

        // Add creator as first participant
        await pool.execute(
            `INSERT INTO tokes_session_participants (session_id, platform_user_id, display_name, hits_taken)
             VALUES (?, ?, ?, 1)`,
            [sessionId, userId, username]
        );

        // Update session total hits
        await pool.execute(
            `UPDATE tokes_sessions SET total_hits = 1 WHERE id = ?`,
            [sessionId]
        );

        // Build response
        let response = `${username} starts a smoke circle with a ${piece}!`;
        if (strain) {
            response += ` (${strain})`;
        }
        response += ` Join with !hit | Pass with !pass | End with !doused`;

        reply(response);

    } catch (error) {
        logger.error('[SeshCommand] Error', { error: error.message });
        reply(`${username}, couldn't start the session. Try again!`);
    }
}

/**
 * !hit / !puff - Take a hit in the session
 */
export async function hitCommand(ctx) {
    const { channel, username, userId, reply, profile } = ctx;

    try {
        const session = await getActiveSession(channel.id);
        if (!session) {
            reply(`No active session! Start one with !sesh`);
            return;
        }

        // Check if user is the current holder or joining fresh
        const participants = await getParticipants(session.id);
        let participant = participants.find(p => p.platform_user_id === userId);

        if (session.holder !== username && participant) {
            // Not their turn but already in session
            reply(`${username}, wait for the ${session.piece} to come around! ${session.holder} has it.`);
            return;
        }

        if (!participant) {
            // New participant joining
            await pool.execute(
                `INSERT INTO tokes_session_participants (session_id, platform_user_id, display_name, hits_taken)
                 VALUES (?, ?, ?, 1)`,
                [session.id, userId, username]
            );

            // Update max participants
            await pool.execute(
                `UPDATE tokes_sessions SET
                    total_hits = total_hits + 1,
                    max_participants = GREATEST(max_participants, ?),
                    holder = ?
                 WHERE id = ?`,
                [participants.length + 1, username, session.id]
            );

            // Update channel stats
            await pool.execute(
                `UPDATE tokes_channel_stats SET sessions_joined = sessions_joined + 1
                 WHERE channel_id = ? AND platform_user_id = ?`,
                [channel.id, userId]
            );

            reply(`${username} joins the circle and takes a hit! ${participants.length + 1} in the sesh now. !pass to continue`);

        } else {
            // Existing participant taking another hit
            await pool.execute(
                `UPDATE tokes_session_participants SET hits_taken = hits_taken + 1
                 WHERE session_id = ? AND platform_user_id = ?`,
                [session.id, userId]
            );

            await pool.execute(
                `UPDATE tokes_sessions SET total_hits = total_hits + 1, holder = ?
                 WHERE id = ?`,
                [username, session.id]
            );

            reply(`${username} takes another hit from the ${session.piece}! Total hits: ${session.total_hits + 1}. !pass to continue`);
        }

    } catch (error) {
        logger.error('[HitCommand] Error', { error: error.message });
        reply(`${username}, couldn't take that hit. Try again!`);
    }
}

/**
 * !pass / !next - Pass to the next person
 */
export async function passCommand(ctx) {
    const { channel, username, userId, reply, args } = ctx;

    try {
        const session = await getActiveSession(channel.id);
        if (!session) {
            reply(`No active session! Start one with !sesh`);
            return;
        }

        if (session.holder !== username) {
            reply(`${username}, you don't have the ${session.piece}! ${session.holder} does.`);
            return;
        }

        const participants = await getParticipants(session.id);

        logger.debug('[PassCommand] Debug info', {
            username,
            args,
            participantCount: participants.length,
            participants: participants.map(p => p.display_name),
            sessionHolder: session.holder
        });

        // Determine who to pass to
        let nextHolder;

        if (args[0]) {
            // Pass to specific person
            const target = args[0].replace('@', '').toLowerCase();
            const found = participants.find(p => p.display_name.toLowerCase() === target);
            if (found) {
                nextHolder = found.display_name;
            } else {
                // Pass to someone not in session yet (they'll join with !hit)
                nextHolder = args[0].replace('@', '');
            }
        } else {
            // Pass to next person in rotation
            const currentIndex = participants.findIndex(p => p.display_name === username);
            const nextIndex = (currentIndex + 1) % participants.length;

            // If only one person, can't pass to yourself
            if (participants.length === 1) {
                reply(`${username}, you're the only one in the circle! Get someone to !hit first.`);
                return;
            }

            nextHolder = participants[nextIndex].display_name;
        }

        // Update session holder
        await pool.execute(
            `UPDATE tokes_sessions SET holder = ? WHERE id = ?`,
            [nextHolder, session.id]
        );

        reply(`${username} passes the ${session.piece} to ${nextHolder}! Take a !hit`);

    } catch (error) {
        logger.error('[PassCommand] Error', { error: error.message });
        reply(`${username}, couldn't pass. Try again!`);
    }
}

/**
 * !doused / !endsesh - End the current session
 */
export async function dousedCommand(ctx) {
    const { channel, username, userId, reply, isBroadcaster, isMod } = ctx;

    try {
        const session = await getActiveSession(channel.id);
        if (!session) {
            reply(`No active session to end!`);
            return;
        }

        // Only starter, mods, or broadcaster can end
        const canEnd = session.started_by === username || isBroadcaster || isMod;
        if (!canEnd) {
            reply(`${username}, only ${session.started_by} or a mod can end the session!`);
            return;
        }

        const participants = await getParticipants(session.id);

        // End session
        await pool.execute(
            `UPDATE tokes_sessions SET status = 'finished', ended_at = NOW()
             WHERE id = ?`,
            [session.id]
        );

        // Award XP to participants
        const xpPerHit = 5;
        for (const p of participants) {
            const xpGain = p.hits_taken * xpPerHit + 25; // Base 25 + 5 per hit
            await pool.execute(
                `UPDATE tokes_profiles SET xp = xp + ?
                 WHERE platform_user_id = ?`,
                [xpGain, p.platform_user_id]
            );
        }

        // Calculate session duration
        const duration = Math.floor((Date.now() - new Date(session.started_at).getTime()) / 60000);

        // Build stats
        const topHitter = participants.reduce((a, b) => a.hits_taken > b.hits_taken ? a : b);

        let response = `Session complete! `;
        response += `${session.total_hits} total hits | `;
        response += `${participants.length} participants | `;
        response += `${duration}min | `;
        response += `MVP: ${topHitter.display_name} (${topHitter.hits_taken} hits)`;

        reply(response);

    } catch (error) {
        logger.error('[DousedCommand] Error', { error: error.message });
        reply(`${username}, couldn't end the session. Try again!`);
    }
}
