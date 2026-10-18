"""gen_sprites.py が使うモデルの重みを Hugging Face から取得する（無料・公開モデル。素材のアップロードはしない）。

  python fetch_models.py --out models --profile sd15        （約 6 GB）
  python fetch_models.py --out models --profile sdxl        （約 10 GB、GPU 向け）

huggingface.co へ接続できる環境で実行する。ダウンロードだけで、画像・動画はどこにも送らない。
ライセンスはモデルごとに異なる（下の表）。利用前に各ページで確認すること。
"""
import argparse
import os

MODELS = {
    'sd15': [
        # (リポジトリ, 保存先, 取得するファイル, ライセンス)
        ('Lykon/dreamshaper-8', 'dreamshaper-8',
         ['model_index.json', 'scheduler/*', 'text_encoder/*.json', 'text_encoder/model.safetensors', 'tokenizer/*',
          'unet/*.json', 'unet/diffusion_pytorch_model.safetensors', 'vae/*.json', 'vae/diffusion_pytorch_model.safetensors',
          'feature_extractor/*'], 'CreativeML OpenRAIL-M'),
        ('lllyasviel/control_v11p_sd15_openpose', 'control_v11p_sd15_openpose',
         ['config.json', 'diffusion_pytorch_model.safetensors'], 'OpenRAIL'),
        ('h94/IP-Adapter', 'IP-Adapter',
         ['models/ip-adapter-plus_sd15.safetensors', 'models/image_encoder/*'], 'Apache-2.0'),
    ],
    'sdxl': [
        ('cagliostrolab/animagine-xl-3.1', 'animagine-xl-3.1',
         ['model_index.json', 'scheduler/*', 'text_encoder/*', 'text_encoder_2/*', 'tokenizer/*', 'tokenizer_2/*',
          'unet/*.json', 'unet/diffusion_pytorch_model.safetensors', 'vae/*'], 'Fair AI Public License 1.0-SD'),
        ('xinsir/controlnet-openpose-sdxl-1.0', 'controlnet-openpose-sdxl-1.0',
         ['config.json', 'diffusion_pytorch_model.safetensors'], 'Apache-2.0'),
        ('h94/IP-Adapter', 'IP-Adapter',
         ['sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors', 'models/image_encoder/*'], 'Apache-2.0'),
    ],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='models')
    ap.add_argument('--profile', choices=MODELS, default='sd15')
    a = ap.parse_args()
    from huggingface_hub import snapshot_download
    for repo, name, patterns, lic in MODELS[a.profile]:
        print(f'{repo}  ({lic})', flush=True)
        snapshot_download(repo, local_dir=os.path.join(a.out, name), allow_patterns=patterns)
    print('done ->', a.out)


if __name__ == '__main__':
    main()
