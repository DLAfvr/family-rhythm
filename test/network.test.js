'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Store=require('../src/store');
const {FamilyNetwork}=require('../src/network');
function cleanup(dir){for(let i=0;i<5;i++){try{return fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:20});}catch(e){if(i===4)throw e;}}}

test('two local devices can pair and synchronize a shared reminder',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'family-network-test-'));
  const hostStore=new Store(path.join(dir,'host.json')),clientStore=new Store(path.join(dir,'client.json'));
  const host=new FamilyNetwork(hostStore,()=>{},0,'0.6.3'),client=new FamilyNetwork(clientStore,()=>{},0,'0.6.2');
  try{
    const hs=await host.createFamily('測試家庭','主要電腦');
    client.port=hs.port;
    await client.join('127.0.0.1',hs.pairingCode,'孩子電腦');
    hostStore.state.reminders.push({id:'shared-r1',title:'喝水',shared:true,targetDeviceId:clientStore.state.network.deviceId});hostStore.save();
    await client.sync();
    const received=Object.values(clientStore.state.network.remoteItems).flatMap(x=>x.reminders||[]);
    assert.equal(received.some(x=>x.id==='shared-r1'),true);
    assert.equal(Object.values(hostStore.state.network.peers)[0].name,'孩子電腦');
    assert.equal(Object.values(hostStore.state.network.peers)[0].appVersion,'0.6.2');
    assert.equal(client.status().peers[hostStore.state.network.deviceId].appVersion,'0.6.3');
  }finally{await client.stop();await host.stop();cleanup(dir);}
});

test('three family devices see one another online through host status',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'family-presence-test-')),hostStore=new Store(path.join(dir,'host.json')),aStore=new Store(path.join(dir,'a.json')),bStore=new Store(path.join(dir,'b.json'));
  const host=new FamilyNetwork(hostStore,()=>{},0,'0.8.1'),a=new FamilyNetwork(aStore,()=>{},0,'0.8.1'),b=new FamilyNetwork(bStore,()=>{},0,'0.8.0');
  try{
    const hs=await host.createFamily('在線測試','主要電腦');a.port=hs.port;b.port=hs.port;
    await a.join('127.0.0.1',hs.pairingCode,'家長筆電');await b.join('127.0.0.1',hs.pairingCode,'孩子電腦');await a.sync();
    const peers=a.status().peers,hostId=hostStore.state.network.deviceId,bId=bStore.state.network.deviceId;
    assert.equal(peers[hostId].online,true);assert.equal(peers[bId].online,true);assert.ok(peers[bId].lastSeen);
  }finally{await a.stop();await b.stop();await host.stop();cleanup(dir);}
});

test('pairing code expires and repeated failures are rate limited',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'family-pair-security-')),hostStore=new Store(path.join(dir,'host.json'));
  const host=new FamilyNetwork(hostStore,()=>{},0,'0.7.0');
  try{
    const hs=await host.createFamily('安全測試','主要電腦');
    const attempts=[];for(let i=0;i<6;i++){const s=new Store(path.join(dir,`bad-${i}.json`)),c=new FamilyNetwork(s,()=>{},hs.port,'0.7.0');attempts.push(c.join('127.0.0.1','000000',`錯誤裝置${i}`).then(()=>null,e=>e.message));}
    const errors=await Promise.all(attempts);assert.equal(errors.some(x=>/次數過多/.test(x)),true);
    host.refreshPairingCode();hostStore.state.network.pairingExpiresAt=new Date(Date.now()-1000).toISOString();hostStore.save();
    const expiredStore=new Store(path.join(dir,'expired.json')),expired=new FamilyNetwork(expiredStore,()=>{},hs.port,'0.7.0');
    await assert.rejects(()=>expired.join('127.0.0.1',hostStore.state.network.pairingCode,'逾期裝置'),/已過期/);
  }finally{await host.stop();cleanup(dir);}
});

test('custom reminder sound is transferred once by content id',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'family-sound-test-'));
  const hostStore=new Store(path.join(dir,'host.json')),clientStore=new Store(path.join(dir,'client.json'));
  const host=new FamilyNetwork(hostStore,()=>{},0),client=new FamilyNetwork(clientStore,()=>{},0);
  try{
    const hs=await host.createFamily('測試家庭','主要電腦');client.port=hs.port;
    await client.join('127.0.0.1',hs.pairingCode,'家人電腦');
    const childId=clientStore.state.network.deviceId,assetId='sha256-test-sound';
    hostStore.state.soundAssets[assetId]={id:assetId,name:'休息.mp3',mime:'audio/mpeg',size:4,data:'dGVzdA=='};
    hostStore.state.reminders.push({id:'custom-r1',title:'休息一下',sound:'custom',customSoundId:assetId,customSoundName:'休息.mp3',shared:true,targetDeviceId:childId});hostStore.save();
    await client.sync();
    assert.equal(clientStore.state.soundAssets[assetId].name,'休息.mp3');
    const saved=JSON.parse(fs.readFileSync(path.join(dir,'client.json'),'utf8'));
    assert.equal(saved.soundAssets[assetId].data,'dGVzdA==');
    await client.sync();
    assert.equal(Object.keys(clientStore.state.soundAssets).length,1);
  }finally{await client.stop();await host.stop();cleanup(dir);}
});

