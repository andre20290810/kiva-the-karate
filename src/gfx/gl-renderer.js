// WebGL2 レンダラー: 疑似3Dステージ（床・背景をシェーダーで描画）、柱・ゲート、人物（リムライト・反射・残像）、
// VFX スプライト（プロシージャル形状・加算合成）、ポストエフェクト（ブルーム・色収差・揺れ・ノイズ・閃光）。

import { STRIDE } from './batch.js';

const HEADER = '#version 300 es\nprecision highp float;\n';

const FULLSCREEN_VS = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }`;

// 床と背景（消失点・パース付き床面・メタリックパネル・ネオンライン・霧・床面の衝撃伝播）
const ENV_FS = HEADER + `
in vec2 vUv; out vec4 o;
uniform vec2 uRes; uniform float uDpr; uniform float uHorizon; uniform float uVpX; uniform float uFocal; uniform float uCamH;
uniform float uScroll; uniform float uTime; uniform float uFog; uniform float uPanel; uniform float uNeonEvery; uniform float uCharZ; uniform float uCharX;
uniform vec4 uPulses[8]; uniform int uPulseCount; uniform float uEnergy; uniform float uCorridor;
float h1(float n){return fract(sin(n)*43758.5453);}
float h2(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h2(i),h2(i+vec2(1,0)),f.x),mix(h2(i+vec2(0,1)),h2(i+vec2(1,1)),f.x),f.y);}
float lineAA(float d, float w){ float fw=max(fwidth(d),1e-4); return 1.0-smoothstep(w, w+fw*1.5, abs(d)); }
vec3 sky(vec2 p){
  float y = p.y/uHorizon; // 0=上端 1=地平線
  vec3 top = vec3(0.012,0.014,0.03), mid = vec3(0.03,0.04,0.085), hor = vec3(0.09,0.12,0.22);
  vec3 c = mix(top, mid, smoothstep(0.0,0.7,y));
  c = mix(c, hor, smoothstep(0.6,1.0,y));
  // 遠景のビル群シルエット（ゆっくりした視差）
  float sx = (p.x - uVpX)/uRes.x;
  float col = floor((sx*3.2 + uScroll*0.0015)*18.0);
  float hgt = 0.06 + pow(h1(col*1.7),2.5)*0.22;
  float bld = step(1.0-hgt, y) * step(y, 1.0);
  vec3 bc = vec3(0.025,0.03,0.055);
  float win = step(0.82, h2(floor(vec2((sx*3.2+uScroll*0.0015)*18.0*6.0, y*90.0)))) * bld * 0.35;
  c = mix(c, bc, bld*0.85) + vec3(0.25,0.55,1.0)*win*smoothstep(0.75,1.0,y)*0.5;
  // 地平線の発光
  c += vec3(0.15,0.45,1.0) * exp(-pow((1.0-y)*uHorizon/18.0,2.0)) * (0.55+0.25*uEnergy);
  c += vec3(0.6,0.2,1.0) * exp(-pow((1.0-y)*uHorizon/60.0,2.0)) * 0.12;
  // 上方からのスポット光
  float spot = exp(-pow((p.x-uVpX)/(uRes.x*0.22),2.0)) * smoothstep(0.0,1.0,y);
  c += vec3(0.12,0.16,0.28)*spot*0.5;
  return c;
}
void main(){
  vec2 p = vec2(gl_FragCoord.x, uRes.y*uDpr - gl_FragCoord.y)/uDpr; // CSS px, 左上原点
  float dy = p.y - uHorizon;
  if (dy <= 0.5) { o = vec4(sky(p),1.0); return; }
  float z = uFocal*uCamH/dy;
  float x = (p.x - uVpX)*z/uFocal;
  float wz = z + uScroll;
  vec2 cell = vec2(x, wz)/uPanel;
  vec2 id = floor(cell); vec2 f = fract(cell);
  float rnd = h2(id);
  // メタリックパネル（ヘアライン + パネルごとの明暗差）
  float brushed = vnoise(vec2(x*40.0, wz*1.5))*0.5 + vnoise(vec2(x*7.0, wz*0.4))*0.5;
  vec3 metal = mix(vec3(0.055,0.06,0.075), vec3(0.11,0.12,0.15), rnd*0.6 + brushed*0.4);
  // 継ぎ目（面取り）: 遠方ではちらつかないよう距離で弱める
  float far = smoothstep(8.0, 40.0, z);
  float seam = max(lineAA(f.x-0.5, 0.48), lineAA(f.y-0.5, 0.48)) ; // 0.48→端の細い帯
  seam = 1.0 - min(lineAA(f.x-0.5,0.485), lineAA(f.y-0.5,0.485));
  metal *= 1.0 - seam*0.55*(1.0-far);
  float bevel = smoothstep(0.0,0.06,f.y)*smoothstep(0.0,0.06,1.0-f.y);
  metal += vec3(0.05,0.06,0.08)*(1.0-bevel)*(1.0-far)*step(0.5,f.y);
  // スポットライトの反射（人物の足元付近）
  float dc = length(vec2((x-uCharX)*0.7, z-uCharZ));
  vec3 col = metal + vec3(0.32,0.38,0.5)*exp(-dc*dc*0.18)*0.6 + vec3(0.1,0.13,0.2)*exp(-dc*0.25)*0.5;
  // ネオンライン（横方向: 手前へ流れる / 縦方向: 消失点へ収束）
  float lat = (wz/(uPanel*uNeonEvery));
  float latD = (fract(lat)-0.5);
  float latLine = lineAA(latD*uPanel*uNeonEvery, 0.035);
  float latGlow = exp(-pow(latD*uPanel*uNeonEvery/0.35,2.0));
  vec3 neonA = vec3(0.1,0.75,1.0);
  float lon1 = lineAA(abs(x)-uCorridor*0.55, 0.03);
  float lonG = exp(-pow((abs(x)-uCorridor*0.55)/0.3,2.0));
  vec3 neonB = vec3(1.0,0.32,0.75);
  float fadeNear = smoothstep(0.0, 2.0, z);
  float neonFar = 1.0 - smoothstep(30.0, 55.0, z);
  col += neonA*(latLine*1.6 + latGlow*0.35)*neonFar*fadeNear*(0.8+0.4*uEnergy);
  col += neonB*(lon1*1.4 + lonG*0.3)*neonFar;
  // 技成立時の床面への衝撃伝播（リング + パネル点灯）
  for (int i=0;i<8;i++){
    if (i>=uPulseCount) break;
    vec4 P = uPulses[i]; // x, z, age, strength
    float d = length(vec2(x-P.x, z-P.y));
    float r = P.z*16.0;
    float life = 1.0 - smoothstep(0.0,1.1,P.z);
    float ring = exp(-pow((d-r)/(0.35+P.z*1.2),2.0));
    // 波面は手前ほど太く見えるので、奥行きで幅を補正して細い光の帯に保つ
    float wv = (0.18 + P.z*0.5) * (0.6 + 0.4*clamp(z/6.0,0.0,1.0));
    vec3 add = vec3(1.0,0.66,0.25)*exp(-pow((d-r)/wv,2.0))*P.w*life*0.7;
    add += vec3(0.25,0.75,1.0)*exp(-pow((d-r*0.72)/(wv*0.7),2.0))*P.w*life*0.3;
    float lit = step(d, r) * step(0.62, rnd) * exp(-P.z*4.0) * step(d, 8.0);
    add += vec3(0.12,0.42,0.9)*lit*P.w*(0.25+0.3*rnd)*(1.0-seam);
    add += vec3(1.0,0.75,0.5)*exp(-d*d*4.0)*exp(-P.z*14.0)*P.w*0.16;
    // 足元の衝撃で床が白く飽和しないよう、1つの衝撃の明るさに上限を設ける
    col += min(add, vec3(0.55));
  }
  // 霧（遠方ほど地平線の色へ）
  float fog = 1.0 - exp(-z*uFog);
  vec3 fogc = vec3(0.07,0.09,0.17);
  col = mix(col, fogc, fog);
  // 画面下端の暗がり
  col *= mix(1.0, 0.7, smoothstep(uRes.y*0.92, uRes.y, p.y));
  o = vec4(col, 1.0);
}`;

// 柱・ゲート（金属面 + ネオンの縁取り + 霧）
const GEO_VS = `#version 300 es
layout(location=0) in vec2 aPos; layout(location=1) in vec2 aUv; layout(location=2) in vec4 aData; // shade, fog, alpha, kind
uniform vec2 uRes;
out vec2 vUv; out vec4 vData;
void main(){ vUv=aUv; vData=aData; gl_Position=vec4(aPos.x/uRes.x*2.0-1.0, 1.0-aPos.y/uRes.y*2.0, 0.0, 1.0); }`;
const GEO_FS = HEADER + `
in vec2 vUv; in vec4 vData; out vec4 o; uniform float uEnergy;
void main(){
  float shade=vData.x, fog=vData.y, alpha=vData.z, kind=vData.w;
  vec3 base = mix(vec3(0.03,0.035,0.05), vec3(0.11,0.12,0.16), vUv.y) * shade;
  base += vec3(0.05)*smoothstep(0.4,0.0,abs(vUv.x-0.3))*shade; // 縦の映り込み
  float fwx = fwidth(vUv.x), fwy=fwidth(vUv.y);
  float edge = 1.0 - smoothstep(0.0, max(fwx*2.0,0.02), min(vUv.x, 1.0-vUv.x));
  float edgeY = 1.0 - smoothstep(0.0, max(fwy*2.0,0.01), min(vUv.y, 1.0-vUv.y));
  vec3 neon = kind < 1.5 ? vec3(0.1,0.7,1.0) : (kind < 2.5 ? vec3(1.0,0.3,0.7) : vec3(0.35,0.8,1.0));
  float bands = (1.0 - smoothstep(0.0, max(fwy*2.0,0.004), abs(fract(vUv.y*6.0)-0.5)-0.46)) * step(kind,1.5);
  vec3 col = base + neon*(edge*1.4 + edgeY*0.8*step(1.5,kind) + bands*0.6)*(0.7+0.5*uEnergy);
  col = mix(col, vec3(0.07,0.09,0.17), fog);
  o = vec4(col*alpha, alpha);
}`;

// 人物（プリマルチの透過画像）: リムライト・色味・残像・床の反射
const CHAR_VS = `#version 300 es
layout(location=0) in vec2 aPos; layout(location=1) in vec2 aUv;
uniform vec2 uRes; out vec2 vUv; out vec2 vPos;
void main(){ vUv=aUv; vPos=aPos; gl_Position=vec4(aPos.x/uRes.x*2.0-1.0, 1.0-aPos.y/uRes.y*2.0, 0.0, 1.0); }`;
const CHAR_FS = HEADER + `
in vec2 vUv; in vec2 vPos; out vec4 o;
uniform sampler2D uTex; uniform vec2 uTexel; uniform float uAlpha; uniform vec4 uTint; uniform vec3 uRim; uniform float uRimAmt;
uniform float uMode; // 0=通常 1=残像(加算) 2=反射
uniform float uFootY; uniform float uReflLen;
void main(){
  vec4 c = texture(uTex, vUv);
  if (uMode > 1.5) {
    float d = (vPos.y - uFootY)/uReflLen;
    float fade = (1.0 - smoothstep(0.0, 1.0, d)) * step(0.0, d);
    c *= fade*fade;
    c.rgb = mix(c.rgb, vec3(0.2,0.35,0.6)*c.a, 0.45);
    o = c*uAlpha; return;
  }
  if (uRimAmt > 0.0) {
    float r = 3.0;
    float aL = texture(uTex, vUv + vec2(-uTexel.x*r, 0.0)).a;
    float aR = texture(uTex, vUv + vec2(uTexel.x*r, 0.0)).a;
    float aU = texture(uTex, vUv + vec2(0.0, -uTexel.y*r)).a;
    float rim = c.a * clamp(max(1.0-aL, 1.0-aR)*0.8 + (1.0-aU)*0.6, 0.0, 1.0);
    c.rgb += uRim * rim * uRimAmt * c.a;
  }
  c.rgb = mix(c.rgb, uTint.rgb*c.a, uTint.a);
  if (uMode > 0.5) { o = vec4(c.rgb*uAlpha, 0.0); return; } // 加算
  o = c*uAlpha;
}`;

// VFX スプライト（形状をシェーダーで生成）
const SPRITE_VS = `#version 300 es
layout(location=0) in vec2 aCorner;
layout(location=1) in vec4 iPosSize; layout(location=2) in vec4 iRKP; layout(location=3) in float iSeed;
layout(location=4) in vec4 iColor; layout(location=5) in float iAdd;
uniform vec2 uRes; uniform float uPass; // 0=すべて 1=加算のみ（ブルーム用）
out vec2 vQ; flat out int vKind; out vec4 vColor; out vec3 vP; flat out float vAdd;
void main(){
  if (uPass > 0.5 && iAdd < 0.5) { gl_Position = vec4(2.0,2.0,2.0,1.0); return; }
  float c=cos(iRKP.x), s=sin(iRKP.x);
  vec2 l = aCorner*iPosSize.zw*0.5;
  vec2 p = iPosSize.xy + vec2(l.x*c-l.y*s, l.x*s+l.y*c);
  gl_Position = vec4(p.x/uRes.x*2.0-1.0, 1.0-p.y/uRes.y*2.0, 0.0, 1.0);
  vQ=aCorner; vKind=int(iRKP.y+0.5); vColor=iColor; vP=vec3(iRKP.z, iRKP.w, iSeed); vAdd=iAdd;
}`;
const SPRITE_FS = HEADER + `
in vec2 vQ; flat in int vKind; in vec4 vColor; in vec3 vP; flat in float vAdd; out vec4 o;
float h1(float n){return fract(sin(n)*43758.5453);}
float n1(float x){float i=floor(x),f=fract(x);f=f*f*(3.-2.*f);return mix(h1(i),h1(i+1.),f);}
float edgeFn(vec2 a, vec2 b, vec2 p){ vec2 e=b-a; return (e.x*(p.y-a.y)-e.y*(p.x-a.x))/length(e); }
void main(){
  vec2 q=vQ; float d=length(q); float a=0.0; vec3 col=vColor.rgb;
  if (vKind==0) { a = exp(-d*d*4.2)*(1.0-smoothstep(0.75,1.0,d)); }
  else if (vKind==1) {
    float core=exp(-d*d*30.0);
    float sx=exp(-abs(q.y)*42.0)*pow(max(0.,1.-abs(q.x)),2.0);
    float sy=exp(-abs(q.x)*42.0)*pow(max(0.,1.-abs(q.y)),2.0);
    vec2 r=vec2(q.x+q.y,q.x-q.y)*0.7071;
    float sd=(exp(-abs(r.y)*70.)*pow(max(0.,1.-abs(r.x)),3.)+exp(-abs(r.x)*70.)*pow(max(0.,1.-abs(r.y)),3.))*0.45;
    a = core*1.8 + (sx+sy)*1.0 + sd + exp(-d*d*5.0)*0.35;
    col = mix(col, vec3(1.0), clamp(core*1.4+0.2,0.,1.));
  }
  else if (vKind==2) {
    float along = pow(max(0.,1.-q.x*q.x),1.4);
    float hot = exp(-q.y*q.y*40.0);
    a = exp(-q.y*q.y*7.0)*along + hot*along*0.6;
    col = mix(col, vec3(1.0), hot*0.75);
  }
  else if (vKind==5) {
    float head = smoothstep(-1.0,1.0,q.x);
    a = exp(-q.y*q.y*5.0)*head*head*pow(max(0.,1.-q.x*q.x),0.35)*1.4;
    col = mix(col, vec3(1.0,1.0,0.92), pow(head,8.0)*0.85);
  }
  else if (vKind==3 || vKind==6) {
    float th = max(vP.x, 0.004);
    float R = 1.0 - th*1.6;
    float ang = atan(q.y,q.x);
    float ring = exp(-pow((d-R)/th,2.0));
    float br = 0.55+0.45*n1(ang*6.0+vP.z*13.0);
    float fine = 0.75+0.25*n1(ang*31.0+vP.z*5.0);
    a = ring*br*fine*1.25 + exp(-pow((d-R)/(th*4.0+0.04),2.0))*0.3;
    float inner = smoothstep(R, 0.0, d)*0.12; a += inner;
    col = mix(col, vec3(1.0), exp(-pow((d-R-th*0.4)/(th*0.35),2.0))*0.7);
    a *= 1.0-smoothstep(0.96,1.0,d);
    if (vKind==6) { float span=vP.y*0.5; a *= 1.0-smoothstep(span*0.55, span, abs(ang)); }
  }
  else if (vKind==4) {
    float s=vP.x;
    vec2 v0=vec2(1.0, 0.15-s*0.3), v1=vec2(-0.8+s*0.2, 0.95), v2=vec2(-0.55+s*0.4, -1.0);
    float e=min(min(edgeFn(v0,v1,q), edgeFn(v1,v2,q)), edgeFn(v2,v0,q));
    a = smoothstep(0.0, 0.08, e);
    float facet = step(0.0, q.x*0.55+q.y*0.45-(s-0.5)*0.4);
    vec3 m = mix(col*0.45, col*1.2, facet);
    float glint = pow(max(0.0, sin(vP.y*22.0+s*40.0)), 24.0)*2.0;
    col = m + vec3(glint) + vec3(1.0,0.6,0.25)*smoothstep(0.08,0.0,e)*0.6;
  }
  float A = a*vColor.a;
  o = vec4(col*A, vAdd > 0.5 ? 0.0 : A);
}`;

const BRIGHT_FS = HEADER + `in vec2 vUv; out vec4 o; uniform sampler2D uTex; uniform float uThr;
void main(){ vec3 c=texture(uTex,vUv).rgb; float l=max(c.r,max(c.g,c.b)); o=vec4(c*smoothstep(uThr,uThr+0.35,l),1.0); }`;
const BLUR_FS = HEADER + `in vec2 vUv; out vec4 o; uniform sampler2D uTex; uniform vec2 uDir;
void main(){ vec3 c=texture(uTex,vUv).rgb*0.227;
  c+=texture(uTex,vUv+uDir*1.385).rgb*0.316; c+=texture(uTex,vUv-uDir*1.385).rgb*0.316;
  c+=texture(uTex,vUv+uDir*3.231).rgb*0.07; c+=texture(uTex,vUv-uDir*3.231).rgb*0.07; o=vec4(c,1.0); }`;
const POST_FS = HEADER + `
in vec2 vUv; out vec4 o;
uniform sampler2D uScene; uniform sampler2D uBloom; uniform float uBloomAmt; uniform vec2 uShake;
uniform float uChroma; uniform float uGlitch; uniform float uFlash; uniform float uCold; uniform float uTime; uniform float uVig;
float h1(float n){return fract(sin(n)*43758.5453);}
void main(){
  vec2 uv = vUv + uShake;
  if (uGlitch > 0.0) {
    float band = floor(uv.y*42.0) + floor(uTime*45.0)*7.0;
    if (h1(band) < uGlitch*0.25) uv.x += (h1(band+3.1)-0.5)*0.022*uGlitch;
  }
  vec2 dir = uv-0.5;
  float ca = uChroma*0.009;
  vec3 col = vec3(texture(uScene, uv+dir*ca).r, texture(uScene, uv).g, texture(uScene, uv-dir*ca).b);
  col += texture(uBloom, uv).rgb*uBloomAmt;
  float l = dot(col, vec3(0.299,0.587,0.114));
  col = mix(col, vec3(l*0.65,l*0.85,l*1.35), uCold*0.65);
  if (uGlitch > 0.0) col += (h1(floor(gl_FragCoord.y*0.5)+uTime*13.0)-0.5)*0.06*uGlitch;
  col += uFlash*vec3(1.0,0.94,0.82)*0.55;
  col *= mix(1.0, smoothstep(1.25, 0.3, length(dir*vec2(1.0,0.85))), uVig);
  o = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('シェーダーのコンパイルに失敗: ' + gl.getShaderInfoLog(s));
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('シェーダーのリンクに失敗: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

export class GLRenderer {
  static create(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    if (!gl) return null;
    try { return new GLRenderer(canvas, gl); } catch (e) { console.warn('WebGL2 初期化失敗、Canvas2D に切り替え:', e); return null; }
  }

  constructor(canvas, gl) {
    this.kind = 'webgl2';
    this.canvas = canvas;
    this.gl = gl;
    this.env = program(gl, FULLSCREEN_VS, ENV_FS);
    this.geo = program(gl, GEO_VS, GEO_FS);
    this.chr = program(gl, CHAR_VS, CHAR_FS);
    this.spr = program(gl, SPRITE_VS, SPRITE_FS);
    this.bright = program(gl, FULLSCREEN_VS, BRIGHT_FS);
    this.blur = program(gl, FULLSCREEN_VS, BLUR_FS);
    this.post = program(gl, FULLSCREEN_VS, POST_FS);

    this.fsVao = gl.createVertexArray();
    gl.bindVertexArray(this.fsVao);
    const fsBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, fsBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // 汎用の動的四角形（柱・人物）
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    this.quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 4 * 8 * 6 * 64, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
    this.quadData = new Float32Array(8 * 6 * 64);

    // スプライト（インスタンス描画）
    this.sprVao = gl.createVertexArray();
    gl.bindVertexArray(this.sprVao);
    const corner = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 4 * STRIDE * 4096, gl.DYNAMIC_DRAW);
    const B = STRIDE * 4;
    const attr = (loc, size, off) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, B, off * 4); gl.vertexAttribDivisor(loc, 1); };
    attr(1, 4, 0); attr(2, 4, 4); attr(3, 1, 8); attr(4, 4, 9); attr(5, 1, 13);
    gl.bindVertexArray(null);

    this.textures = new Map(); // frameIndex → {tex, w, h, used}
    this.texTick = 0;
    this.fbos = null;
    this.stats = { uploads: 0, textureCount: 0 };
  }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    this._makeFbos(W, H);
  }

  _makeFbos(W, H) {
    const gl = this.gl;
    if (this.fbos) for (const f of Object.values(this.fbos)) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.tex); }
    const mk = (w, h) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { fb, tex, w, h };
    };
    const bw = Math.max(1, W >> 2), bh = Math.max(1, H >> 2);
    this.fbos = { scene: mk(W, H), b1: mk(bw, bh), b2: mk(bw, bh) };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** フレーム画像のテクスチャ（LRU で上限枚数を保持） */
  _texture(index, bmp) {
    const gl = this.gl;
    let t = this.textures.get(index);
    if (t && t.bmp === bmp) { t.used = ++this.texTick; return t; }
    if (!t) {
      if (this.textures.size >= 10) {
        let oldK = null, oldU = Infinity;
        for (const [k, v] of this.textures) if (v.used < oldU) { oldU = v.used; oldK = k; }
        gl.deleteTexture(this.textures.get(oldK).tex);
        this.textures.delete(oldK);
      }
      t = { tex: gl.createTexture() };
      this.textures.set(index, t);
    }
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    t.bmp = bmp; t.w = bmp.width; t.h = bmp.height; t.used = ++this.texTick;
    this.stats.uploads++;
    this.stats.textureCount = this.textures.size;
    return t;
  }

  _drawQuads(quads) {
    const gl = this.gl;
    let n = 0;
    const d = this.quadData;
    for (const q of quads) {
      if (n >= 64) break;
      const [a, b, c, e] = q.pts;
      const kind = q.kind === 'front' ? 1 : q.kind === 'side' ? 1 : q.kind === 'gate' ? 2 : 3;
      const verts = [[a, 0, 0], [b, 1, 0], [c, 1, 1], [a, 0, 0], [c, 1, 1], [e, 0, 1]];
      let o = n * 48;
      for (const [p, u, v] of verts) {
        d[o++] = p.x; d[o++] = p.y; d[o++] = u; d[o++] = v;
        d[o++] = q.shade; d[o++] = q.fog; d[o++] = q.alpha; d[o++] = kind;
      }
      n++;
    }
    if (!n) return;
    gl.useProgram(this.geo.p);
    gl.uniform2f(this.geo.u.uRes, this.w, this.h);
    gl.uniform1f(this.geo.u.uEnergy, this.energy || 0);
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, n * 48);
    gl.drawArrays(gl.TRIANGLES, 0, n * 6);
  }

  _drawChar(tex, rect, { alpha = 1, tint = [0, 0, 0, 0], rim = [0.45, 0.75, 1], rimAmt = 0, mode = 0, footY = 0, reflLen = 1 } = {}) {
    const gl = this.gl;
    const { x, y, w, h } = rect;
    const flip = mode === 2;
    // 反射は足元の線を軸に上下反転
    const y0 = flip ? footY + (footY - y) : y;
    const y1 = flip ? footY + (footY - (y + h)) : y + h;
    const d = this.quadData;
    const v = [[x, y0, 0, 0], [x + w, y0, 1, 0], [x + w, y1, 1, 1], [x, y0, 0, 0], [x + w, y1, 1, 1], [x, y1, 0, 1]];
    let o = 0;
    for (const [px, py, u, vv] of v) { d[o++] = px; d[o++] = py; d[o++] = u; d[o++] = vv; d[o++] = 0; d[o++] = 0; d[o++] = 0; d[o++] = 0; }
    gl.useProgram(this.chr.p);
    gl.uniform2f(this.chr.u.uRes, this.w, this.h);
    gl.uniform2f(this.chr.u.uTexel, 1 / tex.w, 1 / tex.h);
    gl.uniform1f(this.chr.u.uAlpha, alpha);
    gl.uniform4fv(this.chr.u.uTint, tint);
    gl.uniform3fv(this.chr.u.uRim, rim);
    gl.uniform1f(this.chr.u.uRimAmt, rimAmt);
    gl.uniform1f(this.chr.u.uMode, mode);
    gl.uniform1f(this.chr.u.uFootY, footY);
    gl.uniform1f(this.chr.u.uReflLen, reflLen);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    gl.uniform1i(this.chr.u.uTex, 0);
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, 48);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  _drawSprites(batch, pass = 0) {
    if (!batch.count) return;
    const gl = this.gl;
    gl.useProgram(this.spr.p);
    gl.uniform2f(this.spr.u.uRes, this.w, this.h);
    gl.uniform1f(this.spr.u.uPass, pass);
    gl.bindVertexArray(this.sprVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.data, 0, batch.count * STRIDE);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
  }

  _fs(prog, target, setup) {
    const gl = this.gl;
    if (target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb); gl.viewport(0, 0, target.w, target.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.canvas.width, this.canvas.height); }
    gl.useProgram(prog.p);
    setup(prog.u);
    gl.bindVertexArray(this.fsVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * 1フレーム描画
   * @param {object} f  scene.js が組み立てるフレーム情報
   */
  render(f) {
    const gl = this.gl;
    const { st, q, sig } = f;
    this.energy = f.energy;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos.scene.fb);
    gl.viewport(0, 0, this.fbos.scene.w, this.fbos.scene.h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    // 1) 背景・床
    this._fs(this.env, this.fbos.scene, (u) => {
      gl.uniform2f(u.uRes, this.w, this.h);
      gl.uniform1f(u.uDpr, this.dpr);
      gl.uniform1f(u.uHorizon, st.horizonY);
      gl.uniform1f(u.uVpX, st.vpX);
      gl.uniform1f(u.uFocal, st.focal);
      gl.uniform1f(u.uCamH, st.p.camH);
      gl.uniform1f(u.uScroll, f.scroll);
      gl.uniform1f(u.uTime, f.t);
      gl.uniform1f(u.uFog, q.fog);
      gl.uniform1f(u.uPanel, st.p.panel);
      gl.uniform1f(u.uNeonEvery, st.p.neonEvery);
      gl.uniform1f(u.uCharZ, f.charZ);
      gl.uniform1f(u.uCharX, f.charX);
      gl.uniform1f(u.uEnergy, f.energy);
      gl.uniform1f(u.uCorridor, st.p.corridor);
      const pulses = new Float32Array(32);
      const n = Math.min(8, f.pulses.length);
      for (let i = 0; i < n; i++) pulses.set([f.pulses[i].x, f.pulses[i].z, f.pulses[i].age, f.pulses[i].strength], i * 4);
      gl.uniform4fv(u.uPulses, pulses);
      gl.uniform1i(u.uPulseCount, n);
    });

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // 2) 人物より奥の柱・ゲート・粒子
    this._drawQuads(f.world.behind);
    this._drawSprites(f.dustBehind);

    // 2.5) ブルームの元: 背景の発光部分だけを抽出（人物を描く前に取るので、白い道着が光らない）
    const bloom = q.bloom;
    if (bloom) {
      gl.disable(gl.BLEND);
      this._fs(this.bright, this.fbos.b1, (u) => { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.fbos.scene.tex); gl.uniform1i(u.uTex, 0); gl.uniform1f(u.uThr, 0.62); });
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos.scene.fb);
      gl.viewport(0, 0, this.fbos.scene.w, this.fbos.scene.h);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }

    // 3) 床の反射・接地影・背面の光
    const ch = f.character;
    if (ch && ch.bmp) {
      const tex = this._texture(ch.index, ch.bmp);
      this._drawSprites(f.under);
      if (q.reflection) this._drawChar(tex, ch.rect, { alpha: 0.32, mode: 2, footY: ch.footY, reflLen: ch.rect.h * 0.28 });
      // 4) 残像（直前の動作の数コマ・加算）
      for (const g of ch.ghosts) {
        if (!g.bmp) continue;
        const gt = this._texture(g.index, g.bmp);
        this._drawChar(gt, ch.rect, { alpha: g.alpha, mode: 1, tint: [0.35, 0.75, 1, 0.75] });
      }
      // 5) 人物（主役）
      this._drawChar(tex, ch.rect, { alpha: 1, rimAmt: q.rimLight ? 0.55 + f.energy * 0.6 : 0, rim: [0.45, 0.78, 1] });
    }

    // 6) 手前の柱・粒子 → VFX
    this._drawQuads(f.world.front);
    this._drawSprites(f.dustFront);
    this._drawSprites(f.fx);

    // 7) ブルーム: エフェクトの加算部分を縮小バッファにも描いてからぼかす
    if (bloom) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos.b1.fb);
      gl.viewport(0, 0, this.fbos.b1.w, this.fbos.b1.h);
      this._drawSprites(f.fx, 1);
    }
    gl.disable(gl.BLEND);
    if (bloom) {
      for (let i = 0; i < 2; i++) {
        this._fs(this.blur, this.fbos.b2, (u) => { gl.bindTexture(gl.TEXTURE_2D, this.fbos.b1.tex); gl.uniform1i(u.uTex, 0); gl.uniform2f(u.uDir, (1 + i) / this.fbos.b1.w, 0); });
        this._fs(this.blur, this.fbos.b1, (u) => { gl.bindTexture(gl.TEXTURE_2D, this.fbos.b2.tex); gl.uniform1i(u.uTex, 0); gl.uniform2f(u.uDir, 0, (1 + i) / this.fbos.b1.h); });
      }
    }
    // 8) 画面への合成
    this._fs(this.post, null, (u) => {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.fbos.scene.tex); gl.uniform1i(u.uScene, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.fbos.b1.tex); gl.uniform1i(u.uBloom, 1);
      gl.uniform1f(u.uBloomAmt, bloom ? q.bloomStrength : 0);
      gl.uniform2f(u.uShake, sig.sx / this.w, -sig.sy / this.h);
      gl.uniform1f(u.uChroma, q.chroma ? sig.chroma : 0);
      gl.uniform1f(u.uGlitch, sig.glitch);
      gl.uniform1f(u.uFlash, sig.flash);
      gl.uniform1f(u.uCold, sig.cold);
      gl.uniform1f(u.uTime, f.t);
      gl.uniform1f(u.uVig, 0.85);
      gl.activeTexture(gl.TEXTURE0);
    });
  }

  dispose() {
    const gl = this.gl;
    for (const t of this.textures.values()) gl.deleteTexture(t.tex);
    this.textures.clear();
  }
}
