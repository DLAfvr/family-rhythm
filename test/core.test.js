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
  assert.equal(core.effectiveShutdownAt(s,'me',weekday).getHours(),20);assert.equal(core.effectiveShutdownAt(s,'me',weekend).getHours(),20);
  const friday=new Date('2026-08-21T19:30:00'),saturday=new Date('2026-08-22T19:30:00');
  assert.equal(core.dayTypeSettings(s.settings,friday).dailyLimitMinutes,60);assert.equal(core.effectiveShutdownAt(s,'me',friday).getHours(),22);
  assert.equal(core.dayTypeSettings(s.settings,saturday).dailyLimitMinutes,180);assert.equal(core.effectiveShutdownAt(s,'me',saturday).getHours(),22);
});

test('vacation date range overrides weekday and weekend rules', () => {
  const s=core.clone(core.DEFAULT_STATE);Object.assign(s.settings,{dayTypeScheduleEnabled:true,weekdayDailyLimitMinutes:60,weekendDailyLimitMinutes:180,weekdayShutdownTime:'20:00',weekendShutdownTime:'22:30',vacationSchedules:[{id:'summer',name:'暑假',startDate:'2026-07-01',endDate:'2026-08-29',dailyLimitMinutes:240,shutdownTime:'23:00'}]});
  const during=core.dayTypeSettings(s.settings,new Date('2026-08-17T19:00:00')),after=core.dayTypeSettings(s.settings,new Date('2026-08-31T19:00:00'));
  assert.equal(during.kind,'vacation');assert.equal(during.name,'暑假');assert.equal(during.dailyLimitMinutes,240);assert.equal(during.shutdownTime,'23:00');assert.equal(after.kind,'weekday');assert.equal(after.dailyLimitMinutes,60);
});

test('vacation schedules reject malformed or overlapping ranges and clamp quota', () => {
  const out=core.normalizeVacationSchedules([{name:'錯誤',startDate:'2026-08-30',endDate:'2026-08-01',dailyLimitMinutes:10,shutdownTime:'21:00'},{name:'無效日期',startDate:'2026-02-30',endDate:'2026-03-02',dailyLimitMinutes:10,shutdownTime:'21:00'},{name:'暑假',startDate:'2026-07-01',endDate:'2026-08-29',dailyLimitMinutes:9999,shutdownTime:'23:00'},{name:'重疊',startDate:'2026-08-01',endDate:'2026-08-31',dailyLimitMinutes:30,shutdownTime:'22:00'}]);
  assert.equal(out.length,1);assert.equal(out[0].dailyLimitMinutes,1440);
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

test('task mode identifies each active limit and respects the night extension cap',()=>{
  const state=core.clone(core.DEFAULT_STATE),now=new Date(2026,9,4,22,0);
  Object.assign(state.settings,{timeControlEnabled:true,timeMode:'both',dailyLimitMinutes:60,shutdownTime:'21:30',rewardExtendsClock:true,maxRewardClockExtensionMinutes:20});
  state.usage[`me:${core.localDateKey(now)}`]=60*60;state.rewardBalanceMinutes=40;
  assert.equal(core.timeBlockReason(state,'me',now),'quota');
  core.spendReward(state,'quota',10,now);
  assert.equal(core.timeBlockReason(state,'me',now),'clock');
  assert.equal(core.rewardSpendLimit(state,'clock',now),20);
  core.spendReward(state,'clock',20,now);
  assert.equal(core.timeBlockReason(state,'me',new Date(2026,9,4,21,45)),null);
  assert.equal(core.rewardSpendLimit(state,'clock',now),0);
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
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});

test('store restores a corrupt primary from the last known-good backup', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'family-store-recovery-')),file=path.join(dir,'state.json');
  try {
    const store=new Store(file);store.state.familyName='還在的家';store.save();store.state.familyName='最後一次正常資料';store.save();
    fs.writeFileSync(file,'{"broken"');
    const recovered=new Store(file);
    assert.equal(recovered.state.familyName,'還在的家');
    assert.equal(recovered.recoveredFromBackup,true);
    assert.equal(fs.readdirSync(dir).some(name=>name.includes('.corrupt-')),true);
  } finally { fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50}); }
});

test('store does not silently reset an unreadable primary without a backup', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'family-store-no-backup-')),file=path.join(dir,'state.json');
  try { fs.writeFileSync(file,'not json');assert.throws(()=>new Store(file),/找不到可用備援/); }
  finally { fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50}); }
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

