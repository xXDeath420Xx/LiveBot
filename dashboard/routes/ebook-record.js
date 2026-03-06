import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { execFile } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const EBOOK_DIR = path.join(__dirname, '..', 'public', 'ebook');
const TEMP_DIR = path.join(EBOOK_DIR, '.tmp-recordings');

// Track conversion status per book
const conversionStatus = {};

// Multer config for large audio uploads (disk storage, 1GB limit)
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
        cb(null, TEMP_DIR);
    },
    filename: (req, file, cb) => {
        const bookNum = req.body.book || 'unknown';
        cb(null, `book${bookNum}-upload-${Date.now()}.webm`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('audio/') || file.mimetype === 'video/webm') {
            cb(null, true);
        } else {
            cb(new Error('Only audio files are accepted'));
        }
    },
});

// POST /api/ebook/record/upload - Receive recorded audio
router.post('/record/upload', upload.single('audio'), async (req, res) => {
    const bookNum = req.body.book;
    if (!bookNum || !['1', '2', '3'].includes(bookNum)) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Invalid book number. Must be 1, 2, or 3.' });
    }

    if (!req.file) {
        return res.status(400).json({ error: 'No audio file received.' });
    }

    const inputPath = req.file.path;
    const outputPath = path.join(EBOOK_DIR, `book${bookNum}-audiobook.mp3`);

    // Start async conversion
    conversionStatus[bookNum] = { status: 'converting', progress: '' };
    res.json({ status: 'accepted', message: 'Upload received. Converting to MP3...' });

    // Convert WebM to MP3 with ffmpeg
    try {
        await convertToMp3(inputPath, outputPath, bookNum);
        conversionStatus[bookNum] = { status: 'complete' };

        // Clean up temp file
        fs.unlinkSync(inputPath);
    } catch (err) {
        conversionStatus[bookNum] = { status: 'error', message: err.message };
        // Clean up temp file on error too
        try { fs.unlinkSync(inputPath); } catch (e) { /* ignore */ }
    }
});

// GET /api/ebook/record/status/:book - Check conversion status
router.get('/record/status/:book', (req, res) => {
    const bookNum = req.params.book;
    const status = conversionStatus[bookNum] || { status: 'unknown' };
    res.json(status);
});

// Convert WebM/Opus to MP3 using ffmpeg
function convertToMp3(inputPath, outputPath, bookNum) {
    return new Promise((resolve, reject) => {
        const args = [
            '-y',               // Overwrite output
            '-i', inputPath,    // Input file
            '-vn',              // No video
            '-ar', '44100',     // Sample rate
            '-ac', '1',         // Mono
            '-b:a', '128k',     // Bitrate
            '-map_metadata', '-1',
            '-metadata', `title=The Blank Slate Trilogy - Book ${bookNum}`,
            '-metadata', 'artist=Speechify',
            '-metadata', 'album=The Blank Slate Trilogy',
            outputPath,
        ];

        const proc = execFile('ffmpeg', args, {
            timeout: 600000, // 10 minute timeout
        }, (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`ffmpeg conversion failed: ${error.message}`));
            } else {
                resolve();
            }
        });

        // Update progress based on ffmpeg stderr output
        proc.stderr.on('data', (data) => {
            const timeMatch = data.toString().match(/time=(\d+:\d+:\d+)/);
            if (timeMatch) {
                conversionStatus[bookNum].progress = `Processed ${timeMatch[1]}`;
            }
        });
    });
}

export default router;
