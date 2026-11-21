#!/usr/bin/env python3
"""
CertiFried voice sidecar (own-voice feature, docs: voice-cloning-design.md 2.2, 2.5, 5.5).

One persistent CPU process so the models load once. It speaks HTTP over a Unix socket only
(mode 0600, owned by death); nothing listens on a TCP port.

  POST /embed               body: WAV (16-bit PCM, any rate, mono or stereo)
                            -> {"duration_s", "rms_db", "peak", "clip_ratio",
                                "redimnet": [192 floats], "ecapa": [192 floats]}
  POST /watermark?msg=N     body: WAV -> WAV with an inaudible AudioSeal mark carrying the 16-bit N
  POST /detect              body: WAV -> {"prob", "message", "bits"}
  GET  /health              -> {"ok": true, "models": [...]}

Models (licences in THIRD_PARTY_NOTICES.md):
  ReDimNet b2 / ft_lm / vox2 (IDRnD, MIT code), through torch.hub.
  SpeechBrain spkrec-ecapa-voxceleb (Apache-2.0).
  AudioSeal 0.2 audioseal_wm_16bits + audioseal_detector_16bits (MIT code and weights since 0.2).

Run under pm2 (services/voice-sidecar/ecosystem.config.cjs). Two torch threads, inference mode only.
"""
import io
import json
import os
import socketserver
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import numpy as np
import soundfile as sf
import torch
import torchaudio

torch.set_num_threads(int(os.environ.get('VOICE_SIDECAR_THREADS', '2')))
torch.set_grad_enabled(False)

SOCKET = os.environ.get('VOICE_SIDECAR_SOCKET', '/home/death/certifried-data/voice/run/sidecar.sock')
CACHE = os.environ.get('VOICE_SIDECAR_CACHE', '/home/death/voice-sidecar/models')
REDIMNET_REPO = os.environ.get('VOICE_REDIMNET_REPO', 'IDRnD/ReDimNet')
MAX_BODY = 25 * 1024 * 1024
SR = 16000

os.makedirs(CACHE, exist_ok=True)
os.environ.setdefault('TORCH_HOME', os.path.join(CACHE, 'torch'))
os.environ.setdefault('HF_HOME', os.path.join(CACHE, 'hf'))
os.environ.setdefault('HF_HUB_DISABLE_TELEMETRY', '1')

LOCK = threading.Lock()
MODELS = {}


def log(*a):
    print(time.strftime('%Y-%m-%dT%H:%M:%S'), *a, flush=True)


def inference_only(m):
    m.train(False)
    return m


def load_models():
    t0 = time.time()
    torch.hub.set_dir(os.environ['TORCH_HOME'])
    MODELS['redimnet'] = inference_only(torch.hub.load(REDIMNET_REPO, 'ReDimNet', model_name='b2', train_type='ft_lm', dataset='vox2', trust_repo=True))
    from speechbrain.inference.speaker import EncoderClassifier
    MODELS['ecapa'] = EncoderClassifier.from_hparams(source='speechbrain/spkrec-ecapa-voxceleb', savedir=os.path.join(CACHE, 'ecapa'),
                                                     run_opts={'device': 'cpu'})
    from audioseal import AudioSeal
    MODELS['wm_gen'] = inference_only(AudioSeal.load_generator('audioseal_wm_16bits'))
    MODELS['wm_det'] = inference_only(AudioSeal.load_detector('audioseal_detector_16bits'))
    # The first pass through each model is several seconds slower (allocator and kernel warm-up): pay it here.
    buf = io.BytesIO()
    sf.write(buf, (np.random.default_rng(1).standard_normal(SR * 2) * 0.05).astype('float32'), SR, subtype='PCM_16', format='WAV')
    warm = buf.getvalue()
    with torch.inference_mode():
        embed(warm)
        detect(watermark(warm, 1))
    log(f'models loaded and warmed in {time.time() - t0:.1f}s')


def read_wav(body):
    data, rate = sf.read(io.BytesIO(body), dtype='float32', always_2d=True)
    mono = data.mean(axis=1)
    return torch.from_numpy(np.ascontiguousarray(mono)), int(rate)


def to16k(wav, rate):
    if rate == SR:
        return wav
    return torchaudio.functional.resample(wav, rate, SR)


def unit(v):
    v = v.flatten().double()
    n = torch.linalg.norm(v)
    return (v / n if n > 0 else v).tolist()


