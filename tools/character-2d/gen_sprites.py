"""ALEXANDRE のスプライトを、KIVA のコマの姿勢どおりに画像生成で描く（ControlNet OpenPose ＋ IP-Adapter）。

  python gen_sprites.py --models models --profile sd15 --kiva-pose kiva_pose.json --refs refs.json \
      --frames 0,120,121,180,285,296,300,308,330,337 --out gen10 [--seed 1234] [--steps 28]

- 姿勢: KIVA の 2D 関節（元動画から測ったもの）を OpenPose 形式で描いて ControlNet に渡す。想像の姿勢は使わない。
- 外見: refs.json に並べた ALEXANDRE の参考画像（顔の主基準・全身の向き別・衣装）を IP-Adapter に渡す。
  体の向きが近い全身画像を毎コマ選び、顔の主基準（D01・D02）は全コマ共通にする。
- 一貫性: 文章（prompt）・seed・参考画像の組を全コマで固定する。
- 位置と大きさ: KIVA の人物の周りを切り出して生成し、元の 576×1024 の同じ位置・同じ倍率に戻す
  （足元の位置と拡大率は KIVA の動画と同じになる）。
- 背景: 緑一色で生成し、外周から続く緑だけを抜いて透過 PNG にする（白いシャツ・銀髪を抜かない）。
- 出力: <out>/alexandre_frame_XXXX.png（576×1024 RGBA）、<out>/raw/XXXX.png（生成そのまま）、<out>/gen_log.json

モデルの重みは --models に置く（fetch_models.md）。ネットワークには接続しない（local_files_only）。
--dry-run は重みを使わず、乱数で作った極小モデルで切り出し・貼り戻し・透過の流れだけを確かめる（画像は意味を持たない）。
"""
import argparse
import json
import os
import time

import cv2
import numpy as np
from PIL import Image

from make_controls import draw as draw_openpose

GREEN = (0, 177, 64)
PROFILES = {
    # CPU でも回せる（1 枚 1〜2 分）。重みは合計約 6 GB
    'sd15': {'base': 'dreamshaper-8', 'controlnet': 'control_v11p_sd15_openpose', 'ip_adapter': 'IP-Adapter',
             'ip_subfolder': 'models', 'ip_weight': 'ip-adapter-plus_sd15.safetensors', 'size': (512, 768), 'xl': False},
    # GPU（VRAM 12 GB 以上）向け。描き込みが細かい
    'sdxl': {'base': 'animagine-xl-3.1', 'controlnet': 'controlnet-openpose-sdxl-1.0', 'ip_adapter': 'IP-Adapter',
             'ip_subfolder': 'sdxl_models', 'ip_weight': 'ip-adapter-plus_sdxl_vit-h.safetensors', 'size': (832, 1216), 'xl': True},
}
PROMPT = ('masterpiece, best quality, 1man, solo, full body, standing on ground, adult man, sharp handsome face, '
          'long straight silver hair, hair tied at the back of the head, long hair down to the waist, '
          'black long leather coat with red lining, high collar, white shirt, black vest, belt, black gloves, '
          'black trousers, black leather boots, martial arts pose, simple green background, plain background')
NEGATIVE = ('lowres, bad anatomy, bad hands, extra fingers, missing fingers, extra arms, extra legs, extra limbs, '
            'fused legs, deformed, multiple people, 2people, cropped, out of frame, text, watermark, logo, '
            'white background, scenery, floor, shadow, karate gi, dogi, woman, female, ponytail on top, hair bun')


def person_box(P, w, h, aspect, margin=0.18):
    """KIVA の関節を囲む切り出し枠（生成サイズと同じ縦横比、足元に余白）。"""
    P = np.asarray(P)[:, :2]
    x0, y0 = P.min(0)
    x1, y1 = P.max(0)
    bh = (y1 - y0) * (1 + 2 * margin) + 0.25 * (y1 - y0)   # 頭頂・髪・裾の分
    bw = max((x1 - x0) * (1 + 2 * margin), bh * aspect)
    bh = max(bh, bw / aspect)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2 - 0.06 * (y1 - y0)
    return cx - bw / 2, cy - bh / 2, bw, bh


