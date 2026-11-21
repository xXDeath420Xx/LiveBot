#!/usr/bin/env python3
"""
Calibrate the own-voice speaker-verification thresholds (design 2.2) on public test audio.

Data: LibriSpeech dev-clean (CC BY 4.0, openslr.org/12), 40 speakers x 12 utterances. Each utterance is scored clean
and degraded the way real recordings are: Opus 32 kbps, Opus 24 kbps with a 3.4 kHz band limit (a poor headset),
and room noise at 15 dB SNR.

Decisions calibrated (both models, ReDimNet b2 and ECAPA-TDNN):
  tLo  one recording against the 3-clip consent voiceprint: FAR 1% over impostor trials (other speakers' clips)
  tHi  the recordings' centroid (8 clips) against the consent voiceprint: above every impostor centroid score,
       targeting FAR 0.1% (the impostor set is small, so tHi = max(quantile 99.9%, max impostor + 0.02))
Writes core/voice-clone/thresholds.json with the false-reject rates measured at those thresholds and the SHA-256
of the trial list, so the version recorded in each consent row can be traced.

  venv/bin/python calibrate.py /home/death/voice-sidecar/calib/LibriSpeech/dev-clean OUT.json
"""
import hashlib
import io
import json
import os
import random
import subprocess
import sys
import time

import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402

ROOT = sys.argv[1]
OUT = sys.argv[2]
SPEAKERS = 40
PER = 12
rng = random.Random(476)


def wav_bytes(x, rate):
    b = io.BytesIO()
    sf.write(b, x, rate, subtype='PCM_16', format='WAV')
    return b.getvalue()


def ffmpeg_roundtrip(wav, args):
    enc = subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-i', 'pipe:0', *args, '-f', 'ogg', 'pipe:1'], input=wav, capture_output=True, check=True).stdout
    return subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'], input=enc, capture_output=True, check=True).stdout


def variants(x, rate):
    clean = wav_bytes(x, rate)
    noise = np.random.default_rng(len(x)).standard_normal(len(x)).astype('float32')
    p_sig = float(np.mean(x ** 2)) + 1e-9
    noisy = x + noise * np.sqrt(p_sig / (10 ** 1.5))
    return {
        'clean': clean,
        'opus32': ffmpeg_roundtrip(clean, ['-c:a', 'libopus', '-b:a', '32k']),
        'headset': ffmpeg_roundtrip(clean, ['-af', 'lowpass=f=3400,highpass=f=200', '-c:a', 'libopus', '-b:a', '24k']),
        'noise15': wav_bytes(np.clip(noisy, -1, 1).astype('float32'), rate),
    }


def unit(v):
    v = np.asarray(v, dtype='float64')
    return v / (np.linalg.norm(v) or 1)


def cent(vs):
    return unit(np.mean([unit(v) for v in vs], axis=0))


def main():
    server.load_models()
    spk = sorted(d for d in os.listdir(ROOT) if os.path.isdir(os.path.join(ROOT, d)))
    rng.shuffle(spk)
    spk = spk[:SPEAKERS]
    data = {}
    trial_list = []
    t0 = time.time()
    for s in spk:
        files = []
        for ch in sorted(os.listdir(os.path.join(ROOT, s))):
            d = os.path.join(ROOT, s, ch)
            files += [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.endswith('.flac')]
        rng.shuffle(files)
        chosen = []
        for f in files:
            x, rate = sf.read(f, dtype='float32')
            if 3.0 <= len(x) / rate <= 15.0:
                chosen.append((f, x, rate))
            if len(chosen) >= PER:
                break
        data[s] = []
        for f, x, rate in chosen:
            trial_list.append(os.path.relpath(f, ROOT))
            embs = {}
            for k, w in variants(x, rate).items():
                e = server.embed(w)
                embs[k] = {'redimnet': e['redimnet'], 'ecapa': e['ecapa']}
            data[s].append(embs)
        print(f'{s}: {len(data[s])} clips, {time.time() - t0:.0f}s', flush=True)

    result = {'models': {}}
    arrays = {}
    for model in ('redimnet', 'ecapa'):
        gen_clip, imp_clip, gen_cent, imp_cent = [], [], [], []
        consent = {}
        for s, clips in data.items():
            consent[s] = cent([c['clean'][model] for c in clips[:3]])
        for s, clips in data.items():
            test = clips[3:]
            for c in test:
                for k in ('clean', 'opus32', 'headset', 'noise15'):
                    gen_clip.append(float(np.dot(unit(c[k][model]), consent[s])))
            sample_c = {k: cent([c[k][model] for c in test]) for k in ('clean', 'opus32', 'headset', 'noise15')}
            for k, v in sample_c.items():
                gen_cent.append(float(np.dot(v, consent[s])))
            for o, oclips in data.items():
                if o == s:
                    continue
                for c in oclips[3:]:
                    for k in ('clean', 'opus32', 'headset', 'noise15'):
                        imp_clip.append(float(np.dot(unit(c[k][model]), consent[s])))
                for k in ('clean', 'opus32', 'headset', 'noise15'):
                    imp_cent.append(float(np.dot(cent([c[k][model] for c in oclips[3:]]), consent[s])))
        gen_clip, imp_clip, gen_cent, imp_cent = map(np.array, (gen_clip, imp_clip, gen_cent, imp_cent))
        t_lo = float(np.quantile(imp_clip, 0.99))
        t_hi = float(max(np.quantile(imp_cent, 0.999), imp_cent.max() + 0.02))
        arrays[model] = (gen_clip, imp_clip, gen_cent, imp_cent, t_lo, t_hi)
        result['models'][model] = {
            'tLo': round(t_lo, 4), 'tHi': round(t_hi, 4),
            'clip': {'genuine_trials': int(gen_clip.size), 'impostor_trials': int(imp_clip.size),
                     'genuine_min': round(float(gen_clip.min()), 4), 'genuine_mean': round(float(gen_clip.mean()), 4),
                     'impostor_max': round(float(imp_clip.max()), 4), 'impostor_mean': round(float(imp_clip.mean()), 4),
                     'frr_at_tLo': round(float((gen_clip < t_lo).mean()), 4), 'far_at_tLo': round(float((imp_clip >= t_lo).mean()), 4)},
            'centroid': {'genuine_trials': int(gen_cent.size), 'impostor_trials': int(imp_cent.size),
                         'genuine_min': round(float(gen_cent.min()), 4), 'impostor_max': round(float(imp_cent.max()), 4),
                         'frr_at_tHi': round(float((gen_cent < t_hi).mean()), 4), 'far_at_tHi': round(float((imp_cent >= t_hi).mean()), 4)},
        }
    # both models must agree: the joint rates
    r, e = arrays['redimnet'], arrays['ecapa']
    result['joint'] = {
        'clip_frr': round(float(((r[0] < r[4]) | (e[0] < e[4])).mean()), 4),
        'clip_far': round(float(((r[1] >= r[4]) & (e[1] >= e[4])).mean()), 5),
        'centroid_frr': round(float(((r[2] < r[5]) | (e[2] < e[5])).mean()), 4),
        'centroid_far': round(float(((r[3] >= r[5]) & (e[3] >= e[5])).mean()), 5),
    }
    result['dataset'] = f'LibriSpeech dev-clean (CC BY 4.0), {len(data)} speakers x {PER} utterances, variants clean/opus32/headset/noise15'
    result['trials_sha256'] = hashlib.sha256('\n'.join(trial_list).encode()).hexdigest()
    result['seconds'] = round(time.time() - t0)
    json.dump(result, open(OUT, 'w'), indent=2)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
