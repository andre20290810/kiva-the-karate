#!/usr/bin/env python3
"""拍の候補を解析する（numpy のみ使用）。

  python3 -I tools/analyze_beats.py assets/seipai/audio.m4a assets/seipai/beats.json

出力:
  beats.json   … BPM候補・拍位置・オンセット（強い打音）候補。すべて「推測値」。
  *_click.m4a  … 元音声に拍クリックを重ねた確認用音声。必ず実際に聴いて確認すること。

この結果をそのまま譜面として確定しないこと。譜面の t は charts/*.json で手動調整する。
"""
import json
import subprocess
import sys

import numpy as np

SR = 22050
HOP = 256
N_FFT = 1024
LAG = N_FFT / 2 / SR  # 解析窓の中心へのずれ補正（秒）


def load(path):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def onset_envelope(y):
    n_fft = N_FFT
    win = np.hanning(n_fft).astype(np.float32)
    frames = 1 + (len(y) - n_fft) // HOP
    idx = np.arange(n_fft)[None, :] + HOP * np.arange(frames)[:, None]
    spec = np.abs(np.fft.rfft(y[idx] * win, axis=1))
    logs = np.log1p(100 * spec)
    flux = np.maximum(0, np.diff(logs, axis=0)).sum(axis=1)
    flux = np.concatenate([[0], flux])
    flux -= np.convolve(flux, np.ones(16) / 16, mode="same")  # 局所平均を引く
    flux = np.maximum(flux, 0)
    return flux / (flux.max() + 1e-9)


def tempo_candidates(env, lo=60, hi=200):
    fr = SR / HOP
    ac = np.correlate(env, env, mode="full")[len(env) - 1:]
    lags = np.arange(len(ac))
    cands = []
    for lag in range(int(fr * 60 / hi), int(fr * 60 / lo) + 1):
        cands.append((ac[lag], 60 * fr / lag))
    cands.sort(reverse=True)
    out = []
    for score, bpm in cands:
        if all(abs(bpm - b) > 3 for _, b in out):
            out.append((float(score), float(bpm)))
        if len(out) >= 5:
            break
    return out


def track_beats(env, bpm, tightness=100):
    """Ellis (2007) の動的計画法による拍追跡"""
    fr = SR / HOP
    period = 60 * fr / bpm
    score = env.copy()
    back = np.full(len(env), -1)
    for i in range(len(env)):
        lo, hi = int(i - 2 * period), int(i - period / 2)
        if hi <= 0:
            continue
        lo = max(lo, 0)
        prev = np.arange(lo, hi)
        pen = -tightness * np.log((i - prev) / period) ** 2
        j = np.argmax(score[prev] + pen)
        score[i] += score[prev[j]] + pen[j]
        back[i] = prev[j]
    i = int(np.argmax(score[-int(period * 2):])) + len(env) - int(period * 2)
    beats = []
    while i >= 0:
        beats.append(i)
        i = back[i]
    return np.array(beats[::-1]) / fr + LAG


def peaks(env, thresh=0.3, min_gap=0.12):
    fr = SR / HOP
    out = []
    for i in range(1, len(env) - 1):
        if env[i] >= thresh and env[i] >= env[i - 1] and env[i] > env[i + 1]:
            t = i / fr + LAG
            if not out or t - out[-1][0] >= min_gap:
                out.append((t, float(env[i])))
            elif env[i] > out[-1][1]:
                out[-1] = (t, float(env[i]))
    return out


def click_track(src, beats, dst):
    y = load(src)
    click = np.sin(2 * np.pi * 1800 * np.arange(int(0.03 * SR)) / SR) * np.exp(-np.arange(int(0.03 * SR)) / (0.006 * SR))
    mix = y.copy() * 0.7
    for t in beats:
        i = int(t * SR)
        seg = mix[i:i + len(click)]
        seg += 0.5 * click[:len(seg)]
    pcm = (np.clip(mix, -1, 1) * 32767).astype(np.int16).tobytes()
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "s16le", "-ar", str(SR), "-ac", "1", "-i", "-",
                    "-c:a", "aac", "-b:a", "96k", dst], input=pcm, check=True)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    y = load(src)
    env = onset_envelope(y)
    cands = tempo_candidates(env)
    bpm = cands[0][1]
    beats = track_beats(env, bpm)
    res = {
        "note": "自動解析の推測値。実際に聴いて確認し、譜面へは手動で反映すること。",
        "duration": len(y) / SR,
        "bpm_candidates": [{"bpm": round(b, 2), "score": round(s, 3)} for s, b in cands],
        "bpm_used": round(bpm, 2),
        "beats": [round(float(t), 3) for t in beats],
        "onsets": [{"t": round(t, 3), "strength": round(s, 3)} for t, s in peaks(env)],
        "rms_db": None,
    }
    rms = np.sqrt(np.mean(y ** 2) + 1e-12)
    res["rms_db"] = round(float(20 * np.log10(rms)), 1)
    json.dump(res, open(dst, "w"), ensure_ascii=False, indent=1)
    click_track(src, beats, dst.replace(".json", "_click.m4a"))
    print(f"duration {res['duration']:.2f}s  rms {res['rms_db']} dBFS")
    print("BPM候補:", ", ".join(f"{c['bpm']}" for c in res["bpm_candidates"]))
    print(f"拍 {len(beats)} 個 / オンセット {len(res['onsets'])} 個 → {dst}")


if __name__ == "__main__":
    main()
