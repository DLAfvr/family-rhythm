'use strict';
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const core=require('./core');const {normalizeVacationSchedules}=core;

const PORT = 45831;
const MANAGED_SETTING_KEYS=['timeControlEnabled','earliestStartEnabled','earliestStartTime','timeMode','dailyLimitMinutes','shutdownTime','dayTypeScheduleEnabled','weekdayDailyLimitMinutes','weekendDailyLimitMinutes','weekdayShutdownTime','weekendShutdownTime','vacationSchedules','rewardExtendsClock','maxRewardClockExtensionMinutes','rewardCapMinutes','shutdownGraceMinutes'];
function managedSettings(settings={}){return Object.fromEntries(MANAGED_SETTING_KEYS.filter(k=>settings[k]!==undefined).map(k=>[k,k==='vacationSchedules'?normalizeVacationSchedules(settings[k]):settings[k]]));}
function localDateKey(date=new Date()){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
function id() { return crypto.randomUUID(); }
function localAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(x => x?.family === 'IPv4' && !x.internal).map(x => x.address);
}
function body(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', chunk => { text += chunk; if (text.length > 10_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function json(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'content-length':Buffer.byteLength(text) });
  res.end(text);
}
function request(host, path, value, headers = {}, port = PORT) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(value || {});
    const req = http.request({ host, port, path, method:'POST', timeout:5000, headers:{ 'content-type':'application/json', 'content-length':Buffer.byteLength(text), ...headers } }, res => {
      let out=''; res.on('data',c=>out+=c); res.on('end',()=>{ try { const parsed=out?JSON.parse(out):{}; res.statusCode>=400?reject(new Error(parsed.error||`HTTP ${res.statusCode}`)):resolve(parsed); } catch(e){reject(e);} });
    });
    req.on('timeout',()=>req.destroy(new Error('連線逾時'))); req.on('error',reject); req.end(text);
  });
}

