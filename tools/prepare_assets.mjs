import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const root = resolve(import.meta.dirname, '..');
const sourceDir = join(root, 'source');
const archiveDir = join(sourceDir, 'seipai_assets');
const outDir = join(root, 'assets', 'seipai');
const framesDir = join(outDir, 'frames');
const mp4 = join(sourceDir, 'seipai.mp4');
const manifest = JSON.parse(await readFile(join(archiveDir, 'manifest.json'), 'utf8'));
const [width, height] = manifest.canvas;
const fps = manifest.sample_fps;
if (fps !== 5 || manifest.frames.length !== 412) {
  throw new Error('Unexpected source asset set: expected 412 frames at 5 fps');
}
await mkdir(framesDir, { recursive: true });

const jointIndices = {
  nose: 0, left_shoulder: 11, right_shoulder: 12,
  left_elbow: 13, right_elbow: 14, left_wrist: 15, right_wrist: 16,
  left_hip: 23, right_hip: 24, left_knee: 25, right_knee: 26,
  left_ankle: 27, right_ankle: 28, left_heel: 29, right_heel: 30,
  left_foot: 31, right_foot: 32,
};
const definitions = [];
let current = 0;
const workers = Array.from({ length: 6 }, async () => {
  for (;;) {
    const i = current++;
    if (i >= manifest.frames.length) break;
    const record = manifest.frames[i];
    const source = join(archiveDir, record.file);
    const name = 'f' + String(i).padStart(4, '0') + '.webp';
    await sharp(source).webp({ quality: 82, alphaQuality: 90, effort: 4 }).toFile(join(framesDir, name));
    const [x0, y0, x1, y1] = record.bbox;
    const joints = {};
    for (const [jointName, index] of Object.entries(jointIndices)) {
      const p = record.pose_landmarks?.[index];
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        joints[jointName] = [
          Math.round(p.x * width * 10) / 10,
          Math.round(p.y * height * 10) / 10,
          Math.round((p.visibility ?? 0) * 1000) / 1000,
        ];
      }
    }
    definitions[i] = {
      i, t: record.time_s, file: 'frames/' + name,
      bbox: [x0, y0, x1 - x0, y1 - y0], joints,
    };
    if ((i + 1) % 75 === 0) console.log('Prepared', i + 1, '/', manifest.frames.length);
  }
});
await Promise.all(workers);
await writeFile(join(outDir, 'frames.json'), JSON.stringify({
  fps, width, height, frames: definitions,
}, null, 2) + '\n', 'utf8');
const outputAudio = join(outDir, 'audio.m4a');
const ffmpeg = spawnSync(ffmpegInstaller.path, ['-hide_banner', '-loglevel', 'error',
  '-y', '-i', mp4, '-vn', '-c:a', 'copy', outputAudio], { stdio: 'inherit' });
if (ffmpeg.status !== 0) throw new Error('ffmpeg audio extraction failed');
console.log('Prepared', definitions.length, 'WebP frames and', basename(outputAudio));
