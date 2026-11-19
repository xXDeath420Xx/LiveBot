/**
 * User-defined colour schemes.
 *
 * ## Security: this stores DATA and generates CSS, never the reverse
 *
 * The obvious shortcut is to let someone save a CSS snippet and echo it into a
 * <style> block. That is a stored-XSS hole — `}</style><script>…` escapes the
 * block trivially, and the payload then runs for that user on every page.
 *
 * So the stored value is a flat map of KNOWN token names to STRICTLY VALIDATED
 * colours, and the CSS is generated here from that map. Anything that isn't a
 * recognised token name paired with a `#rrggbb` value never reaches the page —
 * validation is an allowlist on both sides, not an escape or a sanitiser.
 *
 * ## Derived tokens
 *
 * A user picks 5 colours, not 25. The rest are derived: surfaces are stepped
 * from the base background, muted text is the body colour at reduced alpha,
 * borders come in a decorative and a control weight. That keeps the editor
 * approachable while still producing a complete, coherent theme.
 *
 * ## Contrast is checked, not assumed
 *
 * Someone will pick dark grey text on a black background. Rather than silently
 * shipping something unreadable, buildCustomTheme returns per-pair contrast
 * results so the UI can warn — and the WCAG thresholds are the same ones the
 * preset themes were measured against.
 */

/** The only token names a custom theme may set. Anything else is dropped. */
const BASE_TOKENS = ['bg', 'surface', 'text', 'accent', 'border'];

const HEX = /^#[0-9a-fA-F]{6}$/;

