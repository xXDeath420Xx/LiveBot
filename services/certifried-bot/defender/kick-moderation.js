/**
 * Thin wrapper over Kick's official moderation + chat-delete endpoints.
 * Pure I/O: the caller supplies a valid user access token. No DB coupling.
 * `fetchImpl` is injectable for testing; defaults to global fetch.
 */

const KICK_API_BASE = 'https://api.kick.com/public/v1';

// Reading an error body can itself throw (connection drop, body already
// consumed). Never let that turn a structured failure into an unhandled reject.
async function safeText(response) {
    try {
        return await response.text();
    } catch {
        return null;
    }
}

async function result(response) {
    return { ok: response.ok, status: response.status, error: response.ok ? null : await safeText(response) };
}

export async function banUser(broadcasterId, userId, { duration, reason } = {}, token, fetchImpl = fetch) {
    const body = {
        broadcaster_user_id: parseInt(broadcasterId, 10),
        user_id: parseInt(userId, 10)
    };
    if (typeof duration === 'number') body.duration = duration; // minutes; omit => permanent
    if (reason != null) body.reason = String(reason).slice(0, 100);

    const response = await fetchImpl(`${KICK_API_BASE}/moderation/bans`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return result(response);
}

export async function unbanUser(broadcasterId, userId, token, fetchImpl = fetch) {
    const response = await fetchImpl(`${KICK_API_BASE}/moderation/bans`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            broadcaster_user_id: parseInt(broadcasterId, 10),
            user_id: parseInt(userId, 10)
        })
    });
    return result(response);
}

export async function deleteMessage(messageId, token, fetchImpl = fetch) {
    const response = await fetchImpl(`${KICK_API_BASE}/chat/${messageId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
    });
    return result(response);
}
