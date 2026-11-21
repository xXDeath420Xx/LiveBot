#!/usr/bin/env bash
# CertiFried own-voice training job, run inside WSL by voice-worker.ps1 (one job at a time).
#
#   train_job.sh <job_dir> <steps> <base_ckpt> [espeak_voice]   (espeak voice from the server, default en-us; Bear: en-gb-x-rp)
#
#   job_dir    ~/voice-work/<job id>: the plain scratch folder (mode 0700, ext4). The worker has already piped the
#              decrypted dataset into <job_dir>/dataset (wavs/<id>.wav + metadata.csv) and, when resuming, the decrypted
#              last checkpoint into <job_dir>/train. Nothing here is ever written to the Windows disk in plain form; the
#              worker shreds this folder as soon as this script stops, ends or fails.
#   steps      fine-tune steps (generator steps; Lightning counts generator + discriminator, so max_steps = 2x)
#   base_ckpt  the LibriTTS-R medium checkpoint (CC BY 4.0), SHA-256 checked by the worker
#
# Fine-tunes ONLY on the person's own recordings: no synthetic data and no zero-shot model (owner decision 2026-11-20).
# Uses piper1-gpl (GPL-3.0) from ~/voice-lab/venv-piper as a separate program. Writes:
#   <job_dir>/progress      "step total" every 30 s
#   <job_dir>/train.pid     the process group to stop (SIGTERM to -pgid; last.ckpt is written at each validation)
#   <job_dir>/export/model.onnx(.json) and <job_dir>/done   when finished
set -euo pipefail
umask 077
JOB="$1"; STEPS="$2"; BASE="$3"; ESPEAK="${4:-en-us}"
[[ "$ESPEAK" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || { echo "bad espeak voice" >&2; exit 3; }
LAB="$HOME/voice-lab"
PY="$LAB/venv-piper/bin/python"
[ -x "$PY" ] || { echo "no piper venv at $PY" >&2; exit 3; }
[ -s "$BASE" ] || { echo "no base checkpoint at $BASE" >&2; exit 3; }
[ -s "$JOB/dataset/metadata.csv" ] || { echo "no dataset in $JOB" >&2; exit 4; }
mkdir -p "$JOB"/{train,export}
echo $$ > "$JOB/train.pid"
n=$(wc -l < "$JOB/dataset/metadata.csv")
[ "$n" -ge 50 ] || { echo "only $n clips in the dataset" >&2; exit 4; }
vsplit=$(awk -v n="$n" 'BEGIN{v=20/n; if(v>0.08)v=0.08; if(v<0.02)v=0.02; printf "%.3f", v}')
MAX_STEPS=$((STEPS*2))
TRAIN="$JOB/train"
last=$(ls -t "$TRAIN"/lightning_logs/version_*/checkpoints/last.ckpt 2>/dev/null | head -1 || true)
if [ -n "$last" ]; then resume=(--ckpt_path "$last"); else resume=(--model.warmstart_ckpt "$BASE"); fi

( while sleep 30; do
    s=$(grep -aoE "global_step[=: ]+[0-9]+|step=[0-9]+" "$TRAIN/train.log" 2>/dev/null | tail -1 | grep -oE "[0-9]+$" || echo 0)
    echo "$(( s / 2 )) $STEPS" > "$JOB/progress.tmp" && mv "$JOB/progress.tmp" "$JOB/progress"
  done ) &
PROG=$!
trap 'kill $PROG 2>/dev/null || true' EXIT

export HF_HUB_DISABLE_TELEMETRY=1 TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1
(cd "$TRAIN" && PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True "$PY" -m piper.train fit \
  --data.voice_name certifried_own \
  --data.csv_path "$JOB/dataset/metadata.csv" \
  --data.audio_dir "$JOB/dataset/wavs" \
  --model.sample_rate 22050 \
  --data.espeak_voice "$ESPEAK" \
  --data.cache_dir "$TRAIN/cache" \
  --data.config_path "$TRAIN/config.json" \
  --data.batch_size 16 \
  --data.validation_split "$vsplit" \
  --data.num_workers 4 \
  --trainer.accelerator gpu --trainer.devices 1 \
  --trainer.max_steps "$MAX_STEPS" \
  --trainer.log_every_n_steps 50 \
  --trainer.check_val_every_n_epoch 10 \
  --trainer.default_root_dir "$TRAIN" \
  "${resume[@]}" ) >> "$TRAIN/train.log" 2>&1

ck=$(ls -t "$TRAIN"/lightning_logs/version_*/checkpoints/last.ckpt | head -1)
"$PY" "$LAB/scripts/export_onnx.py" --checkpoint "$ck" --output-file "$JOB/export/model.onnx" > "$JOB/export/export.log" 2>&1
cp "$TRAIN/config.json" "$JOB/export/model.onnx.json"
echo "$STEPS $STEPS" > "$JOB/progress"
echo DONE > "$JOB/done"
