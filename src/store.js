'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_STATE, clone } = require('./core');

class Store {
  constructor(file) { this.file = file; this.backupFile = `${file}.bak`; this.recoveredFromBackup = false; this.state = this.load(); }
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
    if(!fs.existsSync(this.file))return clone(DEFAULT_STATE);
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
    if(fs.existsSync(this.file)){
      try {
        this.parse(this.file);
        const backupTemp=`${this.backupFile}.${process.pid}.tmp`;
        fs.copyFileSync(this.file,backupTemp);
        try { fs.renameSync(backupTemp,this.backupFile); }
        catch { fs.copyFileSync(backupTemp,this.backupFile); try { fs.unlinkSync(backupTemp); } catch { /* already moved */ } }
      } catch { /* never replace a known-good backup with a corrupt primary */ }
    }
    const temp = `${this.file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2));
    try {
      fs.renameSync(temp, this.file);
    } catch (error) {
      // Windows may refuse replacing a destination that another older instance
      // briefly has open. Preserve the valid data with a direct rewrite, then
      // remove only this process's uniquely named temporary file.
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
      try { fs.unlinkSync(temp); } catch { /* already moved or cleaned */ }
    }
    this.recoveredFromBackup=false;
  }
  update(mutator) { const result = mutator(this.state); this.save(); return result; }
}
module.exports = Store;
