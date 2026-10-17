export const DISPLAY_MODES = Object.freeze([
 {id:'kiva-video',label:'KIVA / VIDEO',available:true,kind:'video'},
 {id:'kiva-3d',label:'KIVA / 3D TEST',available:true,kind:'3d',reason:'Uncorrected 2D tracking shown in a 3D scene — NOT final quality'},
 {id:'alexandre-3d',label:'ALEXANDRE / 3D TEST',available:true,kind:'3d',reason:'Low-poly likeness proxy only; not approved final Alexandre character'},
]);
export function findDisplayMode(id){return DISPLAY_MODES.find(m=>m.id===id)||DISPLAY_MODES[0]}
export function canActivateMode(id){return findDisplayMode(id).available}
