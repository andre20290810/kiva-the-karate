// POV / 正解動作ガイド: 3D 姿勢データの読み込み・検証・補間・同期・視点の推定（DOM・Three.js 不要）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePoseText, processPose, analyzeFrames, poseAt, makeDemoParsed, samplesToCsv, segmentLengths,
  FLAG, JOINTS, N, FRAME_COUNT, INTERVAL, DEMO_LABEL, P3,
} from '../app/pov/pose.js';

const demo = () => makeDemoParsed();
const clone = (parsed) => ({ ...parsed, samples: parsed.samples.map((s) => ({ ...s, vals: Float64Array.from(s.vals) })) });

test('DEMO: 412 コマ・0.2 秒刻み・人工的な動作の表示文言。処理しても警告なし', () => {
  const d = demo();
  assert.equal(d.samples.length, FRAME_COUNT);
  assert.equal(d.samples[411].t, 82.2);
  assert.equal(DEMO_LABEL, 'DEMO / 人工的な動作、空手の正解ではありません');
  const r = processPose(d);
  assert.ok(r.ok); assert.equal(r.frames.length, 412); assert.deepEqual(r.report.warnings, []);
  assert.ok(Math.abs(r.lengths.shoulderW - 0.36) < 1e-3 && Math.abs(r.lengths.forearmL - 0.26) < 1e-3);
  // 床: 足が Y=0 付近、目が 1.5 m 前後
  const f = r.frames[0];
  assert.ok(Math.min(f.p[27 * 3 + 1], f.p[28 * 3 + 1]) > 0 && Math.min(f.p[29 * 3 + 1], f.p[31 * 3 + 1]) < 0.05);
  assert.ok(f.p[2 * 3 + 1] > 1.45 && f.p[2 * 3 + 1] < 1.7);
});

