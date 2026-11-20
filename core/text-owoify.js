/*
 * owoify: runs text through the MIT-licensed @zuzak/owo transformer (package.json dependency).
 * Used by /owoify (commands/fun/owoify-text.js), `!owoify` and the natural `owo owo <text>`.
 */
import owo from '@zuzak/owo';

export const OWOIFY_INPUT_MAX = 1800;
export const OWOIFY_OUTPUT_MAX = 2000;

/** The transformed text, capped at Discord's 2000-character message limit. */
export function owoifyText(text) {
    const input = String(text ?? '').slice(0, OWOIFY_INPUT_MAX);
    const out = String(owo(input));
    return out.length > OWOIFY_OUTPUT_MAX ? `${out.slice(0, OWOIFY_OUTPUT_MAX - 1)}…` : out;
}

export default owoifyText;