class FamilyNetwork {
  constructor(store, onChange, port = PORT, appVersion = '0.0.0') { this.store=store; this.onChange=onChange; this.port=port; this.appVersion=appVersion; this.pairFailures=new Map(); this.server=null; this.timer=null; this.running=false; }
  ensure() {
    const s=this.store.state;
    s.network ||= { role:'local', deviceId:id(), deviceName:os.hostname(), familyId:null, familyName:null, hostIp:null, token:null, pairingCode:null, peers:{}, remoteItems:{}, managedConfigs:{}, managementEnabled:false, pendingManagerActions:[], appliedManagerActions:{}, auditLog:[], managerDevices:[], managerAudit:[], memberRole:'member', lastSync:null, online:false };
    s.network.deviceId ||= id(); s.network.deviceName ||= os.hostname(); s.network.peers ||= {}; s.network.remoteItems ||= {};s.network.managedConfigs||={};s.network.itemOverrides||={};s.network.hostKnownAssetIds||=[];s.network.bountyClaims||={};s.network.managementEnabled=Boolean(s.network.managementEnabled);s.network.pendingManagerActions||=[];s.network.appliedManagerActions||={};s.network.pendingSecurityEvents||=[];s.network.appliedSecurityEvents||={};s.network.auditLog||=[];s.network.managerDevices||=[];s.network.managerAudit||=[];s.network.memberRole||='member';this.notifications||=[];
    return s.network;
  }
  status() { const n=this.ensure(); return { role:n.role,memberRole:n.role==='host'?'primary-manager':n.memberRole,deviceId:n.deviceId,deviceName:n.deviceName,appVersion:this.appVersion,familyId:n.familyId,familyName:n.familyName,hostIp:n.hostIp,pairingCode:n.role==='host'?n.pairingCode:null,pairingExpiresAt:n.role==='host'?n.pairingExpiresAt:null,managementEnabled:n.managementEnabled,parentLockRequest:n.parentLockRequest||null,pendingManagerActions:n.pendingManagerActions.length,peers:Object.fromEntries(this.publicPeers().map(x=>[x.deviceId,x])),lastSync:n.lastSync,lastError:n.lastError,online:n.online,addresses:localAddresses(),port:this.port }; }
  async createFamily(name, deviceName) {
    const n=this.ensure(); await this.stop();
    Object.assign(n,{role:'host',memberRole:'primary-manager',familyId:id(),familyName:name||'我們家',deviceName:deviceName||n.deviceName,hostIp:null,token:null,pairingCode:String(crypto.randomInt(0,1_000_000)).padStart(6,'0'),pairingExpiresAt:new Date(Date.now()+10*60*1000).toISOString(),peers:{},remoteItems:{},managedConfigs:{},itemOverrides:{},hostKnownAssetIds:[],managementEnabled:false,pendingManagerActions:[],appliedManagerActions:{},auditLog:[],managerDevices:[],managerAudit:[],online:true});
    this.store.save(); await this.startHost(); return this.status();
  }
  async startHost() {
    const n=this.ensure(); if(this.server) return;
    this.server=http.createServer(async(req,res)=>{
      try {
        if(req.method!=='POST') return json(res,405,{error:'method_not_allowed'});
        const data=await body(req);
        if(req.url==='/pair') {
          const remote=req.socket.remoteAddress||'unknown',now=Date.now(),failures=(this.pairFailures.get(remote)||[]).filter(x=>now-x<10*60*1000);this.pairFailures.set(remote,failures);
          if(failures.length>=5)return json(res,429,{error:'配對錯誤次數過多，請稍後再試'});
          if(!n.pairingExpiresAt||now>=new Date(n.pairingExpiresAt).getTime())return json(res,410,{error:'配對碼已過期，請在主要電腦產生新配對碼'});
          if(String(data.code)!==String(n.pairingCode)){failures.push(now);this.pairFailures.set(remote,failures);return json(res,403,{error:'配對碼不正確'});}
          this.pairFailures.delete(remote);
          const token=crypto.randomBytes(32).toString('hex');
          n.peers[data.deviceId]={deviceId:data.deviceId,name:data.deviceName||'家庭裝置',appVersion:data.appVersion||'未知',token,role:'member',lastSeen:new Date().toISOString(),online:true}; this.store.save(); this.onChange();
          return json(res,200,{familyId:n.familyId,familyName:n.familyName,token,hostDevice:{deviceId:n.deviceId,name:n.deviceName,appVersion:this.appVersion}});
        }
        if(req.url==='/sync') {
          const peer=n.peers[data.deviceId];
          if(!peer||peer.token!==req.headers['x-family-token']) return json(res,403,{error:'裝置驗證失敗'});
          if(peer.offlineAlerted)this.notifications.push({type:'device-online',deviceId:peer.deviceId,deviceName:data.deviceName||peer.name,body:`${data.deviceName||peer.name} 已恢復連線`});peer.offlineAlerted=false;peer.lastSeen=new Date().toISOString();peer.online=true;peer.name=data.deviceName||peer.name;peer.appVersion=data.appVersion||peer.appVersion||'未知';peer.role||='member';peer.managementEnabled=Boolean(data.managementEnabled);
          const ackedActionIds=this.applyManagerActions(peer,data.managerActions||[]);
          const ackedSecurityEventIds=this.applySecurityEvents(peer,data.securityEvents||[]);
          this.store.state.soundAssets||={};for(const [assetId,asset] of Object.entries(data.assets||{}))if(asset?.data&&asset.data.length<7_500_000)this.store.state.soundAssets[assetId]=asset;
          n.remoteItems[data.deviceId]={reminders:(data.reminders||[]).filter(x=>!x.private),tasks:(data.tasks||[]).filter(x=>!x.private),completions:data.completions||[],settings:managedSettings(data.settings),usage:data.usage||{},rewardBalanceMinutes:Math.max(0,Number(data.rewardBalanceMinutes)||0),rewardUsage:data.rewardUsage||{},stats:data.stats||[],remainingMinutes:Number(data.remainingMinutes),lastAppliedResetId:data.lastAppliedResetId||null,parentLockConfigured:Boolean(data.parentLockConfigured),lastAppliedParentLockRequestId:data.lastAppliedParentLockRequestId||null,receivedAt:new Date().toISOString()};
          if(peer.managementEnabled&&!n.managedConfigs[data.deviceId])n.managedConfigs[data.deviceId]={version:1,settings:managedSettings(data.settings),reminders:data.reminders||[],tasks:data.tasks||[],updatedAt:new Date().toISOString()};
          else if(peer.managementEnabled){const cfg=n.managedConfigs[data.deviceId];cfg.reminders=this.mergeItems(cfg.reminders,data.reminders);cfg.tasks=this.mergeItems(cfg.tasks,data.tasks);}
          const hostPublicTasks=this.store.state.tasks.filter(x=>!x.private),hostItems={reminders:this.applyItemOverrides(this.store.state.reminders.filter(x=>!x.private)),tasks:hostPublicTasks,completions:this.store.state.completions.filter(c=>hostPublicTasks.some(t=>t.id===c.taskId))};
          const remoteForSync=Object.fromEntries(Object.entries(n.remoteItems).map(([source,items])=>[source,{...items,reminders:this.applyItemOverrides(items.reminders||[])}]));
          const managedBase=peer.managementEnabled?n.managedConfigs[data.deviceId]||null:null,managedConfig=managedBase?{...managedBase,reminders:this.applyItemOverrides(managedBase.reminders||[])}:null,allReminders=[...hostItems.reminders,...Object.values(remoteForSync).flatMap(x=>x.reminders||[]),...(managedConfig?.reminders||[])],neededIds=new Set(allReminders.filter(x=>!x.targetDeviceId||x.targetDeviceId===data.deviceId).map(x=>x.customSoundId).filter(Boolean)),have=new Set(data.haveAssetIds||[]),assets=Object.fromEntries([...neededIds].filter(assetId=>!have.has(assetId)&&this.store.state.soundAssets[assetId]).map(assetId=>[assetId,this.store.state.soundAssets[assetId]]));
          this.store.save();this.onChange();return json(res,200,{familyName:n.familyName,peers:this.publicPeers(),items:{[n.deviceId]:hostItems,...remoteForSync},managedConfig,ackedActionIds,ackedSecurityEventIds,managerDevices:peer.role==='co-manager'?this.managementView():[],managerAudit:peer.role==='co-manager'?this.auditView():[],knownAssetIds:Object.keys(this.store.state.soundAssets),assets});
        }
        if(req.url==='/bounty-claim'){
          const peer=n.peers[data.deviceId];if(!peer||peer.token!==req.headers['x-family-token'])return json(res,403,{error:'裝置驗證失敗'});
          const all=[...(this.store.state.tasks||[]),...Object.values(n.remoteItems).flatMap(x=>x.tasks||[])],task=all.find(x=>x.id===data.taskId&&x.kind==='bounty'&&!x.deletedAt&&x.enabled!==false);
          if(!task)return json(res,404,{error:'懸賞已關閉或不存在'});if(!task.allFamily&&!(task.eligibleDeviceIds||[]).includes(data.deviceId))return json(res,403,{error:'這台裝置不在懸賞名單中'});
          const claims=n.bountyClaims[task.id]||=[];if(claims.some(x=>x.deviceId===data.deviceId))return json(res,200,{ok:true,duplicate:true,claim:claims.find(x=>x.deviceId===data.deviceId)});if(claims.length>=Math.max(1,Number(task.maxCompletions)||1))return json(res,409,{error:'懸賞已被領完'});
          const claim={id:id(),taskId:task.id,deviceId:data.deviceId,deviceName:peer.name,claimedAt:new Date().toISOString(),rewardMinutes:Math.max(0,Number(task.rewardMinutes)||0),round:Math.max(1,Number(task.round)||1)};claims.push(claim);n.bountyClaims[task.id]=claims;this.store.save();this.onChange();return json(res,200,{ok:true,claim});
        }
        json(res,404,{error:'not_found'});
      } catch(e){json(res,500,{error:e.message});}
    });
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,'0.0.0.0',resolve);});
    this.port=this.server.address().port;
    n.online=true; this.timer=setInterval(()=>this.markOffline(),10000); this.onChange();
  }
  publicPeers(){const n=this.ensure();if(n.role==='client')return Object.values(n.peers).map(p=>({...p,online:Boolean(p.online)}));return [{deviceId:n.deviceId,name:n.deviceName,appVersion:this.appVersion,online:true,lastSeen:new Date().toISOString(),role:'primary-manager'},...Object.values(n.peers).map(p=>({deviceId:p.deviceId,name:p.name,appVersion:p.appVersion||'未知',online:Date.now()-new Date(p.lastSeen).getTime()<30000,lastSeen:p.lastSeen,role:p.role||'member',managementEnabled:Boolean(p.managementEnabled)}))];}
  refreshPairingCode(){const n=this.ensure();if(n.role!=='host')throw new Error('只有主要電腦能產生配對碼');n.pairingCode=String(crypto.randomInt(0,1_000_000)).padStart(6,'0');n.pairingExpiresAt=new Date(Date.now()+10*60*1000).toISOString();this.pairFailures.clear();this.store.save();this.onChange();return this.status();}
  applyItemOverrides(items){const overrides=this.ensure().itemOverrides;return items.map(item=>overrides[item.id]?{...item,...overrides[item.id]}:item);}
  assignedItems(deviceId,kind){const n=this.ensure(),all=[...(this.store.state[kind]||[])];for(const [source,items] of Object.entries(n.remoteItems))if(source!==deviceId)all.push(...(items[kind]||[]));return all.filter(x=>x.targetDeviceId===deviceId);}
  mergeItems(...groups){const map=new Map();for(const group of groups)for(const item of group||[]){const old=map.get(item.id);if(!old||String(item.updatedAt||'')>=String(old.updatedAt||''))map.set(item.id,item);}return [...map.values()];}
  applyManagerActions(peer,actions){
    const n=this.ensure();if(peer.role!=='co-manager')return[];const acked=[];
    for(const action of actions){if(!action?.id)continue;if(n.appliedManagerActions[action.id]){acked.push(action.id);continue;}
      try{
        if(action.type==='settings')this.applyManagedSettings(action.deviceId,action.patch,peer);
        else if(action.type==='reminder-toggle')this.applyReminderToggle(action.deviceId,action.reminderId,action.enabled,peer);
        else if(action.type==='usage-reset')this.applyUsageReset(action.deviceId,peer);
        else if(action.type==='parent-lock-request')this.applyParentLockRequest(action.deviceId,peer);
        else if(action.type==='managed-item')this.applyManagedItem(action.deviceId,action.kind,action.item,action.remove,peer);
        else continue;
        n.appliedManagerActions[action.id]=new Date().toISOString();acked.push(action.id);
      }catch{continue;}
    }
    const entries=Object.entries(n.appliedManagerActions);if(entries.length>500)n.appliedManagerActions=Object.fromEntries(entries.slice(-500));return acked;
  }
  applySecurityEvents(peer,events){
    const n=this.ensure(),acked=[];
    for(const event of events){if(!event?.id)continue;if(n.appliedSecurityEvents[event.id]){acked.push(event.id);continue;}if(!['parent-lock-removed','parent-lock-set'].includes(event.type))continue;n.appliedSecurityEvents[event.id]=new Date().toISOString();acked.push(event.id);this.recordAudit(peer,event.type,peer.deviceId,{deviceName:peer.name});this.notifications.push({type:event.type,deviceId:peer.deviceId,deviceName:peer.name,at:event.at||new Date().toISOString(),body:event.type==='parent-lock-set'?`${peer.name} 已恢復家長鎖`:undefined});}
    const entries=Object.entries(n.appliedSecurityEvents);if(entries.length>500)n.appliedSecurityEvents=Object.fromEntries(entries.slice(-500));return acked;
  }
  queueSecurityEvent(type,detail={}){const n=this.ensure();if(n.role!=='client')return null;const event={id:id(),type,detail,at:new Date().toISOString()};n.pendingSecurityEvents.push(event);this.store.save();this.sync().catch(()=>{});this.onChange();return event;}
  consumeNotifications(){const out=this.notifications||[];this.notifications=[];return out;}
  recordAudit(peer,type,deviceId,detail={}){const n=this.ensure();n.auditLog.push({id:id(),actorDeviceId:peer?.deviceId||n.deviceId,actorName:peer?.name||n.deviceName,type,targetDeviceId:deviceId,detail,at:new Date().toISOString()});if(n.auditLog.length>200)n.auditLog=n.auditLog.slice(-200);}
  auditView(){return this.ensure().role==='host'?this.ensure().auditLog.slice(-50).reverse():this.ensure().managerAudit||[];}
  setPeerRole(deviceId,role){const n=this.ensure();if(n.role!=='host')throw new Error('只有主要電腦能變更家庭角色');if(!['member','co-manager'].includes(role))throw new Error('不支援的家庭角色');const peer=n.peers[deviceId];if(!peer)throw new Error('找不到家庭裝置');peer.role=role;this.recordAudit(null,role==='co-manager'?'manager-granted':'manager-revoked',deviceId,{name:peer.name});this.store.save();this.onChange();return this.status();}
  markOffline(){const n=this.ensure(),now=Date.now();for(const p of Object.values(n.peers)){const age=now-new Date(p.lastSeen).getTime();p.online=age<30000;if(p.managementEnabled&&age>=120000&&!p.offlineAlerted){p.offlineAlerted=true;this.notifications.push({type:'device-offline',deviceId:p.deviceId,deviceName:p.name,body:`${p.name} 已超過 2 分鐘沒有同步，可能已關機、休眠或中斷網路`});}}this.store.save();this.onChange();}
  async join(hostIp, code, deviceName) {
    const n=this.ensure(); await this.stop(); n.deviceName=deviceName||n.deviceName;
    const result=await request(hostIp,'/pair',{code,deviceId:n.deviceId,deviceName:n.deviceName,appVersion:this.appVersion},{},this.port);
    Object.assign(n,{role:'client',familyId:result.familyId,familyName:result.familyName,hostIp,token:result.token,online:true,hostDevice:result.hostDevice});
    this.store.save();this.startClient();return this.status();
  }
  startClient(){clearInterval(this.timer);this.running=true;this.sync().catch(()=>{});this.timer=setInterval(()=>this.sync().catch(()=>{}),5000);}
  async sync(){
    const n=this.ensure();if(n.role!=='client'||!n.hostIp||!n.token)return;
    try{
      const managed=n.managementEnabled,localAssets=this.store.state.soundAssets||{},known=new Set(n.hostKnownAssetIds||[]),assets=Object.fromEntries(Object.entries(localAssets).filter(([assetId])=>!known.has(assetId)));
      const publicReminders=this.store.state.reminders.filter(x=>!x.private),publicTasks=this.store.state.tasks.filter(x=>!x.private),dates=Array.from({length:30},(_,i)=>{const d=new Date();d.setDate(d.getDate()-i);return core.taskStats({...this.store.state,tasks:publicTasks},d);});
      const result=await request(n.hostIp,'/sync',{deviceId:n.deviceId,deviceName:n.deviceName,appVersion:this.appVersion,managementEnabled:managed,settings:managedSettings(this.store.state.settings),usage:this.store.state.usage,rewardBalanceMinutes:this.store.state.rewardBalanceMinutes,rewardUsage:this.store.state.rewardUsage,remainingMinutes:core.remainingMinutes(this.store.state,'me'),stats:dates,lastAppliedResetId:n.lastAppliedResetId,parentLockConfigured:Boolean(this.store.state.settings.parentPassword),lastAppliedParentLockRequestId:n.lastAppliedParentLockRequestId,managerActions:n.pendingManagerActions,securityEvents:n.pendingSecurityEvents,reminders:publicReminders,tasks:publicTasks,completions:this.store.state.completions.filter(c=>publicTasks.some(t=>t.id===c.taskId)),haveAssetIds:Object.keys(localAssets),assets},{'x-family-token':n.token},this.port);
      if(n.hostOfflineAlerted)this.notifications.push({type:'device-online',deviceId:n.hostDevice?.deviceId,deviceName:n.hostDevice?.name||'主要電腦',body:'主要電腦已恢復連線'});n.hostOfflineSince=null;n.hostOfflineAlerted=false;n.online=true;n.lastSync=new Date().toISOString();n.familyName=result.familyName||n.familyName;n.peers=Object.fromEntries((result.peers||[]).map(x=>[x.deviceId,x]));n.memberRole=n.peers[n.deviceId]?.role||'member';n.remoteItems=result.items||{};n.hostKnownAssetIds=result.knownAssetIds||n.hostKnownAssetIds||[];
      this.store.state.soundAssets||={};Object.assign(this.store.state.soundAssets,result.assets||{});
      const acked=new Set(result.ackedActionIds||[]);n.pendingManagerActions=n.pendingManagerActions.filter(x=>!acked.has(x.id));const securityAcked=new Set(result.ackedSecurityEventIds||[]);n.pendingSecurityEvents=n.pendingSecurityEvents.filter(x=>!securityAcked.has(x.id));if(n.memberRole==='co-manager'){n.seenSecurityAuditIds||=[];const seen=new Set(n.seenSecurityAuditIds);for(const event of result.managerAudit||[])if(['parent-lock-removed','parent-lock-set'].includes(event.type)&&!seen.has(event.id)){this.notifications.push({type:event.type,deviceId:event.targetDeviceId,deviceName:event.actorName,at:event.at,body:event.type==='parent-lock-set'?`${event.actorName} 已恢復家長鎖`:undefined});seen.add(event.id);}n.seenSecurityAuditIds=[...seen].slice(-200);n.managerDevices=result.managerDevices||[];n.managerAudit=result.managerAudit||[];}else{n.managerDevices=[];n.managerAudit=[];}
      if(managed&&result.managedConfig){Object.assign(this.store.state.settings,managedSettings(result.managedConfig.settings));this.store.state.reminders=this.mergeItems(this.store.state.reminders.filter(x=>x.private),result.managedConfig.reminders||[]);this.store.state.tasks=this.mergeItems(this.store.state.tasks.filter(x=>x.private),result.managedConfig.tasks||[]);n.appliedManagedVersion=result.managedConfig.version;const reset=result.managedConfig.resetUsageRequest;if(reset?.id&&reset.id!==n.lastAppliedResetId){this.store.state.usage[`me:${localDateKey()}`]=0;n.lastAppliedResetId=reset.id;n.lastUsageResetAt=new Date().toISOString();}const lock=result.managedConfig.parentLockRequest;if(lock?.id&&lock.id!==n.lastAppliedParentLockRequestId)n.parentLockRequest=lock;}
      this.store.save();this.onChange();
    }catch(e){n.online=false;n.lastError=e.message;n.hostOfflineSince||=new Date().toISOString();if(Date.now()-new Date(n.hostOfflineSince).getTime()>=120000&&!n.hostOfflineAlerted){n.hostOfflineAlerted=true;this.notifications.push({type:'device-offline',deviceId:n.hostDevice?.deviceId,deviceName:n.hostDevice?.name||'主要電腦',body:'主要電腦已超過 2 分鐘無法連線'});this.store.save();}this.onChange();}
  }
  async claimBounty(taskId){const n=this.ensure();if(n.role==='host'){const task=this.store.state.tasks.find(x=>x.id===taskId);if(!task)throw new Error('找不到懸賞');const claims=n.bountyClaims[taskId]||[];if(claims.some(x=>x.deviceId===n.deviceId))return{ok:true,duplicate:true,claim:claims.find(x=>x.deviceId===n.deviceId)};if(claims.length>=Math.max(1,Number(task.maxCompletions)||1))throw new Error('懸賞已被領完');const claim={id:id(),taskId,deviceId:n.deviceId,deviceName:n.deviceName,claimedAt:new Date().toISOString(),rewardMinutes:Math.max(0,Number(task.rewardMinutes)||0),round:Math.max(1,Number(task.round)||1)};claims.push(claim);n.bountyClaims[taskId]=claims;this.store.save();return{ok:true,claim};}if(n.role!=='client'||!n.online)throw new Error('懸賞需要連線到主要電腦才能完成');return request(n.hostIp,'/bounty-claim',{deviceId:n.deviceId,taskId},{'x-family-token':n.token},this.port);}
  setManagement(enabled){const n=this.ensure();if(n.role!=='client')throw new Error('只有加入家庭的裝置能開啟受管理模式');n.managementEnabled=Boolean(enabled);this.store.save();this.sync().catch(()=>{});this.onChange();return this.status();}
  renameFamily(name){const n=this.ensure(),value=String(name||'').trim();if(n.role!=='host')throw new Error('只有主要電腦能修改家庭名稱');if(!value)throw new Error('家庭名稱不能空白');if(value.length>40)throw new Error('家庭名稱最多 40 個字');n.familyName=value;this.store.save();this.onChange();return this.status();}
  managementView(){const n=this.ensure();if(n.role==='client'&&n.memberRole==='co-manager')return n.managerDevices||[];if(n.role!=='host')return[];return Object.values(n.peers).filter(p=>p.managementEnabled).map(p=>{const observed=n.remoteItems[p.deviceId]||{},config=n.managedConfigs[p.deviceId]||{},reminders=this.applyItemOverrides(this.mergeItems(config.reminders,observed.reminders,this.assignedItems(p.deviceId,'reminders'))).filter(x=>!x.deletedAt),tasks=this.mergeItems(config.tasks,observed.tasks,this.assignedItems(p.deviceId,'tasks')).filter(x=>!x.deletedAt);return{deviceId:p.deviceId,name:p.name,online:Date.now()-new Date(p.lastSeen).getTime()<30000,lastSeen:p.lastSeen,receivedAt:observed.receivedAt,settings:config.settings||observed.settings||{},reminders,tasks,usage:observed.usage||{},rewardBalanceMinutes:observed.rewardBalanceMinutes||0,rewardUsage:observed.rewardUsage||{},remainingMinutes:Number.isFinite(observed.remainingMinutes)?observed.remainingMinutes:null,stats:observed.stats||[],parentLockConfigured:Boolean(observed.parentLockConfigured),lockRequestPending:Boolean(config.parentLockRequest?.id&&config.parentLockRequest.id!==observed.lastAppliedParentLockRequestId),version:config.version||0,updatedAt:config.updatedAt,resetPending:Boolean(config.resetUsageRequest?.id&&config.resetUsageRequest.id!==observed.lastAppliedResetId),lastResetRequestedAt:config.resetUsageRequest?.requestedAt};});}
  queueManagerAction(action){const n=this.ensure();if(n.role!=='client'||n.memberRole!=='co-manager')throw new Error('這台裝置不是共同管理者');const queued={id:id(),createdAt:new Date().toISOString(),actorDeviceId:n.deviceId,actorName:n.deviceName,...action};n.pendingManagerActions.push(queued);this.store.save();this.sync().catch(()=>{});this.onChange();return queued;}
  applyManagedSettings(deviceId,patch,actor){const n=this.ensure(),peer=n.peers[deviceId];if(n.role!=='host'||!peer?.managementEnabled)throw new Error('這台裝置未授權管理');const current=n.managedConfigs[deviceId]||{version:0,settings:{},reminders:[],tasks:[]};current.settings={...current.settings,...managedSettings(patch)};current.version=(current.version||0)+1;current.updatedAt=new Date().toISOString();n.managedConfigs[deviceId]=current;this.recordAudit(actor,'settings-updated',deviceId,{keys:Object.keys(managedSettings(patch))});return current;}
  updateManagedSettings(deviceId,patch){const n=this.ensure();if(n.role==='client')return this.queueManagerAction({type:'settings',deviceId,patch:managedSettings(patch)});const out=this.applyManagedSettings(deviceId,patch,null);this.store.save();this.onChange();return out;}
  applyReminderToggle(deviceId,reminderId,enabled,actor){const n=this.ensure(),current=n.managedConfigs[deviceId];if(n.role!=='host'||!current)throw new Error('尚未取得受管理裝置資料');const all=this.managementView().find(x=>x.deviceId===deviceId)?.reminders||[],visible=all.find(x=>x.id===reminderId);if(!visible)throw new Error('找不到提醒');const owned=(current.reminders||[]).find(x=>x.id===reminderId);if(owned)owned.enabled=Boolean(enabled);n.itemOverrides[reminderId]={enabled:Boolean(enabled)};current.version=(current.version||0)+1;current.updatedAt=new Date().toISOString();this.recordAudit(actor,'reminder-toggled',deviceId,{reminderId,title:visible.title,enabled:Boolean(enabled)});return current;}
  toggleManagedReminder(deviceId,reminderId,enabled){const n=this.ensure();if(n.role==='client')return this.queueManagerAction({type:'reminder-toggle',deviceId,reminderId,enabled:Boolean(enabled)});const out=this.applyReminderToggle(deviceId,reminderId,enabled,null);this.store.save();this.onChange();return out;}
  applyManagedItem(deviceId,kind,item,remove=false,actor){const n=this.ensure(),peer=n.peers[deviceId],current=n.managedConfigs[deviceId];if(n.role!=='host'||!peer?.managementEnabled||!current)throw new Error('尚未取得受管理裝置資料');if(!['tasks','reminders'].includes(kind))throw new Error('不支援的項目類型');const list=current[kind]||[],now=new Date().toISOString(),existing=list.find(x=>x.id===item?.id),base={...(existing||{}),...(item||{}),id:item?.id||id(),targetDeviceId:deviceId,creatorDeviceId:item?.creatorDeviceId||n.deviceId,private:false,shared:true,updatedAt:now};if(kind==='tasks'&&existing?.kind==='once'&&existing.enabled===false&&item?.enabled===true){base.round=Math.max(1,Number(existing.round)||1)+1;base.date=core.localDateKey();}if(remove)base.deletedAt=now;else delete base.deletedAt;const normalized=kind==='tasks'?core.normalizeTask(base):{enabled:true,triggerMode:'clock',repeat:'daily',type:'gentle',color:'#7c6df2',sound:'chime',...base};const index=list.findIndex(x=>x.id===normalized.id);if(index>=0)list[index]=normalized;else list.push(normalized);current[kind]=list;current.version=(current.version||0)+1;current.updatedAt=now;this.recordAudit(actor,remove?'managed-item-deleted':'managed-item-saved',deviceId,{kind,id:normalized.id,title:normalized.title});return normalized;}
  updateManagedItem(deviceId,kind,item,remove=false){const n=this.ensure();if(n.role==='client')return this.queueManagerAction({type:'managed-item',deviceId,kind,item,remove:Boolean(remove)});const out=this.applyManagedItem(deviceId,kind,item,remove,null);this.store.save();this.onChange();return out;}
  applyUsageReset(deviceId,actor){const n=this.ensure(),peer=n.peers[deviceId],current=n.managedConfigs[deviceId];if(n.role!=='host'||!peer?.managementEnabled||!current)throw new Error('尚未取得受管理裝置資料');current.resetUsageRequest={id:id(),requestedAt:new Date().toISOString()};current.version=(current.version||0)+1;current.updatedAt=new Date().toISOString();this.recordAudit(actor,'usage-reset',deviceId);return current.resetUsageRequest;}
  requestUsageReset(deviceId){const n=this.ensure();if(n.role==='client')return this.queueManagerAction({type:'usage-reset',deviceId});const out=this.applyUsageReset(deviceId,null);this.store.save();this.onChange();return out;}
  applyParentLockRequest(deviceId,actor){const n=this.ensure(),peer=n.peers[deviceId],current=n.managedConfigs[deviceId];if(n.role!=='host'||!peer?.managementEnabled||!current)throw new Error('尚未取得受管理裝置資料');current.parentLockRequest={id:id(),requestedAt:new Date().toISOString()};current.version=(current.version||0)+1;current.updatedAt=new Date().toISOString();this.recordAudit(actor,'parent-lock-requested',deviceId);return current.parentLockRequest;}
  requestParentLock(deviceId){const n=this.ensure();if(n.role==='client')return this.queueManagerAction({type:'parent-lock-request',deviceId});const out=this.applyParentLockRequest(deviceId,null);this.store.save();this.onChange();return out;}
  async leave(){await this.stop();this.store.state.network={role:'local',memberRole:'member',deviceId:this.ensure().deviceId,deviceName:this.ensure().deviceName,familyId:null,familyName:null,hostIp:null,token:null,pairingCode:null,peers:{},remoteItems:{},managedConfigs:{},itemOverrides:{},hostKnownAssetIds:[],managementEnabled:false,pendingManagerActions:[],appliedManagerActions:{},auditLog:[],managerDevices:[],managerAudit:[],lastSync:null,online:false};this.store.save();this.onChange();}
  async stop(){clearInterval(this.timer);this.timer=null;this.running=false;if(this.server){await new Promise(r=>this.server.close(r));this.server=null;}}
  async resume(){const n=this.ensure();if(n.role==='host')await this.startHost();else if(n.role==='client')this.startClient();}
}
module.exports={FamilyNetwork,PORT,localAddresses,managedSettings};