test('CSV（縦長）: 見本 CSV を読み直すと同じ値。原データ（解析結果）は処理で変わらない', () => {
  const d = demo();
  const csv = samplesToCsv(d.samples, { comment: DEMO_LABEL });
  assert.match(csv, /^# DEMO/); assert.match(csv, /time,frame,joint,name,x,y,z,visibility/);
  const parsed = parsePoseText(csv, 'a.csv');
  assert.deepEqual(parsed.errors, []); assert.equal(parsed.meta.format, 'csv-long'); assert.equal(parsed.samples.length, 412);
  const before = Float64Array.from(parsed.samples[100].vals);
  const r1 = processPose(parsed), r0 = processPose(d);
  assert.ok(Math.max(...r1.frames[100].p.map((x, i) => Math.abs(x - r0.frames[100].p[i]))) < 1e-4);
  processPose(parsed, { mirror: true, timeOffset: 0.4, interpolateLowConf: true });
  assert.deepEqual(parsed.samples[100].vals, before); // 原データを書き換えない
});

test('CSV（横長 x0,y0,z0,v0… と nose_x… ）と JSON（kiva-pose3d / MediaPipe 風）を読める', () => {
  const d = demo();
  const head = ['time', ...Array.from({ length: N }, (_, j) => [`x${j}`, `y${j}`, `z${j}`, `v${j}`]).flat()].join(',');
  const rows = d.samples.slice(0, 20).map((s) => [s.t, ...Array.from(s.vals)].join(','));
  const w = parsePoseText([head, ...rows].join('\n'), 'w.csv');
  assert.deepEqual(w.errors, []); assert.equal(w.meta.format, 'csv-wide'); assert.equal(w.samples.length, 20);
  const head2 = ['frame', ...JOINTS.flatMap((n) => [`${n}_x`, `${n}_y`, `${n}_z`, `${n}_visibility`])].join(',');
  const rows2 = d.samples.slice(0, 5).map((s, k) => [k, ...Array.from(s.vals)].join(','));
  const w2 = parsePoseText([head2, ...rows2].join('\n'), 'w2.csv');
  assert.deepEqual(w2.errors, []); assert.equal(w2.samples[3].t, 0.6); // frame × 0.2 秒
  const kiva = { format: 'kiva-pose3d/1', interval: 0.2, coordinateSystem: 'mediapipe-world', frames: d.samples.slice(0, 10).map((s) => ({ t: s.t, landmarks: Array.from({ length: N }, (_, j) => Array.from(s.vals.subarray(j * 4, j * 4 + 4))) })) };
  const j1 = parsePoseText(JSON.stringify(kiva), 'k.json');
  assert.deepEqual(j1.errors, []); assert.equal(j1.samples.length, 10);
  const mp = { frames: d.samples.slice(0, 10).map((s) => ({ timestamp_ms: s.t * 1000, landmarks: [[{ x: 0.5, y: 0.5, z: 0 }]], worldLandmarks: [Array.from({ length: N }, (_, j) => ({ x: s.vals[j * 4], y: s.vals[j * 4 + 1], z: s.vals[j * 4 + 2], visibility: s.vals[j * 4 + 3] }))] })) };
  const j2 = parsePoseText(JSON.stringify(mp), 'm.json');
  assert.deepEqual(j2.errors, []); assert.equal(j2.samples[2].t, 0.4);
  assert.ok(Math.abs(j2.samples[2].vals[15 * 4] - d.samples[2].vals[15 * 4]) < 1e-12);
});

test('検証: 画像の正規化座標・単位違い（mm）・3D のない JSON・空・時刻なしは読み込まない（理由を示す）', () => {
  const d = demo();
  const norm01 = clone(d); for (const s of norm01.samples) for (let j = 0; j < N; j++) { s.vals[j * 4] = 0.4 + s.vals[j * 4] * 0.3; s.vals[j * 4 + 1] = 0.5 + s.vals[j * 4 + 1] * 0.3; }
  assert.match(processPose(norm01).report.errors.join(), /正規化座標/);
  const mm = clone(d); for (const s of mm.samples) for (let j = 0; j < N; j++) for (let a = 0; a < 3; a++) s.vals[j * 4 + a] *= 1000;
  assert.match(processPose(mm).report.errors.join(), /単位がメートルではない/);
  assert.match(parsePoseText(JSON.stringify({ frames: [{ t: 0, landmarks: [{ x: 0.5, y: 0.5, z: 0 }] }] }), 'x.json').errors.join(), /worldLandmarks がありません/);
  assert.match(parsePoseText('', 'x.csv').errors.join(), /空/);
  assert.match(parsePoseText('joint,x,y,z\n0,1,2,3', 'x.csv').errors.join(), /時刻の列/);
  assert.equal(processPose(parsePoseText('{"frames":', 'x.json')).ok, false);
});

test('欠損の補間・低信頼度の印・見失い・重複した時刻・並べ替え', () => {
  const d = clone(demo());
  for (let k = 100; k < 105; k++) d.samples[k].vals.set([NaN, NaN, NaN, NaN], 15 * 4);          // 左手首の欠損 5 コマ
  for (let k = 200; k < 203; k++) d.samples[k].vals[16 * 4 + 3] = 0.1;                            // 右手首の低信頼度
  for (let k = 300; k < 302; k++) for (const j of [13, 14, 15, 16, 25]) d.samples[k].vals[j * 4 + 3] = 0.05; // 主要関節の多くが低信頼度
  const r = processPose(d);
  assert.ok(r.ok);
  const f = r.frames[102];
  assert.ok(f.flags[15] & FLAG.INTERP);
  const ref = processPose(demo()).frames;
  const a = P3(ref[99], 15), b = P3(ref[105], 15), m = P3(f, 15);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(m[i] - (a[i] + (b[i] - a[i]) * 0.5)) < 1e-4, '前後の有効なコマから線形補間');
  assert.ok(r.frames[201].flags[16] & FLAG.LOWCONF); assert.ok(!(r.frames[201].flags[16] & FLAG.INTERP));
  assert.equal(r.frames[300].lost, true); assert.equal(r.frames[250].lost, false);
  assert.match(r.report.info.join(), /欠損 5 点を補間/);
  // 低信頼度も補間する指定
  const r2 = processPose(d, { interpolateLowConf: true });
  assert.ok(r2.frames[201].flags[16] & FLAG.INTERP);
  // 重複した時刻はエラー、逆順は並べ替えて警告
  const dup = clone(demo()); dup.samples[5].t = dup.samples[4].t;
  assert.match(processPose(dup).report.errors.join(), /重複/);
  const rev = clone(demo()); rev.samples.reverse();
  const rr = processPose(rev);
  assert.ok(rr.ok); assert.match(rr.report.warnings.join(), /並べ替え/);
  // 腕の関節がすべて無い → 組み立てられない
  const none = clone(demo()); for (const s of none.samples) s.vals.set([NaN, NaN, NaN, NaN], 13 * 4);
  assert.match(processPose(none).report.errors.join(), /left_elbow/);
  // 顔の点だけ無い → 推定（実測ではないと示す）
  const face = clone(demo()); for (const s of face.samples) for (const j of [1, 3, 4, 6]) s.vals.set([NaN, NaN, NaN, NaN], j * 4);
  const rf = processPose(face);
  assert.ok(rf.ok); assert.match(rf.report.warnings.join(), /推定しました（実測ではありません）/); assert.ok(rf.frames[0].flags[1] & FLAG.DERIVED);
});

