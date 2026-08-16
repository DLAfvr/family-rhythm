'use strict';
const { app, BrowserWindow, ipcMain, screen, shell, Tray, Menu, nativeImage, powerMonitor, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const Store = require('./store');
const core = require('./core');
const { FamilyNetwork } = require('./network');

let store, network, widget, dashboard, reminderWindow, rewardWindow, quitDialog, shutdownTimer, shutdownAt, activeReminder, activeRewardPrompt, updateStatus=null, parentUnlockedUntil=0, unlockFailures=[], tray;
const SENSITIVE_IPC=new Set(['save-reminder','delete-reminder','save-task','delete-task','save-settings','save-update-settings','choose-custom-sound','network-create','network-join','network-leave','network-set-managed','network-refresh-pairing','managed-settings-update','managed-reminder-toggle','managed-usage-reset','network-set-peer-role']);
const fired = new Set();
let sessionId=Date.now(),sessionActiveSeconds=0,sessionWasIdle=false;
const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (dashboard && !dashboard.isDestroyed()) {
      if (dashboard.isMinimized()) dashboard.restore();
      dashboard.focus();
    } else if (widget && !widget.isDestroyed()) {
      widget.show();
      widget.focus();
    }
  });
}

function createWindow(file, options = {}) {
  const win = new BrowserWindow({
    backgroundColor: '#12131a', show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    ...options
  });
  win.setMenuBarVisibility(false);
  const [name, queryString] = file.split('?');
  const query = Object.fromEntries(new URLSearchParams(queryString || ''));
  win.loadFile(path.join(__dirname, 'ui', name), { query });
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(!url.startsWith('file:'))event.preventDefault();});
  win.once('ready-to-show', () => win.show());
  return win;
}
function createWidget() {
  const area = screen.getPrimaryDisplay().workArea;
  widget = createWindow('widget.html', {
    width: 340, height: 252, x: area.x + area.width - 360, y: area.y + 20,
    frame: false, transparent: true, resizable: false, alwaysOnTop: false, skipTaskbar: true
  });
}
function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname,'assets','icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('家庭節奏');
  const menu = [
    { label: '顯示小工具', click: () => { widget?.show(); widget?.focus(); } },
    { label: '開啟管理設定', click: openDashboard },
    { type: 'separator' }
  ];
  menu.push({ label: '退出家庭節奏', click: openQuitDialog });
  tray.setContextMenu(Menu.buildFromTemplate(menu));
  tray.on('double-click', () => { widget?.show(); widget?.focus(); });
}
function openQuitDialog() {
  if (quitDialog && !quitDialog.isDestroyed()) return quitDialog.focus();
  quitDialog = createWindow('quit.html', {
    width: 390, height: 230, resizable: false, minimizable: false, maximizable: false,
    parent: dashboard || undefined, modal: Boolean(dashboard), title: '退出家庭節奏'
  });
  quitDialog.on('closed', () => { quitDialog = null; });
}
function openDashboard() {
  if (dashboard && !dashboard.isDestroyed()) return dashboard.focus();
  dashboard = createWindow('dashboard.html', { width: 1080, height: 720, minWidth: 840, minHeight: 580, title: '家庭節奏' });
  dashboard.on('closed', () => { dashboard = null; });
}
function broadcast(widgetOnly = false) {
  const windows = widgetOnly ? [widget] : [widget, dashboard, reminderWindow, rewardWindow, quitDialog];
  for (const win of windows) if (win && !win.isDestroyed()) win.webContents.send('state-changed');
}
function remoteItems(kind) {
  const n=store.state.network;if(!n?.remoteItems)return [];
  return Object.entries(n.remoteItems).filter(([deviceId])=>deviceId!==n.deviceId).flatMap(([deviceId,items])=>(items[kind]||[]).map(x=>({deviceId,x}))).filter(({x})=>!x.targetDeviceId||x.targetDeviceId===n.deviceId).map(({deviceId,x})=>({...x,remote:true,memberId:kind==='completions'?`remote:${deviceId}`:'me'}));
}
function parentLockStatus(){const configured=Boolean(store.state.settings.parentPassword),unlocked=!configured||Date.now()<parentUnlockedUntil;return{configured,unlocked,expiresAt:unlocked&&configured?parentUnlockedUntil:null};}
function stateForUi(){const {network:_privateNetwork,soundAssets:_privateSounds,...safe}=store.state,settings={...safe.settings};delete settings.parentPassword;return {...safe,settings,appVersion:app.getVersion(),parentLock:parentLockStatus(),reminders:[...store.state.reminders,...remoteItems('reminders')],tasks:[...store.state.tasks,...remoteItems('tasks')],completions:[...store.state.completions,...remoteItems('completions')],networkStatus:network.status(),managedDevices:network.managementView(),managementAudit:network.auditView(),runtime:{shutdownAt,activeReminder,rewardPrompt:activeRewardPrompt,updateStatus,sessionId,sessionActiveSeconds}};}
function unlockParent(password){const now=Date.now();unlockFailures=unlockFailures.filter(x=>now-x<60000);if(unlockFailures.length>=5)return{ok:false,reason:'嘗試次數過多，請一分鐘後再試'};if(!store.state.settings.parentPassword||core.verifyPassword(String(password||''),store.state.settings.parentPassword)){parentUnlockedUntil=now+5*60*1000;unlockFailures=[];broadcast();return{ok:true,...parentLockStatus()};}unlockFailures.push(now);return{ok:false,reason:'家長密碼不正確'};}
function versionParts(v){return String(v||'0').replace(/^v/i,'').split('.').map(x=>Number.parseInt(x,10)||0);}
function newerVersion(a,b){const aa=versionParts(a),bb=versionParts(b);for(let i=0;i<Math.max(aa.length,bb.length);i++){if((aa[i]||0)!==(bb[i]||0))return(aa[i]||0)>(bb[i]||0);}return false;}
function githubRepo(value){const text=String(value||'').trim(),url=text.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i),short=text.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);const m=url||short;if(!m)throw new Error('請輸入 GitHub 專案網址，例如 https://github.com/名稱/專案');return`${m[1]}/${m[2]}`;}
async function checkForUpdates(){try{const repo=githubRepo(store.state.settings.updateRepo),response=await fetch(`https://api.github.com/repos/${repo}/releases/latest`,{headers:{Accept:'application/vnd.github+json','User-Agent':`Family-Rhythm/${app.getVersion()}`}});if(!response.ok)throw new Error(response.status===404?'這個專案還沒有發布 Release':`GitHub 回應 ${response.status}`);const release=await response.json(),latest=String(release.tag_name||release.name||'').replace(/^v/i,'');updateStatus={checkedAt:new Date().toISOString(),available:newerVersion(latest,app.getVersion()),latestVersion:latest,url:release.html_url,error:null};}catch(e){updateStatus={checkedAt:new Date().toISOString(),available:false,latestVersion:null,url:null,error:e.message};}broadcast();return updateStatus;}
function showReminder(reminder) {
  activeReminder = reminder;
  if (reminderWindow && !reminderWindow.isDestroyed()) reminderWindow.close();
  reminderWindow = createWindow(`reminder.html?id=${encodeURIComponent(reminder.id)}`, {
    fullscreen: true, alwaysOnTop: true, frame: false, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, autoplayPolicy: 'no-user-gesture-required' }
  });
  reminderWindow.setAlwaysOnTop(true, 'screen-saver');
  reminderWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  store.update(s => s.events.push({ id: core.uuid(), type: 'reminder-fired', reminderId: reminder.id, at: new Date().toISOString() }));
}
function showRewardPrompt(kind,maxMinutes,title,message){
  const max=Math.min(Math.max(0,Math.floor(Number(maxMinutes)||0)),Math.max(0,Math.floor(Number(store.state.rewardBalanceMinutes)||0)));
  if(!max||(rewardWindow&&!rewardWindow.isDestroyed()))return false;
  activeRewardPrompt={kind,maxMinutes:max,balanceMinutes:Math.floor(Number(store.state.rewardBalanceMinutes)||0),title,message};
  rewardWindow=createWindow('reward.html',{fullscreen:true,alwaysOnTop:true,frame:false,skipTaskbar:true,closable:false});
  rewardWindow.setAlwaysOnTop(true,'screen-saver');rewardWindow.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
  rewardWindow.on('closed',()=>{rewardWindow=null;activeRewardPrompt=null;broadcast();});return true;
}
function startShutdownCountdown(reminderId) {
  const minutes = Math.max(1, Number(store.state.settings.shutdownGraceMinutes) || 10);
  shutdownAt = Date.now() + minutes * 60_000;
  clearTimeout(shutdownTimer);
  shutdownTimer = setTimeout(() => {
    store.update(s => s.events.push({ id: core.uuid(), type: 'shutdown-due', reminderId, at: new Date().toISOString() }));
    if (!store.state.settings.simulateShutdown) execFile('shutdown.exe', ['/s', '/t', '30', '/c', '家庭節奏：使用時間結束，請儲存工作。']);
    shutdownAt = null; broadcast();
  }, minutes * 60_000);
  broadcast();
}
function cancelShutdown(password) {
  if (!core.verifyPassword(password, store.state.settings.parentPassword)) return false;
  clearTimeout(shutdownTimer); shutdownTimer = null; shutdownAt = null;
  execFile('shutdown.exe', ['/a'], () => {});
  store.update(s => s.events.push({ id: core.uuid(), type: 'shutdown-cancelled', at: new Date().toISOString() }));
  broadcast(); return true;
}
function tick() {
  const now = new Date();
  const key = core.localDateKey(now);
  const isIdle=powerMonitor.getSystemIdleTime()>=300,startAt=core.earliestStartAt(store.state,now),beforeStart=Boolean(store.state.settings.timeControlEnabled&&startAt&&now<startAt),earlyAllowed=core.earlyAccessUntil(store.state,now)>now.getTime(),mayUse=!beforeStart||earlyAllowed;
  if(isIdle||!mayUse)sessionWasIdle=true;else{if(sessionWasIdle){sessionId=Date.now();sessionActiveSeconds=0;sessionWasIdle=false;}sessionActiveSeconds++;if(store.state.settings.timeControlEnabled)store.state.usage[`me:${key}`]=(store.state.usage[`me:${key}`]||0)+1;}
  if (now.getSeconds() % 30 === 0) store.save();
  const dueReminders=[...store.state.reminders.filter(x=>!x.targetDeviceId||x.targetDeviceId===store.state.network?.deviceId),...remoteItems('reminders')];
  for (const r of dueReminders) {
    if(r.triggerMode==='afterStart'){
      const bucket=core.relativeReminderBucket(r,sessionActiveSeconds),fireKey=`${r.id}:session:${sessionId}:${bucket}`;
      if(bucket&&!fired.has(fireKey)){fired.add(fireKey);showReminder(r);}
    }else{
      const fireKey = `${r.id}:${key}:${r.time}`;
      if (!fired.has(fireKey) && core.reminderDue(r, now, 2)) { fired.add(fireKey); showReminder(r); }
    }
  }
  const earlyKey=`early-shutdown:${key}:${core.earlyAccessUntil(store.state,now)}`;
  if(beforeStart&&!earlyAllowed&&!shutdownAt&&!activeRewardPrompt&&!fired.has(earlyKey)){
    fired.add(earlyKey);const available=Math.floor(Number(store.state.rewardBalanceMinutes)||0);
    if(available>0)showRewardPrompt('early',available,'還沒到開始使用時間',`現在可花時間晶幣提早使用；原本開放時間是 ${store.state.settings.earliestStartTime}。`);
    else showReminder({id:earlyKey,title:`要到 ${store.state.settings.earliestStartTime} 才能開始使用`,type:'shutdown',color:'#a34f68',sound:'alarm'});
  }
  const effectiveEnd = store.state.settings.timeControlEnabled ? core.effectiveShutdownAt(store.state, 'me', now) : null;
  const clockKey = `clock-shutdown:${key}:${effectiveEnd?.toISOString() || ''}`;
  const quotaKey = `quota-shutdown:${key}:${Number(store.state.rewardUsage?.[key]?.quotaMinutes)||0}`;
  const quotaEnded=store.state.settings.timeControlEnabled&&['quota','both'].includes(store.state.settings.timeMode)&&core.remainingMinutes({...store.state,settings:{...store.state.settings,timeMode:'quota'}},'me',now)<=0;
  if(quotaEnded&&!fired.has(quotaKey)&&!activeRewardPrompt){
    fired.add(quotaKey);const available=Number(store.state.rewardBalanceMinutes)||0;
    if(available>0)showRewardPrompt('quota',available,'今天的基本額度用完了','可以選擇花一些累積的時間晶幣繼續使用。');
    else showReminder({id:quotaKey,title:'今天的使用額度用完了',type:'shutdown',color:'#a34f68',sound:'alarm'});
  }
  if(effectiveEnd&&now>=effectiveEnd&&!fired.has(clockKey)&&!activeRewardPrompt&&!quotaEnded){
    fired.add(clockKey);const used=Number(store.state.rewardUsage?.[key]?.clockMinutes)||0,max=Math.max(0,(Number(store.state.settings.maxRewardClockExtensionMinutes)||0)-used),available=Math.min(max,Number(store.state.rewardBalanceMinutes)||0);
    if(store.state.settings.rewardExtendsClock&&available>0)showRewardPrompt('clock',available,'固定使用時間到了',`今晚依家長設定，還能延長最多 ${max} 分鐘。`);
    else showReminder({id:clockKey,title:'今天的使用時間到了',type:'shutdown',color:'#a34f68',sound:'alarm'});
  }
  broadcast(true);
}

