'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULT_STATE, clone } = require('./core');

class Store {
  constructor(file) { this.file = file; this.backupFile = `${file}.bak`;this.snapshotDir=path.join(path.dirname(file),'snapshots');this.recoveredFromBackup = false; this.state = this.load();this.lastSnapshotHash=null; }
  parse(file) {
    const loaded=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!loaded||typeof loaded!=='object'||Array.isArray(loaded))throw new Error('設定檔格式不正確');
    return loaded;
  }
  withDefaults(loaded) {
    const defaults=clone(DEFAULT_STATE);
    return { ...defaults, ...loaded, settings:{...defaults.settings,...(loaded.settings||{})} };
  }
  load() {
    if(!fs.existsSync(this.file)){
      if(!fs.existsSync(this.backupFile))return clone(DEFAULT_STATE);
      try {this.recoveredFromBackup=true;return this.withDefaults(this.parse(this.backupFile));}
      catch {throw new Error('家庭節奏主資料檔遺失，且找不到可用備援');}
    }
    try { return this.withDefaults(this.parse(this.file)); }
    catch(primaryError) {
      try {
        const state=this.withDefaults(this.parse(this.backupFile));
        this.recoveredFromBackup=true;
        const corrupt=`${this.file}.corrupt-${Date.now()}`;
        try { fs.copyFileSync(this.file,corrupt); } catch { /* preserve recovery even if quarantine fails */ }
        return state;
      } catch {
        throw new Error(`家庭節奏資料檔無法讀取，且找不到可用備援：${primaryError.message}`);
      }
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    const handle=fs.openSync(temp,'wx');
    try {fs.writeFileSync(handle,JSON.stringify(this.state,null,2));fs.fsyncSync(handle);}
    finally {fs.closeSync(handle);}
    this.parse(temp);
    if(fs.existsSync(this.file)){
      let primaryValid=false;
      try {this.parse(this.file);primaryValid=true;} catch { /* keep the last good backup */ }
      if(primaryValid){
        const backupTemp=`${this.backupFile}.${process.pid}.${Date.now()}.tmp`;
        fs.copyFileSync(this.file,backupTemp);
        const backupHandle=fs.openSync(backupTemp,'r+');
        try {fs.fsyncSync(backupHandle);} finally {fs.closeSync(backupHandle);}
        this.parse(backupTemp);
        // If the backup cannot be updated, keep the current primary too.
        fs.renameSync(backupTemp,this.backupFile);
      }
    }
    try {
      fs.renameSync(temp, this.file);
    } catch (error) {
      // A locked destination must not trigger an in-place rewrite: leave the
      // previous data and the complete temporary file available for recovery.
      throw new Error(`無法安全替換家庭節奏資料檔；新資料保留於 ${temp}：${error.message}`);
    }
    this.recoveredFromBackup=false;
  }
  snapshotData(state=this.state){const {network,_runtime,...copy}=clone(state);return{...copy,network:{deviceId:network?.deviceId,deviceName:network?.deviceName}};}
  createSnapshot(label='自動變更前快照',force=false){
    const data=this.snapshotData(),meaningful={settings:data.settings,reminders:data.reminders,tasks:data.tasks,completions:data.completions,rewardBalanceMinutes:data.rewardBalanceMinutes,rewardUsage:data.rewardUsage,soundAssets:data.soundAssets},hash=crypto.createHash('sha256').update(JSON.stringify(meaningful)).digest('hex');
    if(!force&&hash===this.lastSnapshotHash)return null;
    fs.mkdirSync(this.snapshotDir,{recursive:true});const createdAt=new Date().toISOString(),nonce=crypto.randomBytes(3).toString('hex'),name=`${createdAt.replace(/[:.]/g,'-')}-${hash.slice(0,10)}-${nonce}.json`,file=path.join(this.snapshotDir,name);
    fs.writeFileSync(file,JSON.stringify({format:'family-rhythm-snapshot',version:1,createdAt,label,hash,data},null,2),'utf8');this.lastSnapshotHash=hash;
    const files=fs.readdirSync(this.snapshotDir).filter(x=>x.endsWith('.json')).sort();for(const old of files.slice(0,-30))fs.unlinkSync(path.join(this.snapshotDir,old));return name;
  }
  listSnapshots(){if(!fs.existsSync(this.snapshotDir))return[];return fs.readdirSync(this.snapshotDir).filter(x=>x.endsWith('.json')).sort().reverse().map(name=>{try{const p=JSON.parse(fs.readFileSync(path.join(this.snapshotDir,name),'utf8')),d=p.data||{};return{id:name,createdAt:p.createdAt,label:p.label||'自動快照',tasks:(d.tasks||[]).length,reminders:(d.reminders||[]).length,completions:(d.completions||[]).length};}catch{return null;}}).filter(Boolean);}
  restoreSnapshot(name){if(!/^[\w.-]+\.json$/.test(name))throw new Error('快照名稱不正確');const file=path.join(this.snapshotDir,name),payload=JSON.parse(fs.readFileSync(file,'utf8'));if(payload.format!=='family-rhythm-snapshot'||!payload.data)throw new Error('快照格式不正確');this.createSnapshot('復原前安全快照',true);const network=this.state.network,password=this.state.settings?.parentPassword;this.state=this.withDefaults(payload.data);this.state.network=network;if(password)this.state.settings.parentPassword=password;else delete this.state.settings.parentPassword;this.save();return true;}
  update(mutator) { this.createSnapshot();const result = mutator(this.state); this.save(); return result; }
}
module.exports = Store;
