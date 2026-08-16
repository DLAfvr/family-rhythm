'use strict';
document.querySelector('#cancel').onclick=()=>window.rhythm.closeWindow();
document.querySelector('#quit').onclick=async()=>{
  const ok=await window.rhythm.exitApp(document.querySelector('#password').value);
  if(!ok){document.querySelector('#hint').textContent='家長密碼不正確，請再試一次。';document.querySelector('#hint').style.color='#ff9baa';document.querySelector('#password').focus();}
};
document.querySelector('#password').addEventListener('keydown',e=>{if(e.key==='Enter')document.querySelector('#quit').click();});
