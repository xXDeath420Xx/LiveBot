/**
 * Centralized color constants for Discord embeds
 * Ensures consistent branding across all commands
 */

const Colors = {
    // Primary brand colors
    PRIMARY: 0x5865F2,      // Discord Blurple
    SECONDARY: 0x99AAB5,    // Discord Gray

    // Status colors
    SUCCESS: 0x2ECC71,      // Green
    ERROR: 0xFF0000,        // Red
    WARNING: 0xFFA500,      // Orange
    INFO: 0x3498DB,         // Blue

    // Feature-specific colors
    LEVEL_UP: 0xFFD700,     // Gold
    MUSIC: 0x1DB954,        // Spotify Green
    MODERATION: 0xE74C3C,   // Red
    GIVEAWAY: 0x9B59B6,     // Purple
    POLL: 0x3498DB,         // Blue
    BIRTHDAY: 0xFF69B4,     // Pink
    ECONOMY: 0xF1C40F,      // Yellow/Gold
    GAME: 0x9B59B6,         // Purple
    STARBOARD: 0xFFD700,    // Gold
    STREAM: 0x9146FF,       // Twitch Purple

    // Platform colors
    TWITCH: 0x9146FF,
    YOUTUBE: 0xFF0000,
    KICK: 0x52E252,
    TIKTOK: 0x00F2EA,
    TROVO: 0x21D464,

    // Cannabis/Grow colors
    GROW: 0x228B22,         // Forest Green
    HARVEST: 0x32CD32,      // Lime Green

    // RPG colors
    RPG_COMBAT: 0xDC143C,   // Crimson
    RPG_QUEST: 0x4169E1,    // Royal Blue
    RPG_SHOP: 0xDAA520,     // Goldenrod
    RPG_LEVEL: 0x9400D3,    // Dark Violet

    // Neutral
    DEFAULT: 0x36393F,      // Discord Dark
    INVISIBLE: 0x2F3136,    // Discord Embed Background
};

// Hex string versions for CSS/other uses
const ColorsHex = {
    PRIMARY: '#5865F2',
    SECONDARY: '#99AAB5',
    SUCCESS: '#2ECC71',
    ERROR: '#FF0000',
    WARNING: '#FFA500',
    INFO: '#3498DB',
    LEVEL_UP: '#FFD700',
    MUSIC: '#1DB954',
    MODERATION: '#E74C3C',
    GIVEAWAY: '#9B59B6',
    POLL: '#3498DB',
    BIRTHDAY: '#FF69B4',
    ECONOMY: '#F1C40F',
    GAME: '#9B59B6',
    STARBOARD: '#FFD700',
    STREAM: '#9146FF',
    TWITCH: '#9146FF',
    YOUTUBE: '#FF0000',
    KICK: '#52E252',
    TIKTOK: '#00F2EA',
    TROVO: '#21D464',
    GROW: '#228B22',
    HARVEST: '#32CD32',
    RPG_COMBAT: '#DC143C',
    RPG_QUEST: '#4169E1',
    RPG_SHOP: '#DAA520',
    RPG_LEVEL: '#9400D3',
    DEFAULT: '#36393F',
    INVISIBLE: '#2F3136',
};

export { Colors, ColorsHex };
export default Colors;
