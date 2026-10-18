// 音の出力経路は Web Audio（AudioClock）の1本だけにする。
// 以前は スマホで HTMLAudio を併用し、Web Audio 側を gain=0 で消していたが、
//  - AudioParam へ自動化（setTargetAtTime）と value 直接代入を混ぜると、ブラウザ実装によっては
//    Web Audio 側が鳴り直し、HTMLAudio と最大 0.18 秒ずれた二重音（残響のような音）になりうる
//  - HTMLAudio の開始遅延が大きい端末では、0.18 秒を超えるたびにシークが繰り返される
// ため、HTMLAudio / HTMLVideo からは一切音を出さない。判定の基準時刻と聞こえる音が同じ経路になる。
//
// iPhone の消音スイッチ（マナーモード）対策: Web Audio は既定で「消音スイッチに従う」分類なので、
// Audio Session API（Safari 17 以降）で再生用の分類にする。非対応の古い iOS では消音スイッチ中は鳴らない
// （画面に案内を出す）。

export function isIOS(ua = navigator.userAgent, platform = navigator.platform, touchPoints = navigator.maxTouchPoints) {
  return /iPhone|iPad|iPod/i.test(ua) || (platform === 'MacIntel' && touchPoints > 1);
}

/**
 * ユーザー操作（開始・再開）の中で呼ぶ。
 * @returns {{session:'playback'|'unsupported'|'n/a', hint:string|null}}
 */
export function configureAudioSession(nav = navigator) {
  try {
    if (nav.audioSession && 'type' in nav.audioSession) {
      if (nav.audioSession.type !== 'playback') nav.audioSession.type = 'playback';
      return { session: 'playback', hint: null };
    }
  } catch { /* 設定できない環境 */ }
  if (isIOS(nav.userAgent, nav.platform, nav.maxTouchPoints)) {
    return { session: 'unsupported', hint: '音が出ない場合は、iPhone の消音スイッチ（マナーモード）を解除してください。' };
  }
  return { session: 'n/a', hint: null };
}

/** 動画要素から音が出ないことを保証する（演出用の映像は常に無音） */
export function silenceMedia(el) {
  if (!el) return;
  el.muted = true;
  el.defaultMuted = true;
  el.volume = 0;
  el.setAttribute('muted', '');
}