def crop_affine(box, size):
    x, y, bw, bh = box
    s = size[0] / bw
    return np.array([[s, 0, -x * s], [0, size[1] / bh, -y * size[1] / bh]], np.float32)


def green_matte(rgb):
    """外周から続く緑の背景を抜く。戻り値: 0〜1 のアルファ（緑のにじみも除く）。"""
    img = rgb.astype(np.float32)
    bg = np.median(np.concatenate([img[:4].reshape(-1, 3), img[-4:].reshape(-1, 3), img[:, :4].reshape(-1, 3),
                                   img[:, -4:].reshape(-1, 3)]), axis=0)
    d = np.linalg.norm(img - bg, axis=2)
    g = img[..., 1] - np.maximum(img[..., 0], img[..., 2])          # 緑の強さ
    near = ((d < 70) | (g > 60)).astype(np.uint8)
    n, lab = cv2.connectedComponents(near)
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    bgmask = np.isin(lab, list(edge))
    a = np.clip((d - 25) / 60, 0, 1)
    a[~cv2.dilate(bgmask.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)] = 1   # 背景から離れた画素は不透明
    a[bgmask & (d < 25)] = 0
    # 人物は最大の塊だけ残す（背景に残った小さな汚れを消す）
    m = (a > 0.5).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(m)
    if n > 1:
        keep = 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])
        a *= cv2.dilate((lab == keep).astype(np.uint8), np.ones((7, 7), np.uint8))
    return cv2.GaussianBlur(a, (3, 3), 0)


def despill(rgb, a):
    out = rgb.astype(np.float32)
    lim = np.maximum(out[..., 0], out[..., 2])
    out[..., 1] = np.where(out[..., 1] > lim, lim + (out[..., 1] - lim) * (1 - np.clip(1 - a, 0, 1)) * 0.2, out[..., 1])
    return np.clip(out, 0, 255).astype(np.uint8)


def on_green(path, size=None):
    im = Image.open(path).convert('RGBA')
    bg = Image.new('RGBA', im.size, GREEN + (255,))
    bg.alpha_composite(im)
    bg = bg.convert('RGB')
    return bg.resize(size) if size else bg


def pick_refs(refs, yaw, n_body=1):
    """顔の主基準（全コマ共通）＋向きが最も近い全身画像。"""
    body = sorted(refs['body'], key=lambda r: abs((r['yaw'] - yaw + 180) % 360 - 180))[:n_body]
    return refs['face'] + [b['file'] for b in body]


def load_pipeline(a, prof):
    import torch
    from diffusers import ControlNetModel
    dtype = torch.float16 if a.device == 'cuda' else torch.float32
    if a.dry_run:
        return tiny_pipeline(prof, dtype)
    cn = ControlNetModel.from_pretrained(os.path.join(a.models, prof['controlnet']), torch_dtype=dtype, local_files_only=True)
    if prof['xl']:
        from diffusers import StableDiffusionXLControlNetPipeline as P
    else:
        from diffusers import StableDiffusionControlNetPipeline as P
    pipe = P.from_pretrained(os.path.join(a.models, prof['base']), controlnet=cn, torch_dtype=dtype,
                             safety_checker=None, local_files_only=True)
    from transformers import CLIPVisionModelWithProjection
    enc = CLIPVisionModelWithProjection.from_pretrained(os.path.join(a.models, prof['ip_adapter'], 'models', 'image_encoder'),
                                                        torch_dtype=dtype, local_files_only=True)
    pipe.image_encoder = enc
    pipe.load_ip_adapter(os.path.join(a.models, prof['ip_adapter']), subfolder=prof['ip_subfolder'],
                         weight_name=prof['ip_weight'], local_files_only=True)
    pipe.set_ip_adapter_scale(a.ip_scale)
    from diffusers import DPMSolverMultistepScheduler
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, use_karras_sigmas=True)
    pipe.to(a.device)
    pipe.set_progress_bar_config(disable=True)
    return pipe


