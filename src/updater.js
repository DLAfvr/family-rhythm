'use strict';
const OFFICIAL_REPO='DLAfvr/family-rhythm';
const RELEASE_PREFIX=`https://github.com/${OFFICIAL_REPO}/releases/download/`;
function versionParts(v){return String(v||'0').replace(/^v/i,'').split('.').map(x=>Number.parseInt(x,10)||0);}
function newerVersion(a,b){const aa=versionParts(a),bb=versionParts(b);for(let i=0;i<Math.max(aa.length,bb.length);i++){if((aa[i]||0)!==(bb[i]||0))return(aa[i]||0)>(bb[i]||0);}return false;}
function selectSetupAsset(release,currentVersion){const latest=String(release?.tag_name||'').replace(/^v/i,'');if(!/^\d+\.\d+\.\d+$/.test(latest)||!newerVersion(latest,currentVersion))return null;const expected=`Family-Rhythm-Setup-${latest}.exe`,asset=(release.assets||[]).find(x=>x.name===expected);if(!asset||!String(asset.browser_download_url||'').startsWith(RELEASE_PREFIX)||!/^sha256:[a-f0-9]{64}$/i.test(asset.digest||''))return null;return{latestVersion:latest,name:asset.name,size:Number(asset.size)||0,digest:String(asset.digest).toLowerCase(),downloadUrl:asset.browser_download_url,releaseUrl:release.html_url};}
module.exports={OFFICIAL_REPO,RELEASE_PREFIX,versionParts,newerVersion,selectSetupAsset};
