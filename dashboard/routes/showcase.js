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

const router = express.Router();
const ID_RE = /^[a-f0-9]{16}$/;
const SEG_RE = /^seg\d+\.ts$/;
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── Page shell for the showcase's HTML pages ──
// The site design system (cf-ui.css: tokens, header, buttons, inputs) plus a few page rules, the
// visitor's saved theme, and the site header/footer. These pages are public and token-gated, so
// they stay small: no Bootstrap, no session lookups.
const PAGE_CSS = `
 *,*::before,*::after{box-sizing:border-box}
 body{margin:0;min-height:100vh;display:flex;flex-direction:column;overflow-x:hidden}
 .sc-main{flex:1 0 auto;width:100%;max-width:56rem;margin:0 auto;padding:calc(var(--cf-header-h) + var(--cf-8)) var(--cf-5) var(--cf-10)}
 .sc-main.is-narrow{max-width:30rem}
 .sc-eyebrow{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:999px;font-size:var(--cf-text-xs);font-weight:500;color:var(--cf-accent-fg);background:var(--cf-accent-soft);border:1px solid var(--cf-accent-line)}
 .sc-main h1{margin:10px 0 4px;font-size:var(--cf-text-2xl);font-weight:600;line-height:1.2;overflow-wrap:anywhere}
 .sc-sub{margin:0 0 var(--cf-5);color:var(--cf-text-3);font-size:var(--cf-text-md)}
 .sc-panel{background:var(--cf-surface);border:1px solid var(--cf-border);border-radius:var(--cf-radius-lg);padding:var(--cf-5)}
 .sc-field{display:flex;flex-direction:column;gap:6px;margin:0 0 var(--cf-4)}
 .sc-field label{font-size:var(--cf-text-sm);font-weight:500;color:var(--cf-text)}
 .sc-field input{width:100%;min-height:36px;padding:6px 10px;font:inherit;color:var(--cf-text);background:var(--cf-inset);border:1px solid var(--cf-border-strong);border-radius:var(--cf-radius)}
 .sc-field input[type=file]{padding:8px;border-style:dashed;color:var(--cf-text-2)}
 .sc-field input:focus-visible{outline:2px solid var(--cf-accent);outline-offset:0}
 .sc-panel .btn{width:100%;min-height:40px}
 .sc-msg{margin:var(--cf-3) 0 0;min-height:1.3em;font-size:var(--cf-text-sm);color:var(--cf-text-3)}
 .sc-msg.is-ok{color:var(--cf-success)} .sc-msg.is-bad{color:var(--cf-danger)}
 .sc-player video{display:block;width:100%;border-radius:var(--cf-radius-lg);background:#000;outline:none}
 .sc-note{margin:var(--cf-3) 0 0;text-align:center;color:var(--cf-text-3);font-size:var(--cf-text-xs)}
 .sc-foot{max-width:56rem;margin:0 auto;padding:0 var(--cf-5)} .sc-foot .footer-links{display:flex;flex-wrap:wrap}
 @media (max-width:640px){.sc-main{padding-left:var(--cf-4);padding-right:var(--cf-4)}}
`;
const THEME_JS = `(function(){try{var d=document.documentElement,t=localStorage.getItem('ui-theme');if(t)d.setAttribute('data-theme',t);var m=window.matchMedia?matchMedia('(prefers-color-scheme: light)'):null;if(d.getAttribute('data-theme')==='auto'){d.setAttribute('data-theme-mode','auto');d.setAttribute('data-theme',m&&m.matches?'light':'dark');}}catch(e){}})();`;

function showcasePage({ title, body, script = '', narrow = false }) {
  return `<!DOCTYPE html><html lang="en" data-theme="dark"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta name="darkreader-lock"><script>${THEME_JS}</script>
<title>${title}</title><link rel="icon" type="image/png" href="/images/CertiFried.png">
<style>${PAGE_CSS}</style>
<link rel="stylesheet" href="/css/cf-ui.css">
</head><body>
<nav class="navbar"><div class="navbar-container"><a href="/" class="navbar-brand"><img src="/images/CertiFried.png" alt="" class="navbar-logo"><span>CertiFried</span></a></div></nav>
<main class="sc-main${narrow ? ' is-narrow' : ''}">${body}</main>
<footer class="footer"><div class="sc-foot"><div class="footer-links"><a class="footer-link" href="/">CertiFried</a><a class="footer-link" href="/terms">Terms</a><a class="footer-link" href="/privacy">Privacy</a></div></div></footer>
${script}</body></html>`;
}

function showcaseMessage(res, status, heading, text) {
  return res.status(status).set('Content-Type', 'text/html; charset=utf-8').send(showcasePage({
    title: `${escapeHtml(heading)} - CertiFried`,
    narrow: true,
    body: `<span class="sc-eyebrow">Creator Showcase</span><h1>${escapeHtml(heading)}</h1><p class="sc-sub">${escapeHtml(text)}</p>`,
  }));
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

router.get('/showcase/upload/:token', (req, res) => {
  if (!verifyUploadToken(req.params.token)) {
    return showcaseMessage(res, 403, 'This upload link has expired', 'Upload links work for a short time only. Press Upload again in Discord to get a new one.');
  }
  res.set('Content-Type', 'text/html; charset=utf-8').send(showcasePage({
    title: 'Upload to the Showcase - CertiFried',
    narrow: true,
    body: `<span class="sc-eyebrow">Creator Showcase</span>
 <h1>Upload to the Showcase</h1>
 <p class="sc-sub">Audio or video, up to 250 MB. It is posted back to your Discord channel as a watermarked stream that can't be downloaded.</p>
 <form id="f" class="sc-panel">
   <div class="sc-field"><label for="file">File</label><input id="file" type="file" accept="audio/*,video/*" required></div>
   <div class="sc-field"><label for="title">Title</label><input id="title" type="text" maxlength="200" placeholder="Optional"></div>
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
  }));
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

// Player page
router.get('/showcase/:id', async (req, res) => {
  const item = await getItem(req.params.id).catch(() => null);
  if (!item) return showcaseMessage(res, 404, 'Not available', 'This piece was removed or the link is wrong.');
  const id = req.params.id;
  const token = signToken(id);
  const title = escapeHtml(item.title || (item.kind === 'video' ? 'Untitled video' : 'Untitled track'));
  // Audio is rendered as a waveform video, so everything plays in a <video> element.
  // The playlist URL goes into the script as JSON with '<' escaped.
  const src = JSON.stringify(`/showcase/${id}/playlist.m3u8?t=${encodeURIComponent(token)}`).replace(/</g, '\\u003c');
  res.set('Content-Type', 'text/html; charset=utf-8').send(showcasePage({
    title: `${title} - CertiFried`,
    body: `<span class="sc-eyebrow">Protected playback</span>
 <h1>${title}</h1>
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
  }));
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