if (singleInstanceLock) app.whenReady().then(() => {
  store = new Store(path.join(app.getPath('userData'), 'family-rhythm.json'));
  store.state.settings.startWithWindows=app.getLoginItemSettings().openAtLogin;
  network = new FamilyNetwork(store, broadcast, undefined, app.getVersion());
  createWidget();
  createTray();
  network.resume().catch(()=>{});
  setTimeout(()=>{if(store.state.settings.autoCheckUpdates&&store.state.settings.updateRepo)checkForUpdates();},5000);setInterval(()=>{if(store.state.settings.autoCheckUpdates&&store.state.settings.updateRepo)checkForUpdates();},6*60*60*1000);
  setInterval(tick, 1000);
  const originalHandle=ipcMain.handle.bind(ipcMain);ipcMain.handle=(channel,handler)=>originalHandle(channel,(event,...args)=>{if(SENSITIVE_IPC.has(channel)&&!parentLockStatus().unlocked)throw new Error('請先解鎖家長控制');return handler(event,...args);});
  ipcMain.handle('get-state', stateForUi);
  ipcMain.handle('parent-unlock',(_,password)=>unlockParent(password));
  ipcMain.handle('parent-lock',()=>{parentUnlockedUntil=0;broadcast();return parentLockStatus();});
  ipcMain.handle('open-dashboard', openDashboard);
  ipcMain.handle('close-window', e => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle('save-reminder', (_, value) => store.update(s => {
    const item = { enabled: true, triggerMode:'clock', repeat: 'daily', type: 'gentle', color: '#7c6df2', sound: 'chime', ...value };
    item.shared=Boolean(item.targetDeviceId&&item.targetDeviceId!==s.network?.deviceId);
    const index = s.reminders.findIndex(x => x.id === item.id);
    if (index >= 0) s.reminders[index] = item; else s.reminders.push({ ...item, id: core.uuid() });
    broadcast(); return true;
  }));
  ipcMain.handle('delete-reminder', (_, id) => store.update(s => { s.reminders = s.reminders.filter(x => x.id !== id); broadcast(); }));
  ipcMain.handle('save-task', (_, value) => store.update(s => {
    const item = { memberId: 'me', kind: 'daily', rewardMinutes: 0, ...value };
    item.shared=Boolean(item.targetDeviceId&&item.targetDeviceId!==s.network?.deviceId);
    const index = s.tasks.findIndex(x => x.id === item.id);
    if (index >= 0) s.tasks[index] = item; else s.tasks.push({ ...item, id: core.uuid() });
    broadcast(); return true;
  }));
  ipcMain.handle('delete-task', (_, id) => store.update(s => { s.tasks = s.tasks.filter(x => x.id !== id); broadcast(); }));
  ipcMain.handle('complete-task', (_, id) => store.update(s => {
    let out=core.completeTask(s,id,'me');
    if(!out.ok){const task=remoteItems('tasks').find(x=>x.id===id);if(task&&!s.completions.some(x=>x.taskId===id&&x.date===core.localDateKey())){const grant=Math.max(0,Number(task.rewardMinutes)||0),completion={id:core.uuid(),taskId:id,memberId:'me',date:core.localDateKey(),completedAt:new Date().toISOString(),rewardMinutes:grant,shared:true,sourceDeviceId:s.network.deviceId};s.completions.push(completion);s.rewardBalanceMinutes=Math.max(0,Number(s.rewardBalanceMinutes)||0)+grant;out={ok:true,completion,duplicate:false};}}
    broadcast();return out;
  }));
  ipcMain.handle('save-settings', (_, value) => store.update(s => {
    if (value.password){s.settings.parentPassword = core.hashPassword(value.password);parentUnlockedUntil=Date.now()+5*60*1000;}
    if(value.startWithWindows!==undefined){app.setLoginItemSettings({openAtLogin:Boolean(value.startWithWindows),path:process.execPath});s.settings.startWithWindows=Boolean(value.startWithWindows);}
    for (const key of ['timeControlEnabled','earliestStartEnabled','earliestStartTime','dailyLimitMinutes','timeMode','shutdownTime','rewardExtendsClock','maxRewardClockExtensionMinutes','rewardCapMinutes','shutdownGraceMinutes','simulateShutdown']) if (value[key] !== undefined) s.settings[key] = value[key];
    broadcast(); return true;
  }));
  ipcMain.handle('ack-reminder', (_, id) => {
    const reminder = store.state.reminders.find(x => x.id === id) || (activeReminder?.id===id?activeReminder:null) || (String(id).includes('-shutdown:') ? { type: 'shutdown' } : null);
    store.update(s => s.events.push({ id: core.uuid(), type: 'reminder-acknowledged', reminderId: id, at: new Date().toISOString() }));
    if (reminder?.type === 'shutdown') startShutdownCountdown(id);
    reminderWindow?.close(); return true;
  });
  ipcMain.handle('cancel-shutdown', (_, password) => cancelShutdown(password));
  ipcMain.handle('save-update-settings',(_,value={})=>store.update(s=>{s.settings.updateRepo=String(value.updateRepo||'').trim();s.settings.autoCheckUpdates=value.autoCheckUpdates!==false;broadcast();return true;}));
  ipcMain.handle('check-update',()=>checkForUpdates());
  ipcMain.handle('open-update-page',()=>updateStatus?.url?shell.openExternal(updateStatus.url):false);
  ipcMain.handle('respond-reward', (_, value={}) => {if(!activeRewardPrompt)return false;const prompt=activeRewardPrompt,amount=Math.min(prompt.maxMinutes,Math.max(0,Math.floor(Number(value.minutes)||0)));if(value.use&&amount>0)store.update(s=>core.spendReward(s,prompt.kind,amount));else startShutdownCountdown(`reward-${prompt.kind}`);if(rewardWindow&&!rewardWindow.isDestroyed()){rewardWindow.setClosable(true);rewardWindow.close();}broadcast();return true;});
  ipcMain.handle('exit-app', (_, password) => {
    if (store.state.settings.parentPassword && !core.verifyPassword(password || '', store.state.settings.parentPassword)) return false;
    app.quit(); return true;
  });
  ipcMain.handle('choose-sound', async () => shell.openPath(path.join(__dirname, 'assets')));
  ipcMain.handle('choose-custom-sound', async () => {
    const result=await dialog.showOpenDialog(dashboard||widget,{title:'選擇提醒音效',properties:['openFile'],filters:[{name:'音效檔',extensions:['mp3','wav','ogg','m4a']}]});
    if(result.canceled||!result.filePaths[0])return null;const file=result.filePaths[0],stat=fs.statSync(file);
    if(stat.size>5*1024*1024)throw new Error('音效檔不可超過 5MB');
    const data=fs.readFileSync(file),assetId=crypto.createHash('sha256').update(data).digest('hex'),ext=path.extname(file).slice(1).toLowerCase(),mime={mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',m4a:'audio/mp4'}[ext]||'application/octet-stream';
    store.state.soundAssets||={};store.state.soundAssets[assetId]={id:assetId,name:path.basename(file),mime,size:stat.size,data:data.toString('base64')};store.save();return{id:assetId,name:path.basename(file),mime,size:stat.size};
  });
  ipcMain.handle('get-sound-asset', (_, assetId) => {const a=store.state.soundAssets?.[assetId];return a?{id:a.id,name:a.name,mime:a.mime,dataUrl:`data:${a.mime};base64,${a.data}`}:null;});
  ipcMain.handle('network-create', (_, value) => network.createFamily(value.familyName,value.deviceName));
  ipcMain.handle('network-join', (_, value) => network.join(value.hostIp,value.code,value.deviceName));
  ipcMain.handle('network-leave', () => network.leave());
  ipcMain.handle('network-sync', async () => {await network.sync();return network.status();});
  ipcMain.handle('network-set-managed', (_, enabled) => network.setManagement(enabled));
  ipcMain.handle('network-refresh-pairing',()=>network.refreshPairingCode());
  ipcMain.handle('managed-settings-update', (_, deviceId, patch) => network.updateManagedSettings(deviceId,patch));
  ipcMain.handle('managed-reminder-toggle', (_, deviceId, reminderId, enabled) => network.toggleManagedReminder(deviceId,reminderId,enabled));
  ipcMain.handle('managed-usage-reset', (_, deviceId) => network.requestUsageReset(deviceId));
  ipcMain.handle('network-set-peer-role', (_, deviceId, role) => network.setPeerRole(deviceId,role));
});
app.on('window-all-closed', e => e.preventDefault?.());
