'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_STATE, clone } = require('./core');

class Store {
  constructor(file) { this.file = file; this.state = this.load(); }
  load() {
    try {
      const defaults=clone(DEFAULT_STATE),loaded=JSON.parse(fs.readFileSync(this.file,'utf8'));
      return { ...defaults, ...loaded, settings:{...defaults.settings,...(loaded.settings||{})} };
    }
    catch { return clone(DEFAULT_STATE); }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
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
  }
  update(mutator) { const result = mutator(this.state); this.save(); return result; }
}
module.exports = Store;
