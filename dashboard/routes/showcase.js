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
    return res.status(403).send('<body style="font-family:sans-serif;background:#0b0f11;color:#f1f0f6;padding:2rem">This upload link has expired or is invalid. Tap <b>📤 Upload</b> again in Discord for a fresh one.</body>');
  }
  const t = escapeHtml(req.params.token);
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Upload to CertiFried Showcase</title><style>
 *{box-sizing:border-box;margin:0;padding:0} body{background:#0b0f11;color:#f1f0f6;font-family:Inter,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.25rem}
 .card{width:100%;max-width:440px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:1.6rem}
 h1{font-size:1.2rem;margin-bottom:.4rem} p{color:#928da8;font-size:.85rem;margin-bottom:1.1rem}
 label{display:block;font-size:.78rem;color:#b9b4cc;margin:.8rem 0 .35rem} input{width:100%;padding:.7rem;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#15131d;color:#f1f0f6;font-size:.9rem}
 button{width:100%;margin-top:1.2rem;padding:.8rem;border:0;border-radius:10px;background:#f0a500;color:#1a1205;font-weight:700;font-size:.95rem;cursor:pointer}
 button:disabled{opacity:.6;cursor:default} .msg{margin-top:1rem;font-size:.85rem;min-height:1.2rem}
</style></head><body><div class="card">
 <h1>🎶 Upload to the Showcase</h1>
 <p>Audio or video, up to 250&nbsp;MB. It posts back to Discord as a watermarked, no-download stream.</p>
 <form id="f">
   <label>Your file</label><input id="file" type="file" accept="audio/*,video/*" required>
   <label>Title (optional)</label><input id="title" type="text" maxlength="200" placeholder="Name your piece">
   <button id="b" type="submit">Upload</button>
 </form>
 <div class="msg" id="m"></div>
</div><script>
 var f=document.getElementById('f'),b=document.getElementById('b'),m=document.getElementById('m');
 f.onsubmit=async function(e){e.preventDefault();var fi=document.getElementById('file');if(!fi.files[0])return;
   b.disabled=true;b.textContent='Uploading & processing…';m.textContent='Please keep this tab open.';
   var fd=new FormData();fd.append('file',fi.files[0]);fd.append('title',document.getElementById('title').value||'');
   try{var r=await fetch(location.pathname,{method:'POST',body:fd});var j=await r.json().catch(function(){return{};});
     if(r.ok&&j.ok){m.style.color='#7dfc4f';m.textContent='✅ Posted to your channel! You can close this tab.';b.textContent='Done';}
     else{m.style.color='#ff6b6b';m.textContent='❌ '+(j.error||'Upload failed')+'. Get a fresh link in Discord.';b.disabled=false;b.textContent='Upload';}
   }catch(err){m.style.color='#ff6b6b';m.textContent='❌ Network error — try again.';b.disabled=false;b.textContent='Upload';}
 };
</script></body></html>`);
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
  if (!item) return res.status(404).send('Not found or no longer available.');
  const id = req.params.id;
  const token = signToken(id);
  const title = escapeHtml(item.title || (item.kind === 'video' ? 'Untitled video' : 'Untitled track'));
  const isVideo = item.kind === 'video';
  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${title} — CertiFried</title>
<style>
 *{box-sizing:border-box;margin:0;padding:0}
 body{background:#0b0f11;color:#f1f0f6;font-family:Inter,system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;padding:1.25rem}
 .wrap{width:100%;max-width:880px}
 h1{font-size:1.25rem;font-weight:700;margin-bottom:.25rem}
 .by{color:#928da8;font-size:.85rem;margin-bottom:1rem}
 video,audio{width:100%;border-radius:14px;background:#000;outline:none}
 .note{color:#6b6880;font-size:.72rem;margin-top:.9rem;text-align:center}
 .badge{display:inline-block;background:rgba(240,165,0,.15);color:#f0a500;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;letter-spacing:.04em}
</style></head><body>
<div class="wrap">
 <span class="badge">CERTIFRIED • PROTECTED PLAYBACK</span>
 <h1 style="margin-top:.7rem">${title}</h1>
 <div class="by">Creator content — streaming only, downloading disabled.</div>
 <${isVideo ? 'video' : 'audio'} id="p" controls playsinline controlsList="nodownload noplaybackrate" disablePictureInPicture oncontextmenu="return false"></${isVideo ? 'video' : 'audio'}>
 <div class="note">Please respect the creator — recording or redistributing this content is not allowed.</div>
</div>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.13/dist/hls.min.js"></script>
<script>
 var src = "/showcase/${id}/playlist.m3u8?t=${encodeURIComponent(token)}";
 var el = document.getElementById('p');
 if (el.canPlayType('application/vnd.apple.mpegurl')) { el.src = src; }
 else if (window.Hls && Hls.isSupported()) { var h = new Hls(); h.loadSource(src); h.attachMedia(el); }
 else { el.outerHTML = '<p>Your browser can\\'t play this stream.</p>'; }
 document.addEventListener('contextmenu', function(e){ if(e.target.tagName==='VIDEO'||e.target.tagName==='AUDIO') e.preventDefault(); });
</script>
</body></html>`);
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
