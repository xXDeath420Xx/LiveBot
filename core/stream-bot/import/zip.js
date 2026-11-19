/*
 * Stream bot import: a small, strict ZIP reader for uploaded profile folders. Nothing is written to disk; entries
 * come back as Buffers in memory.
 *
 *   readZip(buffer, limits) → { files: Map<path, Buffer>, skipped: [{ path, reason }] }   throws ImportError
 *
 * Refused outright: not a ZIP, ZIP64, encrypted entries, unknown compression, more entries or bytes than the
 * limits, an entry that inflates beyond its declared size. Skipped (listed, never read further): programs and
 * scripts (by extension or by their first bytes), nested archives, anything outside the allowed extensions.
 * Paths are normalised to forward slashes; ".." and absolute paths are refused.
 *
 * Tested in tests/stream-bot-import.test.js.
 */
import zlib from 'node:zlib';

export class ImportError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

export const ZIP_LIMITS = Object.freeze({ entries: 3000, entryBytes: 24 * 1024 * 1024, totalBytes: 80 * 1024 * 1024, ratio: 200 });

/** Extensions that are programs or scripts: never read. */
export const EXECUTABLE_EXT = /\.(exe|dll|com|bat|cmd|ps1|psm1|vbs|vbe|js|mjs|cjs|jse|wsf|wsh|msi|msp|scr|cpl|jar|sh|py|pyc|rb|pl|php|cs|csx|lnk|reg|hta|node|so|dylib|app|apk)$/i;
/** Extensions the importer reads. Everything else is listed as skipped. */
export const READ_EXT = /\.(json|db|db-wal|db-shm|dat|txt|firebotsetup|sb|csv)$/i;

const sig = (b, o) => b.readUInt32LE(o);

/** First bytes of a program: MZ (Windows), ELF, Mach-O, a #! script. */
export function looksExecutable(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 2) return false;
    if (buf[0] === 0x4d && buf[1] === 0x5a) return true; // MZ
    if (buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true; // ELF
    if (buf.length >= 4) {
        const m = buf.readUInt32BE(0);
        if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(m)) return true; // Mach-O / fat / Java class
    }
    return buf[0] === 0x23 && buf[1] === 0x21; // #!
}

export const isZip = (buf) => Buffer.isBuffer(buf) && buf.length >= 22 && sig(buf, 0) === 0x04034b50;

function cleanPath(name) {
    const p = String(name).replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!p || p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').some((s) => s === '..')) return null;
    return p;
}

export function readZip(buf, limits = {}) {
    const L = { ...ZIP_LIMITS, ...limits };
    if (!isZip(buf)) throw new ImportError('not_zip', 'That file is not a ZIP archive.');
    // End of central directory: the last 22 bytes plus up to 64 KB of comment.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
        if (sig(buf, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new ImportError('bad_zip', 'The ZIP archive is damaged (no directory at the end).');
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOff = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) throw new ImportError('zip64', 'ZIP64 archives are not supported. Zip the folder with Windows (Send to, Compressed folder).');
    if (count > L.entries) throw new ImportError('too_many', `The archive has more than ${L.entries} files.`);
    if (cdOff + cdSize > buf.length) throw new ImportError('bad_zip', 'The ZIP archive is damaged.');

    const files = new Map();
    const skipped = [];
    let total = 0;
    let p = cdOff;
    for (let n = 0; n < count; n++) {
        if (p + 46 > buf.length || sig(buf, p) !== 0x02014b50) throw new ImportError('bad_zip', 'The ZIP archive is damaged (directory entry).');
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const csize = buf.readUInt32LE(p + 20);
        const usize = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOff = buf.readUInt32LE(p + 42);
        const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
        p += 46 + nameLen + extraLen + commentLen;

        if (rawName.endsWith('/') || rawName.endsWith('\\')) continue; // folder
        const name = cleanPath(rawName);
        if (!name) { skipped.push({ path: rawName.slice(0, 200), reason: 'unsafe path' }); continue; }
        if (EXECUTABLE_EXT.test(name)) { skipped.push({ path: name, reason: 'program or script (not read)' }); continue; }
        if (/\.(zip|7z|rar|gz|tar|tgz)$/i.test(name)) { skipped.push({ path: name, reason: 'archive inside the archive (not read)' }); continue; }
        if (!READ_EXT.test(name)) { skipped.push({ path: name, reason: 'not a file the importer reads' }); continue; }
        if (flags & 0x1) throw new ImportError('encrypted', 'The ZIP archive is password protected. Zip the folder again without a password.');
        if (method !== 0 && method !== 8) throw new ImportError('method', 'The ZIP archive uses a compression method that is not supported.');
        if (usize > L.entryBytes) throw new ImportError('too_big', `${name} is larger than ${Math.round(L.entryBytes / 1048576)} MB.`);
        if (csize > 0 && usize / csize > L.ratio) throw new ImportError('ratio', 'The ZIP archive is compressed suspiciously well. Zip the folder again.');
        total += usize;
        if (total > L.totalBytes) throw new ImportError('too_big', `The archive unpacks to more than ${Math.round(L.totalBytes / 1048576)} MB.`);

        if (localOff + 30 > buf.length || sig(buf, localOff) !== 0x04034b50) throw new ImportError('bad_zip', 'The ZIP archive is damaged (file header).');
        const lName = buf.readUInt16LE(localOff + 26);
        const lExtra = buf.readUInt16LE(localOff + 28);
        const start = localOff + 30 + lName + lExtra;
        if (start + csize > buf.length) throw new ImportError('bad_zip', 'The ZIP archive is damaged (file data).');
        const data = buf.subarray(start, start + csize);
        let out;
        try {
            out = method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, usize) });
        } catch {
            throw new ImportError('bad_zip', `${name} could not be unpacked.`);
        }
        if (out.length !== usize) throw new ImportError('bad_zip', `${name} unpacked to a different size than the archive says.`);
        if (looksExecutable(out)) { skipped.push({ path: name, reason: 'program or script (not read)' }); continue; }
        files.set(name, out);
    }
    return { files, skipped };
}

export default { readZip, isZip, looksExecutable, ImportError, ZIP_LIMITS, EXECUTABLE_EXT };
