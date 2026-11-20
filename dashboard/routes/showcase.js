// Tokenized player + AES-HLS serving for the Creator Showcase.
//   GET /showcase/:id                 → player page (mints a short-lived token)
//   GET /showcase/:id/playlist.m3u8   → token-gated; rewrites key/segment URIs with the token
//   GET /showcase/:id/key             → token-gated; serves the AES-128 key
//   GET /showcase/:id/segNNN.ts       → token-gated; serves the (encrypted) segment
//
// Segments live OUTSIDE express.static and are AES-encrypted on disk, so the only way to
// play is through this gate; the key is only handed out with a valid, unexpired token.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import pool from '../../utils/db.js';
import {
  SHOWCASE_DIR, signToken, verifyToken,
  verifyUploadToken, ingestWebUpload, isShowcaseChannel,
} from '../../core/showcase-manager.js';
import { sendFramed } from '../services/site-frame.js';
import { stylesheetTag } from '../services/framed-assets.js';

const router = express.Router();
const ID_RE = /^[a-f0-9]{16}$/;
const SEG_RE = /^seg\d+\.ts$/;
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── Page shell for the showcase's HTML pages ──
// The shared site frame (views/site-frame.ejs via services/site-frame.js: site header and footer,
// the visitor's theme with no flash) and the page parts in css/cf-public-pages.css (.sc-*).
// showcasePage() returns the frame's locals; it is pure, so scripts/theme-audit renders it too.
// `title` is plain text (the frame escapes it); `body` and `script` are trusted HTML.
export function showcasePage({ title, body, script = '', narrow = false }) {
  return {
    title: `${title} · CertiFried`,
    description: 'CertiFried Creator Showcase: protected playback for creator content shared in Discord.',
    noindex: true,
    headHtml: stylesheetTag('/css/cf-public-pages.css'),
    bodyHtml: `<main id="main-content" tabindex="-1" class="cfs-main cfs-main--narrow${narrow ? ' sc-narrow' : ''}">${body}</main>`,
    scriptsHtml: script,
  };
}

// Render failures end as a plain 500, never as an unhandled rejection.
function framed(req, res, opts, status = null) {
  return sendFramed(req, res, opts, status).catch(() => { if (!res.headersSent) res.status(500).type('text/plain').send('Page failed to render'); });
}

/** A short message page (expired link, removed piece). */
export function showcaseMessagePage(heading, text) {
  return showcasePage({
    title: heading,
    narrow: true,
    body: `<span class="sc-eyebrow">Creator Showcase</span><h1 class="sc-title">${escapeHtml(heading)}</h1><p class="sc-sub">${escapeHtml(text)}</p>`,
  });
}

function showcaseMessage(req, res, status, heading, text) {
  return framed(req, res, showcaseMessagePage(heading, text), status);
}

// ── Web upload (button → ephemeral link → this form; file never touches Discord) ──
const UPLOAD_TMP = path.join(SHOWCASE_DIR, '_uploads');
fs.mkdirSync(UPLOAD_TMP, { recursive: true });
const upload = multer({
  dest: UPLOAD_TMP,
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^(audio|video)\//.test(file.mimetype) ||
      /\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|aiff?|mp4|mov|webm|mkv|avi|m4v|flv|wmv)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only audio/video files are accepted'), ok);
  },
});

/** The upload form (GET /showcase/upload/:token); the form posts back to the same URL. */
export function showcaseUploadPage() {
  return showcasePage({
    title: 'Upload to the Showcase',
    narrow: true,
    body: `<span class="sc-eyebrow">Creator Showcase</span>
 <h1 class="sc-title">Upload to the Showcase</h1>
 <p class="sc-sub">Audio or video, up to 250 MB. It is posted back to your Discord channel as a watermarked stream that can't be downloaded.</p>
 <form id="f" class="sc-panel cfs-panel cfs-panel-pad">
   <div class="sc-field"><label for="file">File</label><input id="file" class="form-control" type="file" accept="audio/*,video/*" required></div>
   <div class="sc-field"><label for="title">Title</label><input id="title" class="form-control" type="text" maxlength="200" placeholder="Optional"></div>
   <button id="b" type="submit" class="btn btn-primary">Upload</button>
   <p class="sc-msg" id="m" role="status" aria-live="polite"></p>
 </form>`,
    script: `<script>
 var f=document.getElementById('f'),b=document.getElementById('b'),m=document.getElementById('m');
 function say(t,tone){m.textContent=t;m.className='sc-msg'+(tone?' is-'+tone:'');}
 f.onsubmit=async function(e){e.preventDefault();var fi=document.getElementById('file');if(!fi.files[0]){say('Choose a file first.','bad');return;}
   b.disabled=true;b.textContent='Uploading and processing…';say('Keep this tab open until it finishes.');
   var fd=new FormData();fd.append('file',fi.files[0]);fd.append('title',document.getElementById('title').value||'');
   try{var r=await fetch(location.pathname,{method:'POST',body:fd});var j=await r.json().catch(function(){return{};});
     if(r.ok&&j.ok){say('Posted to your channel. You can close this tab.','ok');b.textContent='Done';}
     else{say((j.error||'Upload failed')+'. Get a new link in Discord and try again.','bad');b.disabled=false;b.textContent='Upload';}
   }catch(err){say('Network error. Try again.','bad');b.disabled=false;b.textContent='Upload';}
 };
</script>`,
  });
}

