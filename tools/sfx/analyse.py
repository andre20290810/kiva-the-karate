"""render.mjs の録音を数値で調べる（耳で聞く代わりの目安）。
  python tools/sfx/analyse.py <録音フォルダ> [比較用の録音フォルダ]
各音: 最大（dBFS）とその時刻（鳴らしてから ms）、余韻（最大から -30 dB まで ms）、明るさ（重心 Hz）、
スマホ相当（400 Hz 以下を切った）最大、BGM と重ねたときの効果音の目立ち（効果音の最大 − 直前 0.3 秒の BGM の RMS、dB）。
spectrogram.png に全体の周波数の図を出す。
"""
import json, sys, wave
import numpy as np


def load(path):
    w = wave.open(path)
    x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    return x.reshape(-1, 2).mean(axis=1), w.getframerate()


def hp(x, sr, fc=400):
    X = np.fft.rfft(x); f = np.fft.rfftfreq(len(x), 1 / sr)
    X[f < fc] = 0
    return np.fft.irfft(X, len(x))


def env(x, sr, ms=3):
    n = max(1, int(sr * ms / 1000))
    return np.sqrt(np.convolve(x * x, np.ones(n) / n, mode='same'))


def report(folder):
    dry, sr = load(f'{folder}/sfx_dry.wav')
    mix, _ = load(f'{folder}/sfx_bgm.wav')
    ev = [e for e in json.load(open(f'{folder}/events.json')) if e['kind'] not in ('breathUpdate', 'breathStop')]
    rows = []
    for k, e in enumerate(ev):
        a = int(e['at'] * sr)
        b = int(ev[k + 1]['at'] * sr) if k + 1 < len(ev) else len(dry)
        if e['kind'] == 'breathStart':
            b = int((e['at'] + 2.4) * sr)
        seg = dry[a:b]
        if len(seg) < 10:
            continue
        en = env(seg, sr)
        pk = en.max() + 1e-9; ip = int(en.argmax())
        tail = ip + int(np.argmax(en[ip:] < pk * 10 ** (-30 / 20))) if (en[ip:] < pk * 10 ** (-30 / 20)).any() else len(en)
        X = np.abs(np.fft.rfft(seg[:int(0.3 * sr)] * np.hanning(min(len(seg), int(0.3 * sr))))) ** 2; f = np.fft.rfftfreq(min(len(seg), int(0.3 * sr)), 1 / sr)
        cen = float((X * f).sum() / (X.sum() + 1e-9))
        phone = env(hp(seg, sr), sr).max() + 1e-9
        pre = mix[max(0, a - int(0.3 * sr)):a]
        bg = mix[max(0, a - int(0.3 * sr)):a] - dry[max(0, a - int(0.3 * sr)):a]
        bgr = np.sqrt((bg ** 2).mean()) + 1e-9 if len(bg) else 1e-9
        mx = env(mix[a:b], sr).max() + 1e-9
        rows.append(dict(kind=e['kind'], grade=e.get('grade') or '', peak_db=round(20 * np.log10(pk), 1), peak_ms=round(ip / sr * 1000, 1),
                         tail_ms=round((tail - ip) / sr * 1000), centroid=round(cen), phone_db=round(20 * np.log10(phone), 1),
                         over_bgm_db=round(20 * np.log10(mx / bgr), 1), said_ms=round(e['peakAfter'] * 1000, 1) if e.get('peakAfter') is not None else ''))
    return rows, dry, sr


def main():
    rows, dry, sr = report(sys.argv[1])
    other = report(sys.argv[2])[0] if len(sys.argv) > 2 else None
    print(f"{'音':12} {'判定':8} {'最大dB':>7} {'最大ms':>7} {'予告ms':>7} {'余韻ms':>7} {'重心Hz':>7} {'スマホdB':>8} {'BGM上dB':>8}" + ('   ← 比較' if other else ''))
    for i, r in enumerate(rows):
        o = other[i] if other and i < len(other) else None
        extra = f"   ← {o['peak_db']:>6} {o['peak_ms']:>6} {o['tail_ms']:>6} {o['centroid']:>6} {o['phone_db']:>7} {o['over_bgm_db']:>7}" if o else ''
        print(f"{r['kind']:12} {r['grade']:8} {r['peak_db']:>7} {r['peak_ms']:>7} {r.get('said_ms', ''):>7} {r['tail_ms']:>7} {r['centroid']:>7} {r['phone_db']:>8} {r['over_bgm_db']:>8}{extra}")
    try:
        import cv2
        n = 1024; hop = 256
        frames = [np.abs(np.fft.rfft(dry[i:i + n] * np.hanning(n))) for i in range(0, len(dry) - n, hop)]
        S = 20 * np.log10(np.array(frames).T + 1e-6)
        f = np.fft.rfftfreq(n, 1 / sr)
        S = S[f < 8000][::-1]
        img = np.clip((S + 80) / 80 * 255, 0, 255).astype(np.uint8)
        img = cv2.applyColorMap(cv2.resize(img, (min(2400, img.shape[1]), 400)), cv2.COLORMAP_MAGMA)
        cv2.imwrite(f'{sys.argv[1]}/spectrogram.png', img)
    except ImportError:
        pass


if __name__ == '__main__':
    main()