// --- colour maths (duplicated deliberately: no runtime dep for 30 lines) ----
function toRgb(hex) {
    const h = hex.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function channel(c) {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function luminance(rgb) {
    return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}
export function contrast(a, b) {
    const [hi, lo] = [luminance(toRgb(a)), luminance(toRgb(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}
function mix(a, b, weight) {
    const ra = toRgb(a);
    const rb = toRgb(b);
    const out = ra.map((c, i) => Math.round(c * (1 - weight) + rb[i] * weight));
    return `#${out.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}
function rgbaOf(hex, alpha) {
    const [r, g, b] = toRgb(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
const isLight = (hex) => luminance(toRgb(hex)) > 0.4;

/**
 * Validate a submitted custom theme.
 *
 * @returns {{ok: true, theme: object} | {ok: false, error: string}}
 */
export function validateCustomTheme(input) {
    if (!input || typeof input !== 'object') return { ok: false, error: 'No colours supplied.' };

    const theme = {};
    for (const key of BASE_TOKENS) {
        const value = input[key];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value !== 'string' || !HEX.test(value.trim())) {
            return { ok: false, error: `"${key}" must be a hex colour like #1a2b3c.` };
        }
        theme[key] = value.trim().toLowerCase();
    }

    // bg and text are the two that cannot be derived from anything else.
    if (!theme.bg || !theme.text) {
        return { ok: false, error: 'A background and a text colour are both required.' };
    }

    return { ok: true, theme };
}

/**
 * Expand 5 base colours into the full token set, plus contrast findings.
 *
 * @param {object} base Validated output of validateCustomTheme().
 */
export function buildCustomTheme(base) {
    const bg = base.bg;
    const text = base.text;
    const light = isLight(bg);

    // Surfaces step away from the background, toward white on dark themes and
    // toward black on light ones, so cards read as raised either way.
    const step = light ? '#000000' : '#ffffff';
    const surface = base.surface || mix(bg, step, 0.04);
    const surface2 = mix(bg, step, 0.08);
    const cardTint = rgbaOf(step, light ? 0.03 : 0.035);
    const cardHover = rgbaOf(step, light ? 0.06 : 0.07);

    const accent = base.accent || (light ? '#6d3fd4' : '#a78bfa');

    // Two border weights: decorative dividers, and form controls which WCAG
    // treats as UI components needing 3:1.
    const border = base.border || rgbaOf(step, light ? 0.16 : 0.11);
    const borderStrong = rgbaOf(step, light ? 0.50 : 0.34);

    const tokens = {
        '--bg-primary': bg,
        '--bg-secondary': surface,
        '--bg-tertiary': surface2,
        '--bg-card': cardTint,
        '--bg-card-hover': cardHover,
        '--card-bg': surface,
        '--text-primary': text,
        '--text-secondary': rgbaOf(text, 0.74),
        '--text-muted': rgbaOf(text, light ? 0.63 : 0.56),
        '--text-dim': rgbaOf(text, 0.4),
        '--text': text,
        '--muted': rgbaOf(text, light ? 0.63 : 0.56),
        '--border-color': border,
        '--border': border,
        '--border-strong': borderStrong,
        '--accent-purple': accent,
        '--card-accent': accent,
        '--color-bg-primary': bg,
        '--color-bg-secondary': surface,
        '--color-bg-tertiary': surface2,
        '--color-bg-elevated': surface,
        '--color-dark-900': bg,
        '--color-dark-800': surface,
        '--color-dark-700': surface2,
        '--color-dark-600': cardHover,
        '--color-dark-400': border,
        '--color-text-primary': text,
        '--color-text-secondary': rgbaOf(text, 0.74),
        '--color-text-muted': rgbaOf(text, light ? 0.63 : 0.56),
        '--color-primary-400': accent,
        // The design-system tokens (dashboard/public/css/cf-ui.css) that the pages read.
        '--cf-bg': bg,
        '--cf-surface': surface,
        '--cf-surface-2': surface2,
        '--cf-surface-3': mix(bg, step, 0.12),
        '--cf-inset': light ? '#ffffff' : mix(bg, '#000000', 0.25),
        '--cf-border': border,
        '--cf-border-strong': borderStrong,
        '--cf-text': text,
        '--cf-text-2': rgbaOf(text, 0.74),
        '--cf-text-3': rgbaOf(text, light ? 0.63 : 0.58),
        '--cf-accent': accent,
        '--cf-accent-fg': accent,
        '--cf-accent-hover': mix(accent, light ? '#000000' : '#ffffff', 0.15),
        '--cf-accent-soft': rgbaOf(accent, light ? 0.1 : 0.14),
        '--cf-accent-line': rgbaOf(accent, 0.45),
        '--cf-on-accent': isLight(accent) ? '#0f1409' : '#ffffff',
    };

    // Report rather than silently ship something unreadable.
    const warnings = [];
    const bodyRatio = contrast(text, bg);
    if (bodyRatio < 4.5) {
        warnings.push({
            pair: 'Body text on background',
            ratio: Number(bodyRatio.toFixed(2)),
            needs: 4.5,
            message: `Body text is ${bodyRatio.toFixed(1)}:1 against the background — below the 4.5:1 minimum for readable text.`,
        });
    }
    const accentRatio = contrast(accent, bg);
    if (accentRatio < 3) {
        warnings.push({
            pair: 'Accent on background',
            ratio: Number(accentRatio.toFixed(2)),
            needs: 3,
            message: `The accent colour is ${accentRatio.toFixed(1)}:1 against the background — links and buttons using it will be hard to pick out.`,
        });
    }

    return {
        tokens,
        colorScheme: light ? 'light' : 'dark',
        warnings,
        contrast: {
            body: Number(bodyRatio.toFixed(2)),
            accent: Number(accentRatio.toFixed(2)),
        },
    };
}

/** Final belt-and-braces check before anything is written into a <style> block. */
const SAFE_VALUE = /^(#[0-9a-f]{6}|rgba\(\d{1,3}, \d{1,3}, \d{1,3}, [01](\.\d+)?\))$/i;

/**
 * Render the CSS for a custom theme.
 *
 * Every name is drawn from our own token map and every value is re-checked
 * against SAFE_VALUE here, so even a corrupted database row cannot inject
 * anything — the values are generated, but this function is what actually
 * touches the page and it does not trust its input.
 */
export function renderCustomThemeCss(base) {
    const built = buildCustomTheme(base);

    const declarations = Object.entries(built.tokens)
        .filter(([name, value]) => /^--[a-z0-9-]+$/.test(name) && SAFE_VALUE.test(value))
        .map(([name, value]) => `    ${name}: ${value};`)
        .join('\n');

    if (!declarations) return '';

    return `:root[data-theme="custom"] {\n    color-scheme: ${built.colorScheme};\n${declarations}\n}`;
}

export const CUSTOM_TOKEN_FIELDS = Object.freeze([
    { key: 'bg', label: 'Background', hint: 'The page behind everything.', required: true },
    { key: 'text', label: 'Text', hint: 'Main body text. Needs 4.5:1 against the background.', required: true },
    { key: 'accent', label: 'Accent', hint: 'Links, buttons, focus rings.', required: false },
    { key: 'surface', label: 'Surface', hint: 'Cards and panels. Left blank, it is derived from the background.', required: false },
    { key: 'border', label: 'Border', hint: 'Dividers. Left blank, it is derived.', required: false },
]);

export default { validateCustomTheme, buildCustomTheme, renderCustomThemeCss, contrast, CUSTOM_TOKEN_FIELDS };
