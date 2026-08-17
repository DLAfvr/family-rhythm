'use strict';
function timeText(date) { return date.toLocaleTimeString('zh-TW', { hour:'2-digit', minute:'2-digit' }); }
function activeDayRules(settings,date=new Date()){const weekend=[0,6].includes(date.getDay()),split=Boolean(settings.dayTypeScheduleEnabled);return{limit:split?Number(weekend?settings.weekendDailyLimitMinutes:settings.weekdayDailyLimitMinutes):Number(settings.dailyLimitMinutes),time:split?(weekend?settings.weekendShutdownTime:settings.weekdayShutdownTime):settings.shutdownTime};}
async function render() {
  const s = await window.rhythm.getState();
  const key = `me:${new Date().toLocaleDateString('sv-SE')}`;
  const used = Math.floor((s.usage[key] || 0) / 60);
  const today = new Date().toLocaleDateString('sv-SE');
  const earned = s.completions.filter(x => x.memberId === 'me' && x.date === today).reduce((a,x)=>a+(x.rewardMinutes||0),0),rewardUse=s.rewardUsage?.[today]||{};
  const rules=activeDayRules(s.settings),quotaRemaining=Math.max(0,rules.limit+(Number(rewardUse.quotaMinutes)||0)-used); let clockRemaining=null;
  if (['clock','both'].includes(s.settings.timeMode) && /^\d{2}:\d{2}$/.test(rules.time || '')) {
    const [h,m]=rules.time.split(':').map(Number), end=new Date(),extension=s.settings.rewardExtendsClock?Math.min(Number(rewardUse.clockMinutes)||0,Number(s.settings.maxRewardClockExtensionMinutes)||0):0; end.setHours(h,m+extension,0,0);clockRemaining=Math.max(0,Math.ceil((end-Date.now())/60000));
  }
  const remaining=s.settings.timeMode==='clock'?clockRemaining:s.settings.timeMode==='both'?Math.min(quotaRemaining,clockRemaining):quotaRemaining;
  document.querySelector('#time').textContent = !s.settings.timeControlEnabled ? '自由使用' : s.runtime.shutdownAt ? `關機 ${Math.max(0,Math.ceil((s.runtime.shutdownAt-Date.now())/60000))} 分` : `${remaining} 分鐘`;
  document.querySelector('#reward').textContent = `時間晶幣 ${Number(s.rewardBalanceMinutes)||0} 分鐘 · 今日 +${earned}`;
  const fixed=s.reminders.filter(x=>x.enabled&&x.triggerMode!=='afterStart'&&x.time).map(x=>({x,at:nextAt(x),relative:false})).filter(x=>x.at);
  const relative=s.reminders.filter(x=>x.enabled&&x.triggerMode==='afterStart'&&Number(x.delayMinutes)>0).map(x=>{const interval=Number(x.delayMinutes)*60,used=s.runtime.sessionActiveSeconds||0,remain=x.relativeRepeat?interval-(used%interval):Math.max(0,interval-used);return{x,at:new Date(Date.now()+remain*1000),relative:true,remain};}).filter(x=>x.x.relativeRepeat||x.remain>0);
  const list=[...fixed,...relative].sort((a,b)=>a.at-b.at);
  document.querySelector('#next').textContent = list[0] ? `${list[0].relative?`使用 ${Math.max(1,Math.ceil(list[0].remain/60))} 分鐘後`:timeText(list[0].at)}　${list[0].x.title}` : '尚未設定';
}
function nextAt(r) { const now=new Date(); for(let i=0;i<8;i++){const d=new Date(now);d.setDate(d.getDate()+i);if(r.repeat==='weekly'&&!r.weekdays?.includes(d.getDay()))continue;if(r.repeat==='once'&&r.date!==d.toLocaleDateString('sv-SE'))continue;const [h,m]=r.time.split(':').map(Number);d.setHours(h,m,0,0);if(d>now)return d;} return null; }
document.querySelector('#manage').onclick=()=>window.rhythm.openDashboard();
document.querySelector('#tasks').onclick=()=>window.rhythm.openDashboard();
window.rhythm.onStateChanged(render); setInterval(render,1000); render();