def tiny_pipeline(prof, dtype):
    """--dry-run 用: 乱数の極小モデル（重みのダウンロード不要）。出力は意味のない画像。"""
    import torch
    from diffusers import (AutoencoderKL, ControlNetModel, DDIMScheduler, StableDiffusionControlNetPipeline,
                           UNet2DConditionModel)
    from transformers import CLIPTextConfig, CLIPTextModel, CLIPTokenizer
    torch.manual_seed(0)
    unet = UNet2DConditionModel(block_out_channels=(32, 64), layers_per_block=1, sample_size=32, in_channels=4,
                                out_channels=4, down_block_types=('DownBlock2D', 'CrossAttnDownBlock2D'),
                                up_block_types=('CrossAttnUpBlock2D', 'UpBlock2D'), cross_attention_dim=32,
                                norm_num_groups=8)
    cn = ControlNetModel.from_unet(unet)
    vae = AutoencoderKL(block_out_channels=[8, 16, 32, 32], in_channels=3, out_channels=3, latent_channels=4,
                        down_block_types=['DownEncoderBlock2D'] * 4, up_block_types=['UpDecoderBlock2D'] * 4,
                        norm_num_groups=8)
    te = CLIPTextModel(CLIPTextConfig(bos_token_id=0, eos_token_id=2, hidden_size=32, intermediate_size=37,
                                      layer_norm_eps=1e-5, num_attention_heads=4, num_hidden_layers=2, pad_token_id=1,
                                      vocab_size=1000))
    tok = TinyTokenizer()
    pipe = StableDiffusionControlNetPipeline(vae=vae, text_encoder=te, tokenizer=tok, unet=unet, controlnet=cn,
                                             scheduler=DDIMScheduler(), safety_checker=None, feature_extractor=None,
                                             requires_safety_checker=False)
    pipe.set_progress_bar_config(disable=True)
    return pipe