router.get('/showcase/upload/:token', (req, res) => {
  if (!verifyUploadToken(req.params.token)) {
    return showcaseMessage(req, res, 403, 'This upload link has expired', 'Upload links work for a short time only. Press Upload again in Discord to get a new one.');
  }
  return framed(req, res, showcaseUploadPage());
});

router.post('/showcase/upload/:token', upload.single('file'), async (req, res) => {
  const cleanup = () => { if (req.file?.path) fs.unlink(req.file.path, () => {}); };
  const claim = verifyUploadToken(req.params.token);
  if (!claim) { cleanup(); return res.status(403).json({ error: 'Link expired' }); }
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  try {
    if (!(await isShowcaseChannel(claim.channelId))) { cleanup(); return res.status(400).json({ error: 'Channel is no longer a showcase' }); }
    await ingestWebUpload({
      inputPath: req.file.path, name: req.file.originalname, size: req.file.size,
      guildId: claim.guildId, channelId: claim.channelId, creatorId: claim.userId,
      title: (req.body.title || '').slice(0, 200),
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Processing failed' });
  } finally { cleanup(); }
});

async function getItem(id) {
  if (!ID_RE.test(id)) return null;
  const [rows] = await pool.execute('SELECT * FROM showcase_items WHERE id = ?', [id]);
  return rows[0] || null;
}
const gate = (req, res) => {
  const id = req.params.id;
  if (!ID_RE.test(id) || !verifyToken(id, req.query.t)) { res.status(403).end('forbidden'); return null; }
  return id;
};

/** The player page; `src` is the playlist URL already JSON-encoded with '<' escaped. */
export function showcasePlayerPage({ rawTitle, src }) {
  const title = escapeHtml(rawTitle);
  return showcasePage({
    title: rawTitle,
    body: `<span class="sc-eyebrow">Protected playback</span>
 <h1 class="sc-title">${title}</h1>
 <p class="sc-sub">Creator content. Streaming only; downloading is turned off.</p>
 <div class="sc-player"><video id="p" controls playsinline controlsList="nodownload noplaybackrate" disablePictureInPicture oncontextmenu="return false"></video></div>
 <p class="sc-note">Please respect the creator: recording or sharing this content is not allowed.</p>`,
    script: `<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>
<script>
 var src = ${src};
 var el = document.getElementById('p');
 if (el.canPlayType('application/vnd.apple.mpegurl')) { el.src = src; }
 else if (window.Hls && Hls.isSupported()) { var h = new Hls(); h.loadSource(src); h.attachMedia(el); }
 else { var n = document.createElement('p'); n.className = 'sc-note'; n.textContent = "Your browser can't play this stream."; el.replaceWith(n); }
 document.addEventListener('contextmenu', function(e){ if(e.target.tagName==='VIDEO'||e.target.tagName==='AUDIO') e.preventDefault(); });
</script>`,
  });
}

// Player page
router.get('/showcase/:id', async (req, res) => {
  const item = await getItem(req.params.id).catch(() => null);
  if (!item) return showcaseMessage(req, res, 404, 'Not available', 'This piece was removed or the link is wrong.');
  const id = req.params.id;
  const token = signToken(id);
  const rawTitle = String(item.title || (item.kind === 'video' ? 'Untitled video' : 'Untitled track'));
  // Audio is rendered as a waveform video, so everything plays in a <video> element.
  // The playlist URL goes into the script as JSON with '<' escaped.
  const src = JSON.stringify(`/showcase/${id}/playlist.m3u8?t=${encodeURIComponent(token)}`).replace(/</g, '\\u003c');
  return framed(req, res, showcasePlayerPage({ rawTitle, src }));
});

// Playlist — rewrite key + segment URIs to carry the token
router.get('/showcase/:id/playlist.m3u8', (req, res) => {
  const id = gate(req, res); if (!id) return;
  const file = path.join(SHOWCASE_DIR, id, 'playlist.m3u8');
  if (!fs.existsSync(file)) return res.status(404).end();
  const t = encodeURIComponent(req.query.t);
  const body = fs.readFileSync(file, 'utf8')
    .replace(/URI="key"/g, `URI="key?t=${t}"`)
    .replace(/^(seg\d+\.ts)$/gm, `$1?t=${t}`);
  res.set('Content-Type', 'application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(body);
});

// AES key — only with a valid token
router.get('/showcase/:id/key', (req, res) => {
  const id = gate(req, res); if (!id) return;
  const file = path.join(SHOWCASE_DIR, id, 'enc.key');
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Content-Type', 'application/octet-stream').set('Cache-Control', 'no-store').send(fs.readFileSync(file));
});

// Encrypted segments
router.get('/showcase/:id/:file', (req, res) => {
  const id = gate(req, res); if (!id) return;
  if (!SEG_RE.test(req.params.file)) return res.status(404).end();
  const file = path.join(SHOWCASE_DIR, id, req.params.file);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.set('Content-Type', 'video/mp2t').set('Cache-Control', 'no-store').sendFile(file);
});

export default router;
