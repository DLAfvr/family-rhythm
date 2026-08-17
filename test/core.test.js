'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');
const Store = require('../src/store');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('task reward is granted only once per occurrence', () => {
  const state = core.clone(core.DEFAULT_STATE);
  state.tasks.push({ id: 't1', memberId: 'me', kind: 'daily', rewardMinutes: 15 });
  const date = new Date(2026, 7, 15, 10);
  assert.equal(core.completeTask(state, 't1', 'me', date).duplicate, false);
  assert.equal(core.completeTask(state, 't1', 'me', date).duplicate, true);
  assert.equal(core.rewardMinutes(state, 'me', date), 15);
});

test('task rewards are fully deposited into a cumulative wallet', () => {
  const state = core.clone(core.DEFAULT_STATE);
  state.settings.rewardCapMinutes = 30;
  state.tasks.push({id:'a',memberId:'me',kind:'daily',rewardMinutes:20},{id:'b',memberId:'me',kind:'daily',rewardMinutes:20});
  const date = new Date(2026, 7, 15, 10);
  core.completeTask(state,'a','me',date);core.completeTask(state,'b','me',date);
  assert.equal(core.rewardMinutes(state, 'me', date), 40);
  assert.equal(state.rewardBalanceMinutes,40);
});

test('weekly and one-time task occurrence', () => {
  const saturday = new Date(2026, 7, 15);
  assert.equal(core.taskOccursOn({ kind: 'weekly', weekdays: [6] }, saturday), true);
  assert.equal(core.taskOccursOn({ kind: 'once', date: '2026-08-16' }, saturday), false);
});

test('reminder is due only inside tolerance window', () => {
  const reminder = { enabled: true, repeat: 'daily', time: '09:30' };
  assert.equal(core.reminderDue(reminder, new Date(2026, 7, 15, 9, 30, 12)), true);
  assert.equal(core.reminderDue(reminder, new Date(2026, 7, 15, 9, 31, 0)), false);
});

test('relative reminder fires after active-use delay and repeats by interval', () => {
  const once={enabled:true,triggerMode:'afterStart',delayMinutes:20,relativeRepeat:false};
  assert.equal(core.relativeReminderBucket(once,1199),0);
  assert.equal(core.relativeReminderBucket(once,1200),1);
  assert.equal(core.relativeReminderBucket(once,3600),1);
  const repeating={...once,relativeRepeat:true};
  assert.equal(core.relativeReminderBucket(repeating,2400),2);
});

test('spending wallet minutes extends the clock within the parent cap', () => {
  const state = core.clone(core.DEFAULT_STATE);
  state.settings.timeMode = 'clock';
  state.settings.shutdownTime = '21:30';
  state.settings.maxRewardClockExtensionMinutes=10;state.rewardBalanceMinutes=30;
  const now = new Date(2026, 7, 15, 20, 0);
  core.spendReward(state,'clock',15,now);
  const end = core.effectiveShutdownAt(state, 'me', now);
  assert.equal(end.getHours(), 21);
  assert.equal(end.getMinutes(), 40);
  assert.equal(state.rewardBalanceMinutes,15);
});

test('both mode uses whichever limit arrives first', () => {
  const state = core.clone(core.DEFAULT_STATE);
  state.settings.timeMode = 'both';
  state.settings.dailyLimitMinutes = 40;
  state.settings.shutdownTime = '23:00';
  state.usage['me:2026-08-15'] = 10 * 60;
  const now = new Date(2026, 7, 15, 20, 0);
  assert.equal(core.remainingMinutes(state, 'me', now), 30);
});

test('weekday and weekend schedules select separate quota and clock rules', () => {
  const s=core.clone(core.DEFAULT_STATE);Object.assign(s.settings,{dayTypeScheduleEnabled:true,timeMode:'both',weekdayDailyLimitMinutes:60,weekendDailyLimitMinutes:180,weekdayShutdownTime:'20:00',weekendShutdownTime:'22:30'});
  const weekday=new Date('2026-08-17T19:30:00'),weekend=new Date('2026-08-16T19:30:00');
  assert.equal(core.dayTypeSettings(s.settings,weekday).dailyLimitMinutes,60);assert.equal(core.dayTypeSettings(s.settings,weekend).dailyLimitMinutes,180);
  assert.equal(core.effectiveShutdownAt(s,'me',weekday).getHours(),20);assert.equal(core.effectiveShutdownAt(s,'me',weekend).getHours(),22);
});

test('clock wallet extension can be disabled', () => {
  const state = core.clone(core.DEFAULT_STATE);
  state.settings.timeMode = 'clock';
  state.settings.shutdownTime = '21:30';
  state.settings.rewardExtendsClock = false;
  state.rewardBalanceMinutes=15;core.spendReward(state,'clock',15,new Date(2026,7,15,20,0));
  const end = core.effectiveShutdownAt(state, 'me', new Date(2026, 7, 15, 20, 0));
  assert.equal(end.getMinutes(), 30);
});

test('unused reward wallet survives dates and can buy quota or early access',()=>{
  const state=core.clone(core.DEFAULT_STATE),morning=new Date(2026,7,16,5,30);
  state.rewardBalanceMinutes=45;core.spendReward(state,'quota',20,morning);core.spendReward(state,'early',10,morning);
  assert.equal(state.rewardBalanceMinutes,15);assert.equal(state.rewardUsage['2026-08-16'].quotaMinutes,20);
  assert.equal(core.earlyAccessUntil(state,morning),new Date(2026,7,16,5,40).getTime());
  assert.equal(state.rewardUsage['2026-08-15'],undefined);
});

test('earliest start time creates a daily boundary',()=>{
  const state=core.clone(core.DEFAULT_STATE);state.settings.earliestStartEnabled=true;state.settings.earliestStartTime='07:15';
  const at=core.earliestStartAt(state,new Date(2026,7,16,5));assert.equal(at.getHours(),7);assert.equal(at.getMinutes(),15);
});

test('store can save repeatedly without sharing a fixed temporary filename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-rhythm-test-'));
  const file = path.join(dir, 'state.json');
  try {
    const store = new Store(file);
    store.state.familyName = '第一次'; store.save();
    store.state.familyName = '第二次'; store.save();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).familyName, '第二次');
    assert.equal(fs.readdirSync(dir).filter(x => x.endsWith('.tmp')).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('older settings files receive new defaults without losing saved values', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'family-rhythm-migrate-')),file=path.join(dir,'state.json');
  try{
    fs.writeFileSync(file,JSON.stringify({settings:{dailyLimitMinutes:45}}));
    const store=new Store(file);
    assert.equal(store.state.settings.dailyLimitMinutes,45);
    assert.equal(store.state.settings.timeControlEnabled,true);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