class TinyTokenizer:
    """--dry-run 用の最小トークナイザ（語彙ファイル不要）。"""
    model_max_length = 77
    added_tokens_encoder = {}

    def tokenize(self, text):
        return text.split()

    def __call__(self, text, padding=None, max_length=77, truncation=None, return_tensors=None, **kw):
        import torch
        texts = [text] if isinstance(text, str) else text
        ids = [[0] + [3 + (hash(w) % 990) for w in t.split()][:max_length - 2] + [2] for t in texts]
        ids = [i + [1] * (max_length - len(i)) for i in ids]
        class R(dict):
            __getattr__ = dict.__getitem__
        return R(input_ids=torch.tensor(ids), attention_mask=torch.ones(len(ids), max_length, dtype=torch.long))

    def batch_decode(self, ids, **kw):
        return ['' for _ in ids]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--models', default='models')
    ap.add_argument('--profile', choices=PROFILES, default='sd15')
    ap.add_argument('--kiva-pose', required=True)
    ap.add_argument('--refs', required=True, help='refs.json（make_refs.py が作る）')
    ap.add_argument('--frames', required=True, help='0,120,... または 0-411')
    ap.add_argument('--out', required=True)
    ap.add_argument('--seed', type=int, default=1234)
    ap.add_argument('--steps', type=int, default=28)
    ap.add_argument('--cfg', type=float, default=6.0)
    ap.add_argument('--ip-scale', type=float, default=0.7)
    ap.add_argument('--cn-scale', type=float, default=1.0)
    ap.add_argument('--device', default='cpu')
    ap.add_argument('--skip-existing', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    import torch
    prof = dict(PROFILES[a.profile])
    if a.dry_run:
        prof['size'] = (64, 96)
    W, H = prof['size']
    K = json.load(open(a.kiva_pose))
    refs = json.load(open(a.refs))
    if '-' in a.frames:
        s, e = map(int, a.frames.split('-'))
        frames = list(range(s, e + 1))
    else:
        frames = [int(x) for x in a.frames.split(',')]
    os.makedirs(os.path.join(a.out, 'raw'), exist_ok=True)
    pipe = load_pipeline(a, prof)
    log_path = os.path.join(a.out, 'gen_log.json')
    log = json.load(open(log_path)) if os.path.exists(log_path) else {}
    log['_settings'] = {'profile': a.profile, 'models': {k: prof[k] for k in ('base', 'controlnet', 'ip_weight')},
                        'prompt': PROMPT, 'negative': NEGATIVE, 'seed': a.seed, 'steps': a.steps, 'cfg': a.cfg,
                        'ip_scale': a.ip_scale, 'cn_scale': a.cn_scale, 'size': [W, H], 'dry_run': a.dry_run}
    for i in frames:
        dst = os.path.join(a.out, f'alexandre_frame_{i:04d}.png')
        if a.skip_existing and os.path.exists(dst):
            continue
        t0 = time.time()
        k = K[i]
        P = np.asarray(k['image'])
        box = person_box(P, 576, 1024, W / H)
        M = crop_affine(box, (W, H))
        Pc = P.copy()
        Pc[:, :2] = P[:, :2] @ M[:, :2].T + M[:, 2]
        ctrl = Image.fromarray(draw_openpose(Pc, W, H)[..., ::-1])
        ref_files = pick_refs(refs, k['yaw'])
        kw = {}
        if not a.dry_run:
            kw['ip_adapter_image'] = [[on_green(f, (224, 224)) for f in ref_files]]
        g = torch.Generator('cpu').manual_seed(a.seed)
        img = pipe(PROMPT, negative_prompt=NEGATIVE, image=ctrl, width=W, height=H, num_inference_steps=a.steps,
                   guidance_scale=a.cfg, controlnet_conditioning_scale=a.cn_scale, generator=g, **kw).images[0]
        img.save(os.path.join(a.out, 'raw', f'{i:04d}.png'))
        ctrl.save(os.path.join(a.out, 'raw', f'{i:04d}_pose.png'))
        rgb = np.asarray(img.convert('RGB'))
        al = green_matte(rgb)
        rgb = despill(rgb, al)
        rgba = np.dstack([rgb, (al * 255).astype(np.uint8)])
        # 元の 576×1024 の同じ位置・倍率へ（色はアルファ乗算で縮小し、縁の緑を残さない）
        Minv = cv2.invertAffineTransform(M)
        pre = rgba.astype(np.float32)
        pre[..., :3] *= pre[..., 3:4] / 255
        big = cv2.warpAffine(pre, Minv, (576, 1024), flags=cv2.INTER_AREA if W < box[2] else cv2.INTER_CUBIC,
                             borderValue=(0, 0, 0, 0))
        aa = np.clip(big[..., 3:4], 0, 255)
        col = np.where(aa > 0, big[..., :3] * 255 / np.maximum(aa, 1e-3), 0)
        out = np.dstack([np.clip(col, 0, 255), aa]).astype(np.uint8)
        cv2.imwrite(dst, cv2.cvtColor(out, cv2.COLOR_RGBA2BGRA))
        log[str(i)] = {'t': k['t'], 'yaw': round(k['yaw'], 1), 'box': [round(v, 1) for v in box], 'refs': ref_files,
                       'seconds': round(time.time() - t0, 1)}
        json.dump(log, open(log_path, 'w'), indent=1, ensure_ascii=False)
        print(f'frame {i} t={k["t"]:.1f}s {time.time() - t0:.0f}s', flush=True)


if __name__ == '__main__':
    main()
