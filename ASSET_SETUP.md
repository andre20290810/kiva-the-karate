# KIVA THE KARATE — source-media integration

This repository was initialized from the standalone `karate-rhythm/` prototype on
`andre20290810/ALEXIA` branch `karate-rhythm-prototype`. The ALEXIA
repository is not modified by this import.

## Local media setup

The real kata footage, its audio, and the dancer/performer cutout frames are
**not included in the public repository**. Place the authorized source files
locally:

```
source/
  seipai.mp4
  seipai_frames.zip
```

Unpack `source/seipai_frames.zip` so that
`source/seipai_assets/manifest.json` and
`source/seipai_assets/png/` exist, then run:

```powershell
npm install --no-save --no-package-lock sharp @ffmpeg-installer/ffmpeg
node tools/prepare_assets.mjs
npm test
npm start
```

The asset preparation script produces
`assets/seipai/audio.m4a`,
`assets/seipai/frames.json`, and 412 WebP cutout frames.
`source/`, `assets/`, and `node_modules/` are Git-ignored to
avoid accidentally publishing or committing source material.

## Preliminary chart

`charts/seipai.chart.json` contains 23 **unverified timing candidates**
estimated from relative pose-motion velocity after local motion peaks
in the 5-fps landmark set. Command lanes K1–K4 are placeholders:
they are **not** classified karate moves, and these candidate timings
are not valid reference labels for learning-effect experiments.

A kata expert must check move names, sequence, the exact kime frame,
command assignment, and any flagged transparent-image artifacts before
using this chart as a practice or research ground truth.

## Publication

GitHub Pages and custom-domain publication are deferred until the
source-footage distribution rights, verified chart, and DNS settings
are addressed. No real audio or cutout-image frames are in the public repo.
