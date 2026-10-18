export const DISPLAY_MODES = Object.freeze([
 {id:'kiva-video',label:'MODE 1 KIVA ORIGINAL VIDEO',available:true,kind:'video'},
 {id:'kiva-3d',label:'MODE 2 KIVA 3D (TECH PREVIEW)',available:true,kind:'3d',reason:'Skinned human model; motion estimated from monocular video — depth/rotation not measured'},
 {id:'alexandre-3d',label:'MODE 3 ALEXANDRE 3D (TECH PREVIEW)',available:true,kind:'3d',reason:'Built without the reference video frames; appearance not verified against the reference'},
]);
export function findDisplayMode(id){return DISPLAY_MODES.find(m=>m.id===id)||DISPLAY_MODES[0]}
export function canActivateMode(id){return findDisplayMode(id).available}