test('同期: 30fps のデータを 0.2 秒の 412 コマに合わせる。時刻のずれ・範囲外の表示', () => {
  const d = demo();
  // 30fps 相当（0〜82.2 秒、DEMO の 0.2 秒コマの間を線形に作る）
  const samples = [];
  for (let i = 0; i <= Math.round(82.2 * 30); i++) {
    const t = i / 30, k = Math.min(410, Math.floor(t / 0.2)), u = t / 0.2 - k;
    const a = d.samples[k].vals, b = d.samples[k + 1].vals;
    samples.push({ t, vals: a.map((x, q) => x + (b[q] - x) * Math.min(1, u)) });
  }
  const r = processPose({ samples, meta: d.meta, errors: [], warnings: [] });
  assert.ok(r.ok); assert.equal(r.frames.length, 412);
  assert.match(r.report.warnings.join(), /33\.3 ms（0\.2 秒刻みではない）/);
  const ref = processPose(d).frames;
  let max = 0; for (const k of [0, 50, 211, 411]) for (let i = 0; i < 99; i++) max = Math.max(max, Math.abs(r.frames[k].p[i] - ref[k].p[i]));
  assert.ok(max < 2e-3, `30fps → 0.2 秒の格子 ${max}`);
  // 時刻のずれ +1 秒: 0〜0.8 秒は範囲外（見失いとして示す）
  const s = processPose(d, { timeOffset: 1 });
  assert.equal(s.frames[3].outside, true); assert.equal(s.frames[3].lost, true);
  assert.ok(Math.abs(s.frames[10].p[45] - ref[5].p[45]) < 1e-5);
  assert.match(s.report.warnings.join(), /時間範囲/);
});

test('左右反転: 左右の関節を入れ替えて X を反転（表示用。原データはそのまま）', () => {
  const d = demo();
  const a = processPose(d).frames[20], b = processPose(d, { mirror: true }).frames[20];
  assert.ok(Math.abs(b.p[15 * 3] + a.p[16 * 3]) < 1e-6 && Math.abs(b.p[15 * 3 + 2] - a.p[16 * 3 + 2]) < 1e-6);
});

test('視点の推定: 旋回で頭と胴体の向きが変わる。耳の左右が逆なら反転の疑いで胴体の向きを使う。急変を検出', () => {
  const r = processPose(demo());
  const an = analyzeFrames(r.frames);
  const yawAt = (t) => an[Math.round(t / INTERVAL)];
  assert.ok(Math.abs(yawAt(5).bodyYaw) < 1);
  assert.ok(Math.abs(yawAt(22).bodyYaw - 90) < 1 && Math.abs(yawAt(22).headYaw - 90) < 1);
  assert.ok(Math.abs(Math.abs(yawAt(36).bodyYaw) - 180) < 1);
  assert.ok(an.every((a) => !a.flip));
  // 頭の向き: 耳の左右を入れ替える（ラベルの取り違え）
  const bad = clone(demo());
  for (const k of [50, 51]) { const s = bad.samples[k].vals; const l = s.slice(28, 32), rr = s.slice(32, 36); s.set(rr, 28); s.set(l, 32); }
  const ab = analyzeFrames(processPose(bad).frames);
  assert.equal(ab[50].flip, true); assert.match(ab[50].issues.join(), /反転の疑い/);
  assert.ok(Math.abs(ab[50].headYaw - ab[50].bodyYaw) < 1e-6);
  // 急変: 頭全体を 1 コマだけ 120° 回す
  const jump = clone(demo());
  const s = jump.samples[80].vals;
  for (let j = 0; j <= 10; j++) { const x = s[j * 4], z = s[j * 4 + 2], c = Math.cos(2.1), sn = Math.sin(2.1); s[j * 4] = x * c + z * sn; s[j * 4 + 2] = -x * sn + z * c; }
  const aj = analyzeFrames(processPose(jump).frames);
  assert.ok(aj[80].issues.some((x) => /急変/.test(x)) || aj[80].issues.some((x) => /頭と胴体/.test(x)));
});

test('再生位置: t 秒 → コマ番号（0.2 秒刻み）と補間', () => {
  const fr = processPose(demo()).frames;
  assert.equal(poseAt(fr, 10.0).k, 50); assert.equal(poseAt(fr, 10.0).u, 0);
  const h = poseAt(fr, 10.1);
  assert.equal(h.k, 50); assert.ok(Math.abs(h.u - 0.5) < 1e-6);
  assert.equal(poseAt(fr, 10.1, true).u, 0); // 0.2 秒のコマのまま
  assert.equal(poseAt(fr, 999).k, 411);
  assert.ok(segmentLengths(fr).thighL > 0.4);
});
