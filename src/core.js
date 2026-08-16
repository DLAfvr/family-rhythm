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
    timeMode: 'quota',
    shutdownTime: '21:30',
    rewardExtendsClock: true,
    maxRewardClockExtensionMinutes: 30,
    rewardCapMinutes: 60,
    parentPassword: null,
    shutdownGraceMinutes: 10,
    simulateShutdown: true,
    updateRepo: '',
    autoCheckUpdates: true
  },
  reminders: [],
  soundAssets: {},
  tasks: [],
  completions: [],
  rewardBalanceMinutes: 0,
  rewardUsage: {},
  usage: {},
  events: []
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function uuid() { return crypto.randomUUID(); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function verifyPassword(password, saved) {
  if (!saved?.salt || !saved?.hash) return false;
  const actual = Buffer.from(hashPassword(password, saved.salt).hash, 'hex');
  const expected = Buffer.from(saved.hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function taskOccursOn(task, date = new Date()) {
  const key = localDateKey(date);
  if (task.kind === 'once') return task.date === key;
  if (task.kind === 'daily') return true;
  if (task.kind === 'weekly') return (task.weekdays || []).includes(date.getDay());
  return false;
}
function completionFor(state, taskId, memberId, date = new Date()) {
  const key = localDateKey(date);
  return state.completions.find(x => x.taskId === taskId && x.memberId === memberId && x.date === key);
}
function completeTask(state, taskId, memberId, date = new Date()) {
  const task = state.tasks.find(x => x.id === taskId);
  if (!task || task.memberId !== memberId || !taskOccursOn(task, date)) return { ok: false, reason: 'not_available' };
  const existing = completionFor(state, taskId, memberId, date);
  if (existing) return { ok: true, completion: existing, duplicate: true };
  const granted=Math.max(0,Number(task.rewardMinutes)||0);
  const completion = {
    id: uuid(), taskId, memberId, date: localDateKey(date), completedAt: date.toISOString(),
    rewardMinutes: granted
  };
  state.completions.push(completion);
  state.rewardBalanceMinutes=Math.max(0,Number(state.rewardBalanceMinutes)||0)+granted;
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
function remainingMinutes(state, memberId, date = new Date()) {
  const usage=state.rewardUsage?.[localDateKey(date)]||{};
  const quota = Math.max(0, Number(state.settings.dailyLimitMinutes) + (Number(usage.quotaMinutes)||0) - usedMinutes(state, memberId, date));
  if (['clock','both'].includes(state.settings.timeMode) && /^\d{2}:\d{2}$/.test(state.settings.shutdownTime || '')) {
    const [hour, minute] = state.settings.shutdownTime.split(':').map(Number);
    const end = new Date(date);
    end.setHours(hour, minute, 0, 0);
    if (state.settings.rewardExtendsClock) end.setMinutes(end.getMinutes() + Math.min(Number(usage.clockMinutes)||0,Math.max(0,Number(state.settings.maxRewardClockExtensionMinutes)||0)));
    const clock = Math.max(0, Math.ceil((end - date) / 60000));
    return state.settings.timeMode === 'both' ? Math.min(quota, clock) : clock;
  }
  return quota;
}
function effectiveShutdownAt(state, memberId, date = new Date()) {
  if (!['clock','both'].includes(state.settings.timeMode) || !/^\d{2}:\d{2}$/.test(state.settings.shutdownTime || '')) return null;
  const [hour, minute] = state.settings.shutdownTime.split(':').map(Number);
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

module.exports = { DEFAULT_STATE, clone, uuid, localDateKey, hashPassword, verifyPassword, taskOccursOn, completionFor, completeTask, rewardMinutes, usedMinutes, remainingMinutes, effectiveShutdownAt, spendReward, earliestStartAt, earlyAccessUntil, reminderDue, relativeReminderBucket, nextReminder };
