'use strict';
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');

const PORT = 45831;
const MANAGED_SETTING_KEYS=['timeControlEnabled','earliestStartEnabled','earliestStartTime','timeMode','dailyLimitMinutes','shutdownTime','rewardExtendsClock','maxRewardClockExtensionMinutes','rewardCapMinutes','shutdownGraceMinutes'];
function managedSettings(settings={}){return Object.fromEntries(MANAGED_SETTING_KEYS.filter(k=>settings[k]!==undefined).map(k=>[k,settings[k]]));}
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
    s.network.deviceId ||= id(); s.network.deviceName ||= os.hostname(); s.network.peers ||= {}; s.network.remoteItems ||= {};s.network.managedConfigs||={};s.network.itemOverrides||={};s.network.hostKnownAssetIds||=[];s.network.managementEnabled=Boolean(s.network.managementEnabled);s.network.pendingManagerActions||=[];s.network.appliedManagerActions||={};s.network.pendingSecurityEvents||=[];s.network.appliedSecurityEvents||={};s.network.auditLog||=[];s.network.managerDevices||=[];s.network.managerAudit||=[];s.network.memberRole||='member';this.notifications||=[];
    return s.network;
  }
  status() { const n=this.ensure(); return { role:n.role,memberRole:n.role==='host'?'primary-manager':n.memberRole,deviceId:n.deviceId,deviceName:n.deviceName,appVersion:this.appVersion,familyId:n.familyId,familyName:n.familyName,hostIp:n.hostIp,pairingCode:n.role==='host'?n.pairingCode:null,pairingExpiresAt:n.role==='host'?n.pairingExpiresAt:null,managementEnabled:n.managementEnabled,pendingManagerActions:n.pendingManagerActions.length,peers:Object.fromEntries(this.publicPeers().map(x=>[x.deviceId,x])),lastSync:n.lastSync,lastError:n.lastError,online:n.online,addresses:localAddresses(),port:this.port }; }
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
          peer.lastSeen=new Date().toISOString();peer.online=true;peer.name=data.deviceName||peer.name;peer.appVersion=data.appVersion||peer.appVersion||'未知';peer.role||='member';peer.managementEnabled=Boolean(data.managementEnabled);
          const ackedActionIds=this.applyManagerActions(peer,data.managerActions||[]);
          const ackedSecurityEventIds=this.applySecurityEvents(peer,data.securityEvents||[]);
          this.store.state.soundAssets||={};for(const [assetId,asset] of Object.entries(data.assets||{}))if(asset?.data&&asset.data.length<7_500_000)this.store.state.soundAssets[assetId]=asset;
          n.remoteItems[data.deviceId]={reminders:data.reminders||[],tasks:data.tasks||[],completions:data.completions||[],settings:managedSettings(data.settings),usage:data.usage||{},lastAppliedResetId:data.lastAppliedResetId||null,receivedAt:new Date().toISOString()};
          if(peer.managementEnabled&&!n.managedConfigs[data.deviceId])n.managedConfigs[data.deviceId]={version:1,settings:managedSettings(data.settings),reminders:data.reminders||[],tasks:data.tasks||[],updatedAt:new Date().toISOString()};
          const hostItems={reminders:this.applyItemOverrides(this.store.state.reminders.filter(x=>x.shared)),tasks:this.store.state.tasks.filter(x=>x.shared),completions:this.store.state.completions};
          const remoteForSync=Object.fromEntries(Object.entries(n.remoteItems).map(([source,items])=>[source,{...items,reminders:this.applyItemOverrides(items.reminders||[])}]));
          const managedConfig=peer.managementEnabled?n.managedConfigs[data.deviceId]||null:null,allReminders=[...hostItems.reminders,...Object.values(remoteForSync).flatMap(x=>x.reminders||[]),...(managedConfig?.reminders||[])],neededIds=new Set(allReminders.filter(x=>!x.targetDeviceId||x.targetDeviceId===data.deviceId).map(x=>x.customSoundId).filter(Boolean)),have=new Set(data.haveAssetIds||[]),assets=Object.fromEntries([...neededIds].filter(assetId=>!have.has(assetId)&&this.store.state.soundAssets[assetId]).map(assetId=>[assetId,this.store.state.soundAssets[assetId]]));
          this.store.save();this.onChange();return json(res,200,{peers:this.publicPeers(),items:{[n.deviceId]:hostItems,...remoteForSync},managedConfig,ackedActionIds,ackedSecurityEventIds,managerDevices:peer.role==='co-manager'?this.managementView():[],managerAudit:peer.role==='co-manager'?this.auditView():[],knownAssetIds:Object.keys(this.store.state.soundAssets),assets});
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
  mergeItems(...groups){const map=new Map();for(const group of groups)for(const item of group||[])map.set(item.id,item);return [...map.values()];}
  applyManagerActions(peer,actions){
    const n=this.ensure();if(peer.role!=='co-manager')return[];const acked=[];
    for(const action of actions){if(!action?.id)continue;if(n.appliedManagerActions[action.id]){acked.push(action.id);continue;}
      try{
        if(action.type==='settings')this.applyManagedSettings(action.deviceId,action.patch,peer);
        else if(action.type==='reminder-toggle')this.applyReminderToggle(action.deviceId,action.reminderId,action.enabled,peer);
        else if(action.type==='usage-reset')this.applyUsageReset(action.deviceId,peer);
        else continue;
        n.appliedManagerActions[action.id]=new Date().toISOString();acked.push(action.id);
      }catch{continue;}
    }
    const entries=Object.entries(n.appliedManagerActions);if(entries.length>500)n.appliedManagerActions=Object.fromEntries(entries.slice(-500));return acked;
  }
  applySecurityEvents(peer,events){
    const n=this.ensure(),acked=[];
    for(const event of events){if(!event?.id)continue;if(n.appliedSecurityEvents[event.id]){acked.push(event.id);continue;}if(event.type!=='parent-lock-removed')continue;n.appliedSecurityEvents[event.id]=new Date().toISOString();acked.push(event.id);this.recordAudit(peer,'parent-lock-removed',peer.deviceId,{deviceName:peer.name});this.notifications.push({type:'parent-lock-removed',deviceId:peer.deviceId,deviceName:peer.name,at:event.at||new Date().toISOString()});}
    const entries=Object.entries(n.appliedSecurityEvents);if(entries.length>500)n.appliedSecurityEvents=Object.fromEntries(entries.slice(-500));return acked;
  }
  queueSecurityEvent(type,detail={}){const n=this.ensure();if(n.role!=='client')return null;const event={id:id(),type,detail,at:new Date().toISOString()};n.pendingSecurityEvents.push(event);this.store.save();this.sync().catch(()=>{});this.onChange();return event;}
  consumeNotifications(){const out=this.notifications||[];this.notifications=[];return out;}
  recordAudit(peer,type,deviceId,detail={}){const n=this.ensure();n.auditLog.push({id:id(),actorDeviceId:peer?.deviceId||n.deviceId,actorName:peer?.name||n.deviceName,type,targetDeviceId:deviceId,detail,at:new Date().toISOString()});if(n.auditLog.length>200)n.auditLog=n.auditLog.slice(-200);}
  auditView(){return this.ensure().role==='host'?this.ensure().auditLog.slice(-50).reverse():this.ensure().managerAudit||[];}
  setPeerRole(deviceId,role){const n=this.ensure();if(n.role!=='host')throw new Error('只有主要電腦能變更家庭角色');if(!['member','co-manager'].includes(role))throw new Error('不支援的家庭角色');const peer=n.peers[deviceId];if(!peer)throw new Error('找不到家庭裝置');peer.role=role;this.recordAudit(null,role==='co-manager'?'manager-granted':'manager-revoked',deviceId,{name:peer.name});this.store.save();this.onChange();return this.status();}
  markOffline(){const n=this.ensure();for(const p of Object.values(n.peers))p.online=Date.now()-new Date(p.lastSeen).getTime()<30000;this.onChange();}
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
      const result=await request(n.hostIp,'/sync',{deviceId:n.deviceId,deviceName:n.deviceName,appVersion:this.appVersion,managementEnabled:managed,settings:managedSettings(this.store.state.settings),usage:this.store.state.usage,lastAppliedResetId:n.lastAppliedResetId,managerActions:n.pendingManagerActions,securityEvents:n.pendingSecurityEvents,reminders:managed?this.store.state.reminders:this.store.state.reminders.filter(x=>x.shared),tasks:managed?this.store.state.tasks:this.store.state.tasks.filter(x=>x.shared),completions:this.store.state.completions,haveAssetIds:Object.keys(localAssets),assets},{'x-family-token':n.token},this.port);
      n.online=true;n.lastSync=new Date().toISOString();n.peers=Object.fromEntries((result.peers||[]).map(x=>[x.deviceId,x]));n.memberRole=n.peers[n.deviceId]?.role||'member';n.remoteItems=result.items||{};n.hostKnownAssetIds=result.knownAssetIds||n.hostKnownAssetIds||[];
      this.store.state.soundAssets||={};Object.assign(this.store.state.soundAssets,result.assets||{});
      const acked=new Set(result.ackedActionIds||[]);n.pendingManagerActions=n.pendingManagerActions.filter(x=>!acked.has(x.id));const securityAcked=new Set(result.ackedSecurityEventIds||[]);n.pendingSecurityEvents=n.pendingSecurityEvents.filter(x=>!securityAcked.has(x.id));if(n.memberRole==='co-manager'){n.seenSecurityAuditIds||=[];const seen=new Set(n.seenSecurityAuditIds);for(const event of result.managerAudit||[])if(event.type==='parent-lock-removed'&&!seen.has(event.id)){this.notifications.push({type:event.type,deviceId:event.targetDeviceId,deviceName:event.actorName,at:event.at});seen.add(event.id);}n.seenSecurityAuditIds=[...seen].slice(-200);n.managerDevices=result.managerDevices||[];n.managerAudit=result.managerAudit||[];}else{n.managerDevices=[];n.managerAudit=[];}
      if(managed&&result.managedConfig){Object.assign(this.store.state.settings,managedSettings(result.managedConfig.settings));this.store.state.reminders=result.managedConfig.reminders||[];this.store.state.tasks=result.managedConfig.tasks||[];n.appliedManagedVersion=result.managedConfig.version;const reset=result.managedConfig.resetUsageRequest;if(reset?.id&&reset.id!==n.lastAppliedResetId){this.store.state.usage[`me:${localDateKey()}`]=0;n.lastAppliedResetId=reset.id;n.lastUsageResetAt=new Date().toISOString();}}
      this.store.save();this.onChange();
    }catch(e){n.online=false;n.lastError=e.message;this.onChange();}
  }
  setManagement(enabled){const n=this.ensure();if(n.role!=='client')throw new Error('只有加入家庭的裝置能開啟受管理模式');n.managementEnabled=Boolean(enabled);this.store.save();this.sync().catch(()=>{});this.onChange();return this.status();}
  managementView(){const n=this.ensure();if(n.role==='client'&&n.memberRole==='co-manager')return n.managerDevices||[];if(n.role!=='host')return[];return Object.values(n.peers).filter(p=>p.managementEnabled).map(p=>{const observed=n.remoteItems[p.deviceId]||{},config=n.managedConfigs[p.deviceId]||{},reminders=this.applyItemOverrides(this.mergeItems(config.reminders,observed.reminders,this.assignedItems(p.deviceId,'reminders'))),tasks=this.mergeItems(config.tasks,observed.tasks,this.assignedItems(p.deviceId,'tasks'));return{deviceId:p.deviceId,name:p.name,online:Date.now()-new Date(p.lastSeen).getTime()<30000,lastSeen:p.lastSeen,settings:config.settings||observed.settings||{},reminders,tasks,usage:observed.usage||{},version:config.version||0,updatedAt:config.updatedAt,resetPending:Boolean(config.resetUsageRequest?.id&&config.resetUsageRequest.id!==observed.lastAppliedResetId),lastResetRequestedAt:config.resetUsageRequest?.requestedAt};});}
  queueManagerAction(action){const n=this.ensure();if(n.role!=='client'||n.memberRole!=='co-manager')throw new Error('這台裝置不是共同管理者');const queued={id:id(),createdAt:new Date().toISOString(),actorDeviceId:n.deviceId,actorName:n.deviceName,...action};n.pendingManagerActions.push(queued);this.store.save();this.sync().catch(()=>{});this.onChange();return queued;}
  applyManagedSettings(deviceId,patch,actor){const n=this.ensure(),peer=n.peers[deviceId];if(n.role!=='host'||!peer?.managementEnabled)throw new Error('這台裝置未授權管理');const current=n.managedConfigs[deviceId]||{version:0,settings:{},reminders:[],tasks:[]};current.settings={...current.settings,...managedSettings(patch)};current.version=(current.version||0)+1;current.updatedAt=new Date().toISOString();n.managedConfigs[deviceId]=current;this.recordAudit(actor,'settings-updated',deviceId,{keys:Object.keys(managedSettings(patch))});return current;}
  updateManagedSettings(deviceId,patch){const n=this.ensure();if(n.role==='client')return this.queueManagerAction({type:'settings',deviceId,patch:managedSettings(patch)});const out=this.applyManagedSettings(deviceId,patch,null);this.store.save();this.onChange();return out;}
  applyReminderToggle(deviceId,reminderId,enabled,actor){const n=this.ensure(),current=n.managedConfigs[deviceId];if(n.role!=='host'||!current)throw new Error('尚未取得受管理裝置資料');const all=this.managementView().find(x=>x.deviceId===deviceId)?.reminders||[],visible=all.find(x=>x.id===reminderId);if(!visible)throw new Error('找不到提醒');const owned=(current.reminders||[]).find(x=>x.id===reminderId);if(owned)owned.enabled=Boolean(enabled);n.itemOverrides[reminderId]={enabled:Boolean(enabled)};current.version=(current.version||0)+1;current.updatedAt=new Date().toISOString();this.recordAudit(actor,'reminder-toggled',deviceId,{reminderId,title:visible.title,enabled:Boolean(enabled)});return current;}
  toggleManagedReminder(deviceId,reminderId,enabled){const n=this.ensure();if(n.role==='client')return this.queueManagerAction({type:'reminder-toggle',deviceId,reminderId,enabled:Boolean(enabled)});const out=this.applyReminderToggle(deviceId,reminderId,enabled,null);this.store.save();this.onChange();return out;}
  applyUsageReset(deviceId,actor){const n=this.ensure(),peer=n.peers[deviceId],current=n.managedConfigs[deviceId];if(n.role!=='host'||!peer?.managementEnabled||!current)throw new Error('尚未取得受管理裝置資料');current.resetUsageRequest={id:id(),requestedAt:new Date().toISOString()};current.version=(current.version||0)+1;current.updatedAt=new Date().toISOString();this.recordAudit(actor,'usage-reset',deviceId);return current.resetUsageRequest;}
  requestUsageReset(deviceId){const n=this.ensure();if(n.role==='client')return this.queueManagerAction({type:'usage-reset',deviceId});const out=this.applyUsageReset(deviceId,null);this.store.save();this.onChange();return out;}
  async leave(){await this.stop();this.store.state.network={role:'local',memberRole:'member',deviceId:this.ensure().deviceId,deviceName:this.ensure().deviceName,familyId:null,familyName:null,hostIp:null,token:null,pairingCode:null,peers:{},remoteItems:{},managedConfigs:{},itemOverrides:{},hostKnownAssetIds:[],managementEnabled:false,pendingManagerActions:[],appliedManagerActions:{},auditLog:[],managerDevices:[],managerAudit:[],lastSync:null,online:false};this.store.save();this.onChange();}
  async stop(){clearInterval(this.timer);this.timer=null;this.running=false;if(this.server){await new Promise(r=>this.server.close(r));this.server=null;}}
  async resume(){const n=this.ensure();if(n.role==='host')await this.startHost();else if(n.role==='client')this.startClient();}
}
module.exports={FamilyNetwork,PORT,localAddresses,managedSettings};
