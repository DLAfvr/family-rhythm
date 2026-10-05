'use strict';
let passwordRequired=false;
window.rhythm.getState().then(state=>{
  passwordRequired=Boolean(state.networkStatus?.managementEnabled&&state.parentLock?.configured);
  document.querySelector('#password').hidden=!passwordRequired;
  if(passwordRequired)document.querySelector('#hint').textContent='退出後，提醒、責任同步與使用時間管理都會停止。這台裝置正受家庭管理，請輸入家長密碼確認退出。';
});
document.querySelector('#cancel').onclick=()=>window.rhythm.closeWindow();
document.querySelector('#quit').onclick=async()=>{
  const password=document.querySelector('#password');
  const ok=await window.rhythm.exitApp(passwordRequired?password.value:'');
  if(!ok){document.querySelector('#hint').textContent='家長密碼不正確，請再試一次。';document.querySelector('#hint').style.color='#ff9baa';document.querySelector('#password').focus();}
};
document.querySelector('#password').addEventListener('keydown',e=>{if(e.key==='Enter')document.querySelector('#quit').click();});