test('managed client authorizes host settings and reminder control',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'family-managed-test-'));
  const hostStore=new Store(path.join(dir,'host.json')),clientStore=new Store(path.join(dir,'client.json'));
  const host=new FamilyNetwork(hostStore,()=>{},0),client=new FamilyNetwork(clientStore,()=>{},0);
  try{
    const hs=await host.createFamily('測試家庭','家長電腦');client.port=hs.port;
    await client.join('127.0.0.1',hs.pairingCode,'孩子電腦');
    clientStore.state.reminders.push({id:'child-r1',title:'吃藥',time:'20:00',enabled:true,type:'gentle'});clientStore.save();
    const now=new Date(),today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    clientStore.state.usage[`me:${today}`]=3600;
    client.setManagement(true);await client.sync();
    const childId=clientStore.state.network.deviceId;
    hostStore.state.reminders.push({id:'parent-r1',title:'休息眼睛',time:'20:30',enabled:true,type:'gentle',shared:true,targetDeviceId:childId});
    hostStore.state.tasks.push({id:'parent-t1',title:'洗餐具',kind:'daily',shared:true,targetDeviceId:childId});hostStore.save();await client.sync();
    const device=host.managementView()[0];
    assert.equal(device.name,'孩子電腦');assert.equal(device.reminders.length,2);assert.equal(device.tasks.length,1);
    host.updateManagedSettings(device.deviceId,{timeControlEnabled:false,dailyLimitMinutes:30,earliestStartEnabled:true,earliestStartTime:'07:15',maxRewardClockExtensionMinutes:20});
    host.toggleManagedReminder(device.deviceId,'child-r1',false);
    host.toggleManagedReminder(device.deviceId,'parent-r1',false);
    host.requestUsageReset(device.deviceId);
    await client.sync();
    assert.equal(clientStore.state.settings.timeControlEnabled,false);
    assert.equal(clientStore.state.settings.dailyLimitMinutes,30);
    assert.equal(clientStore.state.settings.earliestStartEnabled,true);
    assert.equal(clientStore.state.settings.earliestStartTime,'07:15');
    assert.equal(clientStore.state.settings.maxRewardClockExtensionMinutes,20);
    assert.equal(clientStore.state.reminders[0].enabled,false);
    const parentReminder=Object.values(clientStore.state.network.remoteItems).flatMap(x=>x.reminders||[]).find(x=>x.id==='parent-r1');
    assert.equal(parentReminder.enabled,false);
    assert.equal(clientStore.state.usage[`me:${today}`],0);
    assert.equal(host.managementView()[0].resetPending,true);
    await client.sync();
    assert.equal(host.managementView()[0].resetPending,false);
  }finally{await client.stop();await host.stop();cleanup(dir);}
});

