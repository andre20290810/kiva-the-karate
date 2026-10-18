export const DISPLAY_MODES = Object.freeze([
 {id:'kiva-video',label:'MODE 1 KIVA ORIGINAL VIDEO',available:true,kind:'video'},
 {id:'kiva-3d',label:'MODE 2 KIVA 3D (TECH PREVIEW)',available:true,kind:'3d',reason:'Skinned model fitted to measured face/body ratios; Seipai motion estimated from the source video — depth/rotation not measured'},
 {id:'alexandre-3d',label:'MODE 3 ALEXANDRE 3D (TECH PREVIEW)',available:true,kind:'3d',reason:'Built against the turntable reference (coat, boots, long silver hair); face and hair are simplified, not a likeness'},
 {id:'kiva-frames',label:'MODE 4 KIVA FRAME ANIMATION',available:true,kind:'frames',character:'kiva'},
 {id:'alexandre-frames',label:'MODE 5 ALEXANDRE 2D FRAME ANIMATION (PREVIEW)',available:true,kind:'frames',character:'alexandre',
  reason:'412 frames re-posed from the ALEXANDRE turntable images onto KIVA poses by 2D warping (no 3D, no face swap); large poses are distorted'},
]);
export function findDisplayMode(id){return DISPLAY_MODES.find(m=>m.id===id)||DISPLAY_MODES[0]}
export function canActivateMode(id){return findDisplayMode(id).available}
