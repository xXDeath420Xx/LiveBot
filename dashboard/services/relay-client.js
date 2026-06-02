// Reads live status from the relay's localhost-only status API.
const RELAY_STATUS_URL = process.env.RELAY_STATUS_URL || 'http://127.0.0.1:4090';

export async function getRelayStatus(streamKey) {
  try {
    const res = await fetch(`${RELAY_STATUS_URL}/status?key=${encodeURIComponent(streamKey)}`, {
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) return { live: false, destinations: [] };
    return await res.json();
  } catch {
    return { live: false, destinations: [], relayUnreachable: true };
  }
}
