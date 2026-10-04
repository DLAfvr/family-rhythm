'use strict';
const $=selector=>document.querySelector(selector);
const dayKey=(date=new Date())=>date.toLocaleDateString('sv-SE');
function occurs(task,date=new Date()){
  if(task.kind==='once')return task.date===dayKey(date);
  if(task.kind==='daily')return true;
  if(task.kind==='weekly')return(task.weekdays||[]).includes(date.getDay());
  return false;
}
function completed(state,taskId){return state.completions.some(x=>x.taskId===taskId&&x.date===dayKey());}
function reasonText(kind){return{early:'現在還沒到開始使用時間；晶幣會兌換成提早使用時間。',quota:'今天的基本額度已用完；晶幣會補入今日可用額度。',clock:'固定關機時間已到；晶幣會在家長允許的上限內延長今晚時間。'}[kind]||'完成責任後，可以使用獲得的時間晶幣。';}
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
let busy=false;
async function render(message=''){
  const state=await window.rhythm.getState(),mode=state.runtime.taskMode;
  if(!mode)return;
  const tasks=state.tasks.filter(task=>(!task.targetDeviceId||task.targetDeviceId===state.networkStatus.deviceId)&&occurs(task));
  const done=tasks.filter(task=>completed(state,task.id));
  $('#balance').textContent=mode.balanceMinutes;
  $('#reason').textContent=reasonText(mode.kind);
  $('#progress').textContent=`已完成 ${done.length}／${tasks.length} 項`;
  $('#task-list').innerHTML=tasks.length?tasks.map(task=>{const isDone=completed(state,task.id);return`<div class="task ${isDone?'done':''}"><div><div class="task-title">${escapeHtml(task.title)}</div><div class="reward">${Number(task.rewardMinutes)>0?`完成獲得 ✦ ${Number(task.rewardMinutes)} 分鐘`:'這項責任沒有時間獎勵'}</div></div><button class="complete ${isDone?'':'primary'}" data-id="${escapeHtml(task.id)}" ${isDone?'disabled':''}>${isDone?'已完成 ✓':'完成並打勾'}</button></div>`;}).join(''):'<div class="empty">今天目前沒有責任。可以按「重新整理同步」取得家長剛安排的新任務。</div>';
  const input=$('#minutes');input.max=mode.maxMinutes;input.value=mode.maxMinutes||1;input.disabled=mode.maxMinutes<1;
  $('#use').disabled=mode.maxMinutes<1;
  $('#use-note').textContent=mode.maxMinutes>0?`目前最多可使用 ${mode.maxMinutes} 分鐘`:(mode.balanceMinutes>0&&mode.kind==='clock'?'已達家長設定的今晚延長上限':'先完成有獎勵的責任，取得時間晶幣');
  $('#sync-state').textContent=message;
  document.querySelectorAll('.complete').forEach(button=>button.onclick=async()=>{if(busy)return;busy=true;button.disabled=true;$('#sync-state').textContent='正在記錄並同步完成狀態…';try{const out=await window.rhythm.completeTask(button.dataset.id);if(!out?.ok)throw new Error('這項責任目前無法完成');await window.rhythm.refreshTaskMode();await render(out.duplicate?'這項責任今天已經完成。':'完成了，時間晶幣已存入！');}catch(error){await render(error.message||'無法完成任務');}finally{busy=false;}});
}
$('#refresh').onclick=async()=>{if(busy)return;busy=true;$('#refresh').disabled=true;$('#sync-state').textContent='正在向家庭主要電腦同步…';try{const out=await window.rhythm.refreshTaskMode();if(out.network.role==='client'&&!out.network.online)throw new Error(out.network.lastError||'主要電腦目前離線');await render('同步完成，已載入最新責任。');}catch(error){await render(`同步失敗：${error.message||'目前無法連線'}`);}finally{busy=false;$('#refresh').disabled=false;}};
$('#use').onclick=async()=>{if(busy)return;busy=true;$('#use').disabled=true;const out=await window.rhythm.useTaskModeReward(Number($('#minutes').value));if(out?.ok&&!out.unlocked){busy=false;await render(out.nextKind==='clock'?'額度已補入，但固定關機時間也到了；請再兌換關機延長時間。':'還有另一項時間限制需要處理。');return;}if(!out?.ok){busy=false;await render('目前沒有可用的晶幣，或已達家長設定的延長上限。');}};
$('#shutdown').onclick=async()=>{if(confirm('確定結束任務模式並開始關機倒數？'))await window.rhythm.shutdownFromTaskMode();};
window.rhythm.onStateChanged(()=>{if(!busy)render();});
render();