test('primary manager grants and revokes a co-manager with queued deduplicated actions',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'family-multi-parent-test-'));
  const hostStore=new Store(path.join(dir,'host.json')),childStore=new Store(path.join(dir,'child.json')),parentStore=new Store(path.join(dir,'parent2.json'));
  const host=new FamilyNetwork(hostStore,()=>{},0),child=new FamilyNetwork(childStore,()=>{},0),parent2=new FamilyNetwork(parentStore,()=>{},0);
  try{
    const hs=await host.createFamily('測試家庭','主要家長');child.port=hs.port;parent2.port=hs.port;
    await child.join('127.0.0.1',hs.pairingCode,'孩子電腦');child.setManagement(true);await child.sync();
    await parent2.join('127.0.0.1',hs.pairingCode,'另一位家長');
    const parentId=parentStore.state.network.deviceId,childId=childStore.state.network.deviceId;
    host.setPeerRole(parentId,'co-manager');await parent2.sync();
    assert.equal(parentStore.state.network.memberRole,'co-manager');assert.equal(parent2.managementView()[0].deviceId,childId);
    parent2.updateManagedSettings(childId,{dailyLimitMinutes:75});await parent2.sync();await child.sync();
    assert.equal(childStore.state.settings.dailyLimitMinutes,75);
    await host.stop();parent2.requestUsageReset(childId);await new Promise(r=>setTimeout(r,25));
    assert.equal(parentStore.state.network.pendingManagerActions.length,1);
    await host.startHost();await parent2.sync();
    assert.equal(parentStore.state.network.pendingManagerActions.length,0);
    const before=host.auditView().filter(x=>x.type==='settings-updated').length;
    const duplicate={id:'same-action',type:'settings',deviceId:childId,patch:{rewardCapMinutes:25}};
    const peer=hostStore.state.network.peers[parentId];host.applyManagerActions(peer,[duplicate]);host.applyManagerActions(peer,[duplicate]);
    const after=host.auditView().filter(x=>x.type==='settings-updated').length;
    assert.equal(after-before,1);
    host.setPeerRole(parentId,'member');await parent2.sync();
    assert.equal(parentStore.state.network.memberRole,'member');assert.equal(parent2.managementView().length,0);
    assert.throws(()=>parent2.updateManagedSettings(childId,{dailyLimitMinutes:20}),/不是共同管理者/);
  }finally{await parent2.stop();await child.stop();await host.stop();cleanup(dir);}
});

test('managed device security event reaches parent once and remains in audit',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'family-security-event-test-')),hostStore=new Store(path.join(dir,'host.json')),childStore=new Store(path.join(dir,'child.json'));
  const host=new FamilyNetwork(hostStore,()=>{},0),child=new FamilyNetwork(childStore,()=>{},0);
  try{
    const hs=await host.createFamily('測試家庭','家長電腦');child.port=hs.port;
    await child.join('127.0.0.1',hs.pairingCode,'孩子電腦');child.setManagement(true);await child.sync();
    child.queueSecurityEvent('parent-lock-removed');await child.sync();
    assert.equal(childStore.state.network.pendingSecurityEvents.length,0);
    assert.equal(host.auditView().filter(x=>x.type==='parent-lock-removed').length,1);
    assert.equal(host.consumeNotifications()[0].deviceName,'孩子電腦');
    await child.sync();assert.equal(host.auditView().filter(x=>x.type==='parent-lock-removed').length,1);
  }finally{await child.stop();await host.stop();cleanup(dir);}
});

test('parent can request a local-only lock without sending the password',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'family-lock-request-test-')),hostStore=new Store(path.join(dir,'host.json')),childStore=new Store(path.join(dir,'child.json'));
  const host=new FamilyNetwork(hostStore,()=>{},0),child=new FamilyNetwork(childStore,()=>{},0);
  try{
    const hs=await host.createFamily('測試家庭','家長電腦');child.port=hs.port;await child.join('127.0.0.1',hs.pairingCode,'孩子電腦');child.setManagement(true);await child.sync();const childId=childStore.state.network.deviceId;
    host.requestParentLock(childId);await child.sync();const request=childStore.state.network.parentLockRequest;assert.ok(request?.id);assert.equal(host.managementView()[0].lockRequestPending,true);
    childStore.state.settings.parentPassword={salt:'local-only',hash:'not-transmitted'};childStore.state.network.lastAppliedParentLockRequestId=request.id;childStore.state.network.parentLockRequest=null;child.queueSecurityEvent('parent-lock-set');await child.sync();
    assert.equal(host.managementView()[0].parentLockConfigured,true);assert.equal(host.managementView()[0].lockRequestPending,false);assert.equal(JSON.stringify(hostStore.state).includes('not-transmitted'),false);
  }finally{await child.stop();await host.stop();cleanup(dir);}
});

test('managed device offline alert waits two minutes and is deduplicated',async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'family-offline-alert-test-')),hostStore=new Store(path.join(dir,'host.json')),childStore=new Store(path.join(dir,'child.json'));const host=new FamilyNetwork(hostStore,()=>{},0),child=new FamilyNetwork(childStore,()=>{},0);try{const hs=await host.createFamily('測試家庭','家長電腦');child.port=hs.port;await child.join('127.0.0.1',hs.pairingCode,'孩子電腦');child.setManagement(true);await child.sync();const peer=Object.values(hostStore.state.network.peers)[0];peer.lastSeen=new Date(Date.now()-121000).toISOString();host.markOffline();assert.equal(host.consumeNotifications().filter(x=>x.type==='device-offline').length,1);host.markOffline();assert.equal(host.consumeNotifications().length,0);await child.sync();assert.equal(host.consumeNotifications().filter(x=>x.type==='device-online').length,1);}finally{await child.stop();await host.stop();cleanup(dir);}});
