# KIVA THE KARATE — Three visual modes (development prototype)

## Shared gameplay
All three views share AudioClock, score, chart timewarp, judgment, AUTO/MANUAL, keyboard and GameSir mappings. The VIEW selector changes presentation only.

1. **KIVA / VIDEO**: original source `source/seipai.mp4`, displayed whole-frame, muted, clock-synchronized via `src/original-video.js`. This avoids the flawed foreground segmentation. Score and hit text remain.
2. **KIVA / 3D TEST**: Blender-exported animated GLB (`prototypes/kiva_motion_2d_reference.glb`) rendered in a stationary Three.js stage (`src/three-stage.js`).
3. **ALEXANDRE / 3D TEST**: a separate GLB (`prototypes/alexandre_appearance_proxy.glb`) with rough silver-blue hair, black coat, red lining; the same 82.2 s timing data. **Low-poly prototype only — not faithful to the original Alexandre reference video.**

## Important limitations (do not represent these as complete)
- Monocular source landmarks are **2D observations**, with no measured depth. Limbs, body turning, foot placement, occlusion and physics must be reviewed and corrected against source footage. This is not validated motion capture.
- Current 3D avatars are **debug geometry**, not quality-approved finished human likenesses. Alexandre appearance proxy is visibly crude and must NOT be sent to KIVA as a final game.
- The rhythm chart has 23 candidate (unverified) note timings; human review/calibration required.
- The current video and 3D overlays cover the existing scene's VFX canvas. The hit text works, but character-relative VFX need a dedicated correctly aligned overlay layer.
- The 3D stage is fixed in world coordinates (no conveyor scroll). It is intentionally distinct from the original moving-stage shader.
- Public URL has **not** been redeployed. The previously deployed version remains unchanged.

## Private asset handling
The repository is **PUBLIC**. `source/`, `assets/`, `prototypes/`, and `dist/` are Git-ignored. Do not push raw KIVA video, 412 cutouts, derived GLB files, reference Alexandre video, or private screenshots.

The local PC has:
- `source/seipai.mp4`
- `source/seipai_assets/manifest.json` with 412x33 2D tracking observations
- `source/retarget-prototype/{all_pose2d.json,full_humanoid_motion.blend,alexandre_appearance_proxy.blend}`
- `prototypes/{kiva_motion_2d_reference.glb,alexandre_appearance_proxy.glb}`

Reproduce source assets locally using `node tools/character-retargeting/export_full_pose.mjs`, Blender CLI with `tools/character-retargeting/create_full_motion.py`, and `create_alexandre_proxy.py`; export KIVA GLB via Blender glTF export. Then run `node tools/build-dist.mjs`. `prototypes/` must remain local.

## Checks run
- 61 unit tests passed.
- Edge Chromium headless: all three modes switched successfully at 1200x800, 390x844, and 844x390, with no page errors.
- GLB animations contain ~82.24 s each; browser Three.js rendered both.
- Further visual QA and movement accuracy testing are REQUIRED before any production deploy.
