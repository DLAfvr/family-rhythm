'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {newerVersion,selectSetupAsset}=require('../src/updater');
test('semantic versions are compared numerically',()=>{assert.equal(newerVersion('0.10.0','0.9.9'),true);assert.equal(newerVersion('0.8.0','0.8.0'),false);});
test('only an exact official setup asset with SHA-256 is accepted',()=>{const release={tag_name:'v0.8.1',html_url:'https://github.com/DLAfvr/family-rhythm/releases/tag/v0.8.1',assets:[{name:'Family-Rhythm-Setup-0.8.1.exe',size:100,digest:`sha256:${'a'.repeat(64)}`,browser_download_url:'https://github.com/DLAfvr/family-rhythm/releases/download/v0.8.1/Family-Rhythm-Setup-0.8.1.exe'}]};assert.equal(selectSetupAsset(release,'0.8.0').latestVersion,'0.8.1');assert.equal(selectSetupAsset({...release,assets:[{...release.assets[0],browser_download_url:'https://evil.example/update.exe'}]},'0.8.0'),null);assert.equal(selectSetupAsset({...release,assets:[{...release.assets[0],digest:null}]},'0.8.0'),null);});