test('one-off task defaults to today and persists without becoming recurring', () => {
  const now = new Date(2026, 8, 13, 23, 58);
  const task = core.normalizeTask({id:'temporary',kind:'once',date:'',rewardMinutes:20}, now);
  assert.equal(task.date, '2026-09-13');
  assert.equal(core.taskOccursOn(task, now), true);
  assert.equal(core.taskOccursOn(task, new Date(2026,8,14)), false);
  const state=core.clone(core.DEFAULT_STATE);state.tasks.push(task);
  assert.equal(core.completeTask(state,task.id,'me',now).duplicate,false);
  assert.equal(core.completeTask(state,task.id,'me',now).duplicate,true);
  assert.equal(state.rewardBalanceMinutes,20);
  assert.equal(core.normalizeTask({kind:'once',date:'2026-09-15'},now).date,'2026-09-15');
  assert.throws(()=>core.normalizeTask({kind:'once',date:'2026-02-30'},now),/日期/);
});

test('clock reminders catch delayed sync once per date and survive restart',()=>{
  const now=new Date(2026,8,13,15,5),r={id:'late',enabled:true,triggerMode:'clock',repeat:'once',date:'2026-09-13',time:'15:00'};
  assert.equal(core.pendingClockReminder(r,[],now),true);
  assert.equal(core.pendingClockReminder(r,[],new Date(2026,8,13,14,59)),false);
  const events=[{type:'reminder-fired',reminderId:r.id,occurrenceKey:core.reminderOccurrenceKey(r,now),at:now.toISOString()}];
  assert.equal(core.pendingClockReminder(r,JSON.parse(JSON.stringify(events)),now),false);
  assert.equal(core.pendingClockReminder(r,[],new Date(2026,8,14,15,5)),false);
  assert.equal(core.pendingClockReminder({...r,repeat:'daily'},events,new Date(2026,8,14,15,5)),true);
  assert.equal(core.pendingClockReminder({...r,enabled:false},[],now),false);
  assert.equal(core.pendingClockReminder({...r,triggerMode:'afterStart'},[],now),false);
});

test('one-time task disables after completion and reopening creates a new reward round',()=>{
  const now=new Date(2026,9,4,12),state=core.clone(core.DEFAULT_STATE),task=core.normalizeTask({id:'once-round',kind:'once',date:'2026-10-04',rewardMinutes:5},now);state.tasks.push(task);
  assert.equal(core.completeTask(state,task.id,'me',now).ok,true);assert.equal(task.enabled,false);assert.equal(state.rewardBalanceMinutes,5);
  task.enabled=true;task.round++;assert.equal(core.completeTask(state,task.id,'me',now).duplicate,false);assert.equal(state.rewardBalanceMinutes,10);
});

test('custom task reset keeps early morning in the previous responsibility day',()=>{
  const task=core.normalizeTask({kind:'weekly',weekdays:[6],customReset:true,resetTime:'04:00'},new Date(2026,9,4));
  assert.equal(core.responsibilityDateKey(task,new Date(2026,9,4,2,0)),'2026-10-03');
  assert.equal(core.taskOccursOn(task,new Date(2026,9,4,2,0)),true);
});

test('annual vacation supports cross-year ranges',()=>{
  const settings={...core.DEFAULT_STATE.settings,vacationSchedules:[{id:'winter',name:'寒假',annual:true,startMonthDay:'12-20',endMonthDay:'02-10',dailyLimitMinutes:200,shutdownTime:'22:00'}]};
  assert.equal(core.dayTypeSettings(settings,new Date(2027,0,5)).kind,'vacation');assert.notEqual(core.dayTypeSettings(settings,new Date(2027,2,5)).kind,'vacation');
});

test('task statistics separate completed pending and missed with timestamps',()=>{
  const state=core.clone(core.DEFAULT_STATE);state.tasks=[core.normalizeTask({id:'daily-stat',title:'洗餐具',kind:'daily'})];state.completions=[{id:'c',taskId:'daily-stat',memberId:'me',date:'2026-10-03',round:1,completedAt:'2026-10-03T12:30:00.000Z',rewardMinutes:8}];
  const done=core.taskStats(state,'2026-10-03',new Date(2026,9,4));assert.equal(done.completed[0].completedAt,'2026-10-03T12:30:00.000Z');assert.equal(done.earnedMinutes,8);
  assert.equal(core.taskStats(state,'2026-10-02',new Date(2026,9,4)).missed.length,1);assert.equal(core.taskStats(state,'2026-10-04',new Date(2026,9,4)).pending.length,1);
});

test('store keeps only thirty deduplicated snapshots and restores without replacing credentials',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'family-snapshot-test-')),file=path.join(dir,'state.json');try{const store=new Store(file);store.state.network={deviceId:'device',token:'secret'};store.state.settings.parentPassword={salt:'s',hash:'h'};for(let i=0;i<35;i++){store.state.familyName=`家庭${i}`;store.createSnapshot('test',true);}assert.equal(store.listSnapshots().length,30);const target=store.listSnapshots().at(-1);store.state.familyName='現在';store.restoreSnapshot(target.id);assert.equal(store.state.network.token,'secret');assert.equal(store.state.settings.parentPassword.hash,'h');assert.notEqual(store.state.familyName,'現在');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