def embed(body):
    wav, rate = read_wav(body)
    if wav.numel() < rate * 0.5:
        raise ValueError('clip shorter than half a second')
    peak = float(wav.abs().max())
    clip_ratio = float((wav.abs() >= 0.999).float().mean())
    rms = float(torch.sqrt(torch.mean(wav ** 2)) + 1e-12)
    w16 = to16k(wav, rate)
    r = MODELS['redimnet'](w16.unsqueeze(0))
    e = MODELS['ecapa'].encode_batch(w16.unsqueeze(0))
    return {
        'duration_s': round(wav.numel() / rate, 3),
        'rms_db': round(20 * float(np.log10(rms)), 2),
        'peak': round(peak, 4),
        'clip_ratio': round(clip_ratio, 5),
        'redimnet': unit(r),
        'ecapa': unit(e),
    }


def msg_bits(n):
    n = int(n)
    if not 0 <= n <= 0xFFFF:
        raise ValueError('message must be 0..65535')
    return torch.tensor([[(n >> (15 - i)) & 1 for i in range(16)]], dtype=torch.int32)


def watermark(body, n):
    wav, rate = read_wav(body)
    x16 = to16k(wav, rate).view(1, 1, -1)
    wm16 = MODELS['wm_gen'].get_watermark(x16, sample_rate=SR, message=msg_bits(n)).view(-1)
    wm = wm16 if rate == SR else torchaudio.functional.resample(wm16, SR, rate)
    if wm.numel() < wav.numel():
        wm = torch.nn.functional.pad(wm, (0, wav.numel() - wm.numel()))
    out = torch.clamp(wav + wm[: wav.numel()], -1.0, 1.0).detach().numpy()
    buf = io.BytesIO()
    sf.write(buf, out, rate, subtype='PCM_16', format='WAV')
    return buf.getvalue()


def detect(body):
    wav, rate = read_wav(body)
    x16 = to16k(wav, rate).view(1, 1, -1)
    prob, message = MODELS['wm_det'].detect_watermark(x16, sample_rate=SR)
    bits = [int(b) for b in message.view(-1).tolist()]
    value = 0
    for b in bits:
        value = (value << 1) | (b & 1)
    return {'prob': round(float(prob), 4), 'message': value, 'bits': ''.join(str(b) for b in bits)}


class Handler(BaseHTTPRequestHandler):
    server_version = 'cf-voice-sidecar/1'

    def log_message(self, fmt, *args):
        pass

    def address_string(self):
        return 'unix'

    def reply(self, code, payload, ctype='application/json'):
        body = payload if isinstance(payload, (bytes, bytearray)) else json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == '/health':
            return self.reply(200, {'ok': bool(MODELS), 'models': sorted(MODELS.keys())})
        return self.reply(404, {'error': 'not found'})

    def do_POST(self):
        u = urlparse(self.path)
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0 or length > MAX_BODY:
            return self.reply(413, {'error': 'body missing or too large'})
        body = self.rfile.read(length)
        try:
            # grad mode is per thread in torch: every request runs in inference mode on its own handler thread
            with LOCK, torch.inference_mode():
                if u.path == '/embed':
                    return self.reply(200, embed(body))
                if u.path == '/watermark':
                    n = parse_qs(u.query).get('msg', [''])[0]
                    return self.reply(200, watermark(body, n), 'audio/wav')
                if u.path == '/detect':
                    return self.reply(200, detect(body))
            return self.reply(404, {'error': 'not found'})
        except ValueError as e:
            return self.reply(400, {'error': str(e)[:200]})
        except Exception as e:  # noqa: BLE001
            log('error', u.path, repr(e)[:300])
            traceback.print_exc(limit=3)
            return self.reply(500, {'error': 'sidecar failed'})


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    load_models()
    os.makedirs(os.path.dirname(SOCKET), mode=0o700, exist_ok=True)
    try:
        os.unlink(SOCKET)
    except FileNotFoundError:
        pass
    old = os.umask(0o177)
    srv = Server(SOCKET, Handler)
    os.umask(old)
    os.chmod(SOCKET, 0o600)
    log('listening on', SOCKET)
    try:
        srv.serve_forever()
    finally:
        try:
            os.unlink(SOCKET)
        except OSError:
            pass


if __name__ == '__main__':
    sys.exit(main())
