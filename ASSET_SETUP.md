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

## Portrait/landscape support

The same UI supports phone portrait, phone landscape, tablets and desktop.
The live performer canvas and track resize on viewport changes without
restarting audio. Four touch buttons and Start/Pause/Restart remain visible.
Audio volume and input-latency adjustments are under the expandable
"音量・入力補正" control. Existing gameplay, pause and score state are
preserved when rotating while playing.

Regression tests:

```powershell
npm test
npm start  # in a second terminal
npm run test:layout
```

The layout test uses locally installed Microsoft Edge on Windows
(or set CHROME_PATH for another Chromium executable). It also supports
BASE=http://localhost:8177/ for non-default server ports.
The test captures screenshots under Git-ignored source/rotation-shots/.
The automated rotation test uses a browser viewport emulation;
physical-device QA is still recommended before public release.

## Local access and publication safety

The included development server binds only to 127.0.0.1 by default and
returns 403 for source/, .git, node_modules and hidden files. It is NOT
a production authentication system. On a trusted LAN, use HOST=0.0.0.0
explicitly and stop the server after testing. Public deployment must
not expose unprocessed source files or unprotected media.

**A hard-to-guess/unshared URL is NOT access control.** Ordinary GitHub
Pages sites are publicly reachable; GitHub repo privacy does not add a
login barrier to a deployed Pages site. For Kiba-only access, set up
Cloudflare Access (or an equivalent authenticated hosting layer) and
confirm allowlisted identities before publishing `assets/seipai/`.
Do not deploy the performer footage, audio or cutout frames to an
unguarded public Pages site.

Custom-domain publication is deferred until access protection,
source-footage distribution permission and DNS settings are addressed.
No real audio or cutout-image frames are in the GitHub repository.
