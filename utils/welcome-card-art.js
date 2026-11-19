/*
 * The light welcome card.
 *
 * The first version was a rectangle: hard corners, a flat gradient, the avatar
 * and three lines of text crammed into the left third, and five hundred pixels
 * of nothing to the right of them. The owner's word for it was "blocky", which
 * is exactly right — nothing on it was round except the avatar, and the empty
 * half made the straight edges the loudest thing in the picture.
 *
 * So: a deeper corner radius, soft blooms and arcs drawn behind the content to
 * break up the flat field, a halo around the avatar instead of a hard ring, and
 * a decorative cluster occupying the right side so the card reads as a composed
 * shape rather than a slab with a caption.
 *
 * Everything is drawn as vectors. node-canvas has no colour-emoji face, so a
 * decorative glyph would come out as a tofu box — the sparkles here are paths.
 */

/** A rounded rectangle path. */
export function roundedRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

/** #rrggbb → "rgba(r, g, b, a)". */
export function rgba(hex, alpha) {
    const h = String(hex).replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/**
 * A soft blob: a radial gradient that fades to nothing.
 *
 * Canvas has no blur that works on fills, so the softness has to be the gradient
 * itself. Three stops rather than two — a straight linear fade still reads as a
 * disc with an edge.
 */
function bloom(ctx, x, y, radius, colour, peak = 0.5) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, rgba(colour, peak));
    g.addColorStop(0.55, rgba(colour, peak * 0.35));
    g.addColorStop(1, rgba(colour, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
}

/** A four-pointed sparkle, the shape every kawaii sticker uses. */
function sparkle(ctx, x, y, size, colour, alpha = 0.9) {
    ctx.fillStyle = rgba(colour, alpha);
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.quadraticCurveTo(x + size * 0.18, y - size * 0.18, x + size, y);
    ctx.quadraticCurveTo(x + size * 0.18, y + size * 0.18, x, y + size);
    ctx.quadraticCurveTo(x - size * 0.18, y + size * 0.18, x - size, y);
    ctx.quadraticCurveTo(x - size * 0.18, y - size * 0.18, x, y - size);
    ctx.closePath();
    ctx.fill();
}

/**
 * The decorative cluster that fills the right of the card.
 *
 * Concentric open rings with a bloom behind them and sparkles around — an echo
 * of the ornament on the owner's own poster art, without copying it. It sits off
 * the right edge deliberately, so the card looks cropped from something larger
 * rather than centred in dead space.
 */
function ornament(ctx, cx, cy, scale, palette) {
    const ink = palette.dark ? '#FFFFFF' : palette.ink;

    bloom(ctx, cx, cy, 210 * scale, palette.dark ? '#FFFFFF' : palette.eyebrow, palette.dark ? 0.16 : 0.13);

    ctx.save();
    ctx.lineWidth = 2.5 * scale;
    for (const [r, a] of [[150, 0.16], [110, 0.22], [66, 0.3]]) {
        ctx.strokeStyle = rgba(ink, a);
        ctx.beginPath();
        ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
        ctx.stroke();
    }
    // A broken outer ring reads as decoration; a closed one reads as a target.
    ctx.strokeStyle = rgba(ink, 0.2);
    ctx.lineWidth = 4 * scale;
    ctx.beginPath();
    ctx.arc(cx, cy, 186 * scale, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 186 * scale, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    ctx.restore();

    sparkle(ctx, cx - 128 * scale, cy - 96 * scale, 17 * scale, ink, 0.5);
    sparkle(ctx, cx + 92 * scale, cy - 132 * scale, 12 * scale, ink, 0.38);
    sparkle(ctx, cx + 140 * scale, cy + 86 * scale, 20 * scale, ink, 0.45);
    sparkle(ctx, cx - 62 * scale, cy + 148 * scale, 11 * scale, ink, 0.32);
}

/**
 * Paint the background: gradient, blooms, and a pair of long arcs.
 *
 * The arcs are the thing that stops it feeling like a box. They run off both
 * edges, so the eye follows a curve across the card instead of stopping at the
 * corners.
 */
export function paintBackground(ctx, width, height, palette) {
    const g = ctx.createLinearGradient(0, 0, width, height);
    palette.stops.forEach((c, i) => g.addColorStop(i / (palette.stops.length - 1), c));
    ctx.fillStyle = g;
    ctx.fill();          // caller has already set the rounded path

    const tint = palette.dark ? '#FFFFFF' : '#FFFFFF';
    bloom(ctx, width * 0.14, height * 0.12, 320, tint, palette.dark ? 0.1 : 0.42);
    bloom(ctx, width * 0.62, height * 1.02, 300, palette.stops[2], 0.5);
    bloom(ctx, width * 0.95, height * 0.1, 260, palette.stops[0], 0.45);

    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = rgba(palette.dark ? '#FFFFFF' : palette.ink, 0.1);
    ctx.beginPath();
    ctx.moveTo(-40, height * 0.82);
    ctx.bezierCurveTo(width * 0.3, height * 0.62, width * 0.62, height * 1.02, width + 40, height * 0.66);
    ctx.stroke();
    ctx.strokeStyle = rgba(palette.dark ? '#FFFFFF' : palette.ink, 0.07);
    ctx.beginPath();
    ctx.moveTo(-40, height * 0.3);
    ctx.bezierCurveTo(width * 0.34, height * 0.08, width * 0.6, height * 0.44, width + 40, height * 0.16);
    ctx.stroke();
    ctx.restore();
}

/** The avatar, with a soft halo rather than a hard outline. */
export function paintAvatar(ctx, image, cx, cy, size, palette) {
    const r = size / 2;

    bloom(ctx, cx, cy, r * 1.9, palette.dark ? '#FFFFFF' : palette.eyebrow, palette.dark ? 0.22 : 0.3);

    // A translucent collar, then the white rim. Two soft edges instead of one hard one.
    ctx.fillStyle = rgba('#FFFFFF', 0.35);
    ctx.beginPath();
    ctx.arc(cx, cy, r + 14, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = rgba('#FFFFFF', 0.9);
    ctx.beginPath();
    ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
    ctx.fill();

    if (image) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(image, cx - r, cy - r, size, size);
        ctx.restore();
    } else {
        ctx.fillStyle = rgba(palette.eyebrow, 0.5);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
    }
}

/** Where the ornament sits, given the card's size. */
export function ornamentSpot(width, height) {
    return { cx: width * 0.845, cy: height * 0.5, scale: Math.min(width, height) / 400 };
}

export function paintOrnament(ctx, width, height, palette) {
    const { cx, cy, scale } = ornamentSpot(width, height);
    ornament(ctx, cx, cy, scale, palette);
}

export default {
    roundedRectPath, rgba, paintBackground, paintAvatar, paintOrnament, ornamentSpot,
};
