/*
 * A minimal ustar writer for the training dataset stream (worker-api.js GET /v1/jobs/:id/dataset): the decrypted WAVs
 * go straight from memory into the response, never to disk on the server.
 *
 *   tarHeader(name, size, mtime?) → Buffer(512)
 *   tarEntry(name, buf) → Buffer   header, data and padding
 *   TAR_END                        two zero blocks
 * Names are plain ASCII paths under 100 characters (wavs/123.wav, metadata.csv). Tested in tests/voice-clone.test.js.
 */
export function tarHeader(name, size, mtime = Math.floor(Date.now() / 1000)) {
    if (!/^[A-Za-z0-9_./-]{1,99}$/.test(name)) throw new Error('bad tar name');
    const h = Buffer.alloc(512, 0);
    h.write(name, 0, 'ascii');
    h.write('0000644\0', 100, 'ascii');
    h.write('0000000\0', 108, 'ascii');
    h.write('0000000\0', 116, 'ascii');
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    h.write(`${Math.floor(mtime).toString(8).padStart(11, '0')}\0`, 136, 'ascii');
    h.write('        ', 148, 'ascii');
    h.write('0', 156, 'ascii');
    h.write('ustar\0', 257, 'ascii');
    h.write('00', 263, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i];
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    return h;
}

export function tarEntry(name, buf) {
    const pad = (512 - (buf.length % 512)) % 512;
    return Buffer.concat([tarHeader(name, buf.length), buf, Buffer.alloc(pad, 0)]);
}

export const TAR_END = Buffer.alloc(1024, 0);

export default { tarHeader, tarEntry, TAR_END };
