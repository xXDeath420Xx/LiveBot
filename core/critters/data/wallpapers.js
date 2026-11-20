/*
 * Critters profile wallpapers (original data, 2026-11-19). Ids 1..14 (members' shop ids are 200 + id, so
 * 201..214). Four price bands. Rendered procedurally by core/critters/render.js from style + colours.
 * name_color is the RGBA colour for the member's name on the card.
 */

const WP = (id, name, price, style, colors, nameColor, description) => Object.freeze({
    id, shopId: 200 + id, name, price, style, colors: Object.freeze(colors), nameColor: Object.freeze(nameColor), description, active: true,
});

export const WALLPAPERS = Object.freeze([
    // band 1
    WP(1, 'Moss Bed', 5000, 'solid', ['#2f4a35'], [236, 244, 230, 255], 'Soft green moss, the kind critters nap on.'),
    WP(2, 'Pebble Path', 5000, 'stripes', ['#5b5f66', '#6d727a'], [250, 250, 250, 255], 'Grey stones laid out in neat rows.'),
    WP(3, 'Pond Glass', 5000, 'gradient', ['#1f3b4d', '#3f7f8c'], [235, 250, 255, 255], 'Still water at the edge of the reeds.'),
    WP(4, 'Clay Burrow', 5000, 'solid', ['#6b4430'], [255, 240, 225, 255], 'Warm earth, dug by many small paws.'),
    // band 2
    WP(5, 'Meadow Noon', 20000, 'gradient', ['#7fb069', '#e6c86e'], [30, 40, 20, 255], 'Tall grass in full sun.'),
    WP(6, 'Tidepool', 20000, 'waves', ['#16506b', '#2c8fa3', '#7fd1c7'], [240, 255, 255, 255], 'Little waves over little rocks.'),
    WP(7, 'Fern Shade', 20000, 'stripes', ['#24402c', '#335c3d', '#447a50'], [230, 255, 230, 255], 'Layered ferns under the canopy.'),
    WP(8, 'Hearth Ember', 20000, 'gradient', ['#3a1410', '#a34224', '#e88a3c'], [255, 245, 230, 255], 'The glow of a fire that has been going all night.'),
    // band 3
    WP(9, 'Firefly Hollow', 60000, 'stars', ['#0f1a14', '#c9e86b'], [240, 255, 200, 255], 'A dark clearing full of slow little lights.'),
    WP(10, 'Coral Drift', 60000, 'waves', ['#2a1f4f', '#c4577d', '#f3a76b'], [255, 240, 245, 255], 'Warm currents through a sunset reef.'),
    WP(11, 'Frost Fern', 60000, 'gradient', ['#d9eef7', '#7aa7c7', '#3b5f8a'], [20, 30, 50, 255], 'Ice patterns on an early window.'),
    // band 4
    WP(12, 'Night Orchard', 150000, 'stars', ['#0b0d24', '#f5e6a8'], [255, 248, 220, 255], 'Stars over rows of sleeping trees.'),
    WP(13, 'Aurora Ridge', 150000, 'waves', ['#071b2c', '#2fd18a', '#8a5cf0'], [235, 255, 245, 255], 'Green and violet light rolling over the hills.'),
    WP(14, 'Golden Hoard', 150000, 'stripes', ['#3d2b05', '#b8860b', '#f2c94c'], [255, 252, 235, 255], 'Polished acorns, stacked high and gleaming.'),
]);

export function wallpaperById(id) {
    return WALLPAPERS.find(w => w.id === Number(id)) || null;
}

/** Resolve a shop id (201..) or a bare wallpaper id (1..) to a wallpaper. */
export function wallpaperByShopOrId(id) {
    const n = Number(id);
    if (!Number.isInteger(n)) return null;
    return n > 200 ? wallpaperById(n - 200) : wallpaperById(n);
}

export const DEFAULT_ACCENT = '#5f7a4f';
