'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('../src/core');
const backup=require('../src/backup');

test('backup excludes password and network credentials',()=>{const state=core.clone(core.DEFAULT_STATE);state.settings.parentPassword={salt:'secret-salt',hash:'secret-hash'};state.network={hostIp:'192.168.1.2',token:'secret-token'};state.tasks.push({id:'t1',title:'洗餐具'});const payload=backup.createBackup(state,'0.9.0',new Date('2026-08-17T00:00:00Z')),text=JSON.stringify(payload);assert.equal(text.includes('secret-hash'),false);assert.equal(text.includes('secret-token'),false);assert.equal(text.includes('192.168.1.2'),false);assert.equal(payload.data.tasks[0].title,'洗餐具');});

test('restore preserves current password and family connection',()=>{const current=core.clone(core.DEFAULT_STATE);current.settings.parentPassword={salt:'current',hash:'lock'};current.network={deviceId:'new-device',token:'paired'};const source=core.clone(core.DEFAULT_STATE);source.network={deviceId:'old-device'};source.settings.dailyLimitMinutes=45;source.tasks=[{id:'t2',title:'簽聯絡簿',targetDeviceId:'old-device'}];const payload=backup.createBackup(source);backup.applyBackup(current,payload);assert.equal(current.settings.dailyLimitMinutes,45);assert.equal(current.settings.parentPassword.hash,'lock');assert.equal(current.network.token,'paired');assert.equal(current.tasks[0].title,'簽聯絡簿');assert.equal(current.tasks[0].targetDeviceId,'new-device');});
