'use strict';

const crypto = require('node:crypto');

const DEFAULT_STATE = {
  version: 1,
  familyName: '我們家',
  members: [{ id: 'me', name: '我', color: '#7c6df2', managed: true }],
  settings: {
    startWithWindows: false,
    timeControlEnabled: true,
    earliestStartEnabled: false,
    earliestStartTime: '07:00',
    dailyLimitMinutes: 120,
    dayTypeScheduleEnabled: false,
    weekdayDailyLimitMinutes: 120,
    weekendDailyLimitMinutes: 120,
    timeMode: 'quota',
    shutdownTime: '21:30',
    weekdayShutdownTime: '21:30',
    weekendShutdownTime: '21:30',
    vacationSchedules: [],
    rewardExtendsClock: true,
    maxRewardClockExtensionMinutes: 30,
    rewardCapMinutes: 60,
    parentPassword: null,
    shutdownGraceMinutes: 10,
    simulateShutdown: true,
    autoCheckUpdates: true
  },
  reminders: [],
  soundAssets: {},
  tasks: [],
  completions: [],
  rewardBalanceMinutes: 0,
  rewardUsage: {},
  usage: {},
  events: [],
  notifications: []
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function uuid() { return crypto.randomUUID(); }
function validDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
function validClockTime(value) { return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value || ''); }
function validMonthDay(value) {
  if (!/^\d{2}-\d{2}$/.test(value || '')) return false;
  const [month, day]=value.split('-').map(Number);
  return month>=1&&month<=12&&day>=1&&day<=new Date(Date.UTC(2024,month,0)).getUTCDate();
}
function normalizeVacationSchedules(items = []) {
  const normalized = (Array.isArray(items) ? items : [])
    .filter(x => x && validClockTime(x.shutdownTime) && Number.isFinite(Number(x.dailyLimitMinutes)) && (x.annual ? validMonthDay(x.startMonthDay)&&validMonthDay(x.endMonthDay) : validDateKey(x.startDate)&&validDateKey(x.endDate)&&x.startDate<=x.endDate))
    .map(x => ({
      id: String(x.id || uuid()),
      name: String(x.name || '假期').trim().slice(0, 40) || '假期',
      annual:Boolean(x.annual),
      ...(x.annual?{startMonthDay:x.startMonthDay,endMonthDay:x.endMonthDay}:{startDate:x.startDate,endDate:x.endDate}),
      dailyLimitMinutes: Math.min(1440, Math.max(0, Math.floor(Number(x.dailyLimitMinutes)))),
      shutdownTime: x.shutdownTime
    }))
    .sort((a,b)=>String(a.startDate||a.startMonthDay).localeCompare(String(b.startDate||b.startMonthDay)));
  const accepted=[];for(const item of normalized){if(!item.annual&&accepted.some(x=>!x.annual&&item.startDate<=x.endDate&&x.startDate<=item.endDate))continue;accepted.push(item);}return accepted.slice(0,30);
}
function vacationOccursOn(item,date=new Date()){
  if(!item.annual){const key=localDateKey(date);return item.startDate<=key&&key<=item.endDate;}
  const md=`${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  if(md==='02-29'&&date.getMonth()!==1)return false;
  return item.startMonthDay<=item.endMonthDay?(item.startMonthDay<=md&&md<=item.endMonthDay):(md>=item.startMonthDay||md<=item.endMonthDay);
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, saved) {
  if (!saved?.salt || !saved?.hash) return false;
  const actual = Buffer.from(hashPassword(password, saved.salt).hash, 'hex');
  const expected = Buffer.from(saved.hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function normalizeTask(value, now = new Date()) {
  const task = { memberId:'me',kind:'once',rewardMinutes:0,enabled:true,private:false,resetTime:'00:00',customReset:false,round:1,updatedAt:now.toISOString(),...value };
  if (task.kind === 'once') {
    if (!task.date) task.date = localDateKey(now);
    if (!validDateKey(task.date)) throw new Error('請選擇有效的任務日期');
  }
  task.enabled=task.enabled!==false;task.private=Boolean(task.private);task.customReset=Boolean(task.customReset);
  task.resetTime=validClockTime(task.resetTime)?task.resetTime:'00:00';task.round=Math.max(1,Math.floor(Number(task.round)||1));
  if(task.kind==='bounty'){task.maxCompletions=Math.max(1,Math.floor(Number(task.maxCompletions)||1));task.eligibleDeviceIds=Array.isArray(task.eligibleDeviceIds)?task.eligibleDeviceIds.map(String):[];task.allFamily=task.allFamily!==false;}
  return task;
}
function responsibilityDate(task,date=new Date()){
  const shifted=new Date(date);if(task?.customReset&&validClockTime(task.resetTime)){const[h,m]=task.resetTime.split(':').map(Number);if(date.getHours()*60+date.getMinutes()<h*60+m)shifted.setDate(shifted.getDate()-1);}return shifted;
}
function responsibilityDateKey(task,date=new Date()){return localDateKey(responsibilityDate(task,date));}
function taskOccursOn(task, date = new Date()) {
  if(!task||task.enabled===false||task.deletedAt)return false;
  const effective=responsibilityDate(task,date),key=localDateKey(effective);
  if (task.kind === 'once') return task.date === key;
  if (task.kind === 'daily'||task.kind==='bounty') return true;
  if (task.kind === 'weekly') return (task.weekdays || []).includes(effective.getDay());
  return false;
}
function completionFor(state, taskId, memberId, date = new Date()) {
  const task=state.tasks.find(x=>x.id===taskId),key=responsibilityDateKey(task,date),round=Math.max(1,Number(task?.round)||1);
  return state.completions.find(x => x.taskId === taskId && x.memberId === memberId && x.date === key && Math.max(1,Number(x.round)||1)===round);
}
function completeTask(state, taskId, memberId, date = new Date()) {
  const task = state.tasks.find(x => x.id === taskId);
  if (!task || task.memberId !== memberId) return { ok: false, reason: 'not_available' };
  const existing = completionFor(state, taskId, memberId, date);
  if (existing) return { ok: true, completion: existing, duplicate: true };
  if (!taskOccursOn(task, date)) return { ok: false, reason: 'not_available' };
  const granted=Math.max(0,Number(task.rewardMinutes)||0);
  const completion = {
    id: uuid(), taskId, memberId, date: responsibilityDateKey(task,date),round:Math.max(1,Number(task.round)||1), completedAt: date.toISOString(),
    rewardMinutes: granted
  };
  state.completions.push(completion);
  state.rewardBalanceMinutes=Math.max(0,Number(state.rewardBalanceMinutes)||0)+granted;
  if(task.kind==='once'){task.enabled=false;task.updatedAt=date.toISOString();}
  return { ok: true, completion, duplicate: false };
}
function rewardMinutes(state, memberId, date = new Date()) {
  const key = localDateKey(date);
  const earned = state.completions
    .filter(x => x.memberId === memberId && x.date === key)
    .reduce((sum, x) => sum + (Number(x.rewardMinutes) || 0), 0);
  return Math.max(0, earned);
}
function usedMinutes(state, memberId, date = new Date()) {
  return Math.floor((state.usage[`${memberId}:${localDateKey(date)}`] || 0) / 60);
}
function dayTypeSettings(settings,date=new Date()){const vacation=normalizeVacationSchedules(settings.vacationSchedules).find(x=>vacationOccursOn(x,date));if(vacation)return{kind:'vacation',name:vacation.name||'假期',dailyLimitMinutes:Number(vacation.dailyLimitMinutes),shutdownTime:vacation.shutdownTime};const day=date.getDay(),weekendQuota=[0,6].includes(day),weekendNight=[5,6].includes(day),enabled=Boolean(settings.dayTypeScheduleEnabled);return{kind:weekendQuota?'weekend':'weekday',dailyLimitMinutes:enabled?Number(weekendQuota?settings.weekendDailyLimitMinutes:settings.weekdayDailyLimitMinutes):Number(settings.dailyLimitMinutes),shutdownTime:enabled?(weekendNight?settings.weekendShutdownTime:settings.weekdayShutdownTime):settings.shutdownTime};}
function taskStats(state,date=new Date(),now=new Date()){
  const dateKey=typeof date==='string'?date:localDateKey(date),day=new Date(`${dateKey}T12:00:00`),today=localDateKey(now),tasks=(state.tasks||[]).filter(t=>!t.deletedAt&&t.kind!=='once'?taskOccursOn({...t,enabled:true},day):(t.date===dateKey));
  const rows=tasks.map(task=>{const completion=(state.completions||[]).filter(c=>c.taskId===task.id&&c.date===dateKey).sort((a,b)=>String(a.completedAt).localeCompare(String(b.completedAt)))[0];return{taskId:task.id,title:task.title,rewardMinutes:Number(completion?.rewardMinutes)||0,completedAt:completion?.completedAt||null,status:completion?'completed':dateKey<today?'missed':'pending'};});
  return{date:dateKey,completed:rows.filter(x=>x.status==='completed'),pending:rows.filter(x=>x.status==='pending'),missed:rows.filter(x=>x.status==='missed'),earnedMinutes:rows.reduce((n,x)=>n+x.rewardMinutes,0)};
}
function remainingMinutes(state, memberId, date = new Date()) {
  const usage=state.rewardUsage?.[localDateKey(date)]||{};
  const rules=dayTypeSettings(state.settings,date),quota = Math.max(0, rules.dailyLimitMinutes + (Number(usage.quotaMinutes)||0) - usedMinutes(state, memberId, date));
  if (['clock','both'].includes(state.settings.timeMode) && /^\d{2}:\d{2}$/.test(rules.shutdownTime || '')) {
    const [hour, minute] = rules.shutdownTime.split(':').map(Number);
    const end = new Date(date);
    end.setHours(hour, minute, 0, 0);
    if (state.settings.rewardExtendsClock) end.setMinutes(end.getMinutes() + Math.min(Number(usage.clockMinutes)||0,Math.max(0,Number(state.settings.maxRewardClockExtensionMinutes)||0)));
    const clock = Math.max(0, Math.ceil((end - date) / 60000));
    return state.settings.timeMode === 'both' ? Math.min(quota, clock) : clock;
  }
  return quota;
}
function effectiveShutdownAt(state, memberId, date = new Date()) {
  const rules=dayTypeSettings(state.settings,date);if (!['clock','both'].includes(state.settings.timeMode) || !/^\d{2}:\d{2}$/.test(rules.shutdownTime || '')) return null;
  const [hour, minute] = rules.shutdownTime.split(':').map(Number);
  const end = new Date(date);
  end.setHours(hour, minute, 0, 0);
  const usage=state.rewardUsage?.[localDateKey(date)]||{};
  if (state.settings.rewardExtendsClock) end.setMinutes(end.getMinutes() + Math.min(Number(usage.clockMinutes)||0,Math.max(0,Number(state.settings.maxRewardClockExtensionMinutes)||0)));
  return end;
}
function spendReward(state,kind,minutes,date=new Date()){
  const amount=Math.min(Math.max(0,Math.floor(Number(minutes)||0)),Math.max(0,Math.floor(Number(state.rewardBalanceMinutes)||0)));
  if(!amount)return 0;const key=localDateKey(date);state.rewardUsage||={};state.rewardUsage[key]||={quotaMinutes:0,clockMinutes:0,earlySessions:[]};
  if(kind==='quota')state.rewardUsage[key].quotaMinutes=(Number(state.rewardUsage[key].quotaMinutes)||0)+amount;
  else if(kind==='clock')state.rewardUsage[key].clockMinutes=(Number(state.rewardUsage[key].clockMinutes)||0)+amount;
  else if(kind==='early')state.rewardUsage[key].earlySessions.push({minutes:amount,startedAt:date.toISOString(),accessUntil:new Date(date.getTime()+amount*60000).toISOString()});
  else return 0;state.rewardBalanceMinutes-=amount;return amount;
}
function earliestStartAt(state,date=new Date()){if(!state.settings.earliestStartEnabled||!/^\d{2}:\d{2}$/.test(state.settings.earliestStartTime||''))return null;const [h,m]=state.settings.earliestStartTime.split(':').map(Number),at=new Date(date);at.setHours(h,m,0,0);return at;}
function earlyAccessUntil(state,date=new Date()){const sessions=state.rewardUsage?.[localDateKey(date)]?.earlySessions||[];return sessions.reduce((latest,x)=>Math.max(latest,new Date(x.accessUntil).getTime()||0),0);}
function timeBlockReason(state,memberId='me',date=new Date()){
  if(!state.settings.timeControlEnabled)return null;
  const startAt=earliestStartAt(state,date);
  if(startAt&&date<startAt&&earlyAccessUntil(state,date)<=date.getTime())return'early';
  if(['quota','both'].includes(state.settings.timeMode)&&remainingMinutes({...state,settings:{...state.settings,timeMode:'quota'}},memberId,date)<=0)return'quota';
  const end=effectiveShutdownAt(state,memberId,date);
  return end&&date>=end?'clock':null;
}
function rewardSpendLimit(state,kind,date=new Date()){
  const balance=Math.max(0,Math.floor(Number(state.rewardBalanceMinutes)||0));
  if(kind!=='clock')return balance;
  if(state.settings.rewardExtendsClock===false)return 0;
  const used=Number(state.rewardUsage?.[localDateKey(date)]?.clockMinutes)||0;
  return Math.min(balance,Math.max(0,(Number(state.settings.maxRewardClockExtensionMinutes)||0)-used));
}
function reminderOccursOn(reminder, date = new Date()) {
  if (!reminder.enabled) return false;
  if (reminder.repeat === 'once') return reminder.date === localDateKey(date);
  if (reminder.repeat === 'weekly') return (reminder.weekdays || []).includes(date.getDay());
  return true;
}
function reminderDue(reminder, now = new Date(), toleranceSeconds = 30) {
  if (!reminderOccursOn(reminder, now) || !/^\d{2}:\d{2}$/.test(reminder.time || '')) return false;
  const [hour, minute] = reminder.time.split(':').map(Number);
  const scheduled = new Date(now);
  scheduled.setHours(hour, minute, 0, 0);
  const delta = (now - scheduled) / 1000;
  return delta >= 0 && delta < toleranceSeconds;
}
function reminderOccurrenceKey(reminder, now = new Date()) {
  return `${reminder.id}:${localDateKey(now)}:${reminder.time}`;
}
function pendingClockReminder(reminder, events, now = new Date()) {
  if (reminder.triggerMode === 'afterStart' || !reminderDue(reminder, now, Infinity)) return false;
  const key = reminderOccurrenceKey(reminder, now);
  return !events.some(e => e.type === 'reminder-fired' && (e.occurrenceKey === key ||
    (!e.occurrenceKey && e.reminderId === reminder.id && localDateKey(new Date(e.at)) === localDateKey(now))));
}
function relativeReminderBucket(reminder, activeSeconds) {
  if (!reminder.enabled || reminder.triggerMode !== 'afterStart') return 0;
  const interval=Math.max(1,Number(reminder.delayMinutes)||0)*60;
  const bucket=Math.floor(Math.max(0,activeSeconds)/interval);
  if(bucket<1)return 0;
  return reminder.relativeRepeat?bucket:1;
}
function nextReminder(state, memberId, now = new Date()) {
  const candidates = [];
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(now); day.setDate(day.getDate() + offset);
    for (const reminder of state.reminders.filter(x => x.memberId === memberId && reminderOccursOn(x, day))) {
      if (!/^\d{2}:\d{2}$/.test(reminder.time || '')) continue;
      const [h, m] = reminder.time.split(':').map(Number);
      const at = new Date(day); at.setHours(h, m, 0, 0);
      if (at > now) candidates.push({ reminder, at });
    }
  }
  return candidates.sort((a, b) => a.at - b.at)[0] || null;
}

module.exports = { pendingClockReminder, reminderOccurrenceKey, normalizeTask, DEFAULT_STATE, clone, uuid, normalizeVacationSchedules, vacationOccursOn, localDateKey, responsibilityDateKey, hashPassword, verifyPassword, taskOccursOn, completionFor, completeTask, taskStats, rewardMinutes, usedMinutes, dayTypeSettings, remainingMinutes, effectiveShutdownAt, spendReward, earliestStartAt, earlyAccessUntil, timeBlockReason, rewardSpendLimit, reminderDue, relativeReminderBucket, nextReminder };
