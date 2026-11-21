export const permissionGuard = `(()=>{
  const denied=()=>Promise.reject(new DOMException('Permission request denied in DSH agent tab','NotAllowedError'));
  const replace=(object,key,value)=>{try{if(object&&typeof object[key]==='function')Object.defineProperty(object,key,{value,configurable:true,writable:true})}catch{}};
  replace(globalThis.Notification,'requestPermission',callback=>{if(typeof callback==='function')queueMicrotask(()=>callback('denied'));return Promise.resolve('denied')});
  for(const [object,keys] of [
    [navigator.mediaDevices,['getUserMedia','getDisplayMedia']],
    [navigator.clipboard,['read','readText','write','writeText']],
    [navigator.bluetooth,['requestDevice']], [navigator.usb,['requestDevice']],
    [navigator.hid,['requestDevice']], [navigator.serial,['requestPort']],
    [globalThis,['showOpenFilePicker','showSaveFilePicker','showDirectoryPicker']]
  ])for(const key of keys)replace(object,key,denied);
  for(const key of ['getCurrentPosition','watchPosition'])replace(navigator.geolocation,key,(_success,error)=>{if(typeof error==='function')queueMicrotask(()=>error({code:1,message:'Permission denied in DSH agent tab',PERMISSION_DENIED:1}));return -1});
})()`
