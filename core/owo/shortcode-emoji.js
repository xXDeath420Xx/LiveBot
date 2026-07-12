/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * Discord emoji-shortcode → Unicode mapping for upstream OwO animals.
 *
 * Upstream stores animal names as Discord emoji shortcodes (e.g. `:bee:`)
 * because Discord auto-renders them to emoji when they appear in message
 * content. For embeds and any non-message rendering we need the Unicode
 * directly. This map covers the 20 seeded animals plus the handful of
 * special placeholders used by the rank fallback lists.
 *
 * Additions: as admins seed new animals via the dashboard catalog editor
 * (Phase 9), add corresponding entries here. Missing entries fall back to
 * the shortcode string itself, which Discord will still render in most
 * message contexts.
 */

const SHORTCODE_TO_UNICODE = {
    // --- seeded animals ---
    ':bee:': '🐝',
    ':beetle:': '🪲',
    ':bug:': '🐛',
    ':butterfly:': '🦋',
    ':snail:': '🐌',
    ':crocodile:': '🐊',
    ':elephant:': '🐘',
    ':penguin:': '🐧',
    ':tiger2:': '🐅',
    ':whale:': '🐳',
    ':cat2:': '🐈',
    ':cow2:': '🐄',
    ':dog2:': '🐕',
    ':pig2:': '🐖',
    ':sheep:': '🐑',
    ':baby_chick:': '🐤',
    ':chipmunk:': '🐿️',
    ':mouse2:': '🐁',
    ':rabbit2:': '🐇',
    ':rooster:': '🐓',
    // --- rank placeholders from animal.json ---
    ':dragon:': '🐉',
    ':unicorn:': '🦄',
    ':snowman2:': '⛄',
    ':ghost:': '👻',
    ':dove:': '🕊️',
    ':rabbit:': '🐰',
    ':chicken:': '🐔',
    ':pig:': '🐷',
    ':cow:': '🐮',
    ':cat:': '🐱',
    ':dog:': '🐶',
    ':mouse:': '🐭',
    ':tiger:': '🐯',
};

export function resolveEmoji(shortcodeOrRaw) {
    if (!shortcodeOrRaw) return '';
    // Already Unicode or Discord custom emoji tag? Pass through.
    if (!/^:[a-z0-9_]+:$/.test(shortcodeOrRaw)) return shortcodeOrRaw;
    return SHORTCODE_TO_UNICODE[shortcodeOrRaw] || shortcodeOrRaw;
}

export function registerEmoji(shortcode, unicode) {
    SHORTCODE_TO_UNICODE[shortcode] = unicode;
}

export default SHORTCODE_TO_UNICODE;
