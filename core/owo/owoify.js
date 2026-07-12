/*
 * Thin wrapper around @zuzak/owo (MIT license — independent of OwO Bot).
 * https://www.npmjs.com/package/@zuzak/owo
 *
 * This file contains no OwO Bot source code and is therefore NOT part of the
 * CC-BY-NC-SA module boundary. It's included under CertiFried's own license.
 */
import owo from '@zuzak/owo';

export function owoify(text) {
    if (!text) return '';
    return owo(String(text));
}
