'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8');
function extract(name,next){return source.slice(source.indexOf(`function ${name}(`),source.indexOf(`function ${next}(`));}
test('received usage reset cancels countdown, OS shutdown and stale prompts only once',()=>{
  const commands=[],cleared=[],closed=[];
  const window=name=>({isDestroyed:()=>false,close:()=>closed.push(name),setClosable:()=>{}});
  const state={network:{lastAppliedResetId:'reset-2'},events:[]};
  const ctx=vm.createContext({store:{state,update:fn=>fn(state)},lastHandledResetId:'reset-1',systemShutdownPending:true,
    shutdownTimer:123,shutdownAt:456,activeReminder:{id:'shutdown',type:'shutdown'},activeRewardPrompt:{kind:'quota'},
    reminderWindow:window('reminder'),rewardWindow:window('reward'),fired:new Set(['quota-shutdown:today:0','clock-shutdown:today','regular']),
    clearTimeout:x=>cleared.push(x),execFile:(...args)=>commands.push(args.slice(0,2)),core:{uuid:()=> 'event'},broadcast:()=>{},network:{consumeNotifications:()=>[]}});
  vm.runInContext(extract('cancelForUsageReset','cancelShutdown')+extract('onNetworkChange','applyBackup'),ctx);
  vm.runInContext('onNetworkChange();onNetworkChange();',ctx);
  assert.deepEqual(cleared,[123]);assert.equal(ctx.shutdownAt,null);assert.equal(ctx.shutdownTimer,null);
  assert.equal(commands.length,1);assert.equal(commands[0][0],'shutdown.exe');assert.equal(commands[0][1][0],'/a');
  assert.deepEqual(closed,['reminder','reward']);assert.equal(ctx.activeReminder,null);assert.equal(ctx.activeRewardPrompt,null);
  assert.equal(ctx.fired.has('quota-shutdown:today:0'),false);assert.equal(ctx.fired.has('clock-shutdown:today'),true);assert.equal(ctx.fired.has('regular'),true);
  assert.equal(state.events.length,1);
  ctx.systemShutdownPending=false;state.network.lastAppliedResetId='reset-3';vm.runInContext('onNetworkChange()',ctx);
  assert.equal(commands.length,1); // Never abort an unrelated Windows shutdown.
});
