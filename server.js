const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const dns = require('dns').promises;
const net = require('net');
const {URL} = require('url');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const LEGACY_DATA = path.join(ROOT, 'data');
// Static images/icons are bundled in one manifest to keep deployment ZIPs tidy.
let BUNDLED_ASSET_MANIFEST = null;
function bundledAssetRecord(assetPath){
  const key='/' + String(assetPath||'').replace(/^\/+/, '');
  if(!BUNDLED_ASSET_MANIFEST){try{BUNDLED_ASSET_MANIFEST=JSON.parse(fs.readFileSync(path.join(ROOT,'bundled-assets.json'),'utf8'))}catch(_){BUNDLED_ASSET_MANIFEST={}}}
  const row=BUNDLED_ASSET_MANIFEST[key];if(!row||typeof row.base64!=='string')return null;
  try{return {buffer:Buffer.from(row.base64,'base64'),contentType:String(row.contentType||'application/octet-stream')}}catch(_){return null}
}
function readStaticAssetBuffer(assetPath){
  const full=path.resolve(ROOT,'.'+String(assetPath||''));const rel=path.relative(ROOT,full);
  if(rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel)&&fs.existsSync(full))return fs.readFileSync(full);
  const row=bundledAssetRecord(assetPath);return row?.buffer||null;
}
// Prefer a Railway Volume or explicit persistent directory; only fall back to release-local data.
const DATA = path.resolve(process.env.SADA_DATA_DIR || process.env.DATA_DIR || (process.env.RAILWAY_VOLUME_MOUNT_PATH ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'sada-data') : LEGACY_DATA));
const DATA_IS_EXTERNAL = path.resolve(DATA) !== path.resolve(LEGACY_DATA);
// This release intentionally retains no service/section catalog snapshots. Purge those
// legacy files on startup and after verified deletes so stale catalog rows cannot be restored.
function purgeCatalogServiceSnapshots(){
  const dir=path.join(DATA,'catalog-backups');
  const ownedNames=/^(?:catalog-delete-all|catalog-service-delete|section-delete|firebase-services)-.*\.json$/i;
  let removed=0;
  try{
    if(!fs.existsSync(dir))return 0;
    for(const name of fs.readdirSync(dir)){
      if(!ownedNames.test(name))continue;
      try{fs.rmSync(path.join(dir,name),{force:true});removed++;}catch(e){console.error('Catalog snapshot cleanup failed:',name,String(e.message||e));}
    }
    if(!fs.readdirSync(dir).length){try{fs.rmdirSync(dir)}catch(_){}}
  }catch(e){console.error('Catalog snapshot cleanup unavailable:',String(e.message||e));}
  return removed;
}
purgeCatalogServiceSnapshots();
const APP_NAME = 'صدى العراق';
const APP_VERSION = '1.6.88';
const BUILD_ID = 'SADA-1.6.88-SPEED-LAZY-SERVICE-LIST-20261020';
// Keep the owner's admin identity available after packaging, but store only a scrypt hash
// in the project. Railway variables can still explicitly override this packaged credential.
function loadBundledAdminAuth(){
  try{
    const value=JSON.parse(fs.readFileSync(path.join(ROOT,'admin-auth.json'),'utf8'));
    const email=String(value?.email||'').trim().toLowerCase();
    const passwordHash=String(value?.passwordHash||'').trim();
    if(email&&passwordHash.startsWith('scrypt$'))return {email,passwordHash};
  }catch(_){}
  return {};
}
const BUNDLED_ADMIN_AUTH = loadBundledAdminAuth();
// Restore the original project-owner account as the default authority.
// Environment credentials are only used when no valid bundled owner record exists.
const ADMIN_USER = BUNDLED_ADMIN_AUTH.email || process.env.ADMIN_EMAIL || 'hsydgyg5@gmail.com';
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const FIXED_RECEIVER = process.env.ASIACELL_RECEIVER || '07763308188';
const FIXED_RATE = 1250; // 1 USD = 1,250 IQD
// v1.5.40: signed stateless sessions survive Railway restarts/instance changes.
const sessions = new Map(); // legacy sessions kept only during rolling deployments
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
let SESSION_SECRET_SOURCE='unknown';
function stableSessionSecretFromEnvironment(){
  const rawJson=String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON||process.env.GOOGLE_SERVICE_ACCOUNT_JSON||'').trim();
  const rawBase64=String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64||'').trim();
  let account=null;
  try{if(rawJson)account=JSON.parse(rawJson);else if(rawBase64)account=JSON.parse(Buffer.from(rawBase64,'base64').toString('utf8'));}catch(_){}
  if(account&&account.client_email&&account.private_key){
    const material=[String(account.project_id||''),String(account.client_email),String(account.private_key)].join('|');
    return crypto.createHash('sha512').update('SadaIraq|session-signing|v1|'+material).digest('base64url');
  }
  const stable=String(process.env.FIREBASE_DATABASE_SECRET||process.env.ADMIN_PASSWORD_HASH||'').trim();
  if(stable.length>=32)return crypto.createHash('sha512').update('SadaIraq|session-signing|v1|'+stable).digest('base64url');
  return '';
}
function loadSessionSecret(){
  const configured=String(process.env.SESSION_SECRET||'').trim();
  if(configured.length>=32){SESSION_SECRET_SOURCE='environment';return configured;}
  const file=path.join(DATA,'.sada-session-secret');
  // Reuse an existing persistent secret first so a mounted-volume deployment does not
  // invalidate already issued sessions just because the code version changes.
  try{fs.mkdirSync(DATA,{recursive:true});const existing=String(fs.readFileSync(file,'utf8')||'').trim();if(existing.length>=32){SESSION_SECRET_SOURCE='persistent-file';return existing;}}catch(_){}
  const stable=stableSessionSecretFromEnvironment();
  if(stable){SESSION_SECRET_SOURCE='firebase-service-credential';return stable;}
  try{const generated=crypto.randomBytes(48).toString('base64url');fs.mkdirSync(DATA,{recursive:true});fs.writeFileSync(file,generated,{encoding:'utf8',flag:'wx',mode:0o600});SESSION_SECRET_SOURCE='created-file';return generated;}catch(e){try{const existing=String(fs.readFileSync(file,'utf8')||'').trim();if(existing.length>=32){SESSION_SECRET_SOURCE='persistent-file';return existing;}}catch(_){}SESSION_SECRET_SOURCE='ephemeral';console.warn('SECURITY WARNING: session secret is ephemeral because it could not be saved persistently.');return crypto.randomBytes(48).toString('base64url');}
}
const SESSION_SECRET = loadSessionSecret();
const SESSION_COOKIE = 'sadairaq_sid';
const SESSION_TOKEN_HEADER = 'x-sada-session';
const RATE_BUCKETS = new Map();
// AsiaCell OTP state must persist across separate stateless-cookie API requests.
// Keep access tokens server-side, keyed by a hash of the site's session token; never put them in the cookie.
const ASIACELL_SESSIONS = new Map();
const ASIACELL_SESSION_TTL_MS = 5 * 60 * 1000;
const ASIACELL_CRITICAL_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const isAsiacellSafetyCritical = value => ['starting_transfer','confirming_transfer','provider_confirmed','resending_transfer_code','resend_uncertain'].includes(String(value?.step||''));
const ASIACELL_RESEND_COOLDOWN_MS = process.env.NODE_ENV === 'test' ? Math.max(10, Number(process.env.ASIACELL_RESEND_COOLDOWN_MS || 45_000)) : 45_000;
const ASIACELL_MAX_RESEND_ATTEMPTS = 3;
const API_KEY_UNUSED_TTL_MS = 24 * 60 * 60 * 1000;
const ASIACELL_SESSION_NODE = 'asiacellSessions';
const ASIACELL_OPERATION_LOCK_NODE = 'asiacellOperationLocks';
const ASIACELL_PENDING_USER_NODE = 'asiacellPendingByUser';
function asiacellPendingUserPath(username){return ASIACELL_PENDING_USER_NODE+'/'+sha256(String(username||'').trim().toLowerCase());}
async function writeAsiacellPendingPointer(username,stateKey,value){
  if(!String(username||'').trim()||!stateKey||!isAsiacellSafetyCritical(value))return true;
  if(!FIREBASE_DATABASE_URL||!firebaseServiceAccountConfigured())return false;
  const pointer={stateKey:String(stateKey),step:String(value.step||''),updatedAt:Number(value.updatedAt||Date.now()),expiresAt:Date.now()+ASIACELL_CRITICAL_STATE_TTL_MS};
  try{await firebaseWriteJson(asiacellPendingUserPath(username),pointer,4000);const check=await firebaseGetJson(asiacellPendingUserPath(username),4000);return !!check&&check.stateKey===pointer.stateKey&&check.step===pointer.step;}catch(_){return false;}
}
async function clearAsiacellPendingPointer(username,stateKey){
  if(!String(username||'').trim()||!stateKey||!FIREBASE_DATABASE_URL||!firebaseServiceAccountConfigured())return;
  try{const p=await firebaseGetJson(asiacellPendingUserPath(username),2500);if(p&&String(p.stateKey||'')===String(stateKey))await firebaseDeleteJson(asiacellPendingUserPath(username),2500);}catch(_){}
}
async function findPendingAsiacellSession(username){
  if(!String(username||'').trim()||!FIREBASE_DATABASE_URL||!firebaseServiceAccountConfigured())return null;
  const pointerPath=asiacellPendingUserPath(username);let pointer=null;
  try{pointer=await firebaseGetJson(pointerPath,3000);}catch(_){return null;}
  if(!pointer||!pointer.stateKey)return null;
  try{
    const stored=await firebaseGetJson(ASIACELL_SESSION_NODE+'/'+String(pointer.stateKey),3000);
    if(!stored||!stored.encrypted||Number(stored.expiresAt||0)<=Date.now())throw new Error('expired');
    const plain=decryptSecret(stored.encrypted),state=plain?JSON.parse(plain):null;
    if(!state||String(state.owner||'').toLowerCase()!==String(username).toLowerCase()||!isAsiacellSafetyCritical(state))throw new Error('stale pointer');
    return {stateKey:String(pointer.stateKey),state};
  }catch(_){await clearAsiacellPendingPointer(username,String(pointer.stateKey));return null;}
}
setInterval(()=>{const now=Date.now();for(const [k,v] of ASIACELL_SESSIONS){if(!isAsiacellSafetyCritical(v)&&now-Number(v.updatedAt||v.createdAt||0)>ASIACELL_SESSION_TTL_MS)ASIACELL_SESSIONS.delete(k);}if(ASIACELL_SESSIONS.size>5000){for(const [k,v] of ASIACELL_SESSIONS){if(!isAsiacellSafetyCritical(v)&&now-Number(v.updatedAt||v.createdAt||0)>ASIACELL_SESSION_TTL_MS)ASIACELL_SESSIONS.delete(k);}}},60_000).unref();
// OTP and transfer bearer tokens are encrypted before being saved to Firebase so a Railway
// restart or instance switch does not silently destroy an in-progress AsiaCell checkout.
// The Firebase key is only a SHA-256 of the signed site session; no session token is stored as a path.
async function loadAsiacellSession(stateKey){
  let local=ASIACELL_SESSIONS.get(stateKey)||null,remoteReadSucceeded=false,stored=null;
  try{stored=await firebaseGetJson(ASIACELL_SESSION_NODE+'/'+stateKey,3500);remoteReadSucceeded=true;}catch(_){}
  if(remoteReadSucceeded){
    // A successful Firebase read that returns null is authoritative. Never resurrect a locally cached
    // OTP session after logout/reset deleted it on another Railway instance.
    if(!stored){ASIACELL_SESSIONS.delete(stateKey);return null;}
    if(typeof stored.encrypted==='string'&&stored.encrypted){
      const plain=decryptSecret(stored.encrypted);let remote=null;try{remote=plain?JSON.parse(plain):null}catch(_){}
      const remoteAge=Date.now()-Number(remote?.updatedAt||remote?.createdAt||0),remoteCritical=isAsiacellSafetyCritical(remote);
      if(remote&&typeof remote==='object'&&Number(stored.expiresAt||0)>Date.now()&&(remoteCritical||remoteAge<=ASIACELL_SESSION_TTL_MS)){
        // Firebase is authoritative; don't prefer a newer local copy over the persisted transaction state.
        ASIACELL_SESSIONS.set(stateKey,remote);return remote;
      }
      ASIACELL_SESSIONS.delete(stateKey);
      if(Number(stored.expiresAt||0)<=Date.now())firebaseDeleteJson(ASIACELL_SESSION_NODE+'/'+stateKey,2500).catch(()=>{});
      return null;
    }
    ASIACELL_SESSIONS.delete(stateKey);return null;
  }
  // Allow a short-lived local fallback only when Firebase itself could not be reached, not when it
  // explicitly says the session was deleted or expired.
  if(local&&(isAsiacellSafetyCritical(local)||Date.now()-Number(local.updatedAt||local.createdAt||0)<=ASIACELL_SESSION_TTL_MS))return local;
  ASIACELL_SESSIONS.delete(stateKey);return null;
}
async function saveAsiacellSession(stateKey,value){
  if(!value||typeof value!=='object')return false;
  value.updatedAt=Date.now();ASIACELL_SESSIONS.set(stateKey,value);
  if(!FIREBASE_DATABASE_URL||!firebaseServiceAccountConfigured()||!telegramEncryptionReady())return false;
  try{
    const expiresAt=Date.now()+(isAsiacellSafetyCritical(value)?ASIACELL_CRITICAL_STATE_TTL_MS:ASIACELL_SESSION_TTL_MS);
    const encrypted=encryptSecret(JSON.stringify(value));
    await firebaseWriteJson(ASIACELL_SESSION_NODE+'/'+stateKey,{version:1,expiresAt,updatedAt:value.updatedAt,encrypted},5000);
    const check=await firebaseGetJson(ASIACELL_SESSION_NODE+'/'+stateKey,5000);
    if(!check||check.encrypted!==encrypted||Number(check.expiresAt)!==expiresAt)throw new Error('encrypted session read-back did not match');
    if(isAsiacellSafetyCritical(value)){
      if(!await writeAsiacellPendingPointer(value.owner,stateKey,value))throw new Error('pending transfer pointer could not be verified');
    }else{
      // Best-effort cleanup; status checks validate the referenced encrypted state before trusting a pointer.
      await clearAsiacellPendingPointer(value.owner,stateKey);
    }
    return true;
  }catch(e){console.warn('AsiaCell encrypted-session persistence failed:',String(e.message||e).slice(0,120));return false;}
}
async function deleteAsiacellSession(stateKey){
  let owner=ASIACELL_SESSIONS.get(stateKey)?.owner||'';
  if(!owner&&FIREBASE_DATABASE_URL&&firebaseServiceAccountConfigured()){
    try{const stored=await firebaseGetJson(ASIACELL_SESSION_NODE+'/'+stateKey,2500);const plain=stored?.encrypted?decryptSecret(stored.encrypted):null;owner=plain?String(JSON.parse(plain)?.owner||''):'';}catch(_){}
  }
  ASIACELL_SESSIONS.delete(stateKey);
  if(!FIREBASE_DATABASE_URL||!firebaseServiceAccountConfigured())return true;
  try{await firebaseDeleteJson(ASIACELL_SESSION_NODE+'/'+stateKey,3500);const verify=await firebaseGetJson(ASIACELL_SESSION_NODE+'/'+stateKey,3500);if(verify==null){if(owner)await clearAsiacellPendingPointer(owner,stateKey);return true;}return false;}catch(_){return false;}
}
// Distributed lease per session + action around money-moving AsiaCell operations. This is an RTDB compare-and-swap,
// so two Railway instances cannot duplicate one action, while the next valid checkout step is not blocked.
async function acquireAsiacellOperationLock(stateKey,action){
  if(!FIREBASE_DATABASE_URL||!firebaseServiceAccountConfigured())return null;
  const lockId=sha256(String(stateKey)+'|'+String(action||''));const lockPath=ASIACELL_OPERATION_LOCK_NODE+'/'+lockId,owner=crypto.randomUUID(),started=Date.now();
  const tx=await firebaseTransaction(lockPath,current=>{
    if(current&&Number(current.expiresAt||0)>Date.now())return {write:false,result:{acquired:false,expiresAt:Number(current.expiresAt||0)}};
    const value={owner,action:String(action||''),createdAt:Date.now(),expiresAt:Date.now()+120000};
    return {write:true,value,result:{acquired:true,expiresAt:value.expiresAt}};
  },6000,8);
  return tx.result?.acquired?{path:lockPath,owner,action,started}:null;
}
async function releaseAsiacellOperationLock(lock){
  if(!lock?.path||!lock.owner)return;
  try{await firebaseTransaction(lock.path,current=>current&&current.owner===lock.owner?{write:true,value:null,result:{released:true}}:{write:false,result:{released:false}},4000,4)}catch(_){/* The lease expires automatically; never retry a money-moving provider call here. */}
}
const RATE_RULES = { auth:{window:60_000,max:12}, captcha:{window:60_000,max:30}, email:{window:10*60_000,max:5}, registerEmail:{window:10*60_000,max:10}, provider:{window:60_000,max:20}, order:{window:60_000,max:20}, api:{window:60_000,max:60}, general:{window:60_000,max:60} };
// SECURITY (1.6.29-p1): the left-most X-Forwarded-For value is chosen by the caller and let attackers reset every
// rate limit (login, register, API) by changing it. Railway's proxy appends the real client IP on the right, so
// use the TRUSTED_PROXY_HOPS-th value from the right (default 1). TRUSTED_PROXY_HOPS=0 restores the legacy behaviour.
function clientIp(req){
  const raw=process.env.TRUSTED_PROXY_HOPS;const hops=raw===undefined||String(raw).trim()===''?1:Math.max(0,Math.floor(Number(raw))||0);
  const xff=String(req.headers['x-forwarded-for']||'').split(',').map(x=>x.trim()).filter(Boolean);
  if(xff.length){return hops===0?xff[0]:xff[Math.max(0,xff.length-hops)];}
  return String(req.socket.remoteAddress||'unknown');
}
function rateLimit(req,bucket='general'){ const r=RATE_RULES[bucket]||RATE_RULES.general; const key=clientIp(req)+'|'+bucket; const now=Date.now(); let x=RATE_BUCKETS.get(key); if(!x||now-x.started>r.window)x={started:now,count:0}; x.count++; RATE_BUCKETS.set(key,x); if(x.count>r.max){ return Math.ceil((x.started+r.window-now)/1000); } return 0; }
setInterval(()=>{ const now=Date.now(); for(const [k,v] of RATE_BUCKETS) if(now-v.started>120_000) RATE_BUCKETS.delete(k); for(const [k,v] of sessions) if(now-(v.createdAt||0)>SESSION_TTL_MS) sessions.delete(k); }, 120_000).unref();


function ensureTelegramDefaults(){
  const cfg=readJSON('settings.json',{});
  const tg=cfg.telegram&&typeof cfg.telegram==='object'?{...cfg.telegram}:{};
  if(tg.enabled===undefined) tg.enabled=true;
  // Never silently fall back to an unrelated default Telegram destination.
  // A destination must be configured explicitly in Railway or the admin panel.
  if(!tg.chat) tg.chat=String(process.env.TELEGRAM_CHAT_ID||'').trim();
  if(tg.chat||cfg.telegram) { cfg.telegram=tg; writeJSON('settings.json',cfg); }
}

function ensureData() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, {recursive:true});
  // On the first boot with a persistent directory, safely migrate any existing JSON data.
  if(DATA_IS_EXTERNAL && fs.existsSync(LEGACY_DATA)){
    try{for(const file of fs.readdirSync(LEGACY_DATA)){if(!file.endsWith('.json'))continue;const from=path.join(LEGACY_DATA,file),to=path.join(DATA,file);if(!fs.existsSync(to)&&fs.statSync(from).isFile())fs.copyFileSync(from,to);}}catch(e){console.warn('Data migration to persistent directory failed:',e.message)}
  }
  const defaults={
    'users.json':{users:{}},
    'google_accounts.json':{},
    'telegram_order_state.json':{initialized:false,seen:{}},
    'orders.json':[],
    'provider_failures.json':[],
    'payments.json':[],
    'notifications.json':[],
    'telegram_notifications.json':[],
    'notification_seen.json':{},
    'user_notifications.json':{},
    'earn_requests.json':[],
    'providers.json':{activeProvider:'',providers:{},deletedProviderIds:[]},
    // Provider state is stored separately so code updates do not overwrite it.
    'providers.runtime.json':{activeProvider:'',providers:{},deletedProviderIds:[]},
    'settings.json':{},
    'api_services.json':[],
    'api_refills.json':[],
    'services.json':{},
    'free_services.json':{},
    'manual_services.json':{},
    'free_service_usage.json':{},
    'category_meta.json':{},
    'provider_services.json':{},
    'catalog_settings.json':{},
    'balance_ledger.json':[],
    'refunds.json':[],
    'api_keys.json':{},
    'stats_state.json':{resetAt:null},
    'order_audit_state.json':{alerts:{}},
    'email_challenges.json':{}
  };
  for(const [file,def] of Object.entries(defaults)){
    const full=path.join(DATA,file);
    let cur=null, ok=true;
    try{cur=JSON.parse(fs.readFileSync(full,'utf8'));}catch(_){ok=false;}
    if(file==='users.json') ok=!!(cur&&typeof cur==='object'&&cur.users&&typeof cur.users==='object'&&!Array.isArray(cur.users));
    else if(file==='orders.json'||file==='provider_failures.json'||file==='payments.json'||file==='notifications.json'||file==='telegram_notifications.json'||file==='api_refills.json') ok=Array.isArray(cur);
    else if(file==='notification_seen.json'||file==='user_notifications.json') ok=!!(cur&&typeof cur==='object'&&!Array.isArray(cur));
    else if(file==='providers.json') ok=!!(cur&&typeof cur==='object'&&cur.providers&&typeof cur.providers==='object'&&!Array.isArray(cur.providers));
    else if(file==='settings.json'||file==='api_keys.json'||file==='stats_state.json'||file==='order_audit_state.json'||file==='google_accounts.json'||file==='telegram_order_state.json'||file==='email_challenges.json'||file==='services.json'||file==='free_services.json'||file==='manual_services.json'||file==='free_service_usage.json'||file==='category_meta.json'||file==='provider_services.json'||file==='catalog_settings.json') ok=!!(cur&&typeof cur==='object'&&!Array.isArray(cur));
    else if(file==='api_services.json'||file==='balance_ledger.json'||file==='refunds.json'||file==='earn_requests.json') ok=Array.isArray(cur);
    if(!ok){
      // Never silently discard unreadable legacy data: retain a byte-for-byte recovery copy first.
      if(fs.existsSync(full)){try{const stamp=new Date().toISOString().replace(/[:.]/g,'-');const backup=full+'.corrupt-'+stamp+'.bak';fs.copyFileSync(full,backup);console.error('Invalid JSON preserved for recovery:',path.basename(full),'backup:',path.basename(backup));}catch(e){console.error('Could not back up invalid data file:',path.basename(full),String(e.message||e));throw e;}}
      fs.writeFileSync(full,JSON.stringify(def,null,2),'utf8');
    }
  }
}
let SITE_SERVICE_IDS_DIRTY = true;
let SITE_SERVICE_IDS_CACHE = {count:0,changed:false,ids:0};
let ADMIN_FREE_SERVICES_READY = false;
let ADMIN_FREE_SERVICES_SYNC_AT = 0;
let ADMIN_FREE_SERVICES_SYNC_IN_FLIGHT = null;
const ADMIN_FREE_SERVICES_SYNC_TTL_MS = 12000;
const SITE_SERVICE_ID_FILES = new Set(['services.json','free_services.json','manual_services.json']);
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA,file), 'utf8')); }
  catch (_) { return fallback; }
}
function writeJSON(file, value) {
  ensureData();
  const target = path.join(DATA,file);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value,null,2), 'utf8');
  fs.renameSync(tmp, target);
  if(SITE_SERVICE_ID_FILES.has(String(file)))SITE_SERVICE_IDS_DIRTY=true;
}
// Use only for updates that cannot add/remove service rows or change their ID fields (prices/status telemetry).
// Unlike writeJSON, this preserves the current service-ID allocation dirty flag.
function writeCatalogNonStructuralJSON(file, value) {
  if(!SITE_SERVICE_ID_FILES.has(String(file)))throw new Error('writeCatalogNonStructuralJSON only supports service-ID catalog files');
  ensureData();
  const target=path.join(DATA,file),tmp=target+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(value,null,2),'utf8');
  fs.renameSync(tmp,target);
}

// The service catalog and its display metadata live in small host JSON files.
// Users, balances/recharges, chats and real orders continue to use their existing server/Firebase paths.
const LOCAL_CATALOG_BUCKETS = Object.freeze({services:'services.json',categoryMeta:'category_meta.json',providerServices:'provider_services.json'});
const CATALOG_FORBIDDEN_KEYS = new Set(['__proto__','prototype','constructor']);
let CATALOG_SEED_IN_FLIGHT = null, CATALOG_SEED_LAST_AT = 0;
let CATALOG_FIREBASE_READY = false, CATALOG_FIREBASE_READY_IN_FLIGHT = null;
function catalogPathSpec(rawPath){
  const parts=String(rawPath||'').split('/').filter(Boolean).map(x=>String(x));
  if(!parts.length) return null;
  if(CATALOG_FORBIDDEN_KEYS.has(parts[0])||parts.some(x=>CATALOG_FORBIDDEN_KEYS.has(x))) return null;
  if(Object.prototype.hasOwnProperty.call(LOCAL_CATALOG_BUCKETS,parts[0])) return {file:LOCAL_CATALOG_BUCKETS[parts[0]],parts:parts.slice(1),bucket:parts[0]};
  if(parts[0]==='settings'&&['catalogOrder','svcsVersion'].includes(parts[1])) return {file:'catalog_settings.json',parts:parts.slice(1),bucket:'settings'};
  return null;
}
function catalogReadPath(rawPath){
  const spec=catalogPathSpec(rawPath);if(!spec)return {ok:false,error:'مسار الكتالوج غير مسموح'};
  const root=readJSON(spec.file,{});let value=root;
  for(const part of spec.parts){if(!value||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,part)){value=null;break;}value=value[part];}
  return {ok:true,value:value===undefined?null:value};
}
function normalizeCatalogLabel(value){return String(value??'').trim().toLocaleLowerCase('ar');}
function normalizeCatalogKey(value){return String(value??'').trim().toLowerCase().replace(/[^a-zA-Z0-9\u0600-\u06ff_-]+/g,'_').slice(0,90)||('cat_'+Date.now());}
function catalogRowGroups(row){
  const out=[],seen=new Set();const add=value=>{const name=String(value??'').trim(),key=normalizeCatalogLabel(name);if(name&&key&&!seen.has(key)){seen.add(key);out.push(name)}};
  if(Array.isArray(row?.groups))row.groups.forEach(add);if(Array.isArray(row?.categories))row.categories.forEach(add);add(row?.category);return out;
}
function canonicalCatalogOrder(orderValue,metaRoot=readJSON('category_meta.json',{})){
  const order=orderValue&&typeof orderValue==='object'&&!Array.isArray(orderValue)?{...orderValue}:{};
  const existing=Array.isArray(order.categories)?order.categories.map(x=>String(x??'').trim()).filter(Boolean):[];
  const byKey=new Map();for(const name of existing)if(!byKey.has(normalizeCatalogLabel(name)))byKey.set(normalizeCatalogLabel(name),name);
  const pinned=[];for(const [key,value] of Object.entries(metaRoot&&typeof metaRoot==='object'&&!Array.isArray(metaRoot)?metaRoot:{})){const name=String(value?.name||key).trim();if(name&&value?.pinned===true&&String(value?.pinScope||'all')!=='platform'&&!pinned.some(x=>normalizeCatalogLabel(x)===normalizeCatalogLabel(name)))pinned.push(name);}
  const pinKeys=new Set(pinned.map(normalizeCatalogLabel));const seen=new Set();const names=[];
  for(const name of [...pinned,...existing]){const k=normalizeCatalogLabel(name);if(!k||seen.has(k))continue;seen.add(k);names.push(name)}
  names.sort((a,b)=>{const ap=pinKeys.has(normalizeCatalogLabel(a)),bp=pinKeys.has(normalizeCatalogLabel(b));if(ap!==bp)return ap?-1:1;const ai=existing.findIndex(x=>normalizeCatalogLabel(x)===normalizeCatalogLabel(a)),bi=existing.findIndex(x=>normalizeCatalogLabel(x)===normalizeCatalogLabel(b));if(ai>=0&&bi>=0)return ai-bi;if(ai>=0)return -1;if(bi>=0)return 1;return String(a).localeCompare(String(b),'ar')});
  order.categories=names;
  order.services=order.services&&typeof order.services==='object'&&!Array.isArray(order.services)?{...order.services}:{};
  return order;
}
function syncCatalogServiceOrderChanges(changes){
  if(!Array.isArray(changes)||!changes.length)return false;
  const settings=readJSON('catalog_settings.json',{}),oldOrder=settings.catalogOrder&&typeof settings.catalogOrder==='object'?settings.catalogOrder:{categories:[],services:{}};
  let order={...oldOrder,categories:Array.isArray(oldOrder.categories)?oldOrder.categories.slice():[],services:oldOrder.services&&typeof oldOrder.services==='object'&&!Array.isArray(oldOrder.services)?{...oldOrder.services}:{}};let changed=false;
  const prepend=(bucket,key)=>{const id=String(key||'').trim();if(!id)return;const before=Array.isArray(order.services[bucket])?order.services[bucket].map(String):[];const next=[id,...before.filter(x=>x!==id)];if(JSON.stringify(before)!==JSON.stringify(next)){order.services[bucket]=next;changed=true;}};
  const remove=(key)=>{const id=String(key||'');for(const [bucket,raw] of Object.entries(order.services)){if(!Array.isArray(raw))continue;const next=raw.map(String).filter(x=>x!==id);if(next.length!==raw.length){order.services[bucket]=next;changed=true;}}};
  const addCategory=(name)=>{const label=String(name||'').trim();if(!label)return;if(!order.categories.some(x=>normalizeCatalogLabel(x)===normalizeCatalogLabel(label))){order.categories.push(label);changed=true;}};
  for(const entry of changes){const key=String(entry?.key||'').trim();if(!key)continue;const before=entry.oldRow&&typeof entry.oldRow==='object'?entry.oldRow:null;const after=entry.newRow&&typeof entry.newRow==='object'?entry.newRow:null;
    if(!after){if(before)remove(key);continue;}
    const oldGroups=before?catalogRowGroups(before):[],nextGroups=catalogRowGroups(after),oldKeys=new Set(oldGroups.map(normalizeCatalogLabel));
    const groupsToPromote=before?nextGroups.filter(name=>!oldKeys.has(normalizeCatalogLabel(name))):nextGroups;
    for(const name of nextGroups)addCategory(name);
    for(const name of groupsToPromote)prepend(normalizeCatalogKey(name),key);
    const wasAll=before&&(before.showInAll===true||before.scope==='all'||(!catalogRowGroups(before).length));
    const isAll=after.showInAll===true||after.scope==='all'||(!nextGroups.length);
    if(!before||groupsToPromote.length||(!wasAll&&isAll))prepend('__all__',key);
  }
  const nextOrder=canonicalCatalogOrder(order,readJSON('category_meta.json',{}));
  if(JSON.stringify(nextOrder)!==JSON.stringify(settings.catalogOrder||{}))changed=true;
  if(changed){settings.catalogOrder=nextOrder;writeJSON('catalog_settings.json',settings);}
  return changed;
}
function catalogMutatePath(rawPath,mode,value,options={}){
  const spec=catalogPathSpec(rawPath);if(!spec)return {ok:false,error:'مسار الكتالوج غير مسموح'};
  const serviceBefore=spec.bucket==='services'?readJSON('services.json',{}):null;
  const beforeRows=[];
  if(spec.bucket==='services'){
    if(spec.parts.length===1){const key=spec.parts[0];beforeRows.push({key,oldRow:serviceBefore?.[key]||null});}
    else if(spec.parts.length===0&&mode!=='update'){for(const [key,row] of Object.entries(serviceBefore&&typeof serviceBefore==='object'?serviceBefore:{}))beforeRows.push({key,oldRow:row||null});}
  }
  if(!spec.parts.length){
    if(mode==='set'){if(!value||typeof value!=='object'||Array.isArray(value))return {ok:false,error:'قيمة الكتالوج يجب أن تكون كائناً'};writeJSON(spec.file,value);}
    else if(mode==='update'){const old=readJSON(spec.file,{});if(!value||typeof value!=='object'||Array.isArray(value))return {ok:false,error:'تحديث الكتالوج غير صالح'};writeJSON(spec.file,{...old,...value});}
    else if(mode==='remove')writeJSON(spec.file,{});
    else return {ok:false,error:'نوع تعديل غير مدعوم'};
    if(spec.bucket==='services'){ensureNumericSiteServiceIds();markCatalogSeeded();if(!options.skipServiceOrdering){const after=readJSON('services.json',{}),changes=beforeRows.map(x=>({key:x.key,oldRow:x.oldRow,newRow:after?.[x.key]||null}));for(const [key,row] of Object.entries(after&&typeof after==='object'?after:{}))if(!beforeRows.some(x=>x.key===key))changes.push({key,oldRow:null,newRow:row});syncCatalogServiceOrderChanges(changes);}}
    if(spec.bucket==='settings'&&spec.parts.length===0){const settings=readJSON('catalog_settings.json',{});if(settings.catalogOrder){settings.catalogOrder=canonicalCatalogOrder(settings.catalogOrder);writeJSON('catalog_settings.json',settings);}}
    return {ok:true};
  }
  const root=readJSON(spec.file,{});let parent=root;
  for(let i=0;i<spec.parts.length-1;i++){const part=spec.parts[i];if(!parent[part]||typeof parent[part]!=='object'||Array.isArray(parent[part]))parent[part]={};parent=parent[part];}
  const key=spec.parts[spec.parts.length-1];
  if(mode==='set')parent[key]=value;
  else if(mode==='update'){
    if(!value||typeof value!=='object'||Array.isArray(value))return {ok:false,error:'تحديث الكتالوج غير صالح'};
    const cur=parent[key];parent[key]={...(cur&&typeof cur==='object'&&!Array.isArray(cur)?cur:{}),...value};
  }else if(mode==='remove')delete parent[key];
  else return {ok:false,error:'نوع تعديل غير مدعوم'};
  if(spec.bucket==='settings'&&spec.parts[0]==='catalogOrder')root.catalogOrder=canonicalCatalogOrder(root.catalogOrder,readJSON('category_meta.json',{}));
  writeJSON(spec.file,root);
  if(spec.bucket==='services'){ensureNumericSiteServiceIds();markCatalogSeeded();if(!options.skipServiceOrdering){if(spec.parts.length===1){const after=readJSON('services.json',{});syncCatalogServiceOrderChanges([{key,oldRow:beforeRows[0]?.oldRow||null,newRow:after?.[key]||null}]);}else if(spec.parts.length===0){const after=readJSON('services.json',{});syncCatalogServiceOrderChanges(beforeRows.map(x=>({key:x.key,oldRow:x.oldRow,newRow:after?.[x.key]||null})));}}}
  return {ok:true};
}
function markCatalogSeeded(){const c=readJSON('catalog_settings.json',{});c.legacySeedAttempted=true;c.legacySeedAt=nowISO();writeJSON('catalog_settings.json',c);}
const SITE_SERVICE_ID_MIN = 1000;
const SITE_SERVICE_ID_MAX = 9999;
function currentSiteServiceId(row){
  return String(row?.siteServiceId||row?.internalServiceId||row?.sadaServiceId||'').trim();
}
function serviceRowMatchesSiteId(row,id){
  const needle=String(id??'').trim();if(!needle||!row||typeof row!=='object')return false;
  return [row.siteServiceId,row.internalServiceId,row.sadaServiceId,row.catalogId,
    ...(Array.isArray(row.legacySiteServiceIds)?row.legacySiteServiceIds:[])]
    .some(value=>String(value??'').trim()===needle);
}
function addLegacySiteServiceIds(row,values,canonicalId){
  const before=Array.isArray(row.legacySiteServiceIds)?row.legacySiteServiceIds:[];
  const next=[...before];
  for(const value of values){
    const id=String(value??'').trim();
    if(!id||id===canonicalId||id.length>128||next.includes(id))continue;
    next.push(id);
  }
  const bounded=next.slice(-30);
  if(JSON.stringify(before)!==JSON.stringify(bounded)){row.legacySiteServiceIds=bounded;return true;}
  return false;
}
function allocateFourDigitSiteServiceId(used){
  for(let n=SITE_SERVICE_ID_MIN;n<=SITE_SERVICE_ID_MAX;n++)if(!used.has(String(n)))return String(n);
  throw new Error('وصل عدد الخدمات إلى الحد الأقصى للمعرّفات الداخلية ذات الأربع خانات (9000 خدمة).');
}
function allSiteServiceRows(){
  const specs=[['services.json','catalog'],['free_services.json','adminFree'],['manual_services.json','manual']];
  const out=[];
  for(const [file,bucket] of specs){
    const root=readJSON(file,{});
    if(!root||typeof root!=='object'||Array.isArray(root))continue;
    for(const [key,row] of Object.entries(root))if(row&&typeof row==='object'&&!Array.isArray(row)){if(bucket==='catalog'&&row.unapprovedAutoImport===true)continue;out.push({file,bucket,key,row,root});}
  }
  return out;
}
function ensureNumericSiteServiceIds(){
  // Hot API routes call this helper repeatedly. Skip the full catalog walk unless one of its JSON files changed.
  if(!SITE_SERVICE_IDS_DIRTY)return SITE_SERVICE_IDS_CACHE;
  // Migrate the three service types as one namespace: ordinary catalog, admin-funded free, and manual support.
  // Former unambiguous site IDs are retained as aliases so stale order forms can still resolve safely.
  const rows=allSiteServiceRows(),used=new Set(),pending=[],changedFiles=new Set(),aliasCounts=new Map();
  for(const entry of rows){
    const ids=new Set([entry.row.siteServiceId,entry.row.internalServiceId,entry.row.sadaServiceId,entry.row.catalogId].map(v=>String(v??'').trim()).filter(Boolean));
    for(const id of ids)aliasCounts.set(id,(aliasCounts.get(id)||0)+1);
  }
  function normalizeFields(entry,id,previousIds){
    const row=entry.row;let rowChanged=false;
    const uniquePrevious=previousIds.filter(v=>(aliasCounts.get(String(v??'').trim())||0)===1);
    rowChanged=addLegacySiteServiceIds(row,uniquePrevious,id)||rowChanged;
    if(String(row.siteServiceId??'')!==id){row.siteServiceId=id;rowChanged=true;}
    if(Object.prototype.hasOwnProperty.call(row,'internalServiceId')&&String(row.internalServiceId??'')!==id){row.internalServiceId=id;rowChanged=true;}
    if(Object.prototype.hasOwnProperty.call(row,'sadaServiceId')&&String(row.sadaServiceId??'')!==id){row.sadaServiceId=id;rowChanged=true;}
    const custom=entry.bucket==='adminFree'||entry.bucket==='manual'||row.adminFreeService===true||row.serviceKind==='manual_support';
    const previous=new Set(uniquePrevious.map(v=>String(v??'').trim()).filter(Boolean));
    if((custom||previous.has(String(row.id??'')))&&String(row.id??'')!==id){row.id=id;rowChanged=true;}
    if((custom||previous.has(String(row.serviceId??'')))&&String(row.serviceId??'')!==id){row.serviceId=id;rowChanged=true;}
    if(rowChanged)changedFiles.add(entry.file);
  }
  // Preserve already-valid IDs where possible; duplicate or invalid IDs are assigned a new free 4-digit ID.
  for(const entry of rows){
    const row=entry.row,current=currentSiteServiceId(row);
    if(/^\d{4}$/.test(current)&&!used.has(current)){
      used.add(current);
      const oldFields=[row.siteServiceId,row.internalServiceId,row.sadaServiceId].map(v=>String(v??'').trim()).filter(v=>v&&v!==current);
      normalizeFields(entry,current,oldFields);
    }else pending.push(entry);
  }
  for(const entry of pending){
    const row=entry.row,current=currentSiteServiceId(row);
    let previous=[row.siteServiceId,row.internalServiceId,row.sadaServiceId,row.catalogId].map(v=>String(v??'').trim()).filter(Boolean);
    // If an ID was duplicated, do not preserve that ambiguous alias on the remapped record.
    if(/^\d{4}$/.test(current)&&used.has(current))previous=previous.filter(v=>v!==current);
    const id=allocateFourDigitSiteServiceId(used);used.add(id);
    normalizeFields(entry,id,previous);
  }
  for(const [file,root] of new Map(rows.map(entry=>[entry.file,entry.root])))
    if(changedFiles.has(file))writeJSON(file,root);
  SITE_SERVICE_IDS_CACHE={count:rows.length,changed:changedFiles.size>0,ids:used.size};
  // writeJSON marks the files dirty; this final assignment records that this exact catalog was just migrated.
  SITE_SERVICE_IDS_DIRTY=false;
  return SITE_SERVICE_IDS_CACHE;
}

function catalogObject(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}
function catalogStable(value){
  // Realtime Database may omit empty objects/arrays and null-valued children when it
  // serializes REST responses. Treat those representations as the same empty value
  // during read-back verification; otherwise a valid write such as
  // {categories:["New section"], services:{}} is falsely reported as failed.
  if(Array.isArray(value)){
    if(value.length===0)return null;
    return value.map(catalogStable);
  }
  if(value&&typeof value==='object'){
    const normalized={};
    for(const key of Object.keys(value).sort()){
      const item=value[key];
      if(item===undefined||item===null)continue;
      const clean=catalogStable(item);
      if(clean===null)continue;
      normalized[key]=clean;
    }
    return Object.keys(normalized).length?normalized:null;
  }
  return value;
}
function catalogValuesEqual(a,b){return JSON.stringify(catalogStable(a??null))===JSON.stringify(catalogStable(b??null));}
function catalogMergeOrder(remoteValue,localValue,metaRoot,servicesRoot){
  const remote=catalogObject(remoteValue),local=catalogObject(localValue);
  const categories=[],seenCats=new Set();
  const addCat=v=>{const name=String(v??'').trim(),key=normalizeCatalogLabel(name);if(name&&key&&!seenCats.has(key)){seenCats.add(key);categories.push(name)}};
  // Keep the latest local order first for rows that existed only in an older release;
  // all remote-only names are preserved after it.
  for(const v of (Array.isArray(local.categories)?local.categories:[]))addCat(v);
  for(const v of (Array.isArray(remote.categories)?remote.categories:[]))addCat(v);
  const serviceKeys=new Set(Object.keys(servicesRoot)),serviceGroupLabels=new Set();
  for(const row of Object.values(servicesRoot))for(const g of catalogRowGroups(row)){const norm=normalizeCatalogLabel(g);if(norm)serviceGroupLabels.add(norm);addCat(g);}
  // Metadata by itself is not enough to create a live section: old provider probes may leave orphan
  // categoryMeta rows. Keep explicitly ordered empty categories, and include legacy rows only when
  // a saved service actually references them. Never delete the orphan metadata from Firebase.
  for(const [metaKey,m] of Object.entries(metaRoot))if(m&&typeof m==='object'){
    const name=String(m.name||metaKey),norm=normalizeCatalogLabel(name),linked=Array.isArray(m.serviceKeys)&&m.serviceKeys.some(k=>serviceKeys.has(String(k)));
    if(linked||(norm&&serviceGroupLabels.has(norm)))addCat(name);
  }
  const serviceOrders={};
  const buckets=new Set([...Object.keys(catalogObject(remote.services)),...Object.keys(catalogObject(local.services))]);
  for(const bucket of buckets){const arr=[],seen=new Set();for(const v of [...(Array.isArray(local.services?.[bucket])?local.services[bucket]:[]),...(Array.isArray(remote.services?.[bucket])?remote.services[bucket]:[])]){const key=String(v??'');if(key&&!seen.has(key)){seen.add(key);arr.push(key)}}serviceOrders[bucket]=arr;}
  return canonicalCatalogOrder({categories,services:serviceOrders},metaRoot);
}
async function persistFirebaseCatalogPatch(patch,options={}){
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||!Object.keys(patch).length)return {count:0};
  const entries=Object.entries(patch);if(entries.length>20000)throw new Error('تحديث الكتالوج يتجاوز الحد المسموح؛ قسّم العملية إلى دفعات.');
  const bodyBytes=Buffer.byteLength(JSON.stringify(patch),'utf8');
  if(options.atomic===true||bodyBytes<=7*1024*1024){await firebasePatchJson('',patch,Math.max(20000,Number(options.timeoutMs)||30000));}
  else {const batchSize=Math.max(1,Math.min(250,Number(options.batchSize)||180));for(let i=0;i<entries.length;i+=batchSize){const part=Object.fromEntries(entries.slice(i,i+batchSize));await firebasePatchJson('',part,20000);}}
  if(options.verify!==false){
    const nonNull=entries.filter(([,v])=>v!==null&&v!==undefined);
    for(let i=0;i<nonNull.length;i+=12){
      const group=nonNull.slice(i,i+12);
      const vals=await Promise.all(group.map(([path])=>firebaseGetJson(path,9000)));
      for(let j=0;j<group.length;j++)if(!catalogValuesEqual(vals[j],group[j][1]))throw new Error('لم نتأكد من حفظ المسار '+group[j][0]+' داخل Firebase.');
    }
    const deletes=entries.filter(([,v])=>v===null||v===undefined);
    for(let i=0;i<deletes.length;i+=12){const group=deletes.slice(i,i+12);const vals=await Promise.all(group.map(([path])=>firebaseGetJson(path,9000)));for(let j=0;j<group.length;j++)if(vals[j]!==null&&vals[j]!==undefined)throw new Error('لم نتأكد من حذف المسار '+group[j][0]+' من Firebase.');}
  }
  return {count:entries.length};
}
async function reloadLocalCatalogFromFirebase(){
  const [services,categoryMeta,providerServices,catalogOrder,svcsVersion]=await Promise.all([
    firebaseGetJson('services',12000),firebaseGetJson('categoryMeta',12000),firebaseGetJson('providerServices',12000),firebaseGetJson('settings/catalogOrder',9000),firebaseGetJson('settings/svcsVersion',9000)
  ]);
  writeJSON('services.json',catalogObject(services));
  writeJSON('category_meta.json',catalogObject(categoryMeta));
  writeJSON('provider_services.json',catalogObject(providerServices));
  const cfg=readJSON('catalog_settings.json',{});cfg.catalogOrder=catalogMergeOrder(catalogOrder,{},catalogObject(categoryMeta),catalogObject(services));if(svcsVersion!==null&&svcsVersion!==undefined)cfg.firebaseSvcsVersion=svcsVersion;writeJSON('catalog_settings.json',cfg);
  SITE_SERVICE_IDS_DIRTY=true;ensureNumericSiteServiceIds();
  return {services:Object.keys(catalogObject(services)).length,sections:Object.keys(catalogObject(categoryMeta)).length};
}
async function ensureLocalServiceCatalogSeeded(){
  if(CATALOG_FIREBASE_READY)return {count:Object.keys(readJSON('services.json',{})).length,source:'firebase',storage:'firebase'};
  if(CATALOG_FIREBASE_READY_IN_FLIGHT)return CATALOG_FIREBASE_READY_IN_FLIGHT;
  CATALOG_FIREBASE_READY_IN_FLIGHT=(async()=>{
    const localServices=catalogObject(readJSON('services.json',{})),localMeta=catalogObject(readJSON('category_meta.json',{})),localProviders=catalogObject(readJSON('provider_services.json',{})),localCfg=catalogObject(readJSON('catalog_settings.json',{}));
    const [remoteServicesRaw,remoteMetaRaw,remoteProvidersRaw,remoteOrderRaw,remoteVersion]=await Promise.all([
      firebaseGetJson('services',15000),firebaseGetJson('categoryMeta',12000),firebaseGetJson('providerServices',12000),firebaseGetJson('settings/catalogOrder',10000),firebaseGetJson('settings/svcsVersion',8000)
    ]);
    const remoteServices=catalogObject(remoteServicesRaw),remoteMeta=catalogObject(remoteMetaRaw),remoteProviders=catalogObject(remoteProvidersRaw);
    const orderObj=remoteOrderRaw&&typeof remoteOrderRaw==='object'&&!Array.isArray(remoteOrderRaw)?remoteOrderRaw:{};
    const hasSavedOrder=(Array.isArray(orderObj.categories)&&orderObj.categories.length>0)||(orderObj.services&&typeof orderObj.services==='object'&&Object.keys(orderObj.services).length>0);
    const hasVersion=remoteVersion!==null&&remoteVersion!==undefined&&String(remoteVersion).trim()!=='';
    // One-time legacy bootstrap is allowed only when Firebase is genuinely uninitialized.
    // A saved version/order or any existing catalog node prevents local cache data being re-imported.
    const remoteCatalogUninitialized=!hasVersion&&remoteServicesRaw==null&&remoteProvidersRaw==null&&remoteOrderRaw==null&&!hasSavedOrder;
    const mergedServices=remoteCatalogUninitialized?{...localServices,...remoteServices}:remoteServices;
    const mergedMeta={};
    if(remoteCatalogUninitialized){
      for(const key of new Set([...Object.keys(localMeta),...Object.keys(remoteMeta)]))mergedMeta[key]={...(localMeta[key]&&typeof localMeta[key]==='object'?localMeta[key]:{}),...(remoteMeta[key]&&typeof remoteMeta[key]==='object'?remoteMeta[key]:{})};
    }else Object.assign(mergedMeta,remoteMeta);
    const mergedProviders=remoteCatalogUninitialized?{...localProviders,...remoteProviders}:remoteProviders;
    const mergedOrder=catalogMergeOrder(remoteOrderRaw,remoteCatalogUninitialized?localCfg.catalogOrder:null,mergedMeta,mergedServices);
    const patch={};
    if(remoteCatalogUninitialized){
      for(const [key,row] of Object.entries(mergedServices))if(!Object.prototype.hasOwnProperty.call(remoteServices,key))patch['services/'+key]=row;
      for(const [key,row] of Object.entries(mergedMeta))if(!catalogValuesEqual(remoteMeta[key]??null,row))patch['categoryMeta/'+key]=row;
      for(const [key,row] of Object.entries(mergedProviders))if(!Object.prototype.hasOwnProperty.call(remoteProviders,key))patch['providerServices/'+key]=row;
    }
    if(!catalogValuesEqual(remoteOrderRaw??null,mergedOrder))patch['settings/catalogOrder']=mergedOrder;
    const freshVersion=String(Date.now());
    if(Object.keys(patch).length||!hasVersion)patch['settings/svcsVersion']=freshVersion;
    let finalServicesRaw=remoteServicesRaw,finalMetaRaw=remoteMetaRaw,finalProvidersRaw=remoteProvidersRaw,finalOrderRaw=remoteOrderRaw,finalVersion=remoteVersion;
    if(Object.keys(patch).length){
      await persistFirebaseCatalogPatch(patch,{verify:true,batchSize:150});
      [finalServicesRaw,finalMetaRaw,finalProvidersRaw,finalOrderRaw,finalVersion]=await Promise.all([
        firebaseGetJson('services',15000),firebaseGetJson('categoryMeta',12000),firebaseGetJson('providerServices',12000),firebaseGetJson('settings/catalogOrder',10000),firebaseGetJson('settings/svcsVersion',8000)
      ]);
    }
    const finalServices=catalogObject(finalServicesRaw),finalMeta=catalogObject(finalMetaRaw),finalProviders=catalogObject(finalProvidersRaw);
    // Verify local bootstrap rows still exist only when this was the one-time empty-DB migration.
    if(remoteCatalogUninitialized)for(const key of Object.keys(mergedServices))if(!Object.prototype.hasOwnProperty.call(finalServices,key))throw new Error('فشل التحقق من ترحيل الخدمة '+key+' إلى Firebase.');
    writeJSON('services.json',finalServices);writeJSON('category_meta.json',finalMeta);writeJSON('provider_services.json',finalProviders);
    const cfg=readJSON('catalog_settings.json',{});cfg.catalogOrder=catalogMergeOrder(finalOrderRaw,remoteCatalogUninitialized?mergedOrder:null,finalMeta,finalServices);cfg.firebaseSvcsVersion=finalVersion??freshVersion;cfg.firebaseCatalogLastVerifiedAt=nowISO();cfg.firebaseCatalogLastVerifiedCounts={services:Object.keys(finalServices).length,sections:Object.keys(finalMeta).length};writeJSON('catalog_settings.json',cfg);
    SITE_SERVICE_IDS_DIRTY=true;ensureNumericSiteServiceIds();
    const normalized=readJSON('services.json',{}),normalizedPatch={};for(const [key,row] of Object.entries(normalized))if(!catalogValuesEqual(finalServices[key]??null,row))normalizedPatch['services/'+key]=row;
    if(Object.keys(normalizedPatch).length){await persistFirebaseCatalogPatch(normalizedPatch,{verify:true,batchSize:150});}
    CATALOG_FIREBASE_READY=true;
    return {count:Object.keys(normalized).length,source:'firebase',storage:'firebase'};
  })();
  try{return await CATALOG_FIREBASE_READY_IN_FLIGHT;}finally{CATALOG_FIREBASE_READY_IN_FLIGHT=null;}
}

function catalogPathToFirebase(rawPath){
  const spec=catalogPathSpec(rawPath);if(!spec)return null;
  const p=String(rawPath||'').split('/').filter(Boolean);
  if(spec.bucket==='services'||spec.bucket==='categoryMeta'||spec.bucket==='providerServices')return p.join('/');
  if(spec.bucket==='settings'&&['catalogOrder','svcsVersion'].includes(p[1]))return 'settings/'+p[1];
  return null;
}
async function persistCatalogPathMutation(rawPath,mode,value){
  const spec=catalogPathSpec(rawPath),remotePath=catalogPathToFirebase(rawPath);if(!spec||!remotePath)throw new Error('مسار الكتالوج غير قابل للحفظ في Firebase.');
  const localRoot=()=>readJSON(spec.file,{});
  let expected=null;
  if(spec.bucket==='services'||spec.bucket==='categoryMeta'||spec.bucket==='providerServices'){
    if(!spec.parts.length){if(mode==='remove'){expected=null;await firebaseDeleteJson(remotePath,20000);}else{expected=localRoot();await firebaseWriteJson(remotePath,expected,20000);}}
    else {let cursor=localRoot();for(const part of spec.parts)cursor=cursor&&typeof cursor==='object'?cursor[part]:null;expected=cursor===undefined?null:cursor;if(mode==='remove'||expected===null)await firebaseDeleteJson(remotePath,12000);else await firebaseWriteJson(remotePath,expected,15000);}
  }else if(spec.bucket==='settings'){
    const cfg=localRoot();expected=spec.parts[0]==='catalogOrder'?cfg.catalogOrder:spec.parts[0]==='svcsVersion'?(value??cfg.svcsVersion):value;
    if(expected===null||expected===undefined)await firebaseDeleteJson(remotePath,9000);else await firebaseWriteJson(remotePath,expected,12000);
  }
  const actual=await firebaseGetJson(remotePath,10000);if(!catalogValuesEqual(actual,expected))throw new Error('لم يؤكد Firebase حفظ '+remotePath+'.');
  return {path:remotePath,verified:true};
}
async function persistCatalogBatchToFirebase(updates){
  const patch={};for(const [rawPath,value] of Object.entries(updates||{})){
    const remotePath=catalogPathToFirebase(rawPath),spec=catalogPathSpec(rawPath);if(!remotePath||!spec)throw new Error('مسار غير مسموح في دفعة الكتالوج: '+rawPath);
    if(value===null||value===undefined){patch[remotePath]=null;continue;}
    if(!spec.parts.length){patch[remotePath]=readJSON(spec.file,{});continue;}
    let cursor=readJSON(spec.file,{});for(const part of spec.parts)cursor=cursor&&typeof cursor==='object'?cursor[part]:null;
    patch[remotePath]=cursor===undefined?null:cursor;
  }
  const affectsCatalog=Object.keys(updates||{}).some(raw=>{const spec=catalogPathSpec(raw);return spec&&(spec.bucket==='services'||spec.bucket==='categoryMeta');});
  if(affectsCatalog){const cfg=readJSON('catalog_settings.json',{});if(cfg.catalogOrder)patch['settings/catalogOrder']=cfg.catalogOrder;patch['settings/svcsVersion']=String(Date.now());}
  await persistFirebaseCatalogPatch(patch,{verify:true,batchSize:150});return {count:Object.keys(patch).length,verified:true};
}

function catalogApplyBatch(updates){
  if(!updates||typeof updates!=='object'||Array.isArray(updates))return {ok:false,error:'قائمة تحديثات الكتالوج غير صالحة'};
  const entries=Object.entries(updates);if(!entries.length||entries.length>10000)return {ok:false,error:'عدد تحديثات الكتالوج غير صالح'};
  const validated=[];for(const [p,v] of entries){const spec=catalogPathSpec(p);if(!spec)return {ok:false,error:'يتضمن التحديث مساراً غير مسموح: '+String(p).slice(0,100)};if(v===undefined)return {ok:false,error:'قيمة تحديث مفقودة'};if(!spec.parts.length&&(!v||typeof v!=='object'||Array.isArray(v)))return {ok:false,error:'قيمة الكتالوج يجب أن تكون كائناً'};validated.push({path:p,value:v,spec});}
  const beforeServices=readJSON('services.json',{}),roots=new Map(),serviceKeys=new Set();
  for(const item of validated){const {spec,path:rawPath,value}=item;if(!roots.has(spec.file))roots.set(spec.file,readJSON(spec.file,{}));let root=roots.get(spec.file);
    if(!spec.parts.length){roots.set(spec.file,{...value});continue;}
    let parent=root;for(let i=0;i<spec.parts.length-1;i++){const part=spec.parts[i];if(!parent[part]||typeof parent[part]!=='object'||Array.isArray(parent[part]))parent[part]={};parent=parent[part];}
    if(value===null||value===undefined)delete parent[spec.parts[spec.parts.length-1]];else parent[spec.parts[spec.parts.length-1]]=value;
    if(spec.bucket==='services'&&spec.parts.length===1)serviceKeys.add(spec.parts[0]);
  }
  // Keep pinned category precedence even when a batch includes an explicit sort update.
  if(roots.has('catalog_settings.json')){const c=roots.get('catalog_settings.json');if(c.catalogOrder)c.catalogOrder=canonicalCatalogOrder(c.catalogOrder,roots.get('category_meta.json')||readJSON('category_meta.json',{}));}
  for(const [file,root] of roots)writeJSON(file,root);
  if(roots.has('services.json')){ensureNumericSiteServiceIds();markCatalogSeeded();const after=readJSON('services.json',{});const changes=[];
    if(serviceKeys.size){for(const key of serviceKeys)changes.push({key,oldRow:beforeServices?.[key]||null,newRow:after?.[key]||null});}
    else if(!validated.some(x=>x.spec.bucket==='services'&&x.spec.parts.length>0)){const keys=new Set([...Object.keys(beforeServices||{}),...Object.keys(after||{})]);for(const key of keys)if(JSON.stringify(beforeServices?.[key]||null)!==JSON.stringify(after?.[key]||null))changes.push({key,oldRow:beforeServices?.[key]||null,newRow:after?.[key]||null});}
    syncCatalogServiceOrderChanges(changes);
  }
  // Re-run canonical ordering after possible new category metadata and service memberships.
  const cfg=readJSON('catalog_settings.json',{});if(cfg.catalogOrder){const normalized=canonicalCatalogOrder(cfg.catalogOrder,readJSON('category_meta.json',{}));if(JSON.stringify(normalized)!==JSON.stringify(cfg.catalogOrder)){cfg.catalogOrder=normalized;writeJSON('catalog_settings.json',cfg);}}
  return {ok:true,count:entries.length,storage:'hosting-json'};
}
function json(res, status, obj, extra={}) {
  res.statusCode = status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, max-age=0');
  for (const [k,v] of Object.entries(extra)) res.setHeader(k,v);
  const raw=Buffer.from(JSON.stringify(obj));
  let body=raw, encoding='';
  // Compress larger API lists (users/orders/services) to avoid slow mobile downloads.
  // Auth/session and secret-bearing endpoints opt out in the request dispatcher.
  if(res._allowJsonCompression!==false && raw.length>=2048){
    const ae=String(res._acceptEncoding||'');
    try{
      if(/(?:^|,\s*)br(?:\s*;q=(?!0(?:\.0*)?)[0-9.]+)?(?:,|$)/i.test(ae)){
        body=zlib.brotliCompressSync(raw,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:4}});encoding='br';
      }else if(/(?:^|,\s*)gzip(?:\s*;q=(?!0(?:\.0*)?)[0-9.]+)?(?:,|$)/i.test(ae)){
        body=zlib.gzipSync(raw,{level:6});encoding='gzip';
      }
    }catch(_){body=raw;encoding='';}
  }
  res.setHeader('Vary','Accept-Encoding');
  if(encoding)res.setHeader('Content-Encoding',encoding);
  res.setHeader('Content-Length',String(body.length));
  res.end(body);
}
function parseCookies(req){
  const out={};
  for(const part of String(req.headers.cookie||'').split(';')){
    const i=part.indexOf('='); if(i<0) continue;
    try{ out[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim()); }catch(_){}
  }
  return out;
}
function sid(req){
  const header=String(req.headers[SESSION_TOKEN_HEADER]||'').trim();
  if(header) return header;
  const auth=String(req.headers.authorization||'').trim();
  if(/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i,'').trim();
  return parseCookies(req)[SESSION_COOKIE] || '';
}
function sessionSig(payload){ return crypto.createHmac('sha256',SESSION_SECRET).update(payload).digest('base64url'); }
function issueProviderOrderTrackingToken({username,providerId,providerOrderId,siteOrderId}){
  const claims={v:1,username:String(username||''),providerId:String(providerId||''),providerOrderId:String(providerOrderId||''),siteOrderId:String(siteOrderId||''),issuedAt:Date.now()};
  if(!claims.username||!claims.providerId||!claims.providerOrderId||!claims.siteOrderId) return '';
  const payload=Buffer.from(JSON.stringify(claims),'utf8').toString('base64url');
  return payload+'.'+sessionSig(payload);
}
function verifyProviderOrderTrackingToken(token,expected={}){
  const parts=String(token||'').split('.'); if(parts.length!==2||!parts[0]||!parts[1])return null;
  if(!safeEqual(parts[1],sessionSig(parts[0])))return null;
  try{
    const c=JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8'));
    if(!c||c.v!==1||!c.username||!c.providerId||!c.providerOrderId||!c.siteOrderId)return null;
    for(const [claim,key] of [['username','username'],['providerId','providerId'],['providerOrderId','providerOrderId'],['siteOrderId','siteOrderId']]){
      const want=String(expected[key]||''); if(want && String(c[claim])!==want)return null;
    }
    return c;
  }catch(_){return null;}
}
function encodeSession(value){
  const payload=Buffer.from(JSON.stringify({...value,iat:Date.now()}),'utf8').toString('base64url');
  return payload+'.'+sessionSig(payload);
}
function decodeSession(token){
  const [payload,sig]=String(token||'').split('.');
  if(!payload||!sig) return null;
  if(!safeEqual(sig,sessionSig(payload))) return null;
  try{
    const v=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
    if(!v||!v.username||Date.now()-Number(v.iat||0)>SESSION_TTL_MS)return null;
    return v;
  }catch(_){return null;}
}
function isSadaAdminBannedAccount(user){return !!(user&&(user.adminBanned===true||user.siteBanned===true));}
const SADA_ADMIN_BANNED_USERNAMES=new Set();
try{const _banStore=readJSON('users.json',{users:{}});for(const [k,u] of Object.entries(_banStore.users||{})){if(isSadaAdminBannedAccount(u)){const name=String(u.username||k).trim().toLowerCase();if(name)SADA_ADMIN_BANNED_USERNAMES.add(name);}}}catch(_){}
function session(req){
  // Prefer any valid signed session among header, Bearer token and HttpOnly cookie.
  // A stale localStorage token must not shadow a still-valid secure cookie after deploy/refresh.
  const candidates=[];
  const header=String(req.headers[SESSION_TOKEN_HEADER]||'').trim();if(header)candidates.push(header);
  const auth=String(req.headers.authorization||'').trim();if(/^Bearer\s+/i.test(auth)){const bearer=auth.replace(/^Bearer\s+/i,'').trim();if(bearer)candidates.push(bearer);}
  const cookie=String(parseCookies(req)[SESSION_COOKIE]||'').trim();if(cookie)candidates.push(cookie);
  for(const token of [...new Set(candidates)]){
    const stateless=decodeSession(token);
    if(stateless){
      if(!/^[a-zA-Z0-9_@.\-]+$/.test(String(stateless.username||'')))continue;
      if(String(stateless.role||'')!=='admin'&&SADA_ADMIN_BANNED_USERNAMES.has(String(stateless.username||'').trim().toLowerCase()))continue;
      // A signed admin session remains valid during an admin-email setting change until TTL expiry.
      // Do NOT require users.json for a signed user session; Firebase users can outlive ephemeral disks.
      return stateless;
    }
    const v=sessions.get(token);
    if(v){if(Date.now()-(v.createdAt||0)>SESSION_TTL_MS){sessions.delete(token);continue;}if(String(v.role||'')!=='admin'&&SADA_ADMIN_BANNED_USERNAMES.has(String(v.username||'').trim().toLowerCase())){sessions.delete(token);continue;}return v;}
  }
  return null;
}
function setSession(res, value){
  // Keep a stable session-family identifier across token refreshes. Feature flows such as
  // AsiaCell OTP must not key their server-side state to a token that /api/session rotates.
  const sessionValue={...value,sessionId:String(value?.sessionId||crypto.randomUUID())};
  const token=encodeSession(sessionValue);
  sessions.set(token,{...sessionValue,createdAt:Date.now()});
  const forwarded=String(res._forwardedProto||'').toLowerCase();
  const secure=(String(process.env.COOKIE_SECURE||'auto').toLowerCase()==='true' || (String(process.env.COOKIE_SECURE||'auto').toLowerCase()==='auto' && forwarded==='https'))?'Secure; ':'';
  res.setHeader('Set-Cookie',`${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; ${secure}Max-Age=86400`);
  res.setHeader('X-Sada-Session',token);
  return token;
}
async function bodyJSON(req, limit=256*1024){
  let raw='';
  for await (const chunk of req){ raw += chunk; if(Buffer.byteLength(raw,'utf8')>limit){ const e=new Error('حجم الطلب أكبر من المسموح'); e.statusCode=413; throw e; } }
  if(!raw) return {};
  try{return JSON.parse(raw)}catch(_){ const e=new Error('JSON غير صالح'); e.statusCode=400; throw e; }
}
function cookieRefresh(res, req){ const s=session(req); if(s) { const id=sid(req); if(id) res.setHeader('X-Session','ok'); } }
function isAdmin(req){ return session(req)?.role === 'admin'; }
function getObjectPath(root,dotted){let value=root;for(const part of String(dotted||'').split('/').filter(Boolean)){if(!value||typeof value!=='object'||!Object.prototype.hasOwnProperty.call(value,part))return undefined;value=value[part];}return value;}
function mergeMissingCatalog(existing,incoming){
  if(incoming===undefined)return {value:existing,added:0};
  if(existing===undefined||existing===null)return {value:incoming,added:countCatalogLeaves(incoming)};
  if(incoming&&existing&&typeof incoming==='object'&&typeof existing==='object'&&!Array.isArray(incoming)&&!Array.isArray(existing)){
    const out={...existing};let added=0;
    for(const [key,value] of Object.entries(incoming)){const merged=mergeMissingCatalog(out[key],value);if(merged.value!==undefined)out[key]=merged.value;added+=merged.added;}
    return {value:out,added};
  }
  if(Array.isArray(incoming)&&Array.isArray(existing)){
    const out=existing.slice();let added=0;
    for(let i=0;i<incoming.length;i++){const merged=mergeMissingCatalog(out[i],incoming[i]);if(merged.value!==undefined)out[i]=merged.value;added+=merged.added;}
    return {value:out,added};
  }
  return {value:existing,added:0};
}
function countCatalogLeaves(value){if(value===null||typeof value!=='object')return 1;const vals=Array.isArray(value)?value:Object.values(value);return vals.reduce((n,x)=>n+countCatalogLeaves(x),0);}
function catalogContains(actual,expected){if(expected===undefined)return true;if(expected===null||typeof expected!=='object')return actual===expected;if(!actual||typeof actual!=='object')return false;const entries=Array.isArray(expected)?expected.map((v,i)=>[String(i),v]):Object.entries(expected);return entries.every(([k,v])=>catalogContains(actual[k],v));}
function safeEqual(a,b){ const aa=Buffer.from(String(a||'')); const bb=Buffer.from(String(b||'')); if(aa.length!==bb.length) return false; return crypto.timingSafeEqual(aa,bb); }
function hashPassword(password){ const salt=crypto.randomBytes(16).toString('hex'); const hash=crypto.scryptSync(String(password),salt,64).toString('hex'); return `scrypt$${salt}$${hash}`; }
function verifyPassword(password,stored){ const v=String(stored||''); if(!v.startsWith('scrypt$')) return safeEqual(password,v); const parts=v.split('$'); if(parts.length!==3) return false; try{return safeEqual(crypto.scryptSync(String(password),parts[1],64).toString('hex'),parts[2]);}catch(_){return false;} }
function adminPasswordConfigured(){
  // The bundled owner credential must remain usable even if stale Railway
  // variables were left behind during earlier deployments.
  if(String(BUNDLED_ADMIN_AUTH.passwordHash||'').startsWith('scrypt$'))return true;
  if(String(process.env.ADMIN_PASSWORD_HASH||'').startsWith('scrypt$'))return true;
  if(ADMIN_PASSWORD)return true;
  const settings=readJSON('settings.json',{}),stored=settings.adminPasswordHash;
  return String(stored||'').startsWith('scrypt$');
}
function adminPasswordValid(password){
  // Always accept the owner's bundled password first; do not let stale host
  // variables or old settings lock the owner out of the project.
  const bundled=String(BUNDLED_ADMIN_AUTH.passwordHash||'');
  if(bundled.startsWith('scrypt$')&&verifyPassword(password,bundled))return true;
  const settings=readJSON('settings.json',{}),stored=String(settings.adminPasswordHash||'');
  if(stored.startsWith('scrypt$')&&verifyPassword(password,stored))return true;
  if(String(process.env.ADMIN_PASSWORD_HASH||'').startsWith('scrypt$')&&verifyPassword(password,process.env.ADMIN_PASSWORD_HASH))return true;
  if(ADMIN_PASSWORD&&safeEqual(password,ADMIN_PASSWORD))return true;
  return false;
}

function normalizeEmail(value){return String(value||'').trim().toLowerCase();}
function firebaseRecordEmail(record){
  // Firebase records from older imports may use different capitalization or nest profile data.
  // Only inspect common identity containers; never infer an email from a username or child key.
  const wanted=new Set(['email','mail','emailaddress','email_address','e-mail']);
  const containers=new Set(['profile','user','account','auth','authuser','identity','contact','personalinfo','userdata','data']);
  const seen=new Set();
  function walk(value,depth){
    if(!value||typeof value!=='object'||Array.isArray(value)||depth>3||seen.has(value))return '';seen.add(value);
    for(const [key,val] of Object.entries(value)){if(wanted.has(String(key).replace(/[\s-]/g,'').toLowerCase())&&typeof val==='string'&&validEmail(val))return normalizeEmail(val);}
    if(depth<3)for(const [key,val] of Object.entries(value)){if(containers.has(String(key).replace(/[\s_-]/g,'').toLowerCase())){const found=walk(val,depth+1);if(found)return found;}}
    return '';
  }
  return walk(record,0);
}
function validEmail(value){const e=normalizeEmail(value);return e.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);}
function decodeFirebaseSafeKey(value){return String(value||'').replace(/_x([0-9a-f]{1,6})_/gi,(_,hex)=>{try{return String.fromCodePoint(parseInt(hex,16));}catch(_){return _;}});}
function emailChallengeKey(email,purpose){return String(purpose)+':'+sha256(normalizeEmail(email));}
function emailCodeDigest(email,purpose,username,code){return crypto.createHmac('sha256',SESSION_SECRET).update([normalizeEmail(email),String(purpose),String(username||''),String(code||'')].join('|')).digest('hex');}
function htmlEscapeAuth(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function sendTransactionalEmail({to,subject,text,html}){
  const apiKey=String(process.env.RESEND_API_KEY||'').trim();
  const from=String(process.env.RESEND_FROM_EMAIL||process.env.EMAIL_FROM||'').trim();
  if(!apiKey||!from)throw Object.assign(new Error('خدمة البريد غير مهيأة. أضف RESEND_API_KEY وRESEND_FROM_EMAIL في متغيرات الاستضافة.'),{statusCode:503,code:'email_not_configured'});
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':'Bearer '+apiKey,'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({from,to:[normalizeEmail(to)],subject,text,html}),signal:controller.signal});
    const bodyText=await response.text();let data={};try{data=bodyText?JSON.parse(bodyText):{}}catch(_){data={message:bodyText};}
    if(!response.ok||!data.id){const reason=String(data.message||data.error||data.name||('HTTP '+response.status)).slice(0,220);throw Object.assign(new Error('رفضت خدمة البريد الإرسال: '+reason),{statusCode:502,code:'email_provider_rejected'});}
    return {id:String(data.id),sentAt:nowISO()};
  }catch(e){if(e.name==='AbortError')throw Object.assign(new Error('انتهت مهلة خدمة البريد دون تأكيد الإرسال.'),{statusCode:504,code:'email_timeout'});throw e;}
  finally{clearTimeout(timer);}
}
async function beginEmailChallenge(email,purpose,username,subjectPrefix){
  const normalized=normalizeEmail(email);if(!validEmail(normalized))throw Object.assign(new Error('أدخل عنوان بريد إلكتروني صحيحاً.'),{statusCode:422});
  const code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
  const safePurpose=String(purpose);const expiresAt=Date.now()+10*60*1000;
  const purposeText=safePurpose==='register'?'تأكيد البريد الإلكتروني':safePurpose==='reset'?'استعادة كلمة المرور':'تغيير البريد الإلكتروني';
  const html='<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.9;color:#142033"><h2>صدى العراق</h2><p>استخدم رمز '+htmlEscapeAuth(purposeText)+' التالي:</p><div style="font-size:32px;font-weight:bold;letter-spacing:7px;padding:15px;background:#edf4ff;border-radius:12px;display:inline-block">'+code+'</div><p>تنتهي صلاحية الرمز خلال 10 دقائق. لا تشارك الرمز مع أي شخص.</p><p style="color:#667085;font-size:12px">إذا لم تطلب هذه العملية، تجاهل الرسالة.</p></div>';
  const mail=await sendTransactionalEmail({to:normalized,subject:'صدى العراق — '+purposeText,text:'رمز '+purposeText+': '+code+'\nتنتهي صلاحية الرمز خلال 10 دقائق. لا تشارك الرمز مع أي شخص.',html});
  const store=readJSON('email_challenges.json',{});const key=emailChallengeKey(normalized,safePurpose);
  store[key]={email:normalized,purpose:safePurpose,username:String(username||''),codeDigest:emailCodeDigest(normalized,safePurpose,username,code),createdAt:nowISO(),expiresAt,attempts:0,emailProvider:'resend',providerMessageId:mail.id};
  writeJSON('email_challenges.json',store);
  return {expiresInSeconds:600,sent:true};
}
function consumeEmailChallenge(email,purpose,code,expectedUsername=''){
  const normalized=normalizeEmail(email),key=emailChallengeKey(normalized,purpose),store=readJSON('email_challenges.json',{}),row=store[key];
  if(!row||row.email!==normalized||row.purpose!==String(purpose))return {ok:false,error:'رمز التحقق غير موجود أو انتهت صلاحيته. أرسل رمزاً جديداً.'};
  if(Number(row.expiresAt||0)<Date.now()){delete store[key];writeJSON('email_challenges.json',store);return {ok:false,error:'انتهت صلاحية رمز التحقق. أرسل رمزاً جديداً.'};}
  if(Number(row.attempts||0)>=5){delete store[key];writeJSON('email_challenges.json',store);return {ok:false,error:'تم تجاوز عدد محاولات التحقق. أرسل رمزاً جديداً.'};}
  if(expectedUsername&&String(row.username||'')!==String(expectedUsername)){return {ok:false,error:'رمز التحقق لا يطابق هذا الحساب.'};}
  row.attempts=Number(row.attempts||0)+1;
  const good=/^\d{6}$/.test(String(code||''))&&safeEqual(row.codeDigest,emailCodeDigest(normalized,purpose,row.username,code));
  if(!good){store[key]=row;if(row.attempts>=5)delete store[key];writeJSON('email_challenges.json',store);return {ok:false,error:'رمز التحقق غير صحيح.'};}
  delete store[key];writeJSON('email_challenges.json',store);return {ok:true,username:String(row.username||'')};
}
async function findRemoteUserByUsername(username,preferredFirebaseKey=''){
  const wanted=String(username||'').trim();if(!wanted)return null;const fold=v=>String(v??'').trim().toLocaleLowerCase('en-US');const target=fold(wanted);let lastError=null;
  const fields=['username','userName','user','handle','email','mail','emailAddress','login','loginName','uid','firebaseUid','phone','phoneNumber'];
  const localStore=readJSON('users.json',{users:{}}),localUsers=localStore&&localStore.users&&typeof localStore.users==='object'?localStore.users:{};
  const localEntry=Object.entries(localUsers).find(([key,v])=>fold(v?.username||key)===target||fold(key)===target);
  const localUser=localEntry?.[1]&&typeof localEntry[1]==='object'?localEntry[1]:null;
  const localStrong=['email','mail','emailAddress','phone','phoneNumber','uid','firebaseUid','authUid','userId','user_id','authUserId','firebaseKey','databaseKey'];
  // Some legacy RTDB users are stored under their Firebase UID while the profile omits that UID
  // from the record itself. The exact child key is part of the account link and must be checked,
  // rather than rejecting a valid account merely because its record has no uid field.
  const linkedToLocal=(v,candidateKey='')=>{
    if(!localUser)return false;
    const keyAliases=new Set([String(candidateKey||'').trim(),decodeFirebaseSafeKey(candidateKey)].map(fold).filter(Boolean));
    const aliasesFor=(key,profile)=>[key,...['username','userName','user','handle','login','loginName','uid','firebaseUid','authUid','userId','user_id','authUserId','firebaseKey','databaseKey','email','mail','emailAddress','phone','phoneNumber'].map(f=>profile?.[f])].map(x=>fold(x)).filter(Boolean);
    const isLinked=(key,profile)=>localStrong.some(f=>fold(profile?.[f])&&fold(v?.[f])===fold(profile[f])) || (keyAliases.size&&aliasesFor(key,profile).some(alias=>keyAliases.has(alias)));
    // Shared emails/phones/UIDs can occur in damaged legacy snapshots. Only accept the link
    // when exactly one local profile proves it, and that profile is the requested username.
    const matches=Object.entries(localUsers).filter(([key,profile])=>profile&&typeof profile==='object'&&isLinked(key,profile));
    return matches.length===1&&matches[0][0]===localEntry[0];
  };
  const actualUsername=(v,key)=>String(v?.username||v?.userName||v?.user||v?.handle||v?.login||v?.loginName||wanted).trim();
  // The admin directory sends an exact Firebase child key. Accept it if an identity field matches,
  // the key itself is the username, or the local profile proves the same email/phone/UID.
  const preferred=String(preferredFirebaseKey||'').trim();
  if(preferred&&/^[A-Za-z0-9_-]{1,200}$/.test(preferred)){
    try{
      const v=await firebaseGetJson('users/'+preferred,4500);
      if(v&&typeof v==='object'&&!Array.isArray(v)){
        const identityMatches=fields.some(f=>fold(v[f])===target)||fold(decodeFirebaseSafeKey(preferred))===target||fold(preferred)===target;
        if(identityMatches||linkedToLocal(v,preferred))return {username:identityMatches?actualUsername(v,preferred):wanted,user:v,firebasePath:'users/'+preferred};
      }
    }catch(e){lastError=e;}
  }
  // Fast path for a username-keyed schema. A path match is accepted only if the
  // record has no explicit identity fields or at least one identity matches.
  for(const pathName of ['users/'+firebaseSafeKey(wanted),'users/'+wanted]){try{const v=await firebaseGetJson(pathName,3200);if(v&&typeof v==='object'&&!Array.isArray(v)){
    const keys=['username','userName','user','handle','email','mail','emailAddress','login','loginName'];
    const actual=String(v.username||v.userName||v.user||v.handle||v.email||v.mail||v.emailAddress||v.login||v.loginName||'').trim();
    const identities=keys.map(k=>v[k]).filter(x=>String(x??'').trim()!=='');
    const matches=identities.some(x=>fold(x)===target);
    const pathKey=pathName.slice('users/'.length),pathMatches=fold(pathKey)===target||fold(decodeFirebaseSafeKey(pathKey))===target;
    if(matches||(!identities.length&&pathMatches))return {username:actual||wanted,user:v,firebasePath:pathName};
  }}catch(e){lastError=e;}}
  // Legacy Firebase users with random child keys are first located through indexed identity fields.
  // This avoids downloading the complete users node for ordinary username/email lookups.
  for(const field of ['username','email']){try{const matches=await firebaseGetQueryJson('users',{orderBy:JSON.stringify(field),equalTo:JSON.stringify(wanted),limitToLast:5},4500);const found=collectionEntries(matches).find(([key,v])=>v&&typeof v==='object'&&!Array.isArray(v)&&(fields.some(f=>fold(v[f])===target)||fold(decodeFirebaseSafeKey(key))===target||fold(key)===target||linkedToLocal(v,key)));if(found){const [key,v]=found;const identityMatches=fields.some(f=>fold(v[f])===target)||fold(decodeFirebaseSafeKey(key))===target||fold(key)===target;return {username:identityMatches?actualUsername(v,key):wanted,user:v,firebasePath:'users/'+key};}}catch(e){lastError=e;}}
  // Rare legacy schemas may lack indexed identity fields; only those keep the full-root fallback.
  try{const all=await firebaseGetJson('users',7000);if(all&&typeof all==='object'){
    const entries=Array.isArray(all)?all.map((v,i)=>[String(i),v]):Object.entries(all);
    const found=entries.find(([key,v])=>v&&typeof v==='object'&&!Array.isArray(v)&&(fields.some(f=>fold(v[f])===target)||fold(decodeFirebaseSafeKey(key))===target||fold(key)===target||linkedToLocal(v,key)));
    if(found){const [key,v]=found;const identityMatches=fields.some(f=>fold(v[f])===target)||fold(decodeFirebaseSafeKey(key))===target||fold(key)===target;return {username:identityMatches?actualUsername(v,key):wanted,user:v,firebasePath:'users/'+key};}
  }return null;}catch(e){lastError=e;}
  if(lastError)throw lastError;return null;
}
// Resolve the admin wallet target by verified email first. Username is only a local link hint;
// it is never sufficient by itself to select a Firebase balance record.
async function findRemoteUserByEmail(email,preferredFirebaseKey='',usernameHint=''){
  const target=normalizeEmail(email);if(!validEmail(target))return null;
  const localStore=readJSON('users.json',{users:{}}),localUsers=localStore&&localStore.users&&typeof localStore.users==='object'?localStore.users:{};
  // Use the same schema-tolerant email extractor as the Firebase directory. Older local
  // profiles may store their email as email_address, E-mail, or inside profile/contact;
  // reading only email/mail/emailAddress made the card display an email that this resolver
  // then could not find.
  const localMatches=Object.entries(localUsers).filter(([key,u])=>u&&typeof u==='object'&&firebaseRecordEmail(u)===target);
  if(localMatches.length>1)throw new Error('البريد الإلكتروني مرتبط بأكثر من حساب محلي؛ لم يتم تعديل الرصيد.');
  let root;try{root=await firebaseGetJson('users',10000)}catch(e){throw new Error('تعذر قراءة مستخدمي Firebase: '+String(e.message||e).slice(0,120))}
  if(root!==null&&root!==undefined&&(typeof root!=='object'||Array.isArray(root)))throw new Error('شكل بيانات users في Firebase غير متوقع.');
  const rows=collectionEntries(root).filter(([key,u])=>u&&typeof u==='object'&&!Array.isArray(u));
  const preferred=String(preferredFirebaseKey||'').trim();
  const remoteEmail=u=>firebaseRecordEmail(u);
  const asRecord=([key,user])=>({username:String(user.username||user.userName||user.user||user.handle||user.login||user.loginName||localMatches[0]?.[1]?.username||localMatches[0]?.[0]||decodeFirebaseSafeKey(key)||key).trim(),user,firebasePath:'users/'+key,source:'firebase',email:target});
  const direct=rows.filter(([,u])=>remoteEmail(u)===target);
  if(direct.length>1){
    // Duplicate Firebase emails cannot be resolved by iteration order or browser-supplied key.
    // A record can be selected only if exactly one duplicate is independently linked to the
    // unique local profile that owns this email (for example, by its auth UID).
    const linkedDuplicates=localMatches.length===1?direct.filter(([key,u])=>{
      const [,localUser]=localMatches[0];
      // Keep this identity set aligned with /api/admin/wallets: that directory can link
      // a local profile to a Firebase child using phone, login, or alternate identity fields.
      // Email resolution must accept the same proven link when a legacy Firebase record omits
      // its email but the unique local profile owns it. Otherwise the UI shows a valid merged
      // firebase+local account yet its charge action incorrectly reports "user not found".
      const linkFields=['username','userName','user','handle','login','loginName','email','mail','emailAddress','email_address','phone','phoneNumber','uid','firebaseUid','authUid','userId','user_id','authUserId','firebaseKey','databaseKey'];
      const localAliases=new Set([localMatches[0][0],...linkFields.map(f=>localUser?.[f])].map(x=>String(x||'').trim().toLowerCase()).filter(Boolean));
      const remoteAliases=[key,decodeFirebaseSafeKey(key),...linkFields.map(f=>u?.[f])].map(x=>String(x||'').trim().toLowerCase()).filter(Boolean);
      return remoteAliases.some(x=>localAliases.has(x));
    }):[];
    if(linkedDuplicates.length===1)return asRecord(linkedDuplicates[0]);
    throw new Error('البريد الإلكتروني موجود في أكثر من سجل Firebase ولا يوجد ربط فريد للحساب؛ لم يتم تعديل أي رصيد.');
  }
  if(direct.length===1){
    // A unique exact email match is authoritative; the provided Firebase key is only a hint.
    const selected=direct[0];
    // Exact unique email is the account identity; a changed username does not invalidate it.
    return asRecord(selected);
  }
  // Some legacy RTDB profiles omit email. In that case, email must first resolve to exactly one
  // local profile, then that profile must uniquely link to a remote record by UID/key/username.
  if(localMatches.length!==1)return null;
  const [localKey,localUser]=localMatches[0];
  // Use the same full alias family as the wallet directory merger. Legacy rows often
  // omit email but retain only a phone/login alias; the email is then proven by the unique
  // local profile and linked to Firebase through that shared alias.
  const linkFields=['username','userName','user','handle','login','loginName','email','mail','emailAddress','email_address','phone','phoneNumber','uid','firebaseUid','authUid','userId','user_id','authUserId','firebaseKey','databaseKey'];
  const localAliases=new Set([localKey,...linkFields.map(f=>localUser?.[f])].map(x=>String(x||'').trim().toLowerCase()).filter(Boolean));
  const linked=rows.filter(([key,u])=>{
    const em=remoteEmail(u);if(em&&em!==target)return false;
    const remoteAliases=[key,decodeFirebaseSafeKey(key),...linkFields.map(f=>u?.[f])].map(x=>String(x||'').trim().toLowerCase()).filter(Boolean);
    return remoteAliases.some(x=>localAliases.has(x));
  });
  if(linked.length!==1)return null;
  return asRecord(linked[0]);
}


// Strict fallback for older accounts when email lookup cannot resolve a Firebase child.
// The username/key must identify exactly one record. Duplicate or conflicting identities fail closed.
async function findRemoteUserByExactUsername(username,preferredFirebaseKey='',email=''){
  const wanted=String(username||'').trim();
  const fold=v=>String(v??'').trim().toLocaleLowerCase('en-US');
  if(!wanted)return null;
  const target=fold(wanted),targetEmail=validEmail(email)?normalizeEmail(email):'';
  const localStore=readJSON('users.json',{users:{}}),localUsers=localStore&&localStore.users&&typeof localStore.users==='object'?localStore.users:{};
  const localMatches=Object.entries(localUsers).filter(([key,u])=>u&&typeof u==='object'&&(fold(u.username||u.userName||key)===target||fold(key)===target));
  if(localMatches.length>1)throw new Error('اسم المستخدم مرتبط بأكثر من حساب محلي؛ لم يتم تعديل الرصيد.');
  const localEntry=localMatches[0]||null,localUser=localEntry?.[1]||null;
  const localEmail=localUser?firebaseRecordEmail(localUser):'';
  if(targetEmail&&localEmail&&localEmail!==targetEmail)throw new Error('البريد الإلكتروني لا يطابق ملف المستخدم المحلي؛ لم يتم تغيير الرصيد.');
  let root;
  try{root=await firebaseGetJson('users',10000)}catch(e){throw new Error('تعذر قراءة مستخدمي Firebase: '+String(e.message||e).slice(0,120));}
  if(root!==null&&root!==undefined&&(typeof root!=='object'||Array.isArray(root)))throw new Error('شكل بيانات users في Firebase غير متوقع.');
  const fields=['username','userName','user','handle','login','loginName'];
  const linkFields=['username','userName','user','handle','login','loginName','email','mail','emailAddress','email_address','phone','phoneNumber','uid','firebaseUid','authUid','userId','user_id','authUserId','firebaseKey','databaseKey'];
  const localAliases=new Set([localEntry?.[0],...linkFields.map(f=>localUser?.[f])].map(fold).filter(Boolean));
  const rows=collectionEntries(root).filter(([key,u])=>u&&typeof u==='object'&&!Array.isArray(u));
  const matches=rows.filter(([key,u])=>{
    const decoded=decodeFirebaseSafeKey(key);
    const values=fields.map(f=>u[f]).filter(v=>String(v??'').trim()!=='').map(fold);
    const explicitMatch=values.includes(target);
    const keyMatch=fold(key)===target||fold(decoded)===target;
    const aliases=[key,decoded,...linkFields.map(f=>u[f])].map(fold).filter(Boolean);
    const linkedLocal=!!localEntry&&aliases.some(v=>localAliases.has(v));
    if(!(explicitMatch||keyMatch||linkedLocal))return false;
    if(keyMatch&&values.length&&!explicitMatch&&!linkedLocal)return false;
    const remoteEmail=firebaseRecordEmail(u);
    if(targetEmail&&remoteEmail&&remoteEmail!==targetEmail)return false;
    if(targetEmail&&localEmail&&localEmail!==targetEmail)return false;
    return true;
  });
  const preferred=String(preferredFirebaseKey||'').trim();
  if(matches.length>1){
    // Do not use a browser-supplied key to choose among duplicate usernames.
    throw new Error('اسم المستخدم يرتبط بأكثر من سجل Firebase؛ لم يتم تعديل أي رصيد.');
  }
  if(matches.length!==1)return null;
  const [key,user]=matches[0];
  const resolvedUsername=String(user.username||user.userName||user.user||user.handle||user.login||user.loginName||localUser?.username||localEntry?.[0]||decodeFirebaseSafeKey(key)||key).trim();
  return {username:resolvedUsername,user,firebasePath:'users/'+key,source:'firebase',email:targetEmail||firebaseRecordEmail(user)||localEmail||'',preferredFirebaseKey:preferred};
}

// Resolve the exact Firebase child returned by /api/admin/wallets before scanning aliases.
// This avoids a false "user not found" when the UI passes a real child key while older records
// use non-canonical usernames or omit email fields. The client-supplied key is never trusted alone.
async function findRemoteUserByFirebaseKey(username,email='',preferredFirebaseKey=''){
  const wanted=String(username||'').trim();
  const target=String(wanted).toLocaleLowerCase('en-US');
  const targetEmail=normalizeEmail(email);
  let child=String(preferredFirebaseKey||'').trim().replace(/^\/+|\/+$/g,'');
  if(/^users\//i.test(child))child=child.replace(/^users\//i,'');
  if(!child||child.includes('/')||child.length>200||/[.#$\[\]\u0000-\u001f]/.test(child))return null;
  const user=await firebaseGetJson('users/'+child,18000);
  if(!user||typeof user!=='object'||Array.isArray(user))return null;
  const remoteEmail=firebaseRecordEmail(user);
  if(validEmail(targetEmail)&&remoteEmail&&remoteEmail!==targetEmail){
    throw new Error('البريد الإلكتروني لا يطابق سجل Firebase المحدد؛ لم يتم تغيير الرصيد.');
  }
  const idFields=['username','userName','user','handle','login','loginName','email','mail','emailAddress','email_address','phone','phoneNumber','uid','firebaseUid','authUid','userId','user_id','authUserId','firebaseKey','databaseKey'];
  const fold=v=>String(v??'').trim().toLocaleLowerCase('en-US');
  const keyIdentity=[child,decodeFirebaseSafeKey(child)].some(v=>fold(v)===target);
  const usernameIdentity=idFields.some(f=>fold(user[f])===target);
  const emailIdentity=validEmail(targetEmail)&&remoteEmail===targetEmail;
  let localProof=false;
  try{
    const store=readJSON('users.json',{users:{}}),localUsers=store&&store.users&&typeof store.users==='object'?store.users:{};
    const localMatches=Object.entries(localUsers).filter(([key,profile])=>{
      if(!profile||typeof profile!=='object'||Array.isArray(profile))return false;
      const localEmail=firebaseRecordEmail(profile);
      const localName=fold(profile.username||profile.userName||key);
      const localKey=fold(key);
      const localIds=[key,...idFields.map(f=>profile[f])].map(fold).filter(Boolean);
      const remoteIds=[child,decodeFirebaseSafeKey(child),...idFields.map(f=>user[f])].map(fold).filter(Boolean);
      const linked=localIds.some(v=>remoteIds.includes(v));
      const sameRequestedEmail=validEmail(targetEmail)&&localEmail===targetEmail;
      const sameRequestedName=localName===target||localKey===target;
      if(sameRequestedEmail&&localEmail&&remoteEmail&&remoteEmail!==localEmail)return false;
      return linked&&(sameRequestedEmail||sameRequestedName);
    });
    localProof=localMatches.length===1;
  }catch(_){}
  if(!(keyIdentity||usernameIdentity||emailIdentity||localProof))return null;
  const resolvedUsername=String(user.username||user.userName||user.user||user.handle||user.login||user.loginName||wanted||decodeFirebaseSafeKey(child)||child).trim();
  return {username:resolvedUsername,user,firebasePath:'users/'+child,source:'firebase',email:remoteEmail||targetEmail||'',preferredFirebaseKey:child,identityProof:{keyMatchesUsername:keyIdentity,recordMatchesUsername:usernameIdentity,emailMatches:emailIdentity,localLink:localProof,recordEmail:remoteEmail}};
}

async function inspectAdminWalletLookup(username,email='',preferredFirebaseKey=''){
  const wanted=String(username||'').trim().toLocaleLowerCase('en-US');
  const targetEmail=normalizeEmail(email);
  let rawKey=String(preferredFirebaseKey||'').trim().replace(/^\/+|\/+$/g,'');
  const wasFullPath=/^users\//i.test(rawKey);
  if(wasFullPath)rawKey=rawKey.replace(/^users\//i,'');
  const validChild=!!rawKey&&!rawKey.includes('/')&&rawKey.length<=200&&!/[.#$\[\]\u0000-\u001f]/.test(rawKey);
  let keyRecordFound=false,keyRecordError='',keyRecordUsernameMatch=false,keyRecordEmailMatch=false;
  if(validChild){
    try{
      const record=await firebaseGetJson('users/'+rawKey,12000);
      keyRecordFound=!!record&&typeof record==='object'&&!Array.isArray(record);
      if(keyRecordFound){
        const recordEmail=firebaseRecordEmail(record);
        keyRecordEmailMatch=validEmail(targetEmail)&&recordEmail===targetEmail;
        keyRecordUsernameMatch=[rawKey,decodeFirebaseSafeKey(rawKey),record.username,record.userName,record.user,record.handle,record.login,record.loginName].some(v=>String(v??'').trim().toLocaleLowerCase('en-US')===wanted);
      }
    }catch(e){keyRecordError=String(e.message||e).slice(0,140);}
  }
  let root=null,readable=false,rootError='';
  try{root=await firebaseGetJson('users',12000);readable=root!==null&&root!==undefined&&typeof root==='object'&&!Array.isArray(root);if(!readable)rootError='users-root-empty-or-invalid';}
  catch(e){rootError=String(e.message||e).slice(0,140);}
  const rows=readable?collectionEntries(root).filter(([key,u])=>u&&typeof u==='object'&&!Array.isArray(u)):[];
  const identityFields=['username','userName','user','handle','login','loginName','email','mail','emailAddress','email_address','uid','firebaseUid','authUid','userId','user_id','authUserId','firebaseKey','databaseKey'];
  const fold=v=>String(v??'').trim().toLocaleLowerCase('en-US');
  const usernameMatchCount=rows.filter(([key,u])=>[key,decodeFirebaseSafeKey(key),...identityFields.map(f=>u[f])].some(v=>fold(v)===wanted)).length;
  const emailMatchCount=validEmail(targetEmail)?rows.filter(([,u])=>firebaseRecordEmail(u)===targetEmail).length:null;
  return {firebaseUsersReadable:readable,firebaseUsersCount:readable?rows.length:null,usernameMatchCount,emailMatchCount,keyRecordFound,keyRecordError:keyRecordError||undefined,keyRecordUsernameMatch,keyRecordEmailMatch,keyProvided:!!rawKey,keyWasFullPath:wasFullPath,firebaseRootError:rootError||undefined};
}
function walletLookupFailureMessage(d){
  if(d?.firebaseRootError==='users-root-empty-or-invalid'){
    return 'استجاب الخادم من Firebase لكن مسار users فارغ أو غير صالح في قاعدة البيانات التي يتصل بها؛ تحقق من FIREBASE_DATABASE_URL قبل تعديل الرصيد.';
  }
  if(!d?.firebaseUsersReadable){
    if(d?.keyRecordFound&&(d.keyRecordUsernameMatch||d.keyRecordEmailMatch)){
      return 'تمت قراءة سجل المستخدم المحدد من Firebase، لكن تعذرت قراءة القائمة الكاملة للتحقق من تطابق بقية الحسابات. لم يتم تغيير الرصيد؛ أعد المحاولة، وإذا تكررت المشكلة راجع مهلة/صلاحية قراءة users.';
    }
    const cause=String(d?.firebaseRootError||d?.keyRecordError||'');
    if(/انتهت مهلة|timeout|timed out|ETIMEDOUT/i.test(cause)){
      return 'انتهت مهلة قراءة مستخدمي Firebase. لم يتم تغيير الرصيد؛ أُعيدت محاولة البحث بالسجل المحدد أولاً، ولم نتمكن من التحقق من الحساب ضمن المهلة.';
    }
    if(/Firebase HTTP 401|Firebase HTTP 403|PERMISSION_DENIED|Permission denied|unauthorized|not authorized/i.test(cause)){
      return 'رفض Firebase القراءة بسبب صلاحيات حساب الخادم (401/403). لم يتم تغيير الرصيد؛ راجع اعتماد حساب الخدمة وصلاحياته.';
    }
    if(/ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|socket/i.test(cause)){
      return 'تعذر الاتصال بخادم Firebase بسبب خطأ شبكة. لم يتم تغيير الرصيد؛ حاول مجدداً بعد استقرار الاتصال.';
    }
    return 'تعذر قراءة قائمة المستخدمين من Firebase التي يتصل بها الخادم. لم يتم تغيير الرصيد. سبب القراءة: '+cause.slice(0,140);
  }
  if(Number(d.firebaseUsersCount||0)===0){
    return 'قاعدة Firebase التي يتصل بها الخادم لا تحتوي سجلات تحت users. قد يكون رابط FIREBASE_DATABASE_URL مختلفاً عن قاعدة البيانات التي فتحتها؛ لم يتم تغيير الرصيد.';
  }
  if(d.keyProvided&&!d.keyRecordFound&&Number(d.usernameMatchCount||0)===0&&Number(d.emailMatchCount||0)===0){
    return 'الخادم لا يجد مفتاح الحساب أو البريد/اسم المستخدم داخل قاعدة Firebase المتصلة به. تحقّق من تطابق FIREBASE_DATABASE_URL ومن نشر إصدار الخادم نفسه؛ لم يتم تغيير الرصيد.';
  }
  return 'لم يتم العثور على سجل Firebase فريد مطابق للحساب. تحقّق من مفتاح السجل والبريد/اسم المستخدم، ولم يتم تغيير أي رصيد.';
}

// Wallet-only legacy-compatible lookup: restore the direct-child-first resolution used in
// releases 1.6.03/1.6.04. Once the requested child matches the username/email, the action does
// not depend on successfully downloading the entire /users collection.
async function findAdminWalletUserLegacy(username,email='',preferredFirebaseKey=''){
  const wanted=String(username||'').trim();
  const target=foldWalletIdentity(wanted);
  const normalizedEmail=normalizeEmail(email);
  if(!wanted)return null;

  const fold=foldWalletIdentity;
  const normalizeChild=value=>{
    let child=String(value||'').trim().replace(/^\/+|\/+$/g,'').replace(/^users\//i,'');
    if(!child||child.includes('/')||child.length>200||/[.#$\[\]\u0000-\u001f]/.test(child))return '';
    return child;
  };
  const fields=['username','userName','user','handle','login','loginName','email','mail','emailAddress','email_address','uid','firebaseUid','authUid','userId','user_id','authUserId','firebaseKey','databaseKey'];
  const candidates=[];
  const preferred=normalizeChild(preferredFirebaseKey);
  if(preferred)candidates.push(preferred);
  const safeUsername=normalizeChild(firebaseSafeKey(wanted));
  if(safeUsername)candidates.push(safeUsername);
  const rawUsername=normalizeChild(wanted);
  if(rawUsername)candidates.push(rawUsername);

  let lastDirectError=null;
  for(const child of [...new Set(candidates)]){
    let user=null;
    try{user=await firebaseGetJson('users/'+child,12000);}
    catch(e){lastDirectError=e;continue;}
    if(!user||typeof user!=='object'||Array.isArray(user))continue;

    const recordUsername=String(user.username||user.userName||user.user||user.handle||user.login||user.loginName||'').trim();
    const recordEmail=firebaseRecordEmail(user);
    const keyMatches=[child,decodeFirebaseSafeKey(child)].some(v=>fold(v)===target);
    const nameMatches=fields.some(f=>fold(user[f])===target);
    const emailMatches=validEmail(normalizedEmail)&&recordEmail===normalizedEmail;

    // A cached key whose record explicitly belongs to another email must never be credited.
    if(validEmail(normalizedEmail)&&recordEmail&&recordEmail!==normalizedEmail){
      if(keyMatches||nameMatches)throw new Error('البريد الإلكتروني لا يطابق سجل Firebase المحدد؛ لم يتم تغيير الرصيد.');
      continue;
    }
    if(!(keyMatches||nameMatches||emailMatches))continue;

    // Historical username-only mode checks duplicates when possible. For the common verified
    // key + exact email case, skip the collection read entirely; that direct path was the old
    // working behavior and avoids the error reported in Railway.
    if(!emailMatches){
      try{
        const root=await firebaseGetJson('users',1200);
        if(root&&typeof root==='object'&&!Array.isArray(root)){
          const rows=collectionEntries(root).filter(([k,v])=>v&&typeof v==='object'&&!Array.isArray(v));
          const sameName=rows.filter(([k,v])=>{
            const actual=String(v.username||v.userName||v.user||v.handle||v.login||v.loginName||'').trim();
            return fold(actual)===target||fold(k)===target||fold(decodeFirebaseSafeKey(k))===target;
          });
          if(sameName.length>1)throw new Error('اسم المستخدم مرتبط بأكثر من سجل Firebase؛ لم يتم تعديل الرصيد.');
        }
      }catch(e){
        if(/مرتبط بأكثر من سجل|مرتبط بأكثر من حساب/.test(String(e.message||e)))throw e;
        // Intentionally ignore full-list read failure after the exact child/name already matched.
      }
    }

    return {
      username:recordUsername||decodeFirebaseSafeKey(child)||wanted,
      user,
      firebasePath:'users/'+child,
      source:'firebase',
      email:recordEmail||normalizedEmail||'',
      preferredFirebaseKey:child
    };
  }

  // If the displayed/legacy child key is unrelated to the username, fall back to the older
  // unique-email matcher and then the username directory matcher.
  if(validEmail(normalizedEmail)){
    const byEmail=await findRemoteUserByEmail(normalizedEmail,preferred,wanted);
    if(byEmail?.firebasePath){
      const recordEmail=firebaseRecordEmail(byEmail.user);
      if(recordEmail&&recordEmail!==normalizedEmail)throw new Error('البريد الإلكتروني لا يطابق سجل Firebase المحدد؛ لم يتم تغيير الرصيد.');
      return byEmail;
    }
  }
  const byUsername=await findRemoteUserByExactUsername(wanted,preferred,normalizedEmail);
  if(byUsername?.firebasePath){
    const recordEmail=firebaseRecordEmail(byUsername.user);
    if(validEmail(normalizedEmail)&&recordEmail&&recordEmail!==normalizedEmail)throw new Error('البريد الإلكتروني لا يطابق سجل Firebase المحدد؛ لم يتم تغيير الرصيد.');
    return byUsername;
  }
  if(lastDirectError)throw new Error('تعذرت قراءة سجل Firebase المحدد: '+String(lastDirectError.message||lastDirectError).slice(0,140));
  return null;
}
function foldWalletIdentity(v){return String(v??'').trim().toLocaleLowerCase('en-US');}

async function resolveAdminWalletUser(username,email='',preferredFirebaseKey=''){
  // Shared resolver for admin charge, deduction, absolute-balance and discount operations.
  return findAdminWalletUserLegacy(username,email,preferredFirebaseKey);
}

function isCustomCategoryImage(meta){
  const image=String(meta?.image||meta?.imageUrl||meta?.imageURL||'').trim();
  return meta?.customImage===true||meta?.imageIsCustom===true||/^data:image\//i.test(image)||/^https?:\/\//i.test(image)||/^\/media\/category\//i.test(image);
}
function mergeCategoryMetaRoots(localRoot,remoteRoot){
  const local=localRoot&&typeof localRoot==='object'&&!Array.isArray(localRoot)?localRoot:{};
  const remote=remoteRoot&&typeof remoteRoot==='object'&&!Array.isArray(remoteRoot)?remoteRoot:{};
  const out={...remote,...local};
  for(const key of new Set([...Object.keys(remote),...Object.keys(local)])){
    const r=remote[key]&&typeof remote[key]==='object'&&!Array.isArray(remote[key])?remote[key]:{};
    const l=local[key]&&typeof local[key]==='object'&&!Array.isArray(local[key])?local[key]:{};
    const merged={...r,...l};
    const localCustom=isCustomCategoryImage(l),remoteCustom=isCustomCategoryImage(r);
    if(localCustom){merged.image=l.image||l.imageUrl||l.imageURL;merged.customImage=true;merged.imageIsCustom=true;}
    else if(remoteCustom){merged.image=r.image||r.imageUrl||r.imageURL;merged.customImage=true;merged.imageIsCustom=true;}
    else merged.image=l.image||l.imageUrl||l.imageURL||r.image||r.imageUrl||r.imageURL||'';
    out[key]=merged;
  }
  return out;
}

function recordSuccessfulUserLogin(username){
  const who=String(username||'').trim();if(!who)return '';
  const at=nowISO();
  try{const store=readJSON('users.json',{users:{}});const users=store.users&&typeof store.users==='object'?store.users:{};const key=Object.keys(users).find(k=>k===who)||Object.keys(users).find(k=>k.toLowerCase()===who.toLowerCase());if(key){users[key]={...users[key],lastLoginAt:at};store.users=users;writeJSON('users.json',store);}}catch(e){console.warn('Could not update local last-login timestamp:',String(e.message||e).slice(0,80));}
  setImmediate(async()=>{try{const record=await findRemoteUserByUsername(who);const pathName=record?.firebasePath||('users/'+firebaseSafeKey(who));await firebasePatchJson(pathName,{lastLoginAt:at},3500);}catch(e){console.warn('Remote last-login timestamp could not be synced:',String(e.message||e).slice(0,80));}});
  return at;
}

async function ensureAdminFirebaseUserProfile(){
  const email=normalizeEmail(ADMIN_USER);
  if(!validEmail(email))throw new Error('بريد حساب الإدارة غير مضبوط؛ لم نغيّر قاعدة البيانات.');
  const root=await firebaseGetJson('users',10000);
  if(root!==null&&root!==undefined&&(typeof root!=='object'||Array.isArray(root)))throw new Error('شكل سجل المستخدمين في Firebase غير متوقع؛ لم يتم إنشاء سجل جديد.');
  const entries=collectionEntries(root);
  const matches=entries.filter(([key,row])=>row&&typeof row==='object'&&!Array.isArray(row)&&(firebaseRecordEmail(row)===email||normalizeEmail(row.username||row.userName||row.user||row.handle)===email||normalizeEmail(decodeFirebaseSafeKey(key))===email));
  if(matches.length>1)throw new Error('يوجد أكثر من سجل مرتبط بحساب الإدارة؛ يلزم الربط اليدوي لتجنّب إنشاء حساب مكرر.');
  if(matches.length===1){
    const [key,row]=matches[0],existingRole=String(row.role||'admin');
    if(existingRole!=='admin')throw new Error('سجل البريد موجود بحساب غير إداري؛ لم يتم تغيير الصلاحيات أو ربط حسابين.');
    const path='users/'+key,at=nowISO();let tx;
    try{tx=await firebaseTransaction(path,current=>{
      if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{missing:true}};
      const currentEmail=firebaseRecordEmail(current),currentName=normalizeEmail(current.username||current.userName||current.user||current.handle);
      if((currentEmail&&currentEmail!==email)||(!currentEmail&&currentName!==email))return {write:false,result:{conflict:true}};
      const role=String(current.role||'admin');if(role!=='admin')return {write:false,result:{wrongRole:true}};
      return {write:true,value:{...current,username:String(current.username||current.userName||current.user||current.handle||ADMIN_USER),email:currentEmail||email,role:'admin',isAdminProfile:true,updatedAt:at},result:{linked:true}};
    },10000,8)}catch(e){throw new Error('تعذر ربط سجل الإدارة في Firebase: '+String(e.message||e).slice(0,100));}
    if(tx.result?.conflict||tx.result?.wrongRole||tx.result?.missing)throw new Error('تغير سجل حساب الإدارة أثناء الربط؛ لم يتم تجاوز تعارض الهوية أو الصلاحيات.');
    const verify=await firebaseGetJson(path,8000);
    if(!verify||firebaseRecordEmail(verify)!==email||verify.isAdminProfile!==true||String(verify.role||'')!=='admin')throw new Error('لم يتم التحقق من سجل حساب الإدارة بعد الحفظ.');
    return {ok:true,created:false,linked:true,username:String(verify.username||ADMIN_USER),email};
  }
  const key=firebaseSafeKey(email),path='users/'+key,existing=await firebaseGetJson(path,7000);
  if(existing&&typeof existing==='object'&&!Array.isArray(existing)){
    if(firebaseRecordEmail(existing)!==email&&normalizeEmail(existing.username||existing.userName||existing.user||existing.handle)!==email)throw new Error('مفتاح حساب الإدارة مستخدم لسجل مختلف؛ لم نكتب فوقه.');
  }
  const at=nowISO();let tx;
  try{tx=await firebaseTransaction(path,current=>{
    if(current&&typeof current==='object'&&!Array.isArray(current)){
      const currentEmail=firebaseRecordEmail(current),currentName=normalizeEmail(current.username||current.userName||current.user||current.handle);
      if(currentEmail!==email&&currentName!==email)return {write:false,result:{conflict:true}};
      return {write:true,value:{...current,username:String(current.username||current.userName||ADMIN_USER),email,role:'admin',isAdminProfile:true,updatedAt:at},result:{linked:true}};
    }
    return {write:true,value:{username:ADMIN_USER,userName:ADMIN_USER,email,fullName:'مدير صدى العراق',role:'admin',isAdminProfile:true,balance:0,createdAt:at,updatedAt:at},result:{created:true}};
  },10000,8)}catch(e){throw new Error('تعذر حفظ سجل حساب الإدارة في Firebase: '+String(e.message||e).slice(0,120));}
  if(tx.result?.conflict)throw new Error('تعذّر ربط حساب الإدارة لأن مفتاح Firebase يحمل هوية مختلفة.');
  const verify=await firebaseGetJson(path,8000);
  if(!verify||firebaseRecordEmail(verify)!==email||verify.isAdminProfile!==true)throw new Error('لم يتم التحقق من سجل حساب الإدارة بعد الحفظ.');
  return {ok:true,created:!!tx.result?.created,linked:!!tx.result?.linked,username:String(verify.username||ADMIN_USER),email};
}
async function findAccountByEmail(email){
  const normalized=normalizeEmail(email),store=readJSON('users.json',{users:{}}),users=store.users||{};
  const local=Object.entries(users).find(([key,u])=>u&&normalizeEmail(u.email||u.mail||u.emailAddress)===normalized);
  if(local)return {username:local[0],user:local[1],firebasePath:'users/'+firebaseSafeKey(local[0]),source:'local'};
  if(normalized===normalizeEmail(ADMIN_USER))return {username:ADMIN_USER,user:{email:ADMIN_USER,role:'admin'},source:'admin'};
  try{const all=await firebaseGetJson('users',5000);if(all&&typeof all==='object'){const found=collectionEntries(all).find(([key,u])=>u&&typeof u==='object'&&!Array.isArray(u)&&normalizeEmail(u.email||u.mail||u.emailAddress)===normalized);if(found)return {username:String(found[1].username||found[1].userName||decodeFirebaseSafeKey(found[0])||found[0]),user:found[1],firebasePath:'users/'+found[0],source:'firebase'};}return null;}catch(e){throw e;}
}
function envProvider(){
  const id=String(process.env.SMM_PROVIDER_ID||process.env.PROVIDER_ID||'').trim();
  const name=String(process.env.SMM_PROVIDER_NAME||process.env.PROVIDER_NAME||'').trim() || id;
  const url=String(process.env.SMM_API_URL||process.env.SMM_URL||process.env.PROVIDER_URL||'').trim();
  const key=String(process.env.SMM_API_KEY||process.env.SMM_KEY||process.env.PROVIDER_KEY||'').trim();
  if(!id||!url||!key) return null;
  return {id,name,url,key,source:'environment'};
}
function normalizeProviderId(value){
  return String(value??'').trim().replace(/[^a-zA-Z0-9_-]/g,'');
}
function usableProviderKey(value){
  const key=String(value??'').trim();
  if(!key) return '';
  // The admin UI may submit a masked placeholder instead of the actual secret.
  if(/^\[(?:hidden|masked|مخفي)\]$/i.test(key) || /^(?:hidden|masked)$/i.test(key) || /^[*•●·＿_\s-]{4,}$/.test(key)) return '';
  return key;
}
function providerIdInStore(store,value){
  const providers=store?.providers||{};
  const wanted=String(value??'').trim();
  if(wanted && Object.prototype.hasOwnProperty.call(providers,wanted)) return wanted;
  const norm=normalizeProviderId(wanted);
  if(norm && Object.prototype.hasOwnProperty.call(providers,norm)) return norm;
  const keys=Object.keys(providers);
  return keys.find(k=>normalizeProviderId(k)===norm && norm) || keys.find(k=>k.toLowerCase()===wanted.toLowerCase() && wanted) || '';
}
function providerStore(){
  // Runtime state is authoritative; deploy archives never ship live provider state.
  const legacy=readJSON('providers.json',{activeProvider:'',providers:{},deletedProviderIds:[]});
  let runtime=readJSON('providers.runtime.json',null);
  if(!runtime || !runtime.providers || typeof runtime.providers!=='object') runtime={activeProvider:'',providers:{},deletedProviderIds:[]};
  const providers={};
  const mergeOne=(id,source)=>{
    if(!source || typeof source!=='object') return;
    const prev=providers[id]||{};
    const merged={...prev,...source};
    for(const field of ['id','name','url']){
      if(!String(merged[field]??'').trim() && String(prev[field]??'').trim()) merged[field]=prev[field];
    }
    const incomingKey=usableProviderKey(source.key);
    const previousKey=usableProviderKey(prev.key);
    merged.key=incomingKey||previousKey||'';
    providers[id]={...merged,id:String(merged.id||id)};
  };
  if(legacy?.providers&&typeof legacy.providers==='object') for(const [id,v] of Object.entries(legacy.providers)) mergeOne(String(id),v);
  if(runtime?.providers&&typeof runtime.providers==='object') for(const [id,v] of Object.entries(runtime.providers)) mergeOne(String(id),v);
  const deleted=new Set([
    ...(Array.isArray(legacy?.deletedProviderIds)?legacy.deletedProviderIds.map(String):[]),
    ...(Array.isArray(runtime?.deletedProviderIds)?runtime.deletedProviderIds.map(String):[])
  ]);
  for(const id of deleted){ for(const key of Object.keys(providers)) if(key===id || normalizeProviderId(key)===normalizeProviderId(id)) delete providers[key]; }
  const env=envProvider();
  if(env && !deleted.has(env.id)) mergeOne(env.id,env);
  let active=String(runtime?.activeProvider||legacy?.activeProvider||'');
  let activeKey=providerIdInStore({providers},active);
  if(!activeKey || !providers[activeKey]?.url || !providers[activeKey]?.key){
    activeKey=Object.keys(providers).find(k=>providers[k]?.url&&providers[k]?.key)||'';
  }
  return {activeProvider:activeKey,providers,deletedProviderIds:deleted,envProvider:env};
}
function getProviderById(id, options={}){
  const store=providerStore();
  const requested=String(id??'').trim();
  let pid=providerIdInStore(store,requested || store.activeProvider);
  let prov=pid?store.providers[pid]:null;
  if((!prov?.url||!prov?.key) && options.allowSingleFallback===true){
    const valid=Object.entries(store.providers||{}).filter(([,v])=>v?.url&&v?.key);
    if(valid.length===1){pid=valid[0][0];prov=valid[0][1];}
  }
  return {store,pid,prov};
}
function normalizeProviderStatus(v){ const x=String(v||'').trim().toLowerCase().replace(/[\s_-]+/g,' '); const map={pending:'pending',waiting:'pending',awaiting:'pending',queued:'pending',processing:'processing','in progress':'processing',inprogress:'processing',completed:'completed',complete:'completed',finished:'completed',partial:'partial','partially completed':'partial',canceled:'cancelled',cancelled:'cancelled',failed:'failed',error:'failed',refunded:'refunded'}; return map[x]||'unknown'; }
function normalizeProviderBalance(d){
  const vals=[];
  const add=(v)=>{ if(v!==undefined&&v!==null&&String(v).trim()!=='') vals.push(v); };
  const walk=(x,depth=0)=>{
    if(x===null||x===undefined||depth>3) return;
    if(typeof x==='object' && !Array.isArray(x)){
      for(const k of ['balance','credits','credit','amount','available_balance','availableBalance','wallet_balance','walletBalance']) add(x[k]);
      for(const k of ['data','result','response','account','wallet','user']) walk(x[k],depth+1);
    }
  };
  add(d?.balance); add(d?.credits); add(d?.credit); walk(d);
  for(const v of vals){
    const raw=String(v).trim().replace(/,/g,'');
    const direct=Number(raw.replace(/^[$€£\s]+/,'').trim());
    if(Number.isFinite(direct)) return direct;
    const m=raw.match(/[-+]?\d+(?:\.\d+)?/);
    if(m){ const n=Number(m[0]); if(Number.isFinite(n)) return n; }
  }
  return null;
}
function normalizeProviderOrderId(d){
  const vals=[
    d?.order,d?.order_id,d?.orderId,d?.providerOrderId,d?.id,
    d?.data?.order,d?.data?.order_id,d?.data?.orderId,d?.data?.id,
    d?.result?.order,d?.result?.order_id,d?.result?.orderId,d?.result?.id
  ];
  for(const v of vals){ if(v!==undefined&&v!==null&&String(v).trim()!=='') return String(v).trim(); }
  return '';
}
function providerReturnedError(d){
  if(!d || typeof d!=='object' || Array.isArray(d)) return false;
  const seen=new Set();
  const walk=(x,depth=0)=>{
    if(x===null||x===undefined||depth>3||typeof x!=='object'||seen.has(x)) return false;
    seen.add(x);
    const e=x.error;
    if(e===true) return true;
    if(typeof e==='string' && e.trim()!=='') return true;
    if(e && typeof e==='object') return true;
    for(const k of ['data','result','response','account','wallet']) if(x[k] && walk(x[k],depth+1)) return true;
    return false;
  };
  return walk(d);
}
function providerErrorText(d){
  if(!d||typeof d!=='object') return '';
  const vals=[d.error,d.message,d.msg,d.reason,d.data?.error,d.data?.message,d.result?.error,d.result?.message];
  for(const v of vals) if(typeof v==='string'&&v.trim()) return v.trim();
  return '';
}
function safeProviderResponse(d){
  if(d===undefined) return null;
  try{return JSON.parse(JSON.stringify(d));}catch(_){return String(d);} 
}

function normalizeProviderCurrency(d){
  return String(d?.currency||d?.data?.currency||d?.result?.currency||d?.account?.currency||'USD').toUpperCase();
}

function providerOriginalServiceName(row={}){
  const candidates=[row.name,row.service_name,row.serviceName,row.title,row.service_title,row.serviceTitle,row.label];
  const generic=/^(?:service|خدمة|service\s*#?\s*\d*|خدمة\s*#?\s*\d*|unknown service|خدمة غير مسماة)$/i;
  for(const value of candidates){const name=String(value??'').trim().replace(/\s+/g,' ');if(name&&name.length>1&&!generic.test(name))return name.slice(0,240);}
  return '';
}
function providerServiceName(row={},id=''){
  return providerOriginalServiceName(row)||(id?('خدمة رقم '+String(id).slice(0,60)):'خدمة غير مسماة');
}
function providerServiceDescription(row={}){
  const keys=['description','desc','serviceDescription','service_description','service_desc','serviceDesc','descriptionText','description_text','serviceDescriptionText','service_description_text','details','serviceDetails','service_details','instructions','note','requirements','info','htmlDescription','descriptionHtml','description_ar','desc_ar','شرح','وصف'];
  const candidates=[row];
  for(const key of ['provider','service','data','details','metadata','meta','attributes']){
    const value=row?.[key];
    if(value&&typeof value==='object'&&!Array.isArray(value))candidates.push(value);
  }
  const toText=value=>{
    if(value===undefined||value===null)return '';
    if(typeof value==='string'||typeof value==='number')return String(value).trim();
    if(Array.isArray(value))return value.map(toText).filter(Boolean).join('\n').trim();
    if(typeof value==='object'){
      for(const key of ['text','description','desc','content','value','html','plain','ar']){
        const text=toText(value[key]);if(text)return text;
      }
    }
    return '';
  };
  for(const candidate of candidates){
    for(const key of keys){const text=toText(candidate?.[key]);if(text)return text.slice(0,4000);}
  }
  return '';
}
function normalizeProviderServices(d){
  let rows=[];
  if(Array.isArray(d))rows=d;
  else if(Array.isArray(d?.services))rows=d.services;
  else if(Array.isArray(d?.data))rows=d.data;
  else if(Array.isArray(d?.result))rows=d.result;
  else if(Array.isArray(d?.items))rows=d.items;
  else for(const key of ['services','data','result','items']){const obj=d?.[key];if(obj&&typeof obj==='object'&&!Array.isArray(obj)){rows=Object.entries(obj).map(([service,v])=>({service,...(v&&typeof v==='object'?v:{value:v})}));break;}}
  return rows.filter(x=>x&&typeof x==='object').map(x=>{
    const id=String(x.service??x.service_id??x.serviceId??x.id??x.sid??x.serviceID??'').trim();
    const name=providerServiceName(x,id);
    const rateKeys=['rate','price','cost','service_rate','serviceRate','rate_usd','rateUsd','usd_rate','usdRate','rate_per_1000','ratePer1000','price_per_1000','pricePer1000'];
    let ratePresent=false,rate=null;
    for(const k of rateKeys){const value=x[k];if(value===undefined||value===null||String(value).trim()==='')continue;const n=Number(String(value).replace(/,/g,''));if(Number.isFinite(n)&&n>=0){rate=n;ratePresent=true;break;}}
    const description=providerServiceDescription(x);
    return {...x,service:id||String(x.service||''),name,rate:ratePresent?rate:0,ratePresent,description,providerDescription:description};
  }).filter(x=>String(x.service||'').trim()!=='');
}

function providerActionSucceeded(action,d,orderId=''){
  if(action!=='cancel') return true;
  const okCancel=(v)=>v===1||v==='1'||v===true||(v&&typeof v==='object'&&!v.error&&(v.cancel===1||v.success===true));
  if(Array.isArray(d)) return d.some(x=>String(x?.order||'')===String(orderId) && okCancel(x?.cancel));
  return okCancel(d?.cancel)||d?.success===true||String(d?.status||'').toLowerCase()==='cancelled';
}
function normalizeWhatsAppUrl(v){
  const raw=String(v||'').trim();
  if(/^https?:\/\/wa\.me\//i.test(raw)) return raw.replace(/\s+/g,'');
  const digits=raw.replace(/\D/g,'');
  if(!digits) return 'https://wa.me/9647762267959';
  const intl=digits.startsWith('964')?digits:(digits.startsWith('0')?'964'+digits.slice(1):digits);
  return 'https://wa.me/'+intl;
}
function normalizeWhatsAppNumber(v){
  const url=normalizeWhatsAppUrl(v); const m=url.match(/wa\.me\/(\d+)/i); return m?m[1]: '9647762267959';
}
function isPrivateAddress(address){
  const a=String(address||'').toLowerCase();
  if(net.isIPv4(a)){ const p=a.split('.').map(Number); return p[0]===10 || p[0]===127 || (p[0]===169&&p[1]===254) || p[0]===0 || (p[0]===192&&p[1]===168) || (p[0]===172&&p[1]>=16&&p[1]<=31); }
  if(net.isIPv6(a)){ return a==='::1'||a.startsWith('fc')||a.startsWith('fd')||a.startsWith('fe8')||a.startsWith('fe9')||a.startsWith('fea')||a.startsWith('feb'); }
  return false;
}
function normalizeProviderApiUrl(raw){
  const u=new URL(String(raw||'').trim());
  const host=u.hostname.toLowerCase();
  // YlaFollow documents https://ylafollow.com/api/v2. Accept the older/common typo /apiv2.
  if(host==='ylafollow.com' && /^\/apiv2\/?$/i.test(u.pathname)) u.pathname='/api/v2';
  // Keep the documented v2 path normalized for YlaFollow.
  return u.toString().replace(/\/$/,'');
}

async function validateProviderUrl(raw){
  const u=new URL(String(raw||'').trim());
  if(!/^https?:$/.test(u.protocol)) throw new Error('API URL يجب أن يبدأ بـ http:// أو https://');
  const h=u.hostname.toLowerCase();
  const localTest = process.env.NODE_ENV==='test' && process.env.ALLOW_LOCAL_PROVIDER_TEST==='1';
  if(!localTest && (h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.endsWith('.internal'))) throw new Error('عنوان المزود غير مسموح');
  const records=await dns.lookup(h,{all:true,verbatim:true}); if(!records.length) throw new Error('تعذر حل اسم مزود API');
  if(!localTest && records.some(x=>isPrivateAddress(x.address))) throw new Error('عنوان API داخلي أو خاص غير مسموح');
  return u;
}

async function providerRequest(prov,params,timeoutMs=30000){
  if(!prov?.url||!prov?.key) throw new Error('بيانات المزود غير مكتملة');
  const rawUrl=normalizeProviderApiUrl(String(prov.url).trim());
  await validateProviderUrl(rawUrl);
  const base=rawUrl.replace(/\/+$/,'');
  const action=String(params?.action||'');
  // Read operations may try both slash variants and limited retries.
  // Order creation must be exactly-once from our side: never retry add automatically.
  const endpoints=[base,base+'/'].filter((v,i,a)=>a.indexOf(v)===i);
  const payload=new URLSearchParams();
  payload.set('key',String(prov.key));
  Object.entries(params||{}).forEach(([k,v])=>{if(v!==undefined&&v!==null&&String(v)!=='')payload.set(k,String(v));});

  async function callForm(endpoint,attempts){
    let lastError=null;
    for(let attempt=1;attempt<=attempts;attempt++) {
      const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
      try{
        const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','Accept':'application/json,text/plain,*/*','User-Agent':`SadaIraq/${APP_VERSION}`},body:payload.toString(),redirect:'follow',signal:controller.signal});
        const text=await r.text(); let d={}; try{d=text?JSON.parse(text):{};}catch(_){d={raw:text};}
        if(!r.ok){ const diagnostic=String(text||'').replace(/(api[_-]?key|key|token|secret)\s*[:=]\s*[^&,\s"'{}]+/ig,'$1=[redacted]').slice(0,180);const err=new Error(`مزود SMM أعاد HTTP ${r.status}${diagnostic?': '+diagnostic:''}`); err.httpStatus=Number(r.status)||0;err.providerDiagnostic=diagnostic;err.providerRejected=r.status>=400&&r.status<500&&![408,425,429].includes(r.status); err.retryable=[408,425,429].includes(r.status)||r.status>=500; throw err; }
        if(providerReturnedError(d)){ const providerText=String(providerErrorText(d)||'المزود رفض العملية');const ambiguousServerFailure=/\bserver error\b|internal server|temporary failure|temporarily unavailable|gateway timeout|upstream timeout|unknown error/i.test(providerText);const err=new Error(providerText);err.providerRejected=!ambiguousServerFailure;err.retryable=ambiguousServerFailure;err.providerErrorCode=String(d.code||d.error_code||d.errorCode||d.status_code||'').slice(0,60);err.providerDiagnostic=providerText.slice(0,180);throw err; }
        return d;
      }catch(e){
        lastError=e; const retryable=e?.name==='AbortError'||e?.retryable;
        if(retryable&&attempt<attempts){await new Promise(r=>setTimeout(r,300*attempt));continue;}
        break;
      }finally{clearTimeout(timer);}
    }
    throw lastError||new Error('تعذر الاتصال بالمزود');
  }

  if(['add','refill','cancel'].includes(action)){
    // Mutating provider actions are one-shot. Never retry them across slash variants
    // or transport attempts: timeouts can hide a successful upstream operation.
    return callForm(endpoints[0],1);
  }

  let lastError=null;
  for(const endpoint of endpoints){
    try{return await callForm(endpoint,3);}catch(e){lastError=e;}
  }

  // Compatibility fallbacks for READ operations only. Never use them for order creation.
  if(['balance','services'].includes(action)){
    for(const endpoint of endpoints){
      const variants=[
        {method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json,text/plain,*/*','User-Agent':`SadaIraq/${APP_VERSION}`},body:JSON.stringify(Object.fromEntries(payload.entries()))}
      ];
      for(const v of variants){
        const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
        try{
          const r=await fetch(v.url||endpoint,{method:v.method,headers:v.headers,body:v.body,redirect:'follow',signal:controller.signal});
          const t=await r.text(); let d={}; try{d=t?JSON.parse(t):{};}catch(_){d={raw:t};}
          if(!r.ok||providerReturnedError(d)) continue;
          return d;
        }catch(_){ } finally{clearTimeout(timer);}
      }
    }
  }
  if(lastError?.name==='AbortError') throw lastError;
  throw lastError||new Error('تعذر الاتصال بالمزود');
}

// Resolve saved provider credentials server-side for the provider-list test button.
// The list endpoint intentionally returns hasKey rather than the secret itself.
async function resolveProviderDiagnosticsInput(body={}){
  const providerId=String(body.providerId||body.provider||body.id||'').trim();
  let prov={name:String(body.name||'مزود').trim(),url:String(body.url||'').trim(),key:usableProviderKey(body.key)};
  if(providerId && !prov.key){
    await ensureProviderRuntime(providerId);
    const saved=getProviderById(providerId,{allowSingleFallback:false}).prov;
    if(saved?.url && saved?.key){
      prov={...saved,name:String(body.name||saved.name||providerId).trim()};
    }
  }
  return prov;
}

function userFromSession(req){ const s=session(req); return (s?.role==='user'||s?.role==='admin') ? String(s.username||'') : ''; }
function appendJsonLedger(file,entry){ const arr=readJSON(file,[]); const next=Array.isArray(arr)?arr:[]; next.push(entry); writeJSON(file,next.slice(-5000)); }

let SITE_ORDER_LOCK=Promise.resolve();
function withSiteOrderLock(fn){ const run=SITE_ORDER_LOCK.catch(()=>{}).then(fn); SITE_ORDER_LOCK=run.finally(()=>{}); return run; }
async function nextSiteOrderId(){
  return withSiteOrderLock(async()=>{
    const cfg=readJSON('settings.json',{}); const n=Math.max(0,Number(cfg.orderCounter||0))+1;
    cfg.orderCounter=n; writeJSON('settings.json',cfg); return String(n);
  });
}
let PUBLIC_ORDER_COUNTER_CACHE={at:0,value:0};
let PUBLIC_ORDER_COUNTER_INIT_PROMISE=null;
const PUBLIC_ORDER_COUNTER_CACHE_MS=15000;
function publicOrderCounterNumber(value){return /^\d{1,9}$/.test(String(value??'').trim())?Number(String(value).trim()):0;}
function maxPublicOrderNumberFromRows(root){
  let max=2999;
  for(const [,o] of collectionEntries(root)){
    if(!o||typeof o!=='object'||Array.isArray(o)||o.event)continue;
    for(const candidate of [o.publicOrderNo,o.publicOrderNumber,o.orderNumber,o.siteOrderId,o.id]){
      const n=publicOrderCounterNumber(candidate);if(n>=3000)max=Math.max(max,n);
    }
  }
  return max;
}
async function ensurePublicOrderCounter(){
  const now=Date.now();
  if(PUBLIC_ORDER_COUNTER_CACHE.value>=2999&&now-PUBLIC_ORDER_COUNTER_CACHE.at<PUBLIC_ORDER_COUNTER_CACHE_MS)return PUBLIC_ORDER_COUNTER_CACHE.value;
  if(PUBLIC_ORDER_COUNTER_INIT_PROMISE)return PUBLIC_ORDER_COUNTER_INIT_PROMISE;
  PUBLIC_ORDER_COUNTER_INIT_PROMISE=(async()=>{
    const counterPath='config/counters/publicOrderNo';
    const cfg=readJSON('settings.json',{});
    let remote=0;
    try{remote=publicOrderCounterNumber(await firebaseGetJson(counterPath,4500));}catch(e){throw new Error('تعذر قراءة عدّاد الطلبات من Firebase: '+String(e.message||e).slice(0,100));}
    if(remote>=2999){
      cfg.publicOrderCounter=Math.max(publicOrderCounterNumber(cfg.publicOrderCounter),remote);cfg.publicOrderCounterInitialized=true;writeJSON('settings.json',cfg);
      PUBLIC_ORDER_COUNTER_CACHE={at:Date.now(),value:remote};return remote;
    }
    let seed=Math.max(2999,publicOrderCounterNumber(cfg.publicOrderCounter));
    // One-time migration only: seed a compact Firebase counter from legacy order records.
    // All subsequent page loads and new orders use the one-number counter node, not the orders root.
    if(cfg.publicOrderCounterInitialized!==true){
      let legacy;
      try{legacy=await firebaseGetJson('orders',15000);}catch(e){throw new Error('تعذر تهيئة عدّاد الطلبات بأمان؛ لم ننشئ رقماً قد يتكرر. '+String(e.message||e).slice(0,100));}
      seed=Math.max(seed,maxPublicOrderNumberFromRows(legacy));
    }
    const tx=await firebaseTransaction(counterPath,current=>{
      const currentNo=publicOrderCounterNumber(current);
      if(currentNo>=2999)return {write:false,result:{number:currentNo}};
      return {write:true,value:seed,result:{number:seed}};
    },10000,10);
    const initialized=publicOrderCounterNumber(tx.result?.number??tx.value);
    if(initialized<2999)throw new Error('تعذر تثبيت عدّاد الطلبات في Firebase.');
    cfg.publicOrderCounter=Math.max(publicOrderCounterNumber(cfg.publicOrderCounter),initialized);cfg.publicOrderCounterInitialized=true;cfg.publicOrderCounterUpdatedAt=nowISO();writeJSON('settings.json',cfg);
    PUBLIC_ORDER_COUNTER_CACHE={at:Date.now(),value:initialized};return initialized;
  })().finally(()=>{PUBLIC_ORDER_COUNTER_INIT_PROMISE=null;});
  return PUBLIC_ORDER_COUNTER_INIT_PROMISE;
}
async function nextPublicOrderNumber(){
  return withSiteOrderLock(async()=>{
    await ensurePublicOrderCounter();
    const counterPath='config/counters/publicOrderNo';
    const tx=await firebaseTransaction(counterPath,current=>{
      const present=publicOrderCounterNumber(current);
      const next=Math.max(2999,present)+1;
      if(!Number.isSafeInteger(next)||next<3000||next>999999999)throw new Error('تعذر تخصيص رقم طلب عرض صالح');
      return {write:true,value:next,result:{number:next}};
    },10000,10);
    const n=publicOrderCounterNumber(tx.result?.number??tx.value);
    if(n<3000)throw new Error('لم يرجع عدّاد الطلبات رقماً صالحاً');
    const cfg=readJSON('settings.json',{});cfg.publicOrderCounter=n;cfg.publicOrderCounterInitialized=true;cfg.publicOrderCounterUpdatedAt=nowISO();writeJSON('settings.json',cfg);
    PUBLIC_ORDER_COUNTER_CACHE={at:Date.now(),value:n};return String(n);
  });
}
function siteOrderById(id){ return readJSON('orders.json',[]).find(o=>String(o.id||'')===String(id||''))||null; }
async function persistOrderToFirebase(order){
  if(!order||typeof order!=='object'||!String(order.id||''))throw new Error('لا يمكن حفظ طلب بلا رقم.');
  const key=firebaseSafeKey(order.id),pathName='orders/'+key;
  await firebaseWriteJson(pathName,order,10000);
  const check=await firebaseGetJson(pathName,10000);
  if(!check||String(check.id||'')!==String(order.id)||String(check.user||check.username||'')!==String(order.user||order.username||''))throw new Error('فشل التحقق من الطلب بعد حفظه في Firebase.');
  return {key,verified:true};
}

function normalizedPath(p){
  if (p.endsWith('.php')) return p.slice(0,-4);
  return p;
}

function acHeaders(){
  return {
    'User-Agent':'okhttp/5.0.0-alpha.2',
    'Connection':'Keep-Alive',
    'Accept-Encoding':'gzip',
    'X-ODP-API-KEY':crypto.randomBytes(16).toString('hex'),
    'DeviceID':crypto.randomUUID(),
    'X-OS-Version':'11',
    'X-Device-Type':'[Android]',
    'X-ODP-APP-VERSION':'4.3.7',
    'X-FROM-APP':'odp',
    'X-ODP-CHANNEL':'mobile',
    'Content-Type':'application/json; charset=UTF-8'
  };
}
async function fetchJSON(url, options={}, timeoutMs=30000){
  const controller = new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(url,{...options,signal:controller.signal,redirect:'follow'});
    const text=await r.text();
    let data={}; try{data=text?JSON.parse(text):{};}catch(_){data={raw:text};}
    if(!r.ok) throw new Error(`HTTP ${r.status}${data?.message?': '+data.message:''}`);
    return data;
  }finally{clearTimeout(timer);}
}
const ASIACELL_API_BASE=String(process.env.ASIACELL_API_BASE||'https://odpapp.asiacell.com/api/v1').trim().replace(/\/+$/,'');
async function acPost(url, headers, payload){
  return fetchJSON(url,{method:'POST',headers,body:JSON.stringify(payload)},30000);
}
function cleanPhone(v){
  let p=String(v||'').replace(/\D/g,'');
  if(p.startsWith('00964')) p='0'+p.slice(5);
  else if(p.startsWith('964')) p='0'+p.slice(3);
  return /^07\d{9}$/.test(p)?p:null;
}

async function apiAsiacell(req,res){
  const inBody=await bodyJSON(req); const action=String(inBody.action||'');
  const webSession=session(req), rawSid=String(sid(req)||'').trim();
  if(!webSession||!rawSid) return json(res,401,{error:'سجّل الدخول إلى حساب صدى العراق أولاً ثم أعد عملية الشحن.'});
  const stateKey=sha256(String(webSession.sessionId||rawSid));
  let operationLock=null;
  if(['reset','start_transfer','confirm_transfer','resend_transfer_code'].includes(action)){
    try{operationLock=await acquireAsiacellOperationLock(stateKey,'transfer')}catch(e){return json(res,503,{error:'لم نبدأ أي طلب تحويل لأن الخادم لم يستطع حجز العملية بأمان في Firebase. تحقق من الاتصال ثم أعد المحاولة بعد التأكد من حالة الجلسة.'});}
    if(!operationLock)return json(res,409,action==='reset'?{ok:false,error:'هناك خطوة آسياسيل قيد التنفيذ. لم نمسح الجلسة أثناء العملية؛ أعد فتح القسم بعد لحظات للتحقق من حالتها.',sessionResetDeferred:true,transferStateUncertain:true}:{error:'هناك خطوة تحويل قيد التنفيذ لهذه الجلسة. انتظر قليلاً ولا ترسل طلب تحويل مكرراً.'});
  }
  try{
  let s=await loadAsiacellSession(stateKey);
  if(s&&(s.owner!==String(webSession.username||'')||(!isAsiacellSafetyCritical(s)&&Date.now()-Number(s.updatedAt||s.createdAt||0)>ASIACELL_SESSION_TTL_MS))){
    await deleteAsiacellSession(stateKey);s=null;
  }
  if(action==='reset'){if(s&&isAsiacellSafetyCritical(s))return json(res,409,{ok:false,error:'حالة تحويل تحتاج الحفاظ على الجلسة حتى لا تضيع عملية أو رصيد. تواصل مع الدعم ولا تبدأ تحويلاً جديداً.',transferStateUncertain:true,sessionResetDeferred:true,step:s.step});const reset=await deleteAsiacellSession(stateKey);return reset?json(res,200,{ok:true,sessionReset:true}):json(res,503,{ok:false,error:'تعذر تأكيد انتهاء الجلسة في Firebase؛ انتظر حتى انتهاء المهلة أو تحقق من الاتصال.',sessionResetPending:true});}
  if(action==='status'){
    const pending=await findPendingAsiacellSession(webSession.username);
    if(pending&&pending.stateKey!==stateKey){
      if(pending.state.step==='provider_confirmed'){
        if(s&&!isAsiacellSafetyCritical(s))await deleteAsiacellSession(stateKey);
        const resumed={...pending.state,owner:String(webSession.username)};
        if(!await saveAsiacellSession(stateKey,resumed))return json(res,503,{error:'هناك تحويل مؤكد يحتاج تثبيت الرصيد، لكن تعذرت استعادة حالته بأمان. لا تبدأ تحويلاً جديداً؛ تواصل مع الدعم.',transferStateUncertain:true});
        await deleteAsiacellSession(pending.stateKey);s=resumed;
      }else{
        if(s&&!isAsiacellSafetyCritical(s))await deleteAsiacellSession(stateKey);
        return json(res,200,{ok:true,hasSession:true,pendingProtected:true,state:String(pending.state.step||''),uiStep:4,locked:true,phone:String(pending.state.phone||''),amount:Number(pending.state.amount||1000),resendCount:Number(pending.state.transferResendAttempts||0),message:'هناك عملية تحويل سابقة غير محسومة. أوقفنا بدء جلسة جديدة لحماية رصيدك؛ تواصل مع الدعم للتحقق من رقم العملية قبل المتابعة.'});
      }
    }
    if(!s)return json(res,200,{ok:true,hasSession:false,state:'none',uiStep:1});
    const uiStep=s.step==='sms'?2:s.step==='amount'?3:4;
    const locked=['starting_transfer','confirming_transfer','resending_transfer_code','resend_uncertain'].includes(String(s.step||''));
    const last=Number(s.lastTransferResendAt||s.transferStartedAt||s.updatedAt||Date.now());
    const resendAfterSeconds=s.step==='transfer_sms'?Math.max(0,Math.ceil((ASIACELL_RESEND_COOLDOWN_MS-(Date.now()-last))/1000)):0;
    return json(res,200,{ok:true,hasSession:true,state:String(s.step||''),uiStep,locked,providerConfirmed:s.step==='provider_confirmed',phone:String(s.phone||''),amount:Number(s.amount||1000),resendCount:Number(s.transferResendAttempts||0),resendAfterSeconds,message:locked?'هناك طلب تحويل سابق غير محسوم؛ لا تبدأ طلباً جديداً.':undefined});
  }
  if(action==='login'&&s&&isAsiacellSafetyCritical(s)){return json(res,409,{ok:false,error:'توجد حالة تحويل سابقة يجب الحفاظ عليها حتى لا يتكرر التحويل أو يضيع الرصيد. تواصل مع الدعم قبل بدء جلسة جديدة.',transferStateUncertain:true,sessionResetDeferred:true,step:s.step});}
  if(action==='login'){
    const pending=await findPendingAsiacellSession(webSession.username);
    if(pending&&pending.stateKey!==stateKey)return json(res,409,{error:'توجد عملية تحويل سابقة غير محسومة. أعد فتح قسم آسياسيل للتحقق من حالتها أو تواصل مع الدعم؛ لم نبدأ جلسة جديدة.',transferStateUncertain:true,step:pending.state.step});
  }
  if(action==='login'){
    const phone=cleanPhone(inBody.phone); if(!phone) return json(res,422,{error:'رقم آسياسيل غير صحيح. استخدم 077xxxxxxxx'});
    const headers=acHeaders();
    try{
      const d=await acPost(`${ASIACELL_API_BASE}/login?lang=en`,headers,{captchaCode:'',username:phone});
      const next=String(d.nextUrl||''); const m=next.match(/PID=([a-f0-9-]+)/i);
      if(!m) throw new Error(d.message || 'فشل إرسال رمز SMS');
      s={owner:String(webSession.username),phone,headers,pid:m[1],step:'sms',createdAt:Date.now(),updatedAt:Date.now()};
      const durable=await saveAsiacellSession(stateKey,s);
      return json(res,200,{ok:true,sessionPersisted:durable,message:'تم طلب رمز SMS من آسياسيل؛ وصول الرسالة يعتمد على شبكة الشركة.',warning:durable?'':'تعذر حفظ الجلسة المشفّرة بشكل دائم؛ لن يبدأ التحويل المالي ما لم ينجح حفظ الجلسة. تحقق من إعدادات Firebase والتشفير.'});
    }catch(e){ return json(res,502,{error:String(e.message||e).slice(0,200)}); }
  }
  if(!s) return json(res,409,{error:'انتهت جلسة آسياسيل. ابدأ من الخطوة الأولى وأرسل رمز SMS جديداً؛ لا يوجد تحويل مالي مؤكد بهذه الجلسة.',sessionExpired:true,restartRequired:true,uiStep:1});
  if(action==='verify_sms'){
    if(s.step!=='sms') return json(res,409,{error:'خطوة التحقق غير متاحة؛ أعد إرسال رمز SMS.'});
    const code=String(inBody.passcode||'').trim(); if(!/^\d{4,8}$/.test(code)) return json(res,422,{error:'رمز SMS غير صحيح'});
    try{
      const d=await acPost(`${ASIACELL_API_BASE}/smsvalidation?lang=en`,s.headers,{PID:s.pid,passcode:code,token:''});
      if(!d.success || !d.access_token) throw new Error(d.message || 'رمز SMS غير صحيح');
      s.headers.Authorization='Bearer '+d.access_token; s.step='amount'; s.updatedAt=Date.now();
      const durable=await saveAsiacellSession(stateKey,s);
      return json(res,200,{ok:true,sessionPersisted:durable,message:'تم التحقق من الرقم بنجاح.',warning:durable?'':'تم التحقق من الرقم، لكن لم يُحفظ رمز الجلسة بشكل دائم؛ أصلح إعداد Firebase قبل بدء التحويل.'});
    }catch(e){ return json(res,502,{error:String(e.message||e).slice(0,200)}); }
  }
  if(action==='start_transfer'){
    if(s.step!=='amount') return json(res,409,{error:s.step==='starting_transfer'?'طلب بدء التحويل قيد التحقق؛ لا تعاود بدء تحويل آخر قبل مراجعة حالة العملية.':'تحقق من رقم آسياسيل أولاً.'});
    const pending=await findPendingAsiacellSession(webSession.username);
    if(pending&&pending.stateKey!==stateKey)return json(res,409,{error:'هناك عملية تحويل سابقة غير محسومة لهذا الحساب. لم نبدأ تحويلاً جديداً لتجنب التكرار؛ افتح قسم آسياسيل أو تواصل مع الدعم للتحقق.',transferStateUncertain:true,step:pending.state.step});
    if(webSession.role!=='user')return json(res,403,{error:'شحن آسياسيل التلقائي متاح لحساب المستخدم فقط.'});
    if(!firebaseServiceAccountConfigured()&&!(process.env.NODE_ENV==='test'&&process.env.FIREBASE_ALLOW_UNAUTHENTICATED==='true'))return json(res,503,{error:'لم يبدأ التحويل لأن اعتماد خادم Firebase غير صالح؛ لم يتم إرسال طلب تحويل آسياسيل. أصلح اعتماد الخادم أولاً.'});
    let accountCheck;try{accountCheck=await findRemoteUserByUsername(webSession.username)}catch(e){return json(res,503,{error:'لم يبدأ التحويل لتعذر التحقق من حسابك في Firebase: '+String(e.message||e).slice(0,140)});}
    if(!accountCheck?.user||!accountCheck.firebasePath)return json(res,404,{error:'لم يبدأ التحويل لأن حسابك غير موجود في قاعدة المستخدمين الحالية.'});
    const amount=Number(inBody.amount||0);
    if(!Number.isInteger(amount) || amount<1000 || amount>10000 || amount%1000!==0) return json(res,422,{error:'المبلغ يجب أن يكون بين 1,000 و10,000 د.ع وبمضاعفات 1,000'});
    s.firebaseUserPath=accountCheck.firebasePath;s.amount=amount;s.step='starting_transfer';s.updatedAt=Date.now();
    if(!await saveAsiacellSession(stateKey,s)){s.step='amount';delete s.amount;delete s.firebaseUserPath;ASIACELL_SESSIONS.set(stateKey,s);return json(res,503,{error:'لم يبدأ التحويل. تعذر حفظ جلسة آسياسيل مشفّرة في Firebase، لذلك لم نرسل طلب تحويل مالي. تحقق من رابط قاعدة البيانات وحساب الخدمة ومفتاح التشفير ثم أعد المحاولة.'});}
    try{
      const d=await acPost(`${ASIACELL_API_BASE}/credit-transfer/start?lang=ar`,s.headers,{amount,receiverMsisdn:FIXED_RECEIVER});
      if(!d.PID) throw new Error(d.message || 'لم يؤكد مزود آسياسيل إنشاء طلب التحويل.');
      s.pid_transfer=String(d.PID);s.amount=amount;s.step='transfer_sms';s.transferStartedAt=Date.now();s.lastTransferResendAt=s.transferStartedAt;s.transferResendAttempts=0;s.updatedAt=Date.now();
      const durable=await saveAsiacellSession(stateKey,s);
      if(!durable)return json(res,503,{error:'طلب التحويل بدأ لدى آسياسيل، لكن تعذر حفظ رقم العملية بشكل دائم. لا تبدأ تحويلاً آخر؛ احتفظ بالرسالة وتواصل مع الدعم قبل إعادة المحاولة.',transferStarted:true});
      return json(res,200,{ok:true,message:'تم طلب رمز تأكيد التحويل من آسياسيل. إذا لم تصلك الرسالة بعد انتهاء العدّ التنازلي، استخدم إعادة إرسال رمز التأكيد.',usd:amount/FIXED_RATE,transferPid:s.pid_transfer,resendAfterSeconds:Math.ceil(ASIACELL_RESEND_COOLDOWN_MS/1000),resendCount:0});
    }catch(e){
      const message=String(e.message||e).slice(0,200);
      if(/^HTTP (400|401|403|422)\b/i.test(message)||/رمز|مبلغ غير صالح|invalid amount/i.test(message)){s.step='amount';delete s.pid_transfer;delete s.amount;delete s.firebaseUserPath;await saveAsiacellSession(stateKey,s);}
      return json(res,502,{error:s.step==='starting_transfer'?'لم يتأكد الخادم هل أنشأ مزود آسياسيل طلب التحويل أم لا. لا تضغط بدء التحويل مرة أخرى؛ راجع الدعم لتجنب تكرار التحويل. تفاصيل المزود: '+message:message,transferStateUncertain:s.step==='starting_transfer'});
    }
  }
  if(action==='resend_transfer_code'){
    if(webSession.role!=='user')return json(res,403,{error:'إعادة طلب رمز آسياسيل متاحة لحساب المستخدم فقط.'});
    if(s.step==='resend_uncertain'||s.step==='resending_transfer_code')return json(res,409,{error:'حالة طلب الرمز الجديد غير محسومة. لا تطلب رمزاً جديداً ولا تؤكد رمزاً قديماً؛ تواصل مع الدعم للتحقق.',transferStateUncertain:true,transferPid:s.pid_transfer||''});
    if(s.step!=='transfer_sms'||!s.pid_transfer||!Number.isInteger(Number(s.amount)))return json(res,409,{error:'لا توجد عملية بانتظار رمز التحويل. ارجع إلى خطوة اختيار المبلغ وابدأ العملية بعد التحقق من الجلسة.'});
    const now=Date.now(),attempts=Number(s.transferResendAttempts||0);
    if(attempts>=ASIACELL_MAX_RESEND_ATTEMPTS)return json(res,429,{error:'وصلت إلى الحد الأقصى لطلب رمز جديد لهذه العملية. لا تبدأ تحويلاً آخر؛ تواصل مع الدعم إذا لم تصلك الرسالة.',resendLimitReached:true,resendCount:attempts});
    const waitMs=ASIACELL_RESEND_COOLDOWN_MS-(now-Number(s.lastTransferResendAt||s.transferStartedAt||s.updatedAt||s.createdAt||now));
    if(waitMs>0)return json(res,429,{error:'انتظر قبل طلب رمز جديد.',retryAfterSeconds:Math.ceil(waitMs/1000),resendCount:attempts});
    const amount=Number(s.amount),previousPid=String(s.pid_transfer);s.step='resending_transfer_code';s.lastTransferResendAt=now;s.transferResendAttempts=attempts+1;s.updatedAt=now;
    if(!await saveAsiacellSession(stateKey,s)){s.step='transfer_sms';s.transferResendAttempts=attempts;await saveAsiacellSession(stateKey,s);return json(res,503,{error:'لم نطلب رمزاً جديداً لأن الخادم لم يستطع حفظ حالة المحاولة بأمان. تحقق من الاتصال ثم حاول لاحقاً.',resendNotSent:true});}
    try{
      // The supported provider API exposes the same start endpoint for requesting a fresh transfer OTP.
      // The transfer is not executed until do-transfer accepts an OTP; only the latest PID is confirmable by this site.
      const d=await acPost(`${ASIACELL_API_BASE}/credit-transfer/start?lang=ar`,s.headers,{amount,receiverMsisdn:FIXED_RECEIVER});
      if(!d.PID)throw new Error(d.message||'لم يؤكد مزود آسياسيل إنشاء طلب رمز جديد.');
      s.pid_transfer=String(d.PID);s.step='transfer_sms';s.updatedAt=Date.now();s.lastTransferResendAt=s.updatedAt;
      const durable=await saveAsiacellSession(stateKey,s);
      if(!durable){s.step='resend_uncertain';await saveAsiacellSession(stateKey,s);return json(res,503,{error:'طلب رمز جديد لدى آسياسيل لكن تعذر حفظ معرفه بشكل دائم. لا تؤكد أي رمز ولا تطلب رمزاً آخر؛ تواصل مع الدعم لتجنب التباس الجلسة.',transferStateUncertain:true,transferStarted:true});}
      return json(res,200,{ok:true,message:'تم طلب رمز تأكيد جديد. استخدم أحدث رمز يصلك؛ قد لا يعمل الرمز السابق.',resendCount:s.transferResendAttempts,resendAfterSeconds:Math.ceil(ASIACELL_RESEND_COOLDOWN_MS/1000),transferPid:s.pid_transfer,previousPidReplaced:previousPid!==s.pid_transfer});
    }catch(e){
      const message=String(e.message||e).slice(0,180);
      if(/^HTTP (400|401|403|422)\b/i.test(message)||/رمز|مبلغ غير صالح|invalid amount/i.test(message)){
        s.step='transfer_sms';s.updatedAt=Date.now();await saveAsiacellSession(stateKey,s);
        return json(res,502,{error:'لم يؤكد المزود إرسال رمز جديد، وبقيت العملية السابقة كما هي. التفاصيل: '+message,resendNotSent:true,resendCount:s.transferResendAttempts});
      }
      s.step='resend_uncertain';s.updatedAt=Date.now();await saveAsiacellSession(stateKey,s);
      return json(res,502,{error:'لم يتأكد الخادم هل أنشأ المزود طلب رمز جديد. لا تؤكد الرمز ولا تعِد الإرسال الآن؛ تواصل مع الدعم للتحقق من الجلسة.',transferStateUncertain:true,transferPid:previousPid});
    }
  }
  if(action==='confirm_transfer'){
    if(s.step==='confirming_transfer')return json(res,409,{error:'طلب تأكيد التحويل السابق نتيجته غير محسومة. لا تعاود إرسال الرمز أو التحويل؛ احتفظ برقم العملية وتواصل مع الدعم.',transferStateUncertain:true,transferPid:s.pid_transfer||''});
    if(s.step==='resend_uncertain'||s.step==='resending_transfer_code')return json(res,409,{error:'حالة طلب الرمز الجديد غير محسومة. لا تؤكد أي رمز؛ تواصل مع الدعم للتحقق.',transferStateUncertain:true,transferPid:s.pid_transfer||''});
    if(s.step==='transfer_sms'){
      const code=String(inBody.passcode||'').trim();if(!/^\d{4,8}$/.test(code))return json(res,422,{error:'رمز التأكيد غير صحيح'});
      // Persist intent before the provider call. If the server restarts mid-request, it will not
      // blindly submit the same money-transfer confirmation a second time.
      s.step='confirming_transfer';s.confirmStartedAt=Date.now();s.updatedAt=Date.now();
      if(!await saveAsiacellSession(stateKey,s)){s.step='transfer_sms';delete s.confirmStartedAt;await saveAsiacellSession(stateKey,s);return json(res,503,{error:'لم يُرسل رمز التأكيد للتحويل لأن الخادم لم يستطع حفظ حالة العملية بأمان. تحقق من Firebase ثم أعد المحاولة.'});}
      try{
        const d=await acPost(`${ASIACELL_API_BASE}/credit-transfer/do-transfer?lang=ar`,s.headers,{PID:s.pid_transfer,passcode:code});
        if(!d.success){s.step='transfer_sms';delete s.confirmStartedAt;await saveAsiacellSession(stateKey,s);throw new Error(d.message||'فشل التحويل');}
        s.step='provider_confirmed';s.transferConfirmedAt=Date.now();s.updatedAt=Date.now();
        // Keep the confirmed state and its user-level recovery pointer until credit is durably applied.
        // A retry then only repeats the idempotent Firebase credit transaction, never the provider transfer.
        if(!await saveAsiacellSession(stateKey,s))return json(res,503,{error:'أكدت آسياسيل التحويل، لكن تعذر حفظ مؤشر الاستعادة الآمن. لا تعِد التحويل أو ترسل الرمز مجدداً؛ تواصل مع الدعم لتثبيت الرصيد.',transferConfirmed:true,transferStateUncertain:true,transferPid:s.pid_transfer||'',amountIQD:s.amount});
      }catch(e){
        const message=String(e.message||e).slice(0,180);
        if(s.step==='confirming_transfer'&&(/^HTTP (400|401|403|422)\b/i.test(message)||/رمز.*(خطأ|غير صحيح)|passcode.*invalid/i.test(message))){s.step='transfer_sms';delete s.confirmStartedAt;await saveAsiacellSession(stateKey,s);}
        return json(res,502,{error:s.step==='confirming_transfer'?'لم يتأكد الخادم من نتيجة التحويل. لا تعاود التحويل؛ احتفظ برقم العملية وتواصل مع الدعم. تفاصيل المزود: '+message:message,transferStateUncertain:s.step==='confirming_transfer',transferPid:s.pid_transfer||''});
      }
    }
    if(s.step!=='provider_confirmed')return json(res,409,{error:'لا توجد عملية تحويل مؤكدة بانتظار تثبيت الرصيد. ابدأ بخطوة إرسال رمز SMS.'});
    const amount=Number(s.amount),username=String(webSession.username||''),transferPid=String(s.pid_transfer||'');
    if(!Number.isInteger(amount)||amount<1000||!transferPid||!s.firebaseUserPath)return json(res,503,{error:'أكدت آسياسيل التحويل، لكن بيانات تثبيت الرصيد غير مكتملة. لا تعِد التحويل؛ احتفظ برقم العملية '+transferPid+' وتواصل مع الدعم.',transferConfirmed:true,transferPid,amountIQD:amount});
    const key='AC_'+transferPid.replace(/[^A-Za-z0-9_-]/g,'_');let tx;
    try{tx=await firebaseTransaction(s.firebaseUserPath,current=>{
      if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-not-found'}};
      const ids=current.asiacellTransferIds&&typeof current.asiacellTransferIds==='object'?current.asiacellTransferIds:{};
      if(ids[key])return {write:false,result:{alreadyCredited:true,record:ids[key],balanceIQD:Number(current.balance||0)}};
      const before=Number(current.balance||0),after=Number((before+amount).toFixed(4)),createdAt=nowISO();
      const receipt={id:key,transferPid,amountIQD:amount,amountUSD:Number((amount/FIXED_RATE).toFixed(6)),createdAt,method:'asiacell',status:'completed'};
      current.balance=after;current.lastRecharge=createdAt;current.asiacellTransferIds={...ids,[key]:receipt};current.updatedAt=createdAt;
      const history=Array.isArray(current.rechargeHistory)?current.rechargeHistory.slice(-99):[];history.push(receipt);current.rechargeHistory=history;
      return {write:true,value:current,result:{alreadyCredited:false,beforeIQD:before,balanceIQD:after,record:receipt}};
    },12000,8)}catch(e){return json(res,503,{error:'أكدت آسياسيل التحويل، لكن تعذر تثبيت الرصيد مركزياً. لا تعِد التحويل؛ أعد المحاولة من نفس نافذة التأكيد لتثبيت الرصيد فقط أو تواصل مع الدعم. رقم العملية '+transferPid+'. التفاصيل: '+String(e.message||e).slice(0,100),transferConfirmed:true,transferPid,amountIQD:amount});}
    if(tx.result?.error)return json(res,503,{error:'تم تأكيد آسياسيل لكن لم يُعثر على حساب المستخدم لتثبيت الرصيد. لا تعِد التحويل؛ رقم العملية '+transferPid,transferConfirmed:true,transferPid,amountIQD:amount});
    const record=tx.result.record||{};const createdAt=record.createdAt||nowISO();
    const balanceIQD=Number(tx.value?.balance??tx.result.balanceIQD??0);
    const receipt={id:key,user:username,username,amount,amountIQD:amount,amountUSD:Number((amount/FIXED_RATE).toFixed(6)),rate:FIXED_RATE,method:'asiacell',methodName:'آسياسيل',provider:'asiacell',source:'asiacell-auto',type:'deposit',receiver:'backend-only',status:'completed',state:'completed',automatic:true,transferPid,createdAt,beforeIQD:tx.result.beforeIQD,balanceIQD};
    let receiptSaved=true,receiptError='';
    try{await firebasePatchJson('',{['asiacellTransfers/'+key]:receipt,['payments/'+key]:receipt,['balanceLedger/'+key]:receipt,['users/'+String(s.firebaseUserPath).replace(/^users\//,'')+'/asiacellTransferIds/'+key]:record},10000)}catch(e){receiptSaved=false;receiptError=String(e.message||e).slice(0,120);console.warn('AsiaCell receipt mirror failed; user receipt remains authoritative:',receiptError)}
    if(!tx.result.alreadyCredited){try{appendJsonLedger('balance_ledger.json',{...receipt,user:username,amountUSD:receipt.amountUSD,type:'deposit',source:'asiacell-auto'});}catch(_){} }
    await deleteAsiacellSession(stateKey);
    return json(res,200,{ok:true,credited:true,alreadyCredited:!!tx.result.alreadyCredited,receiptSaved,balanceIQD,balanceUSD:Number((balanceIQD/FIXED_RATE).toFixed(6)),message:tx.result.alreadyCredited?'هذه العملية مسجلة سابقاً ولم يُضف الرصيد مرة ثانية.':'تم تأكيد التحويل وإضافة الرصيد إلى حسابك بنجاح.',usd:amount/FIXED_RATE,amountIQD:amount,phone:s.phone||'',transferPid,createdAt,receiptWarning:receiptError||undefined});
  }
  return json(res,422,{error:'عملية غير معروفة'});
  }finally{await releaseAsiacellOperationLock(operationLock);}
}

async function apiSmm(req,res,urlObj){
  const wait=rateLimit(req,'provider');
  if(wait) return json(res,429,{error:'طلبات المزود كثيرة، أعد المحاولة لاحقاً'},{'Retry-After':String(wait)});
  if(!isAdmin(req)) return json(res,403,{error:'غير مصرح — جلسة الإدارة غير صالحة. حدّث الجلسة أو سجّل الدخول من جديد.'});
  if(req.method!=='GET' && req.method!=='POST') return json(res,405,{error:'طريقة الطلب غير مدعومة'});
  let body={};
  if(req.method==='POST') { try { body=await bodyJSON(req); } catch(_) { return json(res,400,{error:'بيانات طلب المزود غير صالحة'}); } }
  const requestedId=String(body.provider||body.providerId||urlObj.searchParams.get('provider')||'').trim();
  const action=String(body.action||urlObj.searchParams.get('action')||'balance');
  if(!['balance','services','add','status','cancel'].includes(action)) return json(res,422,{error:'عملية غير مدعومة'});
  let store=await ensureProviderRuntime(requestedId);
  let resolved=getProviderById(requestedId,{allowSingleFallback:!requestedId});
  let {pid:providerId,prov}=resolved;
  const suppliedUrl=String(body.url||body.apiUrl||urlObj.searchParams.get('_url')||'').trim();
  const suppliedKey=String(body.key||body.apiKey||urlObj.searchParams.get('_key')||'').trim();
  if(body.syncProvider===true && requestedId && suppliedUrl && suppliedKey){
    try{
      const id=providerIdInStore(store,requestedId)||normalizeProviderId(requestedId);
      if(!id) throw new Error('معرّف المزود غير صالح');
      const url=normalizeProviderApiUrl(suppliedUrl);
      const name=String(body.name||prov?.name||store.providers?.[id]?.name||id).trim();
      const saved={...(store.providers?.[id]||{}),id,name,url,key:suppliedKey,source:'admin'};
      const providers={...(store.providers||{}),[id]:saved};
      const deleted=[...(store.deletedProviderIds||[])].filter(x=>normalizeProviderId(x)!==normalizeProviderId(id));
      const legacy=readJSON('providers.json',{activeProvider:'',providers:{},deletedProviderIds:[]});
      const legacyDeleted=(Array.isArray(legacy.deletedProviderIds)?legacy.deletedProviderIds:[]).filter(x=>normalizeProviderId(x)!==normalizeProviderId(id));
      writeJSON('providers.json',{...legacy,deletedProviderIds:legacyDeleted});
      const nextActive=body.activateProvider===true?id:(providerIdInStore(store,store.activeProvider)||id);
      writeJSON('providers.runtime.json',{activeProvider:nextActive,providers,deletedProviderIds:deleted,updatedAt:nowISO()});
      const k=firebaseSafeKey(id);
      await Promise.allSettled([
        firebaseWriteJson('config/smmProviders/'+k,{id,name,url,hasKey:true}),
        firebaseWriteJson('config/smmProviderSecrets/'+k,{id,name,url,key:suppliedKey}),
        firebaseWriteJson('config/smmActive',nextActive)
      ]);
      store=providerStore(); resolved=getProviderById(id,{allowSingleFallback:false});
      providerId=resolved.pid||id; prov=resolved.prov||saved;
    }catch(e){return json(res,422,{error:'تعذر تثبيت بيانات المزود: '+String(e.message||e)});}
  } else if((!prov?.url||!prov?.key) && suppliedUrl && suppliedKey){
    try{prov={...(prov||{}),id:providerId||requestedId,name:String(body.name||prov?.name||providerId||requestedId),url:normalizeProviderApiUrl(suppliedUrl),key:suppliedKey};}
    catch(_){return json(res,422,{error:'رابط API للمزود غير صالح'});}
  }
  if(!prov?.url||!prov?.key){
    await ensureProviderRuntime(requestedId).catch(()=>{});
    resolved=getProviderById(requestedId,{allowSingleFallback:!requestedId}); providerId=resolved.pid||requestedId; prov=resolved.prov;
  }
  if(!prov?.url||!prov?.key){
    const current=providerStore();
    const available=Object.entries(current.providers||{}).filter(([,v])=>v?.url&&v?.key).map(([id,v])=>({id,name:String(v.name||id)}));
    return json(res,404,{error:'تعذر العثور على مفتاح API المحفوظ لهذا المزود. أعد تحميل إعدادات المزود أو افتح التعديل وأعد حفظ المفتاح.',providerId:requestedId||null,availableProviders:available});
  }
  const payload={...body,action};
  for(const k of ['provider','providerId','url','apiUrl','key','apiKey','syncProvider','activateProvider','name']) delete payload[k];
  for(const k of ['service','link','quantity','order','orders']) if(payload[k]===undefined && urlObj.searchParams.has(k)) payload[k]=urlObj.searchParams.get(k);
  if(action==='cancel' && payload.orders===undefined && payload.order!==undefined){payload.orders=payload.order;delete payload.order;}
  try{
    const d=await providerRequest(prov,payload);
    if(action==='balance'){
      const balance=normalizeProviderBalance(d);
      if(balance===null) return json(res,502,{error:'المزود لم يرجع رصيداً رقمياً صالحاً',providerId,providerName:prov.name||providerId});
      return json(res,200,{ok:true,balance,currency:normalizeProviderCurrency(d),providerId,providerName:prov.name||providerId,checkedAt:new Date().toISOString()});
    }
    if(action==='services')return json(res,200,normalizeProviderServices(d));
    return json(res,200,d);
  }catch(e){return json(res,502,{error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':String(e.message||'تعذر الاتصال بالمزود'),providerId,providerName:prov.name||providerId});}
}

function readNotifications(){ return readJSON('notifications.json',[]); }
function writeNotifications(v){ writeJSON('notifications.json',Array.isArray(v)?v:[]); }
function readNotificationSeen(){ return readJSON('notification_seen.json',{}); }
function writeNotificationSeen(v){ writeJSON('notification_seen.json',v&&typeof v==='object'?v:{}); }
function notifId(){ return 'N'+Date.now().toString(36)+crypto.randomBytes(3).toString('hex'); }
function sanitizeNotification(n){ const m=n.meta&&typeof n.meta==='object'?n.meta:{};const meta={};for(const k of ['serviceName','providerName'])if(m[k]!==undefined)meta[k]=String(m[k]||'').slice(0,140);if(m.quantity!==undefined&&Number.isFinite(Number(m.quantity)))meta.quantity=Number(m.quantity);if(m.providerOrderId!==undefined)meta.providerOrderId=String(m.providerOrderId||'').slice(0,80);const type=String(n.type||'');const delaySeconds=Number.isFinite(Number(n.delaySeconds))?Math.max(1,Math.min(600,Math.round(Number(n.delaySeconds)))):5;return {id:String(n.id||''),title:String(n.title||''),message:String(n.message||''),url:String(n.url||''),required:!!n.required,active:n.active!==false,createdAt:n.createdAt||new Date().toISOString(),updatedAt:n.updatedAt||n.createdAt||new Date().toISOString(),...(n.orderId?{orderId:String(n.orderId)}:{}),...(type?{type}:{}),...(type==='temporary_page'?{delaySeconds}:{}),...(n.status?{status:String(n.status)}:{}),...(Object.keys(meta).length?{meta}:{}),read:!!n.read}; }
function userNotifId(username,type,orderId,status=''){return 'UN'+sha256([username,type,orderId,status].map(x=>String(x||'')).join('|')).slice(0,24)}
function createUserNotification(username, data={}){
  const user=String(username||'').trim();if(!user)return null;
  const type=String(data.type||'info'),orderId=String(data.orderId||''),status=String(data.status||'');
  const id=String(data.id||userNotifId(user,type,orderId,status));
  const n={id,user,title:String(data.title||'إشعار جديد').slice(0,160),message:String(data.message||'').slice(0,1500),orderId,type,status,createdAt:data.createdAt||nowISO(),url:String(data.url||''),read:false,active:true,...(data.meta&&typeof data.meta==='object'?{meta:data.meta}:{})};
  const all=readJSON('user_notifications.json',{});const rows=Array.isArray(all[user])?all[user]:[];
  if(!rows.some(x=>String(x.id)===id)){rows.unshift(n);all[user]=rows.slice(0,300);writeJSON('user_notifications.json',all);}
  const remote={...n};delete remote.user;
  firebaseWriteJson('userNotifications/'+firebaseSafeKey(user)+'/'+id,remote,4500).catch(()=>{});
  return n;
}
async function listUserNotifications(username){
  const user=String(username||'').trim(),all=readJSON('user_notifications.json',{}),local=Array.isArray(all[user])?all[user]:[];let remote=[];
  try{const v=await firebaseGetJson('userNotifications/'+firebaseSafeKey(user),4500);if(v&&typeof v==='object')remote=(Array.isArray(v)?v:Object.values(v)).filter(x=>x&&typeof x==='object').map(x=>({...x,user}));}catch(_){}
  const merged=new Map();for(const n of [...remote,...local]){if(n?.id)merged.set(String(n.id),{...merged.get(String(n.id)),...n,user});}
  const seen={...(readNotificationSeen()[user]||{})};try{const rs=await firebaseGetJson('userNotificationSeen/'+firebaseSafeKey(user),3000);if(rs&&typeof rs==='object')Object.assign(seen,rs)}catch(_){}
  const own=[...merged.values()].map(n=>({...sanitizeNotification(n),read:!!(n.read||seen[n.id]),user}));
  const broadcasts=readNotifications().filter(n=>n.active!==false).map(n=>{const clean=sanitizeNotification(n);return {...clean,read:!!seen[clean.id],type:clean.type||'broadcast'};});
  return [...own,...broadcasts].sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0)).slice(0,500);
}

function ownedProviderOrder(username,providerId,providerOrderId){
  const rows=readJSON('orders.json',[]); return Array.isArray(rows) && rows.some(x=>String(x.user||'')===String(username||'') && String(x.providerId||'')===String(providerId||'') && String(x.providerOrderId||'')===String(providerOrderId||''));
}


function nowISO(){ return new Date().toISOString(); }
function sha256(v){ return crypto.createHash('sha256').update(String(v||'')).digest('hex'); }
// Provider secrets use a dedicated key when configured. Legacy decrypt fallback preserves
// provider credentials saved by older releases while the operator rotates to SADA_ENCRYPTION_KEY.
const LEGACY_PROVIDER_ENCRYPTION_SECRET='sadairaq-session-secret-change-me';
function persistentEncryptionSecret(){
  // A random key is safe as a fallback only when DATA is on durable storage; never claim a
  // release-local key will survive redeployment or encrypt remotely persisted secrets with it.
  if(!DATA_IS_EXTERNAL)return '';
  const file=path.join(DATA,'.sada-encryption-key');
  try{
    fs.mkdirSync(DATA,{recursive:true});
    const existing=String(fs.readFileSync(file,'utf8')||'').trim();
    if(existing.length>=32)return existing;
  }catch(_){}
  try{
    const value=crypto.randomBytes(48).toString('base64url');
    try{fs.writeFileSync(file,value,{encoding:'utf8',flag:'wx',mode:0o600});return value;}
    catch(e){if(e&&e.code==='EEXIST'){const existing=String(fs.readFileSync(file,'utf8')||'').trim();if(existing.length>=32)return existing;}throw e;}
  }catch(e){console.warn('Persistent encryption key unavailable:',String(e.message||e).slice(0,100));return '';}
}
function preferredEncryptionSecret(){
  const dedicated=String(process.env.SADA_ENCRYPTION_KEY||'').trim();
  if(dedicated.length>=32)return dedicated;
  const sessionSecret=String(process.env.SESSION_SECRET||'').trim();
  if(sessionSecret.length>=32 && sessionSecret!=='sadairaq-session-secret-change-me')return sessionSecret;
  // A deliberately configured strong admin password is stable across deploys too.
  const adminSecret=String(process.env.ADMIN_PASSWORD||'').trim();
  if(adminSecret.length>=32)return adminSecret;
  // Railway containers can be replaced. Derive a stable, purpose-separated key from the
  // private server-side Firebase service credential so encrypted Telegram settings survive
  // deploy/restart even when the ephemeral local directory does not.
  try{
    const status=firebaseServiceAccountStatus();
    if(status?.ok&&status.value?.private_key&&status.value?.project_id){
      return crypto.createHash('sha512').update('SadaIraq|telegram-token-encryption|v1|'+status.value.project_id+'|'+status.value.private_key).digest('hex');
    }
  }catch(_){}
  return persistentEncryptionSecret();
}
function telegramEncryptionReady(){return !!preferredEncryptionSecret();}
function apiCipherKey(secret){
  const chosen=arguments.length?String(secret||''):String(preferredEncryptionSecret()||process.env.SESSION_SECRET||process.env.ADMIN_PASSWORD||LEGACY_PROVIDER_ENCRYPTION_SECRET);
  return crypto.createHash('sha256').update(chosen).digest();
}
function encryptSecret(plain){
  const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',apiCipherKey(),iv);
  const enc=Buffer.concat([c.update(String(plain||''),'utf8'),c.final()]);
  const tag=c.getAuthTag();
  return Buffer.concat([iv,tag,enc]).toString('base64url');
}
function decryptSecret(blob){
  const b=Buffer.from(String(blob||''),'base64url'); if(b.length<28)return '';
  const iv=b.subarray(0,12),tag=b.subarray(12,28),enc=b.subarray(28);
  const candidates=[apiCipherKey()];
  for(const secret of [process.env.SESSION_SECRET,process.env.ADMIN_PASSWORD,LEGACY_PROVIDER_ENCRYPTION_SECRET,persistentEncryptionSecret()].filter(Boolean)){const key=apiCipherKey(String(secret));if(!candidates.some(existing=>existing.equals(key)))candidates.push(key);}
  for(const key of candidates){try{const d=crypto.createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(tag);return Buffer.concat([d.update(enc),d.final()]).toString('utf8')}catch(_){}}
  return '';
}
function newApiKey(){ return 'sr_'+crypto.randomBytes(32).toString('base64url'); }
const API_USER_LOCKS=new Map();
async function withApiUserLock(username,fn){
  const k=String(username||''); let tail=API_USER_LOCKS.get(k)||Promise.resolve();
  const run=tail.catch(()=>{}).then(fn); let tracked;
  tracked=run.finally(()=>{if(API_USER_LOCKS.get(k)===tracked)API_USER_LOCKS.delete(k)});
  API_USER_LOCKS.set(k,tracked); return tracked;
}
// Use the explicitly configured Railway database URL when present, and fall back to
// the bundled Sada Iraq database only when no URL was configured. The previous production
// build silently ignored FIREBASE_DATABASE_URL, so key creation and validation could point
// at different Firebase projects and return 401 for keys that exist in the intended database.
// This single effective URL is shared by all Firebase reads, writes and transactions.
const BUNDLED_FIREBASE_DATABASE_URL='https://sada-iraq-app-default-rtdb.firebaseio.com';
const CONFIGURED_FIREBASE_DATABASE_URL=String(process.env.FIREBASE_DATABASE_URL||'').trim().replace(/\/+$/,'');
const FIREBASE_DATABASE_URL_SOURCE=CONFIGURED_FIREBASE_DATABASE_URL?'railway-environment':'bundled-default';
const FIREBASE_DATABASE_URL=String(CONFIGURED_FIREBASE_DATABASE_URL||BUNDLED_FIREBASE_DATABASE_URL).trim().replace(/\/+$/,'');
function firebaseDatabaseDiagnosticInfo(){
  let host='',databaseProjectHint='';
  try{
    const u=new URL(FIREBASE_DATABASE_URL);host=u.host.toLowerCase();
    const first=host.split('.')[0];
    if(host.endsWith('.firebaseio.com')||host.endsWith('.firebasedatabase.app'))databaseProjectHint=first.replace(/-default-rtdb$/,'');
  }catch(_){}
  const credential=firebaseServiceAccountStatus();
  const serviceAccountProjectId=credential.ok?String(credential.value.project_id||''):'';
  const configuredWebProjectId=String(process.env.FIREBASE_PROJECT_ID||FIREBASE_WEB_CONFIG.projectId||'').trim();
  const serviceAccountProjectMatch=serviceAccountProjectId&&databaseProjectHint?serviceAccountProjectId===databaseProjectHint:null;
  return {host,source:FIREBASE_DATABASE_URL_SOURCE,databaseProjectHint,serviceAccountProjectId,configuredWebProjectId,serviceAccountProjectMatch};
}
const FIREBASE_WEB_CONFIG={
  apiKey:String(process.env.FIREBASE_WEB_API_KEY||'').trim(),
  authDomain:String(process.env.FIREBASE_AUTH_DOMAIN||'sada-iraq-app.firebaseapp.com').trim(),
  projectId:String(process.env.FIREBASE_PROJECT_ID||'sada-iraq-app').trim(),
  storageBucket:String(process.env.FIREBASE_STORAGE_BUCKET||'sada-iraq-app.firebasestorage.app').trim(),
  messagingSenderId:String(process.env.FIREBASE_MESSAGING_SENDER_ID||'909760807242').trim(),
  appId:String(process.env.FIREBASE_APP_ID||'1:909760807242:web:641e274f7689680a8181b3').trim()
};
function firebaseWebConfig(){return FIREBASE_DATABASE_URL?{...FIREBASE_WEB_CONFIG,databaseURL:FIREBASE_DATABASE_URL}:null;}
function firebaseSafeKey(value){ const s=String(value??''); return Array.from(s).map(ch=>{const cp=ch.codePointAt(0); return /^[A-Za-z0-9_-]$/.test(ch)?ch:'_x'+cp.toString(16)+'_';}).join('')||'_empty'; }
function firebaseServiceAccountStatus(){
  // Never bundle credentials in the release. Inspect only server-side environment secrets
  // or an explicitly configured file located outside the served project directory.
  const rawJson=String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON||process.env.GOOGLE_SERVICE_ACCOUNT_JSON||'').trim();
  const rawBase64=String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64||'').trim();
  let value=null,source='';
  if(rawJson){
    source='environment-json';
    try{value=JSON.parse(rawJson)}catch(_){return {ok:false,code:'invalid_json',source,message:'FIREBASE_SERVICE_ACCOUNT_JSON لا يحتوي JSON صالحاً.'};}
  }else if(rawBase64){
    source='environment-base64';
    try{
      const decoded=Buffer.from(rawBase64,'base64');
      // Buffer.from(base64) is permissive; round-trip validation catches truncated/invalid input.
      const normalized=rawBase64.replace(/\s+/g,'').replace(/=+$/,'');
      if(!normalized||decoded.toString('base64').replace(/=+$/,'')!==normalized)throw new Error('invalid base64');
      value=JSON.parse(decoded.toString('utf8'));
    }catch(_){return {ok:false,code:'invalid_base64_json',source,message:'FIREBASE_SERVICE_ACCOUNT_BASE64 لا يحتوي JSON صالحاً بترميز Base64.'};}
  }else{
    const configuredPath=String(process.env.FIREBASE_SERVICE_ACCOUNT_FILE||process.env.GOOGLE_APPLICATION_CREDENTIALS||'').trim();
    const bundledPrivatePath=path.join(ROOT,'firebase-service-account.json');
    const useBundledPrivateFile=process.env.NODE_ENV!=='test'&&process.env.FIREBASE_DISABLE_LOCAL_CREDENTIAL_FILE!=='true'&&fs.existsSync(bundledPrivatePath);
    if(configuredPath||useBundledPrivateFile){
      source=configuredPath?'private-file':'bundled-server-file';
      const credentialPath=configuredPath?path.resolve(configuredPath):bundledPrivatePath;
      const relativeToRoot=path.relative(ROOT,credentialPath);
      const isInsideProject=relativeToRoot===''||(!relativeToRoot.startsWith('..'+path.sep)&&relativeToRoot!=='..'&&!path.isAbsolute(relativeToRoot));
      const isExactBundledPrivateFile=credentialPath===bundledPrivatePath;
      // Only the explicitly named, server-only credential file is permitted inside ROOT.
      // The static-file handler separately denies this basename for all HTTP paths.
      if(isInsideProject&&!isExactBundledPrivateFile){
        return {ok:false,code:'credential_file_public',source,message:'يجب حفظ ملف حساب الخدمة خارج مجلد الملفات العامة، باستثناء الملف الخاص firebase-service-account.json.'};
      }
      try{value=JSON.parse(fs.readFileSync(credentialPath,'utf8'))}
      catch(_){return {ok:false,code:'credential_file_unreadable',source,message:'تعذر قراءة ملف حساب خدمة Firebase من المسار الخاص المحدد.'};}
    }else return {ok:false,code:'missing',source:'none',message:'يلزم إعداد سر FIREBASE_SERVICE_ACCOUNT_JSON على الخادم.'};
  }
  if(!value||typeof value!=='object'||Array.isArray(value))return {ok:false,code:'invalid_shape',source,message:'بيانات حساب خدمة Firebase ليست كائناً صالحاً.'};
  if(value.type!=='service_account'||!value.client_email||!value.private_key||!value.project_id)
    return {ok:false,code:'incomplete_credentials',source,message:'بيانات حساب خدمة Firebase ناقصة.'};
  if(value.project_id!=='sada-iraq-app')return {ok:false,code:'wrong_project',source,message:'حساب الخدمة لا يخص مشروع Firebase sada-iraq-app.'};
  const key=String(value.private_key).replace(/\\n/g,'\n');
  if(!key.includes('-----BEGIN PRIVATE KEY-----')||!key.includes('-----END PRIVATE KEY-----'))
    return {ok:false,code:'invalid_private_key',source,message:'صيغة المفتاح الخاص في حساب خدمة Firebase غير صالحة.'};
  try{crypto.createPrivateKey(key)}catch(_){return {ok:false,code:'invalid_private_key',source,message:'المفتاح الخاص في حساب خدمة Firebase غير قابل للقراءة.'};}
  value.private_key=key;
  return {ok:true,code:'valid',source,value,message:'اعتماد حساب الخدمة موجود وصيغته صالحة للمشروع المحدد.'};
}
function firebaseServiceAccount(){
  const status=firebaseServiceAccountStatus();
  if(!status.ok){
    if(status.code==='missing')return null;
    throw Object.assign(new Error(status.message),{code:'firebase_credentials_'+status.code});
  }
  return status.value;
}
function firebaseServiceAccountConfigured(){return firebaseServiceAccountStatus().ok;}
let firebaseGoogleAuth=null,firebaseGoogleAuthKey='';
async function firebaseAuthContext(){
  if(!FIREBASE_DATABASE_URL)throw new Error('رابط قاعدة Firebase المضمّن غير مضبوط؛ لم تتم الكتابة إلى أي قاعدة أخرى.');
  let dbUrl;try{dbUrl=new URL(FIREBASE_DATABASE_URL)}catch(_){throw new Error('FIREBASE_DATABASE_URL ليس رابطاً صالحاً.');}
  if(dbUrl.username||dbUrl.password||dbUrl.search||dbUrl.hash)throw new Error('FIREBASE_DATABASE_URL يجب ألا يحتوي بيانات دخول أو query/hash.');
  if(!/^https:$/.test(dbUrl.protocol)&&!(process.env.NODE_ENV==='test'&&/^http:$/.test(dbUrl.protocol)))throw new Error('يجب أن يكون FIREBASE_DATABASE_URL رابط HTTPS في الإنتاج.');
  if(process.env.NODE_ENV!=='test'&&!(/(^|\.)firebaseio\.com$/i.test(dbUrl.hostname)||/(^|\.)firebasedatabase\.app$/i.test(dbUrl.hostname)))throw new Error('FIREBASE_DATABASE_URL لا يبدو رابط Firebase Realtime Database صالحاً.');
  if(process.env.NODE_ENV==='test'&&process.env.FIREBASE_ALLOW_UNAUTHENTICATED==='true')return {queryAuth:'',headers:{}};
  const secret=String(process.env.FIREBASE_DATABASE_SECRET||'').trim();
  if(secret)return {queryAuth:secret,headers:{}};
  const account=firebaseServiceAccount();
  if(!account)throw new Error('يلزم إعداد سر FIREBASE_SERVICE_ACCOUNT_JSON (أو FIREBASE_SERVICE_ACCOUNT_BASE64) في الاستضافة؛ لم تتم الكتابة إلى قاعدة البيانات.');
  const key=String(account.client_email)+'|'+String(account.private_key).slice(-80);
  if(!firebaseGoogleAuth||firebaseGoogleAuthKey!==key){const {GoogleAuth}=require('google-auth-library');firebaseGoogleAuth=new GoogleAuth({credentials:account,scopes:['https://www.googleapis.com/auth/firebase.database','https://www.googleapis.com/auth/userinfo.email']});firebaseGoogleAuthKey=key;}
  const client=await firebaseGoogleAuth.getClient();const access=await client.getAccessToken();const token=typeof access==='string'?access:access?.token;
  if(!token)throw new Error('تعذر إنشاء رمز وصول لحساب خدمة Firebase.');
  return {queryAuth:'',headers:{Authorization:'Bearer '+token}};
}
function firebasePathUrl(pathname,queryAuth=''){
  const path=String(pathname||'').replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  const u=new URL(FIREBASE_DATABASE_URL+'/'+path+'.json');if(queryAuth)u.searchParams.set('auth',queryAuth);return u;
}
async function firebaseRequest(pathname,method='GET',value=undefined,timeoutMs=8000,extraHeaders={}){
  const auth=await firebaseAuthContext(),u=firebasePathUrl(pathname,auth.queryAuth),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const headers={'Accept':'application/json',...auth.headers,...extraHeaders};const opts={method,headers,signal:controller.signal};
    if(value!==undefined){headers['Content-Type']='application/json';opts.body=JSON.stringify(value);}
    const r=await fetch(u,{...opts,redirect:'error'});const text=await r.text();let data=null;try{data=text?JSON.parse(text):null}catch(_){data=text;}
    if(!r.ok){const detail=(typeof data==='string'?data:(data&&typeof data==='object'?JSON.stringify(data):''));throw new Error('Firebase HTTP '+r.status+(detail?': '+detail.slice(0,180):''));}
    return {data,headers:r.headers,status:r.status};
  }finally{clearTimeout(timer);}
}
let firebaseAdminApp=null;
function firebaseAdminDatabase(){
  const account=firebaseServiceAccount();
  if(!account)throw new Error('يلزم إعداد سر FIREBASE_SERVICE_ACCOUNT_JSON في بيئة الخادم قبل الاتصال بقاعدة Firebase.');
  let sdkApp,sdkDatabase;
  try{sdkApp=require('firebase-admin/app');sdkDatabase=require('firebase-admin/database')}catch(_){throw new Error('اعتماد firebase-admin غير مثبت على الخادم؛ أعد تثبيت تبعيات المشروع.');}
  if(!firebaseAdminApp){
    const appName='sadairaq-server';
    firebaseAdminApp=sdkApp.getApps().find(app=>app.name===appName)||sdkApp.initializeApp({credential:sdkApp.cert(account),databaseURL:FIREBASE_DATABASE_URL},appName);
  }
  return sdkDatabase.getDatabase(firebaseAdminApp);
}
function firebaseAdminMessaging(){
  const account=firebaseServiceAccount();
  if(!account)throw new Error('إشعارات الهاتف تحتاج FIREBASE_SERVICE_ACCOUNT_JSON صالحاً على الخادم.');
  let sdkApp,sdkMessaging;try{sdkApp=require('firebase-admin/app');sdkMessaging=require('firebase-admin/messaging')}catch(_){throw new Error('اعتماد firebase-admin/messaging غير متاح؛ أعد تثبيت تبعيات المشروع.');}
  if(!firebaseAdminApp){const appName='sadairaq-server';firebaseAdminApp=sdkApp.getApps().find(app=>app.name===appName)||sdkApp.initializeApp({credential:sdkApp.cert(account),databaseURL:FIREBASE_DATABASE_URL},appName);}
  return sdkMessaging.getMessaging(firebaseAdminApp);
}
function mediaTypeForImage(ext){return ({'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'})[String(ext||'').toLowerCase()]||'application/octet-stream';}
function publicBaseUrl(req){
  const configured=String(process.env.PUBLIC_APP_URL||process.env.SITE_PUBLIC_URL||'').trim();
  if(configured){try{const u=new URL(configured);if(['https:','http:'].includes(u.protocol)&&u.hostname)return u.origin;}catch(_) {}}
  const host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim();
  if(!/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(host))throw new Error('تعذر تحديد رابط الموقع العام؛ اضبط PUBLIC_APP_URL في الاستضافة.');
  const protocol=String(req.headers['x-forwarded-proto']||'https').split(',')[0].trim().toLowerCase()==='http'&&process.env.NODE_ENV==='test'?'http':'https';return protocol+'://'+host;
}
function firebaseWithTimeout(operation,timeoutMs,label){
  let timer;
  return Promise.race([Promise.resolve(operation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('انتهت مهلة عملية Firebase: '+label)),Math.max(1000,Number(timeoutMs)||8000));})]).finally(()=>clearTimeout(timer));
}
// Keep Realtime Database reads/writes on the same REST + service-account OAuth path as the
// Firebase connection/health check. In v1.5.94 the Admin SDK became the implicit production
// path while health checks still used REST, allowing the check to pass while wallet reads failed.
// Admin SDK use is now an explicit opt-in only; no Railway variable is required for the default.
function firebaseAdminEnabled(){return false; /* RTDB operations are pinned to REST/OAuth to match the connectivity probe. */}
async function firebaseGetJson(pathname,timeoutMs=8000){
  if(firebaseAdminEnabled()){
    const snap=await firebaseWithTimeout(firebaseAdminDatabase().ref(String(pathname||'/')).once('value'),timeoutMs,'read');
    return snap.val();
  }
  return (await firebaseRequest(pathname,'GET',undefined,timeoutMs)).data;
}
// Indexed Firebase Realtime Database query. This lets admin screens and monitors read only
// a bounded/relevant subset rather than downloading the entire root node.
async function firebaseGetQueryJson(pathname,query={},timeoutMs=8000){
  const auth=await firebaseAuthContext(),u=firebasePathUrl(pathname,auth.queryAuth);
  for(const [key,value] of Object.entries(query||{}))if(value!==undefined&&value!==null)u.searchParams.set(String(key),String(value));
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(u,{method:'GET',headers:{'Accept':'application/json',...auth.headers},signal:controller.signal,redirect:'error'});
    const text=await r.text();let data=null;try{data=text?JSON.parse(text):null}catch(_){data=text;}
    if(!r.ok){const detail=typeof data==='string'?data:(data&&typeof data==='object'?JSON.stringify(data):'');throw new Error('Firebase query HTTP '+r.status+(detail?': '+detail.slice(0,180):''));}
    return data;
  }finally{clearTimeout(timer);}
}
async function firebaseWriteJson(pathname,value,timeoutMs=8000){
  if(firebaseAdminEnabled()){
    await firebaseWithTimeout(firebaseAdminDatabase().ref(String(pathname||'/')).set(value),timeoutMs,'write');
    return value;
  }
  const out=await firebaseRequest(pathname,'PUT',value,timeoutMs);return out.data===null?value:out.data;
}
async function firebasePatchJson(pathname,value,timeoutMs=12000){
  if(firebaseAdminEnabled()){
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('بيانات Firebase PATCH يجب أن تكون كائناً.');
    const ref=firebaseAdminDatabase().ref(String(pathname||'/'));
    await firebaseWithTimeout(ref.update(value),timeoutMs,'patch');
    const snap=await firebaseWithTimeout(ref.once('value'),timeoutMs,'verify patch');
    return snap.val();
  }
  const out=await firebaseRequest(pathname,'PATCH',value,timeoutMs);return out.data===null?value:out.data;
}
// Apply a Realtime Database PATCH without downloading the entire database in the write response.
// `print=silent` returns an empty success response; the caller verifies only the affected catalog paths.
async function firebasePatchJsonSilent(pathname,value,timeoutMs=45000){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('بيانات Firebase PATCH يجب أن تكون كائناً.');
  if(firebaseAdminEnabled()){
    await firebaseWithTimeout(firebaseAdminDatabase().ref(String(pathname||'/')).update(value),timeoutMs,'silent patch');
    return {ok:true,status:200};
  }
  const auth=await firebaseAuthContext(),u=firebasePathUrl(pathname,auth.queryAuth);
  u.searchParams.set('print','silent');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(u,{method:'PATCH',headers:{'Accept':'application/json','Content-Type':'application/json',...auth.headers},body:JSON.stringify(value),signal:controller.signal,redirect:'error'});
    if(!r.ok){const detail=await r.text().catch(()=> '');throw new Error('Firebase HTTP '+r.status+(detail?': '+detail.slice(0,180):''));}
    if(r.body&&typeof r.body.cancel==='function')await r.body.cancel().catch(()=>{});
    return {ok:true,status:r.status};
  }finally{clearTimeout(timer);}
}
async function firebaseDeleteJson(pathname,timeoutMs=8000){
  if(firebaseAdminEnabled()){
    await firebaseWithTimeout(firebaseAdminDatabase().ref(String(pathname||'/')).remove(),timeoutMs,'delete');
    return null;
  }
  return firebaseWriteJson(pathname,null,timeoutMs);
}
function firebaseAuthAvailable(){return firebaseServiceAccountConfigured()||(process.env.NODE_ENV==='test'&&(String(process.env.FIREBASE_DATABASE_SECRET||'').trim()||process.env.FIREBASE_ALLOW_UNAUTHENTICATED==='true'));}
function base64urlJson(value){return Buffer.from(JSON.stringify(value),'utf8').toString('base64url');}
function createFirebaseCustomToken(username,role='user'){
  const account=firebaseServiceAccount();if(!account)throw new Error('يلزم إعداد سر حساب خدمة Firebase في الاستضافة لإنشاء رمز دخول آمن.');
  const uid=String(username||'').trim();if(!uid||uid.length>128)throw new Error('اسم المستخدم غير صالح لرمز Firebase.');
  const now=Math.floor(Date.now()/1000),header=base64urlJson({alg:'RS256',typ:'JWT'}),claims=base64urlJson({iss:account.client_email,sub:account.client_email,aud:'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',iat:now,exp:now+3600,uid,claims:{role:role==='admin'?'admin':'user',admin:role==='admin'}}),input=header+'.'+claims;
  const signature=crypto.sign('RSA-SHA256',Buffer.from(input),account.private_key).toString('base64url');return input+'.'+signature;
}

// Order audit: the Firebase `orders` node is the customer-facing source of truth;
// the server ledger is merged in for orders created through the backend API.
const DEFAULT_ORDER_AUDIT_SETTINGS={delayHours:3,notifyAdmin:true,updatedAt:null};
let ORDER_AUDIT_SNAPSHOT_CACHE={at:0,rows:[],firebaseAvailable:false,firebaseError:'',loaded:false};
let ORDER_AUDIT_MONITOR_RUNNING=false;
function cleanOrderAuditSettings(value={}){
  const delay=Number(value.delayHours??3);
  // Legacy false values had been the old default; enable them once unless the admin explicitly saved the toggle in this schema.
  const notifyAdmin=value.notifyAdminExplicit===true?value.notifyAdmin===true:true;
  return {...DEFAULT_ORDER_AUDIT_SETTINGS,...value,delayHours:Number.isFinite(delay)?Math.max(1,Math.min(72,Math.round(delay))):3,notifyAdmin,notifyAdminExplicit:value.notifyAdminExplicit===true};
}
async function getOrderAuditSettings(){
  const local=readJSON('settings.json',{}).orderAudit||{};
  try{const remote=await firebaseGetJson('config/orderAuditSettings',4500);if(remote&&typeof remote==='object'&&!Array.isArray(remote))return cleanOrderAuditSettings({...local,...remote});}catch(_){}
  return cleanOrderAuditSettings(local);
}
async function saveOrderAuditSettings(value){
  const cfg=cleanOrderAuditSettings(value);cfg.updatedAt=nowISO();
  const local=readJSON('settings.json',{});local.orderAudit=cfg;writeJSON('settings.json',local);
  let firebaseSaved=false,error='';
  try{await firebaseWriteJson('config/orderAuditSettings',cfg,8000);firebaseSaved=true;}catch(e){error=String(e.message||e).slice(0,180)}
  return {settings:cfg,firebaseSaved,localSaved:true,persistent:firebaseSaved||DATA_IS_EXTERNAL,error};
}
function auditTimestamp(value){
  if(value===undefined||value===null||value==='')return null;
  if(typeof value==='number'||/^\d{9,16}$/.test(String(value).trim())){const n=Number(value);if(!Number.isFinite(n))return null;const ms=n<100000000000? n*1000:n;return Number.isFinite(ms)&&ms>0&&ms<8640000000000000?ms:null;}
  const parsed=Date.parse(String(value));return Number.isFinite(parsed)&&parsed>0?parsed:null;
}
function auditOrderTime(order={}){
  for(const key of ['createdAt','created_at','created','timestamp','time','date','orderDate','createdOn']){const ms=auditTimestamp(order[key]);if(ms)return ms;}
  return null;
}
function auditStatus(value){
  const raw=String(value??'').trim();if(!raw)return 'unknown';
  const basic=normalizeProviderStatus(raw);if(basic!=='unknown')return basic;
  const x=raw.toLowerCase().replace(/[\s_-]+/g,' ');
  if(['معلق','قيد الانتظار','بانتظار','انتظار','قيد المعالجة'].includes(x))return 'pending';
  if(['قيد التنفيذ','جاري التنفيذ','قيد التقدم','جاري','تحت التنفيذ','قيد العمل'].includes(x))return 'processing';
  if(['مكتمل','مكتملة','منجز','منجزة','تم التنفيذ','مكتمل جزئياً لا'].includes(x))return 'completed';
  if(['جزئي','مكتمل جزئيا','مكتمل جزئياً','جزئي مكتمل'].includes(x))return 'partial';
  if(['ملغي','ملغى','ملغاة','تم الإلغاء','تم الالغاء'].includes(x))return 'cancelled';
  if(['فشل','فاشل','فاشلة','فشل نهائي','مرفوض'].includes(x))return 'failed';
  if(['مسترد','مسترجع','تم الاسترداد'].includes(x))return 'refunded';
  return 'unknown';
}
function auditTerminalStatus(status){return ['completed','cancelled','failed','refunded','partial'].includes(status);}
function auditPlatform(order={}){
  const source={app:order.serviceApp||order.app||order.platform||'',serviceApp:order.serviceApp||order.app||'',platform:order.platform||'',name:order.serviceName||order.service||order.name||'',serviceName:order.serviceName||order.service||'',category:order.category||'',groups:Array.isArray(order.groups)?order.groups:[]};
  const p=canonicalServicePlatform(source).serviceApp;
  return p==='other'?(String(source.app||source.platform||'أخرى')):p;
}
function auditNormalizeRecord(order={},source='firebase',sourceKey=''){
  const o=order&&typeof order==='object'?order:{};
  const id=String(o.siteOrderId||o.id||o.orderId||o.order_id||o.publicOrderNo||'').trim();
  const providerOrderId=String(o.providerOrderId||o.smmpartyOrderId||o.provider_order_id||o.providerOrderID||o.smmOrderId||'').trim();
  const user=String(o.user||o.username||o.userName||o.customer||'').trim();
  const createdMs=auditOrderTime(o);
  const rawStatus=String(o.status||o.providerStatus||o.smmStatus||'').trim();
  return {
    id,siteOrderId:id,publicOrderNo:String((/^\d{1,9}$/.test(String(o.publicOrderNo||''))&&Number(o.publicOrderNo)>=3000)?o.publicOrderNo:(/^\d{1,9}$/.test(id)&&Number(id)>=3000?id:'')),user,
    userName:String(o.userName||o.fullName||o.name||o.customerName||user||'').trim(),
    email:String(o.email||o.userEmail||o.customerEmail||'').trim(),
    serviceName:String(o.serviceName||o.serviceTitle||o.service||o.name||'خدمة').trim(),
    serviceId:String(o.serviceId||o.service_id||o.serviceKey||'').trim(),
    platform:auditPlatform(o),serviceApp:String(o.serviceApp||o.app||o.platform||'').trim(),
    orderSource:String(o.orderSource||o.origin||o.sourceType||o.source||'').trim(),origin:String(o.origin||o.orderSource||o.sourceType||o.source||'').trim(),
    apiCreated:!!o.apiCreated,externalProviderOrder:!!o.externalProviderOrder,providerDirect:!!o.providerDirect,
    free:!!(o.free||o.isFree||o.is_free||o.adminFreeService||o.admin_free_service),
    adminFreeService:!!(o.adminFreeService||o.admin_free_service),
    serviceKind:String(o.serviceKind||o.service_kind||o.kind||'').trim(),
    paymentStatus:String(o.paymentStatus||o.payment_status||o.paymentState||o.payment_state||'').trim().toLowerCase(),
    memberId:String(o.memberId||o.userId||o.uid||o.firebaseUid||o.telegramUserId||''),
    link:String(o.link||o.url||o.target||o.targetUrl||''),quantity:Number(o.quantity??o.qty??0)||0,
    status:auditStatus(rawStatus),rawStatus:rawStatus||'غير مسجلة',createdAt:o.createdAt||o.created_at||o.timestamp||o.date||null,createdMs,
    providerName:String(o.providerName||o.provider||o.smmProviderName||'').trim(),providerId:String(o.providerId||o.provider_id||o.smmProviderId||'').trim(),providerOrderId,
    amountIQD:Number(o.totalIQD??o.totalIqd??o.total_iqd??o.amountIQD??o.amountIqd??o.chargeIQD??o.chargeIqd??o.priceIQD??o.priceIqd??o.amount??NaN),
    lastCheckedAt:o.lastCheckedAt||o.lastChecked||o.providerCheckedAt||null,
    updatedAt:o.updatedAt||o.updated_at||o.lastUpdatedAt||null,
    completedAt:o.completedAt||o.completed_at||o.finishedAt||null,
    cancelledAt:o.cancelledAt||o.cancelled_at||o.cancelAt||null,
    cancelReason:String(o.cancelReason||o.cancellationReason||o.failureReason||o.reason||''),
    remains:o.remains??null,startCount:o.startCount??o.start_count??null,refundState:String(o.refundState||''),refundAmountIQD:Number(o.refundAmountIQD||0),
    source, firebaseKey:source==='firebase'?String(sourceKey||''):'',
    legacyHistory:!!o.legacyHistory, readOnly:!!o.readOnly,
    siteLocalId:source==='server'?String(id||''):'',
    amountUsd:Number(o.chargeUsd??o.chargeUSD??o.totalUsd??o.totalUSD??o.priceUsd??o.priceUSD??o.amountUsd??o.amountUSD??o.amount_usd??NaN),
    sourceTimestamp:createdMs||0
  };
}
function auditIsPaidOrder(row={}){
  const kind=String(row.serviceKind||row.service_kind||'').trim().toLowerCase().replace(/[\s-]+/g,'_');
  const payment=String(row.paymentStatus||row.payment_status||'').trim().toLowerCase();
  if(row.free===true||row.isFree===true||row.adminFreeService===true||row.admin_free_service===true||['free','free_service','admin_free','free_order'].includes(kind))return false;
  if(['paid','charged','completed','success','successful'].includes(payment))return true;
  const usd=Number(row.amountUsd),iqd=Number(row.amountIQD);
  return (Number.isFinite(usd)&&usd>0)||(Number.isFinite(iqd)&&iqd>0);
}
function auditIdentity(row){
  const id=String(row.id||row.publicOrderNo||'').trim(),u=String(row.user||'').trim();
  if(id)return 'id:'+id+'|u:'+u;
  if(row.providerOrderId)return 'provider:'+String(row.providerId||'')+'|'+row.providerOrderId+'|u:'+u;
  return String(row.source||'')+':'+String(row.firebaseKey||row.createdMs||'')+'|u:'+u;
}
async function loadOrderAuditSnapshot(force=false){
  const now=Date.now();if(!force&&ORDER_AUDIT_SNAPSHOT_CACHE.loaded&&now-ORDER_AUDIT_SNAPSHOT_CACHE.at<8000)return ORDER_AUDIT_SNAPSHOT_CACHE;
  const remote=await Promise.allSettled([firebaseGetJson('orders',14000)]);
  const fbOk=remote[0].status==='fulfilled';const fbRoot=fbOk?remote[0].value:null;
  const fbError=fbOk?'':String(remote[0].reason?.message||'تعذر قراءة Firebase').slice(0,180);
  const rawFirebase=[];
  if(fbOk&&fbRoot&&typeof fbRoot==='object'){
    const entries=Array.isArray(fbRoot)?fbRoot.map((v,i)=>[String(i),v]):Object.entries(fbRoot);
    for(const [key,o] of entries){if(!o||typeof o!=='object'||Array.isArray(o)||o.event)continue;const row=auditNormalizeRecord(o,'firebase',key);if(row.id||row.providerOrderId||row.createdMs)rawFirebase.push(row);}
  }
  const local=readJSON('orders.json',[]);const rawLocal=[];
  if(Array.isArray(local))for(const o of local){if(!o||typeof o!=='object'||o.event)continue;const row=auditNormalizeRecord(o,'server',String(o.id||''));if(row.id||row.providerOrderId||row.createdMs)rawLocal.push(row);}
  const merged=new Map();
  // Firebase order records are preferred for current status. Add local-ledger-only fields only if missing.
  for(const row of [...rawFirebase,...rawLocal]){
    const key=auditIdentity(row);const prior=merged.get(key);
    if(!prior){merged.set(key,{...row,_auditSources:[row.source],_firebaseKey:row.firebaseKey||'',_serverOrderId:row.siteLocalId||''});continue;}
    const incomingIsFirebase=row.source==='firebase';const winner=incomingIsFirebase?{...prior,...row}:{...row,...prior};
    for(const [field,value] of Object.entries(row))if((winner[field]===undefined||winner[field]===null||winner[field]===''||winner[field]==='unknown')&&value!==undefined&&value!==null&&value!=='')winner[field]=value;
    winner._auditSources=[...new Set([...(prior._auditSources||[]),row.source])];
    winner._firebaseKey=prior._firebaseKey||row.firebaseKey||'';winner._serverOrderId=prior._serverOrderId||row.siteLocalId||'';
    merged.set(key,winner);
  }
  const providers=providerStore().providers||{};
  const rows=[...merged.values()].map(row=>({...row,providerName:row.providerName||(providers[row.providerId]?.name||''),status:auditStatus(row.status||row.rawStatus)}));
  ORDER_AUDIT_SNAPSHOT_CACHE={at:now,rows,firebaseAvailable:fbOk,firebaseError:fbError,loaded:true};
  return ORDER_AUDIT_SNAPSHOT_CACHE;
}
// Background monitors share one bounded snapshot. Rather than downloading the whole orders node,
// read the latest 500 orders and indexed active/refund-relevant statuses only.
let ORDER_MONITOR_SNAPSHOT_AT=0;
let ORDER_MONITOR_SNAPSHOT_VALUE=null;
let ORDER_MONITOR_SNAPSHOT_PROMISE=null;
async function loadOrderMonitorSnapshot(){
  const now=Date.now();
  if(ORDER_MONITOR_SNAPSHOT_VALUE&&now-ORDER_MONITOR_SNAPSHOT_AT<55_000)return ORDER_MONITOR_SNAPSHOT_VALUE;
  if(ORDER_MONITOR_SNAPSHOT_PROMISE)return ORDER_MONITOR_SNAPSHOT_PROMISE;
  ORDER_MONITOR_SNAPSHOT_PROMISE=(async()=>{
    const statuses=['pending','processing','in progress','in_progress','creating_provider','provider_pending','partial','cancelled'];
    const jobs=[firebaseGetQueryJson('orders',{orderBy:'\"$key\"',limitToLast:500},10000),...statuses.map(status=>firebaseGetQueryJson('orders',{orderBy:'\"status\"',equalTo:JSON.stringify(status),limitToLast:500},10000))];
    const settled=await Promise.allSettled(jobs),raw=new Map();let successes=0;const errors=[];
    settled.forEach((result,index)=>{
      if(result.status!=='fulfilled'){errors.push(String(result.reason?.message||'تعذر تحميل جزء من الطلبات').slice(0,100));return;}
      successes++;
      for(const [key,o] of collectionEntries(result.value)){
        if(!o||typeof o!=='object'||Array.isArray(o)||o.event)continue;
        const row=auditNormalizeRecord(o,'firebase',key);if(!row.id&&!row.providerOrderId&&!row.createdMs)continue;
        const id=auditIdentity(row),prior=raw.get(id);
        if(!prior)raw.set(id,{...row,_auditSources:['firebase'],_firebaseKey:row.firebaseKey||''});
        else {const merged={...prior,...row,source:'firebase',_auditSources:['firebase'],_firebaseKey:prior._firebaseKey||row.firebaseKey||''};raw.set(id,merged);}
      }
    });
    const local=readJSON('orders.json',[]);const merged=new Map(raw);
    if(Array.isArray(local))for(const o of local){if(!o||typeof o!=='object'||o.event)continue;const row=auditNormalizeRecord(o,'server',String(o.id||''));if(!row.id&&!row.providerOrderId&&!row.createdMs)continue;const id=auditIdentity(row),prior=merged.get(id);if(!prior)merged.set(id,{...row,_auditSources:['server'],_serverOrderId:row.siteLocalId||''});else{const winner={...row,...prior};for(const [field,value] of Object.entries(row))if((winner[field]===undefined||winner[field]===null||winner[field]==='')&&value!==undefined&&value!==null&&value!=='')winner[field]=value;winner._auditSources=[...new Set([...(prior._auditSources||[]),'server'])];winner._firebaseKey=prior._firebaseKey||row.firebaseKey||'';winner._serverOrderId=prior._serverOrderId||row.siteLocalId||'';merged.set(id,winner);}}
    const providers=providerStore().providers||{};
    const rows=[...merged.values()].map(row=>({...row,providerName:row.providerName||(providers[row.providerId]?.name||''),status:auditStatus(row.status||row.rawStatus)}));
    return {at:Date.now(),rows,firebaseAvailable:successes>0,firebaseError:errors.slice(0,2).join(' | '),loaded:true,bounded:true,queryCount:successes};
  })().then(snapshot=>{ORDER_MONITOR_SNAPSHOT_VALUE=snapshot;ORDER_MONITOR_SNAPSHOT_AT=Date.now();return snapshot;}).finally(()=>{ORDER_MONITOR_SNAPSHOT_PROMISE=null;});
  return ORDER_MONITOR_SNAPSHOT_PROMISE;
}
function auditPublicRecord(row,now=Date.now(),delayHours=3){
  const createdMs=Number(row.createdMs||auditOrderTime(row)||0)||null;const ageMs=createdMs?Math.max(0,now-createdMs):null;const status=auditStatus(row.status||row.rawStatus);
  return {id:String(row.id||''),siteOrderId:String(row.siteOrderId||row.id||''),publicOrderNo:String((/^\d{1,9}$/.test(String(row.publicOrderNo||''))&&Number(row.publicOrderNo)>=3000)?row.publicOrderNo:(/^\d{1,9}$/.test(String(row.id||''))&&Number(row.id)>=3000?row.id:'')),user:String(row.user||''),userName:String(row.userName||row.user||'—'),email:String(row.email||''),serviceName:String(row.serviceName||'خدمة'),serviceId:String(row.serviceId||''),platform:String(row.platform||auditPlatform(row)),serviceApp:String(row.serviceApp||''),link:String(row.link||''),quantity:Number(row.quantity||0),status,rawStatus:String(row.rawStatus||status),createdAt:row.createdAt||null,createdMs,ageMs,overdue:!row.legacyHistory&&!!(ageMs!==null&&ageMs>delayHours*3600000&&!auditTerminalStatus(status)),providerName:String(row.providerName||'—'),providerId:String(row.providerId||''),providerOrderId:String(row.providerOrderId||''),lastCheckedAt:row.lastCheckedAt||null,updatedAt:row.updatedAt||null,completedAt:row.completedAt||null,cancelledAt:row.cancelledAt||null,cancelReason:String(row.cancelReason||''),remains:row.remains??null,startCount:row.startCount??null,amountUsd:Number.isFinite(row.amountUsd)?row.amountUsd:null,source:String(row.source||''),sourceKey:String(row._firebaseKey||row.firebaseKey||''),legacyHistory:!!row.legacyHistory,readOnly:!!row.legacyHistory||!!row.readOnly,sources:Array.isArray(row._auditSources)?row._auditSources:[row.source].filter(Boolean)};
}
function auditPageFilter(rows,params,settings){
  const now=Date.now(),delayMs=settings.delayHours*3600000;
  const view=String(params.view||'overdue');const q=String(params.q||'').trim().toLowerCase();const numberType=String(params.numberType||'site');
  const provider=String(params.provider||'');const platform=String(params.platform||'');const service=String(params.service||'');const status=String(params.status||'');const delay=String(params.delay||'');const range=String(params.range||'7d');const sort=String(params.sort||'newest');
  const rangeMs=range==='today'?86400000:range==='7d'?7*86400000:range==='30d'?30*86400000:Infinity;const cutoff=rangeMs===Infinity?0:now-rangeMs;
  const records=rows.map(r=>auditPublicRecord(r,now,settings.delayHours));
  const inSelectedRange=r=>rangeMs===Infinity?true:(r.createdMs!==null&&r.createdMs>=cutoff);
  const overdue=records.filter(r=>!r.legacyHistory&&r.overdue), completed=records.filter(r=>r.status==='completed'&&inSelectedRange(r)),cancelled=records.filter(r=>r.status==='cancelled'&&inSelectedRange(r));
  const openWithAge=records.filter(r=>!r.legacyHistory&&r.ageMs!==null&&!auditTerminalStatus(r.status));const stats={overdue:overdue.length,over6:openWithAge.filter(r=>r.ageMs>=6*3600000).length,over12:openWithAge.filter(r=>r.ageMs>=12*3600000).length,completed:completed.length,cancelled:cancelled.length};
  let list=records.filter(r=>{
    if(view==='lookup'&&!q)return false;
    if(view==='overdue'&&!r.overdue)return false;
    if(view==='completed'&&r.status!=='completed')return false;
    if(view==='cancelled'&&r.status!=='cancelled')return false;
    if(view==='lookup'){
      if(numberType==='provider'&&String(r.providerOrderId||'').toLowerCase()!==q)return false;
      if(numberType!=='provider'&&String(r.siteOrderId||r.id||'').toLowerCase()!==q)return false;
    } else if(q){const hay=[r.siteOrderId,r.id,r.user,r.userName,r.email,r.serviceName,r.serviceId,r.link,r.providerName,r.providerOrderId,r.platform].join(' ').toLowerCase();if(!hay.includes(q))return false;}
    // A number lookup is authoritative; stale filters from a previous view must not hide an exact match.
    if(view!=='lookup'&&provider&&r.providerId!==provider&&r.providerName!==provider)return false;
    if(view!=='lookup'&&platform&&r.platform.toLowerCase()!==platform.toLowerCase()&&r.serviceApp.toLowerCase()!==platform.toLowerCase())return false;
    if(view!=='lookup'&&service&&r.serviceName!==service&&r.serviceId!==service)return false;
    if(view!=='lookup'&&status&&status!=='all'&&r.status!==status)return false;
    if(view!=='lookup'&&delay){if(!r.overdue)return false;const h=(r.ageMs||0)/3600000;if(delay==='3-6'&&(h<settings.delayHours||h>=6))return false;if(delay==='6-12'&&(h<6||h>=12))return false;if(delay==='12+'&&h<12)return false;}
    if(['completed','cancelled'].includes(view)&&!inSelectedRange(r))return false;
    return true;
  });
  list.sort((a,b)=>sort==='oldest'?Number(a.createdMs||0)-Number(b.createdMs||0):sort==='delay-high'?Number(b.ageMs||0)-Number(a.ageMs||0):Number(b.createdMs||0)-Number(a.createdMs||0));
  const pageSize=Math.min(50,Math.max(5,Number(params.limit)||20));const total=list.length;const totalPages=Math.max(1,Math.ceil(total/pageSize));const page=Math.min(totalPages,Math.max(1,Number(params.page)||1));const start=(page-1)*pageSize;
  const providers=[...new Map(records.filter(x=>x.providerId||x.providerName).map(x=>[x.providerId||x.providerName,{id:x.providerId||x.providerName,name:x.providerName||x.providerId}])).values()].sort((a,b)=>a.name.localeCompare(b.name));
  const platforms=[...new Set(records.map(x=>x.platform).filter(x=>x&&x!=='أخرى'))].sort();
  const services=[...new Set(records.map(x=>x.serviceName).filter(x=>x&&x!=='خدمة'))].sort((a,b)=>a.localeCompare(b)).map(name=>({id:name,name}));
  return {view,page,pageSize,total,totalPages,items:list.slice(start,start+pageSize),stats,settings,providers,platforms,services,source:{firebaseAvailable:ORDER_AUDIT_SNAPSHOT_CACHE.firebaseAvailable,partial:!ORDER_AUDIT_SNAPSHOT_CACHE.firebaseAvailable,firebaseError:ORDER_AUDIT_SNAPSHOT_CACHE.firebaseError},range};
}
async function orderAuditEnrichUsers(items){
  const local=readJSON('users.json',{users:{}}).users||{};
  return await Promise.all(items.map(async item=>{
    if(!item.user)return item;
    let user=local[item.user]||{};
    // A local username/name may exist while the email is only stored in Firebase; fetch when either is missing.
    if((!user.email&&!user.mail)||(!user.fullName&&!user.name)){try{const remote=await firebaseUserByUsername(item.user);if(remote&&typeof remote==='object')user={...remote,...user,email:user.email||user.mail||remote.email||remote.mail||'',fullName:user.fullName||remote.fullName||'',name:user.name||remote.name||''}}catch(_){}}
    return {...item,userName:item.userName&&item.userName!==item.user?item.userName:String(user.fullName||user.name||item.userName||item.user),email:String(item.email||user.email||user.mail||'')};
  }));
}
async function getOrderAuditState(){
  const local=readJSON('order_audit_state.json',{alerts:{}});
  try{const remote=await firebaseGetJson('config/orderAuditState',4500);if(remote&&typeof remote==='object'&&!Array.isArray(remote))return {...local,...remote,alerts:{...(local.alerts||{}),...(remote.alerts||{})}};}catch(_){}
  return local;
}
async function saveOrderAuditState(state){
  writeJSON('order_audit_state.json',state);try{await firebaseWriteJson('config/orderAuditState',state,6000);return true}catch(_){return DATA_IS_EXTERNAL;}
}
async function ensureOverduePublicOrderNumber(order){
  const valid=v=>/^\d{4,9}$/.test(String(v??'').trim())&&Number(v)>=3000&&Number(v)<=999999999;
  if(valid(order?.publicOrderNo))return String(order.publicOrderNo);
  if(valid(order?.siteOrderId))return String(order.siteOrderId);
  if(valid(order?.id))return String(order.id);
  const publicNo=await nextPublicOrderNumber();let persisted=false;
  const sourceKey=String(order?.sourceKey||order?._firebaseKey||'').trim();
  if(sourceKey){
    const fbPath='orders/'+sourceKey;
    try{await firebaseWriteJson(fbPath+'/publicOrderNo',publicNo,8000);const check=await firebaseGetJson(fbPath,8000);persisted=!!check&&String(check.publicOrderNo||'')===publicNo;}catch(e){console.warn('overdue public order number Firebase write failed:',String(e.message||e).slice(0,100));}
  }
  if(!persisted){
    const localRows=readJSON('orders.json',[]),idx=Array.isArray(localRows)?localRows.findIndex(row=>row&&!row.event&&String(row.id||row.siteOrderId||'')===String(order?.id||'')&&String(row.user||row.username||'')===String(order?.user||'')):-1;
    if(idx>=0){localRows[idx]={...localRows[idx],publicOrderNo:publicNo};writeJSON('orders.json',localRows);try{await persistOrderToFirebase(localRows[idx]);persisted=true}catch(e){console.warn('overdue public order number full-record write failed:',String(e.message||e).slice(0,100));}}
  }
  if(!persisted)throw new Error('تعذر حفظ رقم الطلب الرقمي في سجل الطلب؛ لم نرسل رقماً داخلياً كأنه رقم طلب عام.');
  order.publicOrderNo=publicNo;return publicNo;
}
async function runOrderAuditMonitor(){
  if(ORDER_AUDIT_MONITOR_RUNNING)return;ORDER_AUDIT_MONITOR_RUNNING=true;
  try{
    const cfg=await getOrderAuditSettings();if(!cfg.notifyAdmin)return;
    const tg=telegramConfig();if(!tg.enabled||!tg.token||!tg.overdueChat)return;
    const snap=await loadOrderMonitorSnapshot();if(!snap.firebaseAvailable)return;
    const now=Date.now(),state=await getOrderAuditState(),alerts={...(state.alerts||{})};let changed=false;
    // Escalation levels are fixed at 3/6/12 hours; the dashboard's configurable filter remains separate.
    // The overdue channel is reserved for paid orders. Explicitly exclude free-service flags
    // before constructing audit rows so free or zero-charge requests never trigger an alert.
    const rows=snap.rows.filter(auditIsPaidOrder).map(r=>auditPublicRecord(r,now,cfg.delayHours)).filter(r=>!r.legacyHistory&&Number(r.ageMs||0)>=3*3600000&&!auditTerminalStatus(r.status)).sort((a,b)=>b.ageMs-a.ageMs).slice(0,150);
    const levels=[{h:3,label:'🟠 إنذار أول — تأخير 3 ساعات',kind:'warning'},{h:6,label:'🔴 إنذار مرتفع — تأخير 6 ساعات',kind:'danger'},{h:12,label:'🚨 خطر حرج — تأخير 12 ساعة',kind:'critical'}];
    const work=[];
    for(const o of rows){const key=String(o.siteOrderId||o.id||o.providerOrderId||'');if(!key)continue;const old=alerts[key];const known={...(old&&typeof old==='object'?old:{}),levels:{...(old?.levels||{})}};if(old?.sentAt&&!known.levels['3'])known.levels['3']={sentAt:old.sentAt,status:old.status||''};for(const level of levels){if(Number(o.ageMs||0)>=level.h*3600000&&!known.levels[String(level.h)])work.push({o,key,level});}}
    for(const task of work.slice(0,12)){
      const {o,key,level}=task;
      // Re-read the latest entry per task so alerts for 3, 6 and 12 hours accumulate together.
      const old=alerts[key];const item={...(old&&typeof old==='object'?old:{}),levels:{...(old?.levels||{})}};if(old?.sentAt&&!item.levels['3'])item.levels['3']={sentAt:old.sentAt,status:old.status||''};if(item.levels[String(level.h)])continue;
      const hours=(Number(o.ageMs||0)/3600000).toFixed(1);let publicOrderNo='';
      try{publicOrderNo=await ensureOverduePublicOrderNumber(o)}catch(e){console.warn('Skipping overdue Telegram alert because the numeric site order number could not be verified:',String(e.message||e).slice(0,120));continue;}
      const text=`${level.label} — صدى العراق
🆔 رقم طلب التطبيق: #${/^\d{4,9}$/.test(String(publicOrderNo))?String(publicOrderNo):'غير متوفر'}
👤 المستخدم: ${o.userName||o.user||'—'}
📦 الخدمة: ${o.serviceName||'—'}
🌐 المنصة: ${o.platform||'—'}
🔗 الرابط: ${o.link||'—'}
🔢 الكمية: ${Number(o.quantity||0).toLocaleString('en-US')}
🏷️ المزوّد: ${o.providerName||'—'}
🔢 رقم المزود: ${o.providerOrderId||'غير متوفر'}
📊 الحالة: ${o.rawStatus||o.status}
⏱️ مدة الانتظار: ${hours} ساعة
يرجى فحص الطلب واتخاذ الإجراء المناسب.`;
      const sent=await notifyTelegramRecipients(text,{channel:'overdue',kind:'order_audit_'+level.kind,orderId:key});
      if(sent.ok){item.levels[String(level.h)]={sentAt:nowISO(),status:o.status};item.status=o.status;item.updatedAt=nowISO();alerts[key]=item;changed=true;await saveOrderAuditState({alerts:{...alerts},updatedAt:nowISO()});}
    }
    const entries=Object.entries(alerts).sort((a,b)=>Date.parse(b[1]?.updatedAt||b[1]?.sentAt||0)-Date.parse(a[1]?.updatedAt||a[1]?.sentAt||0)).slice(0,3000);
    if(changed)await saveOrderAuditState({alerts:Object.fromEntries(entries),updatedAt:nowISO()});
  }catch(e){console.warn('order audit monitor error:',String(e.message||e).slice(0,180));}finally{ORDER_AUDIT_MONITOR_RUNNING=false;}
}

// Firebase compare-and-swap: prevents concurrent refund/balance updates from overwriting each other.
async function firebaseTransaction(pathname,mutator,timeoutMs=9000,maxRetries=6){
  if(firebaseAdminEnabled()){
    const ref=firebaseAdminDatabase().ref(String(pathname||'/'));
    let lastDecision=null,updateError=null;
    const tx=await firebaseWithTimeout(ref.transaction(current=>{
      try{
        const decision=mutator(current);
        if(decision&&typeof decision.then==='function')throw new Error('Firebase transaction mutator must be synchronous.');
        lastDecision=decision;
        if(!decision||decision.write===false)return;
        return decision.value;
      }catch(e){updateError=e;return;}
    },undefined,false),timeoutMs,'transaction');
    if(updateError)throw updateError;
    return {ok:true,changed:!!tx.committed,value:tx.snapshot?.val()??null,result:lastDecision?.result||{}};
  }
  for(let attempt=0;attempt<maxRetries;attempt++){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
    let current,etag;
    try{
      const got=await firebaseRequest(pathname,'GET',undefined,timeoutMs,{'X-Firebase-ETag':'true'});
      current=got.data;etag=got.headers.get('etag')||got.headers.get('ETag');
      if(!etag)throw new Error('Firebase لم يرجع ETag؛ أوقفنا تعديل الرصيد لمنع التكرار');
    }finally{clearTimeout(timer)}
    const decision=await mutator(current);
    if(!decision||decision.write===false)return {ok:true,changed:false,value:current,result:decision?.result||{}};
    const controller2=new AbortController(),timer2=setTimeout(()=>controller2.abort(),timeoutMs);
    try{
      const put=await firebaseRequest(pathname,'PUT',decision.value,timeoutMs,{'If-Match':etag});
      return {ok:true,changed:true,value:put.data??decision.value,result:decision.result||{}};
    }catch(e){if(/Firebase HTTP 412/.test(String(e.message||'')))continue;throw e;}
    finally{clearTimeout(timer2)}
  }
  throw new Error('تعذر تثبيت التعديل بسبب تغيّر الرصيد بالتزامن؛ أعد المحاولة');
}
function refundIdentity(order={}){return sha256(String(order.user||order.username||'')+'|'+String(order.id||order.siteOrderId||order.orderId||'')+'|'+String(order.providerId||'')+'|'+String(order.providerOrderId||'' )).slice(0,40)}
async function resolveFinancialOrder(order={}){
  const id=String(order.id||order.siteOrderId||order.orderId||'');const username=String(order.user||order.username||'');const pid=String(order.providerId||'');const po=String(order.providerOrderId||order.smmpartyOrderId||'');
  const rows=readJSON('orders.json',[]);
  const local=Array.isArray(rows)?rows.find(x=>x&&!x.event&&((id&&String(x.id||x.localId||'')===id&&(!username||String(x.user||'')===username))||(po&&String(x.providerOrderId||x.smmpartyOrderId||'')===po&&(!pid||String(x.providerId||'')===pid)&&(!username||String(x.user||'')===username)))):null;
  if(local)return {...order,...local};
  const fbKey=String(order._firebaseKey||order.firebaseKey||'');
  if(fbKey){try{const remote=await firebaseGetJson('orders/'+fbKey,5000);if(remote&&typeof remote==='object')return {...order,...remote,_firebaseKey:fbKey};}catch(_){}}
  if(po){try{const matches=await firebaseGetQueryJson('orders',{orderBy:JSON.stringify('providerOrderId'),equalTo:JSON.stringify(po),limitToLast:100},7000);for(const [key,v] of collectionEntries(matches)){if(!v||typeof v!=='object')continue;if(String(v.providerOrderId||v.smmpartyOrderId||v.provider_order_id||'')===po&&(!pid||String(v.providerId||v.provider_id||'')===pid)&&(!username||String(v.user||v.username||'')===username))return {...order,...v,_firebaseKey:key};}}catch(_){} }
  return {...order};
}
function refundChargeIQD(order={}){
  for(const k of ['totalIQD','chargeIqd','amountIQD','total','amountIqd']){const n=Number(order[k]);if(Number.isFinite(n)&&n>0)return Math.round(n*10000)/10000;}
  for(const k of ['chargeUsd','totalUsd','amountUsd','priceUsd']){const n=Number(order[k]);if(Number.isFinite(n)&&n>0)return Math.round(n*FIXED_RATE*10000)/10000;}
  return 0;
}
async function applyVerifiedOrderRefund(inputOrder={},providerData={},normalizedStatus=''){
  const order=await resolveFinancialOrder(inputOrder);
  const status=normalizeProviderStatus(normalizedStatus||providerData.status||providerData.smmStatus||order.status||'');
  if(!['cancelled','partial'].includes(status))return {ok:true,credited:false,state:'not-eligible',reason:'status-not-refundable'};
  const user=String(order.user||order.username||'').trim();if(!user)return {ok:false,credited:false,state:'pending',reason:'missing-user'};
  if(providerData.refund_confirmed===false||providerData.refunded===false||/^(pending|processing|failed|rejected)$/i.test(String(providerData.refund_status||providerData.refundStatus||'')))return {ok:true,credited:false,state:'pending',reason:'provider-refund-not-confirmed'};
  const charged=refundChargeIQD(order);if(!(charged>0))return {ok:true,credited:false,state:'pending',reason:'missing-charge-amount'};
  let target=charged;
  if(status==='partial'){
    const quantity=Number(order.quantity||order.qty||0);
    const remainsVal=providerData.remains??providerData.remaining??order.remains;
    const remains=Number(remainsVal);
    if(!Number.isFinite(quantity)||quantity<=0||remainsVal===undefined||remainsVal===null||String(remainsVal).trim()===''||!Number.isFinite(remains)||remains<0||remains>quantity)return {ok:true,credited:false,state:'pending',reason:'partial-status-without-reliable-remains'};
    if(remains===0){
      const rows=readJSON('orders.json',[]);let changed=false;
      if(Array.isArray(rows)){for(let i=0;i<rows.length;i++){const x=rows[i];if(!x||x.event)continue;const sameId=String(order.id||order.siteOrderId||'')&&String(x.id||x.localId||'')===String(order.id||order.siteOrderId||'')&&String(x.user||'')===user;const sameProvider=String(order.providerOrderId||order.smmpartyOrderId||'')&&String(x.providerOrderId||x.smmpartyOrderId||'')===String(order.providerOrderId||order.smmpartyOrderId||'')&&String(x.user||'')===user;if(sameId||sameProvider){rows[i]={...x,refundState:'no_refund_due',refundLastUpdatedAt:nowISO()};changed=true;}}}
      if(changed)writeJSON('orders.json',rows);
      const fbKey=String(order._firebaseKey||order.firebaseKey||'');if(fbKey){try{await firebasePatchJson('orders/'+fbKey,{refundState:'no_refund_due',refundLastUpdatedAt:nowISO()},5000)}catch(_){}}
      return {ok:true,credited:false,state:'no-refund-due',reason:'provider-reports-zero-undelivered-quantity'};
    }
    target=Math.round(charged*Math.max(0,Math.min(1,remains/quantity))*10000)/10000;
  }
  const key=refundIdentity(order);let userPath='';
  try{const remoteUser=await findRemoteUserByUsername(user);userPath=String(remoteUser?.firebasePath||'');}catch(e){return {ok:false,credited:false,state:'pending',reason:'firebase-user-lookup-failed',error:String(e.message||e).slice(0,160)}}
  if(!userPath)return {ok:false,credited:false,state:'pending',reason:'firebase-user-record-not-found'};
  let transaction;
  try{
    transaction=await firebaseTransaction(userPath,current=>{
      if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-record-not-found'}};
      const refunds=current.sadaRefunds&&typeof current.sadaRefunds==='object'?{...current.sadaRefunds}:{};
      const old=refunds[key]&&typeof refunds[key]==='object'?refunds[key]:{};
      const previous=Math.max(0,Number(old.totalIQD||old.refundedIQD||0)||0);
      const cumulative=Math.min(charged,Math.max(previous,target));const delta=Math.round((cumulative-previous)*10000)/10000;
      if(delta<=0)return {write:false,result:{credited:false,state:'already-credited',totalRefundIQD:previous,balanceIQD:Number(current.balance||0)}};
      const before=Number(current.balance||0);const after=Math.round((before+delta)*10000)/10000;const at=nowISO();
      const event={id:sha256(key+'|'+cumulative).slice(0,32),orderId:String(order.id||order.siteOrderId||order.orderId||''),providerOrderId:String(order.providerOrderId||order.smmpartyOrderId||''),providerId:String(order.providerId||''),serviceName:String(order.serviceName||order.name||order.service||'خدمة'),serviceId:String(order.serviceId||''),status,quantity:Number(order.quantity||order.qty||0),remains:providerData.remains??order.remains??null,amountIQD:delta,totalRefundIQD:cumulative,amountUSD:Number((delta/FIXED_RATE).toFixed(6)),reason:status==='cancelled'?'استرداد بعد تأكيد إلغاء الطلب من المزود':'استرداد الجزء غير المنفذ بعد تأكيد الحالة الجزئية من المزود',createdAt:at};
      const events=Array.isArray(old.events)?old.events.slice(-50):[];events.push(event);
      refunds[key]={key,orderId:event.orderId,providerOrderId:event.providerOrderId,providerId:event.providerId,serviceName:event.serviceName,status,totalIQD:cumulative,amountUSD:Number((cumulative/FIXED_RATE).toFixed(6)),events,updatedAt:at};
      current.balance=after;current.sadaRefunds=refunds;current.updatedAt=at;
      return {write:true,value:current,result:{credited:true,deltaIQD:delta,totalRefundIQD:cumulative,balanceIQD:after,event}};
    });
  }catch(e){return {ok:false,credited:false,state:'pending',reason:'firebase-balance-update-failed',error:String(e.message||e).slice(0,180)}}
  if(transaction.result?.error)return {ok:false,credited:false,state:'pending',reason:transaction.result.error};
  if(transaction.result?.credited){
    const ev=transaction.result.event;const refunds=readJSON('refunds.json',[]);if(Array.isArray(refunds)&&!refunds.some(x=>x.id===ev.id)){refunds.push({...ev,user});writeJSON('refunds.json',refunds.slice(-10000));}
    appendJsonLedger('balance_ledger.json',{user,type:'refund',amountUSD:ev.amountUSD,amountIQD:ev.amountIQD,after:transaction.result.balanceIQD,reason:ev.reason,admin:'system-provider-status',reference:ev.orderId,providerOrderId:ev.providerOrderId,createdAt:ev.createdAt,refundEventId:ev.id});
    const local=readJSON('orders.json',[]);let changed=false;if(Array.isArray(local)){for(let i=0;i<local.length;i++){const x=local[i];if(!x||x.event)continue;const sameId=ev.orderId&&String(x.id||x.localId||'')===ev.orderId&&String(x.user||'')===user;const sameProvider=ev.providerOrderId&&String(x.providerOrderId||x.smmpartyOrderId||'')===ev.providerOrderId&&String(x.user||'')===user;if(sameId||sameProvider){local[i]={...x,refundState:'credited',refundAmountIQD:transaction.result.totalRefundIQD,refundLastUpdatedAt:ev.createdAt};changed=true;}}}if(changed)writeJSON('orders.json',local);
  }
  const result=transaction.result||{};const settledState=result.error?'pending':(result.credited||result.state==='already-credited'?'credited':'pending');
  if(settledState==='credited'){
    const stamp=nowISO();const localRows=readJSON('orders.json',[]);let touched=false;if(Array.isArray(localRows)){for(let i=0;i<localRows.length;i++){const x=localRows[i];if(!x||x.event)continue;const sameId=String(order.id||order.siteOrderId||'')&&String(x.id||x.localId||'')===String(order.id||order.siteOrderId||'')&&(!user||String(x.user||'')===user);const samePo=String(order.providerOrderId||order.smmpartyOrderId||'')&&String(x.providerOrderId||x.smmpartyOrderId||'')===String(order.providerOrderId||order.smmpartyOrderId||'')&&(!user||String(x.user||'')===user);if(sameId||samePo){localRows[i]={...x,refundState:'credited',refundAmountIQD:Number(result.totalRefundIQD||target),refundLastUpdatedAt:stamp};touched=true;}}}if(touched)writeJSON('orders.json',localRows);
    const fbKey=String(order._firebaseKey||order.firebaseKey||'');if(fbKey){try{await firebasePatchJson('orders/'+fbKey,{refundState:'credited',refundAmountIQD:Number(result.totalRefundIQD||target),refundLastUpdatedAt:stamp},5000)}catch(_) {}}
  }
  return {ok:true,credited:!!result.credited,state:result.state|| (result.credited?'credited':settledState),amountIQD:Number(result.deltaIQD||0),totalRefundIQD:Number(result.totalRefundIQD||target),balanceIQD:Number(result.balanceIQD??transaction.value?.balance??0),currency:'IQD',reason:result.reason||''};
}
async function syncVerifiedOrderStatus(order,providerData,normalizedStatus){
  const normalized=normalizeProviderStatus(normalizedStatus||providerData?.status||'');const update={providerStatus:String(providerData?.status||providerData?.data?.status||''),lastCheckedAt:nowISO(),updatedAt:nowISO()};
  if(normalized!=='unknown')update.status=normalized;if(providerData?.remains!==undefined)update.remains=providerData.remains;if(providerData?.start_count!==undefined||providerData?.startCount!==undefined)update.startCount=providerData.start_count??providerData.startCount;
  const full=await resolveFinancialOrder(order);const rows=readJSON('orders.json',[]);let localChanged=false;for(let i=0;i<rows.length;i++){const x=rows[i];if(!x||x.event)continue;const match=(full.id&&String(x.id||x.localId||'')===String(full.id)&&String(x.user||'')===String(full.user||''))||(full.providerOrderId&&String(x.providerOrderId||x.smmpartyOrderId||'')===String(full.providerOrderId)&&String(x.user||'')===String(full.user||''));if(match){rows[i]={...x,...update};localChanged=true;}}
  if(localChanged)writeJSON('orders.json',rows);
  const fbKey=String(full._firebaseKey||full.firebaseKey||'');if(fbKey){try{await firebasePatchJson('orders/'+fbKey,update,7000)}catch(_) {}}
  let refund=null;if(['cancelled','partial'].includes(normalized))refund=await applyVerifiedOrderRefund({...full,...update},providerData,normalized);
  const old=normalizeProviderStatus(full.status||'');if(normalized!=='unknown'&&old!==normalized)notifyOrderStatusChange({...full,...update},old,normalized).catch(()=>{});
  return {order:{...full,...update},refund};
}
async function runRefundReconciliationMonitor(){
  if(runRefundReconciliationMonitor.running)return;runRefundReconciliationMonitor.running=true;
  try{
    const snapshot=await loadOrderMonitorSnapshot();if(!snapshot.rows?.length)return;const now=Date.now();let examined=0;
    const candidates=snapshot.rows.filter(r=>r.providerId&&r.providerOrderId&&(['pending','processing'].includes(r.status)||(['cancelled','partial'].includes(r.status)&&!['credited','no_refund_due'].includes(String(r.refundState||''))))&&(!r.lastCheckedAt||now-(auditTimestamp(r.lastCheckedAt)||0)>180000)).sort((a,b)=>Number(a.createdMs||0)-Number(b.createdMs||0)).slice(0,12);
    for(const row of candidates){if(examined++>=12)break;try{const full=await resolveFinancialOrder(row);await ensureProviderRuntime(row.providerId);const prov=getProviderById(row.providerId,{allowSingleFallback:false}).prov;if(!prov?.url||!prov?.key)continue;const d=await providerRequest(prov,{action:'status',order:String(row.providerOrderId)},15000);const normalized=normalizeProviderStatus(d?.status??d?.data?.status??d?.result?.status??'');if(normalized==='unknown')continue;await syncVerifiedOrderStatus(full,d,normalized);}catch(e){console.warn('refund/order status monitor:',String(e.message||e).slice(0,120));}}
  }catch(e){console.warn('refund reconciliation monitor:',String(e.message||e).slice(0,160));}finally{runRefundReconciliationMonitor.running=false;}
}

const DEFAULT_GLOBAL_PRICING={markupPct:100,autoSync:true,intervalHours:1,intervalMinutes:10,lastAttemptAt:null,lastSuccessAt:null,lastUpdatedAt:null,lastResult:null,lastError:''};
function cleanGlobalPricing(v={}){
  const pct=Number(v.markupPct??v.markup??DEFAULT_GLOBAL_PRICING.markupPct);
  const interval=Number(v.intervalHours??DEFAULT_GLOBAL_PRICING.intervalHours);
  const mins=Number(v.intervalMinutes);return {...DEFAULT_GLOBAL_PRICING,...v,markupPct:Number.isFinite(pct)?Math.max(0,Math.min(1000,pct)):100,autoSync:v.autoSync!==false,intervalHours:[1,3,6,12,24].includes(interval)?interval:1,intervalMinutes:[5,10,15,30,60].includes(mins)?mins:10};
}
function localGlobalPricing(){const settings=readJSON('settings.json',{});return cleanGlobalPricing(settings.pricing||{});}
async function getGlobalPricing(){
  const local=localGlobalPricing();
  try{const remote=await firebaseGetJson('config/pricing',4500);if(remote&&typeof remote==='object'&&!Array.isArray(remote)){const r=cleanGlobalPricing(remote);const lt=Date.parse(local.lastUpdatedAt||'')||0,rt=Date.parse(r.lastUpdatedAt||'')||0;return rt>=lt?r:local;}}catch(_){}
  return local;
}
async function saveGlobalPricing(v){
  PRICE_GUARD_CFG.at=0;const p=cleanGlobalPricing(v);p.lastUpdatedAt=nowISO();p.lastError='';
  const settings=readJSON('settings.json',{});settings.pricing=p;writeJSON('settings.json',settings);
  let persistedRemotely=false,remoteError='';
  try{
    await firebaseWriteJson('config/pricing',p,9000);
    const pricingCheck=await firebaseGetJson('config/pricing',6000);
    if(!pricingCheck||Number(pricingCheck.markupPct)!==Number(p.markupPct)||String(pricingCheck.lastUpdatedAt||'')!==String(p.lastUpdatedAt))throw new Error('فشل التحقق من قراءة config/pricing بعد الحفظ');
    // Keep the legacy import setting in sync too; old import dialogs read settings/markup.
    await firebaseWriteJson('settings/markup',p.markupPct,9000);
    const legacyCheck=await firebaseGetJson('settings/markup',6000);
    if(Number(legacyCheck)!==Number(p.markupPct))throw new Error('فشل التحقق من قراءة settings/markup بعد الحفظ');
    persistedRemotely=true;
  }catch(e){remoteError=String(e.message||e).slice(0,180)}
  return {pricing:p,persistedRemotely,remoteError};
}
function validRateField(s,keys){
  for(const k of keys){const v=s?.[k];if(v===undefined||v===null||String(v).trim()==='')continue;const n=Number(String(v).replace(/,/g,''));if(Number.isFinite(n)&&n>=0)return n;}return null;
}
function providerServiceKey(s){for(const k of ['providerServiceId','smmpartyId','sourceServiceId','provider_service_id','serviceId','service_id']){const v=s?.[k];if(v!==undefined&&v!==null&&String(v).trim()!=='')return String(v).trim()}return ''}
function providerServiceRate(s){if(s&&s.ratePresent===false)return null;return validRateField(s,['rate','rate_usd','rateUsd','usd_rate','usdRate','rate_per_1000','ratePer1000','price_per_1000','pricePer1000','price','cost'])}
function catalogRate(s){return validRateField(s,['providerRateUsd','smmRateUsd','baseProviderRateUsd','smmRate','provider_rate_usd'])}
function pricedPatch(s,base,pct){const sell=Number((base*(1+pct/100)).toFixed(8));return {sellingUsd:sell,price:Number((sell*FIXED_RATE).toFixed(6)),basePrice:Number((base*FIXED_RATE).toFixed(6)),providerRateUsd:base,smmRateUsd:base,smmRate:base,markupPct:pct,priceSyncedAt:nowISO()}}
// Firebase REST multi-path PATCH: write nested field paths, never replace the entire service object.
function appendServicePricePatch(out,key,values){for(const [field,value] of Object.entries(values))out[String(key)+'/'+field]=value;}
async function applyCachedGlobalMarkup(pct){
  await ensureLocalServiceCatalogSeeded();
  const root=readJSON('services.json',{});if(!root||typeof root!=='object'||Array.isArray(root))return {updated:0,skipped:0};
  const patch={};let updated=0,skipped=0;
  for(const [key,s] of Object.entries(root)){
    if(!s||typeof s!=='object'||s.unapprovedAutoImport===true||s.adminFreeService===true||s.serviceKind==='manual_support')continue;const pid=String(s.providerId||'').trim(),sid=providerServiceKey(s);if(!pid||!sid){skipped++;continue}const base=catalogRate(s);if(base===null){skipped++;continue}
    const priced=pricedPatch(s,base,pct);appendServicePricePatch(patch,key,priced);updated++;
  }
  if(updated){for(const [composite,value] of Object.entries(patch)){const split=composite.indexOf('/');if(split<1)continue;const key=composite.slice(0,split),field=composite.slice(split+1);if(root[key]&&typeof root[key]==='object')root[key][field]=value;}writeCatalogNonStructuralJSON('services.json',root);markCatalogSeeded();}
  return {updated,skipped,localUpdated:0,storage:'hosting-json'};
}
// ===== Real-time provider price guard (patch 1.6.29-p1) =====
// A provider price increase must never be sold at the old (lower) price, and nobody should have to press a button:
//  1) every order re-checks the service's saved provider cost against the provider's live catalog (one shared,
//     short-lived request per provider) and re-prices that service immediately when the cost moved;
//  2) a background watcher re-prices the whole catalog every PRICE_WATCH_MINUTES (default 10) so listings follow
//     the provider without waiting for the hourly sync. Disable with PRICE_GUARD=off.
const PRICE_GUARD_ENABLED=String(process.env.PRICE_GUARD||'on').trim().toLowerCase()!=='off';
const PRICE_GUARD_TTL_MS=Math.max(5,Math.min(900,Number(process.env.PRICE_GUARD_TTL_SECONDS)||60))*1000;
const PRICE_WATCH_MS=Math.max(10,Math.min(7200,Number(process.env.PRICE_WATCH_SECONDS)||(Number(process.env.PRICE_WATCH_MINUTES)||10)*60))*1000;
const PRICE_WATCH_FIRST_MS=Math.max(2,Math.min(300,Number(process.env.PRICE_WATCH_FIRST_DELAY_SECONDS)||45))*1000;
const PRICE_GUARD_FETCH_MS=Math.max(3000,Math.min(60000,Number(process.env.PRICE_GUARD_FETCH_TIMEOUT_MS)||20000));
const PRICE_GUARD_STALE_MS=PRICE_GUARD_TTL_MS;
const PRICE_GUARD_CACHE=new Map();
const PRICE_GUARD_STATUS={enabled:PRICE_GUARD_ENABLED,lastWatchAt:'',lastWatchUpdated:0,lastError:'',orderRepricings:0,lastOrderRepriceAt:''};
let PRICE_GUARD_CFG={at:0,pct:100,auto:true};
async function priceGuardConfig(){
  if(Date.now()-PRICE_GUARD_CFG.at<30000)return PRICE_GUARD_CFG;
  const cfg=cleanGlobalPricing(await getGlobalPricing());
  PRICE_GUARD_CFG={at:Date.now(),pct:cfg.markupPct,auto:cfg.autoSync!==false};
  return PRICE_GUARD_CFG;
}
async function priceGuardProviderRates(pid,opts={}){
  let c=PRICE_GUARD_CACHE.get(pid);
  if(!c){c={at:0,byId:null,inflight:null};PRICE_GUARD_CACHE.set(pid,c);}
  if(!opts.force&&c.byId&&Date.now()-c.at<PRICE_GUARD_TTL_MS)return c.byId;
  if(!c.inflight){
    c.inflight=(async()=>{
      await ensureProviderRuntime(pid);
      const found=getProviderById(pid,{allowSingleFallback:false});
      if(!found.prov?.url||!found.prov?.key)throw new Error('provider credentials unavailable');
      const raw=normalizeProviderServices(await providerRequest(found.prov,{action:'services'},PRICE_GUARD_FETCH_MS));
      const byId=new Map();
      for(const r of raw){const id=String(r?.service??r?.service_id??r?.serviceId??r?.id??r?.serviceID??'').trim();if(id)byId.set(id,providerServiceRate(r));}
      if(!byId.size)throw new Error('provider returned an empty catalog');
      byId.catalogComplete=providerCatalogLooksComplete(raw,byId);c.byId=byId;c.at=Date.now();
    })().finally(()=>{c.inflight=null;});
  }
  try{await c.inflight;}
  catch(e){PRICE_GUARD_STATUS.lastError=(pid+': '+String(e.message||e)).slice(0,200);}
  return c.byId&&Date.now()-c.at<PRICE_GUARD_STALE_MS?c.byId:null;
}
// True when the saved price is out of date: the provider cost moved, or we would sell below cost plus markup.
function priceGuardNeeds(row,live,pct){
  if(live===null||live===undefined||!Number.isFinite(live))return false;
  const stored=catalogRate(row),sell=Number(row?.sellingUsd);
  // A sudden zero from the provider is treated as a glitch, never as a reason to give a paid service away.
  if(live===0&&(stored===null||stored>0||(Number.isFinite(sell)&&sell>0)))return false;
  const expected=live*(1+pct/100);
  const costMoved=stored===null||Math.abs(live-stored)>Math.max(1e-9,stored*1e-6);
  const undercharged=!Number.isFinite(sell)||sell<expected*(1-1e-6);
  return costMoved||undercharged;
}
function priceGuardPersist(pid,sid,fbKey,patch){
  const root=readJSON('services.json',{});if(!root||typeof root!=='object'||Array.isArray(root))return false;
  let key=fbKey&&root[fbKey]&&typeof root[fbKey]==='object'&&String(root[fbKey].providerId||'').trim()===pid?String(fbKey):'';
  if(!key){for(const [k,v] of Object.entries(root)){if(v&&typeof v==='object'&&String(v.providerId||'').trim()===pid&&providerServiceKey(v)===sid){key=k;break;}}}
  if(!key)return false;
  Object.assign(root[key],patch);writeCatalogNonStructuralJSON('services.json',root);return true;
}
// Automatic live-price checks may hide a service only when the provider explicitly confirms
// its state. A missing row, malformed response, timeout or suspicious rate is not evidence
// that the owner wants the service disabled. Recover rows hidden by the older unsafe watcher,
// but never override an explicit site-admin disable flag.
const TRANSIENT_PROVIDER_UNAVAILABLE_REASONS = new Set([
  'not_found_in_live_supplier_catalog','provider_catalog_unverified','live_provider_price_unverified',
  'suspicious_zero_provider_rate','live_price_check_failed','live_price_guard_disabled',
  'provider_mapping_incomplete','awaiting_live_price_verification'
]);
function hasExplicitSiteServiceDisable(row={}){
  return row.active===false || row.enabled===false || row.isActive===false || row.hidden===true || row.isHidden===true || row.deleted===true || String(row.status||'').trim().toLowerCase()==='disabled';
}
function isAutoHiddenProviderService(row={}){
  return row.providerAvailable===false && TRANSIENT_PROVIDER_UNAVAILABLE_REASONS.has(String(row.providerAvailabilityReason||'').trim());
}
function isProviderConfirmedRemoved(row={}){return row.providerAvailable===false&&String(row.providerAvailabilityReason||'').trim()==='provider_confirmed_removed';}
function canRestoreProviderAvailability(row={}){return row.providerAvailable!==false||isAutoHiddenProviderService(row)||isProviderConfirmedRemoved(row);}
function providerCatalogLooksComplete(raw,byId){
  // Conservative guard: only infer removal from a non-empty, mostly well-formed catalog.
  // Empty, partial, malformed, or duplicate-heavy responses must never hide site services.
  return Array.isArray(raw)&&raw.length>0&&byId instanceof Map&&byId.size>0&&byId.size>=Math.ceil(raw.length*0.8);
}
function recordProviderMissingCheck(row,completeCatalog,now=nowISO()){
  if(!row||typeof row!=='object'||hasExplicitSiteServiceDisable(row)||!completeCatalog)return {changed:false,removed:false};
  // Keep the service in the site's catalog even after repeated provider misses. Provider mismatch is
  // enforced at order time (fail closed, no debit); only the site administrator may hide a service.
  row.providerMissingChecks=Math.max(0,Number(row.providerMissingChecks)||0)+1;
  row.providerMissingLastCheckedAt=now;
  row.providerLastCatalogVerifiedAt=now;
  return {changed:true,removed:false};
}

function clearProviderMissingChecks(row,now=nowISO()){
  if(!row||typeof row!=='object')return false;const changed=Number(row.providerMissingChecks||0)!==0||isProviderConfirmedRemoved(row);row.providerMissingChecks=0;row.providerMissingLastCheckedAt='';row.providerRemovedConfirmedAt='';
  if(isProviderConfirmedRemoved(row)){row.providerAvailable=true;row.availabilityStatus='available';row.providerAvailabilityReason='';row.providerCheckedAt=now;}return changed;
}
function recoverTransientlyHiddenServices(root,source='provider-sync'){
  if(!root||typeof root!=='object'||Array.isArray(root))return 0;
  let recovered=0;
  for(const row of Object.values(root)){
    if(!row||typeof row!=='object'||Array.isArray(row)||hasExplicitSiteServiceDisable(row)||!isAutoHiddenProviderService(row))continue;
    row.providerAvailable=true;
    row.availabilityStatus='available';
    row.providerAvailabilityReason='awaiting_live_price_verification';
    row.providerAvailabilityRecoveredAt=nowISO();
    recovered++;
  }
  if(recovered){writeCatalogNonStructuralJSON('services.json',root);try{appendJsonLedger('catalog_recovery.json',{at:nowISO(),via:source,recovered,reason:'recovered_old_transient_provider_unavailable_flags'});}catch(_){}}
  return recovered;
}
function transientProviderCheckFailure(svc,reason){
  // Return a transient fail-closed result to this order attempt only. Do not persist it into
  // the shared catalog, because it would hide entire categories if the provider response is partial.
  return {...svc,providerAvailable:false,availabilityStatus:'unavailable',providerCheckedAt:nowISO(),providerAvailabilityReason:reason};
}
async function guardServicePrice(svc){
  if(!svc||typeof svc!=='object')return svc;
  // This item is deliberately free to site users; provider charges still apply to the site's supplier account.
  // Its provider ID and costs come from the server-only free-services store, not from request fields.
  if(svc.adminFreeService===true)return {...svc};
  const pid=String(svc.providerId||'').trim(),sid=providerServiceKey(svc);
  if(hasExplicitSiteServiceDisable(svc))return transientProviderCheckFailure(svc,'site_admin_disabled');
  if(!pid||!sid)return transientProviderCheckFailure(svc,'provider_mapping_incomplete');
  if(!PRICE_GUARD_ENABLED)return transientProviderCheckFailure(svc,'live_price_guard_disabled');
  try{
    const cfg=await priceGuardConfig();
    const rates=await priceGuardProviderRates(pid);
    if(!rates)return transientProviderCheckFailure(svc,'provider_catalog_unverified');
    if(!rates.has(sid))return transientProviderCheckFailure(svc,'not_found_in_live_supplier_catalog');
    const live=rates.get(sid);
    if(live===null||live===undefined||!Number.isFinite(Number(live)))return transientProviderCheckFailure(svc,'live_provider_price_unverified');
    if(Number(live)===0){const storedCost=catalogRate(svc);if(storedCost!==null&&storedCost>0)return transientProviderCheckFailure(svc,'suspicious_zero_provider_rate');}
    const mayRestoreAvailability=canRestoreProviderAvailability(svc);
    const availability=mayRestoreAvailability?{providerAvailable:true,availabilityStatus:'available',providerCheckedAt:nowISO(),providerAvailabilityReason:''}:{};
    if(!priceGuardNeeds(svc,Number(live),cfg.pct)){
      if(Object.keys(availability).length&& (svc.providerAvailable!==true||String(svc.availabilityStatus||'')!=='available'))priceGuardPersist(pid,sid,svc.fbKey,availability);
      return {...svc,...availability};
    }
    const patch={...pricedPatch(svc,Number(live),cfg.pct),...availability};
    priceGuardPersist(pid,sid,svc.fbKey,patch);
    PRICE_GUARD_STATUS.orderRepricings++;PRICE_GUARD_STATUS.lastOrderRepriceAt=nowISO();
    try{appendJsonLedger('price_changes.json',{at:nowISO(),via:'order-guard',providerId:pid,providerServiceId:sid,siteServiceId:String(svc.siteServiceId||''),oldCostUsd:catalogRate(svc),newCostUsd:Number(live),oldSellUsd:Number(svc.sellingUsd),newSellUsd:patch.sellingUsd,markupPct:cfg.pct});}catch(_){}
    return {...svc,...patch,rateUsd:patch.sellingUsd,rate:patch.sellingUsd};
  }catch(e){
    PRICE_GUARD_STATUS.lastError=String(e.message||e).slice(0,200);
    console.warn('Sada price guard check deferred without changing catalog state:',PRICE_GUARD_STATUS.lastError);
    return transientProviderCheckFailure(svc,'live_price_check_failed');
  }
}
let PRICE_WATCH_RUNNING=false;
async function runPriceWatch(){
  if(!PRICE_GUARD_ENABLED||PRICE_WATCH_RUNNING)return {skipped:true};
  PRICE_WATCH_RUNNING=true;
  try{
    const cfg=await priceGuardConfig();if(!cfg.auto)return {skipped:true,reason:'autoSync-off'};
    await ensureLocalServiceCatalogSeeded();
    let first=readJSON('services.json',{});if(!first||typeof first!=='object'||Array.isArray(first))return {skipped:true};
    const recovered=recoverTransientlyHiddenServices(first,'price-watcher-recovery');
    if(recovered)first=readJSON('services.json',{});
    const pids=[...new Set(Object.values(first).filter(v=>v&&typeof v==='object'&&!hasExplicitSiteServiceDisable(v)).map(v=>String(v.providerId||'').trim()).filter(Boolean))].slice(0,20);
    let updated=0,availabilityChanged=0,unverified=0;const errors=[];
    for(const pid of pids){
      const rates=await priceGuardProviderRates(pid,{force:true});
      if(!rates){errors.push(pid+': provider catalog unavailable; service availability and current rates are unverified');continue;}
      // Re-read immediately before writing so a price update never overwrites another catalog mutation.
      const fresh=readJSON('services.json',{});if(!fresh||typeof fresh!=='object'||Array.isArray(fresh))continue;
      const samples=[];let changed=0,availability=0;
      for(const [key,row] of Object.entries(fresh)){
        if(!row||typeof row!=='object'||String(row.providerId||'').trim()!==pid)continue;
        if(hasExplicitSiteServiceDisable(row))continue;
        const sid=providerServiceKey(row);if(!sid)continue;
        // Only two consecutive absences from a well-formed full catalog hide a service.
        // Keep the row for historical orders; a later reappearance restores it automatically.
        if(!rates.has(sid)){
          unverified++;
          if(rates.catalogComplete){const absent=recordProviderMissingCheck(row,true);if(absent.changed)availability++;}
          continue;
        }
        clearProviderMissingChecks(row);
        const live=rates.get(sid),oldCost=catalogRate(row);
        if(live===null||live===undefined||!Number.isFinite(Number(live))||(Number(live)===0&&oldCost!==null&&oldCost>0)){
          unverified++;continue;
        }
        const mayRestoreAvailability=canRestoreProviderAvailability(row);
        const availablePatch=mayRestoreAvailability?{providerAvailable:true,availabilityStatus:'available',providerAvailabilityReason:'',providerCheckedAt:nowISO()}:{};
        const availabilityWasChanged=Object.keys(availablePatch).length>0&&(row.providerAvailable!==true||String(row.availabilityStatus||'')!=='available');
        if(priceGuardNeeds(row,Number(live),cfg.pct)){
          const patch={...pricedPatch(row,Number(live),cfg.pct),...availablePatch};
          if(samples.length<10)samples.push({providerServiceId:sid,oldCostUsd:oldCost,newCostUsd:Number(live),oldSellUsd:Number(row.sellingUsd),newSellUsd:patch.sellingUsd});
          Object.assign(row,patch);changed++;
        }else if(availabilityWasChanged){Object.assign(row,availablePatch);availability++;}
      }
      if(changed||availability){writeJSON('services.json',fresh);updated+=changed;availabilityChanged+=availability;if(changed)try{appendJsonLedger('price_changes.json',{at:nowISO(),via:'watcher',providerId:pid,count:changed,availabilityChanged:availability,markupPct:cfg.pct,samples});}catch(_){}}
    }
    PRICE_GUARD_STATUS.lastWatchAt=nowISO();PRICE_GUARD_STATUS.lastWatchUpdated=updated;PRICE_GUARD_STATUS.lastAvailabilityChanged=availabilityChanged;
    if(errors.length)PRICE_GUARD_STATUS.lastError=errors.join(' | ').slice(0,200);else PRICE_GUARD_STATUS.lastError='';
    return {updated,availabilityChanged,unverified,recovered,errors};
  }catch(e){PRICE_GUARD_STATUS.lastError=String(e.message||e).slice(0,200);return {error:PRICE_GUARD_STATUS.lastError};}
  finally{PRICE_WATCH_RUNNING=false;}
}
function startPriceWatcher(){
  if(!PRICE_GUARD_ENABLED)return;
  const t=setInterval(()=>{runPriceWatch().catch(()=>{});},PRICE_WATCH_MS);t.unref();
  const first=setTimeout(()=>{runPriceWatch().catch(()=>{});},PRICE_WATCH_FIRST_MS);first.unref();
}
let GLOBAL_PRICE_SYNC_RUNNING=false;
async function runProviderPriceSync(options={}){
  if(GLOBAL_PRICE_SYNC_RUNNING)return {ok:false,busy:true,updated:0,errors:['مزامنة أخرى قيد التنفيذ']};
  GLOBAL_PRICE_SYNC_RUNNING=true;
  let cfg=await getGlobalPricing();cfg.lastAttemptAt=nowISO();const settings=readJSON('settings.json',{});settings.pricing=cfg;writeJSON('settings.json',settings);
  const result={ok:true,updated:0,skipped:0,providers:0,providerErrors:[],localUpdated:0,imported:0,newServicesRequireApproval:0,unavailable:0,unverified:0,recovered:0,priceVerified:0};
  try{
    // Migrate the legacy catalog once, then keep automatic pricing on host JSON.
    await ensureLocalServiceCatalogSeeded();
    let root=readJSON('services.json',{});if(!root||typeof root!=='object'||Array.isArray(root))throw new Error('تعذر قراءة كتالوج الخدمات من ملفات الاستضافة');
    result.recovered=recoverTransientlyHiddenServices(root,'provider-sync-recovery');
    if(result.recovered)root=readJSON('services.json',{});
    const rows=Object.entries(root).filter(([k,v])=>v&&typeof v==='object'&&!Array.isArray(v)&&v.unapprovedAutoImport!==true);
    if(!rows.length)throw new Error('كتالوج الخدمات على الاستضافة فارغ؛ لم تُجرَ مزامنة. استورد الخدمات أولاً أو تحقق من ملف services.json.');
    // Local/manual and free services are fulfilled without an external provider. Never attempt provider price sync for them.
    const providerBackedRows=rows.filter(([,svc])=>{
      const kind=String(svc?.serviceKind||svc?.service_kind||'').trim().toLowerCase();
      const pid=String(svc?.providerId||'').trim().toLowerCase();
      return svc?.adminFreeService!==true && svc?.free!==true && svc?.isFree!==true &&
        svc?.manualService!==true && svc?.adminManualService!==true && svc?.catalogLocalManual!==true &&
        kind!=='manual_support' && kind!=='free_service' && kind!=='admin_free' && pid!=='manual-support' && pid!=='free-service' && !!pid;
    });
    const rowsByProvider=new Map();for(const pair of providerBackedRows){const pid=String(pair[1]?.providerId||'').trim();if(!rowsByProvider.has(pid))rowsByProvider.set(pid,[]);rowsByProvider.get(pid).push(pair)}
    const providerIds=[...rowsByProvider.keys()];
    if(!providerIds.length){result.ok=false;result.providerErrors.push('لا توجد خدمات مرتبطة بمزود وسعر تكلفة محفوظ');}
    const pct=cleanGlobalPricing(cfg).markupPct;
    const allPatches={},availabilitySnapshots={};
    for(const pid of providerIds.slice(0,20)){
      const pendingBeforeProvider=result.newServicesRequireApproval;
      try{
        await ensureProviderRuntime(pid);const found=getProviderById(pid,{allowSingleFallback:false});if(!found.prov?.url||!found.prov?.key)throw new Error('بيانات المزود غير متوفرة');
        const raw=normalizeProviderServices(await providerRequest(found.prov,{action:'services'},22000));
        if(!raw.length)throw new Error('المزود لم يرجع قائمة خدمات');
        const byId=new Map();for(const r of raw){const id=String(r?.service??r?.service_id??r?.serviceId??r?.id??r?.serviceID??'').trim();if(id)byId.set(id,r)}
        const catalogComplete=providerCatalogLooksComplete(raw,byId);
        if(!catalogComplete)result.providerErrors.push(pid+': كتالوج المزود غير مكتمل؛ لن تُخفى أي خدمة غائبة');
        let pUpdated=0;
        const providerRows=rowsByProvider.get(pid)||[];
        const existingIds=new Set(providerRows.map(([,v])=>providerServiceKey(v)).filter(Boolean));
        for(const [key,svc] of providerRows){
          const sid=providerServiceKey(svc);if(!sid){result.skipped++;continue}
          const latest=byId.get(sid);
          if(!latest){
            // Only a second consecutive absence from a well-formed, non-empty catalog confirms removal.
            // Never delete the record: order history and provider mapping must remain auditable.
            result.unverified++;result.skipped++;
            if(catalogComplete){const absent=recordProviderMissingCheck(svc,true);if(absent.changed){result.availabilityChanged=(result.availabilityChanged||0)+1;availabilitySnapshots[key]={...svc};}if(absent.removed){result.unavailable++;result.removedConfirmed=(result.removedConfirmed||0)+1;}}
            continue;
          }
          if(clearProviderMissingChecks(svc))availabilitySnapshots[key]={...svc};
          // Repair only generic/empty saved labels when the provider supplies a real name.
          // Never overwrite a meaningful custom name already saved by the site owner.
          const originalProviderName=providerOriginalServiceName(latest);
          const currentName=String(svc.name||'').trim();
          const genericCurrentName=!currentName||/^(?:service|خدمة|service\s*#?\s*\d*|خدمة\s*#?\s*\d*|unknown service|خدمة غير مسماة)$/i.test(currentName);
          if(originalProviderName&&genericCurrentName){appendServicePricePatch(allPatches,key,{name:originalProviderName});result.namesFixed=(result.namesFixed||0)+1;}
          const base=providerServiceRate(latest);
          const oldBase=catalogRate(svc);
          if(base===null||(base===0&&oldBase!==null&&oldBase>0)){
            // Keep the existing service enabled and cached price intact when the rate is
            // absent or suspicious. The order guard will pause an order transiently instead.
            result.unverified++;result.skipped++;
            if(base===0&&oldBase!==null&&oldBase>0)result.providerErrors.push(pid+' الخدمة '+sid+': تجاهلنا سعراً صفرياً غير متوقع؛ لم نغيّر حالة الخدمة');
            continue;
          }
          const priced=pricedPatch(svc,base,pct);
          const canRestore=!hasExplicitSiteServiceDisable(svc)&&canRestoreProviderAvailability(svc);
          appendServicePricePatch(allPatches,key,canRestore?{...priced,providerAvailable:true,availabilityStatus:'available',providerCheckedAt:nowISO(),providerAvailabilityReason:''}:{...priced});
          pUpdated++;result.updated++;result.priceVerified++;
        }
        // Automatic synchronization is price/status-only. Never add provider catalog rows or categories here.
        // New services are imported only through the admin's explicit selected-service import UI.
        for(const latest of raw){
          const sid=String(latest?.service??latest?.service_id??latest?.serviceId??latest?.id??latest?.serviceID??'').trim();
          if(sid&&!existingIds.has(sid))result.newServicesRequireApproval++;
        }
        result.providers++;if(!pUpdated&&result.newServicesRequireApproval===pendingBeforeProvider)result.providerErrors.push(pid+': لم تتم مطابقة معرّفات الخدمات أو لم يوجد سعر صالح');
      }catch(e){result.ok=false;result.providerErrors.push(pid+': '+String(e.message||e).slice(0,160))}
    }
    if(Object.keys(allPatches).length||result.availabilityChanged){
      // Provider requests are awaited above. Re-read the latest catalog before applying narrow field patches
      // so an admin service import/edit completed during the request is never overwritten by a stale snapshot.
      const persistRoot=readJSON('services.json',{});let applied=0;
      const expectedMappings=new Map(rows.map(([key,svc])=>[key,{providerId:String(svc.providerId||''),providerServiceId:providerServiceKey(svc)}]));
      const patchesByKey=new Map();
      for(const [composite,value] of Object.entries(allPatches)){const split=composite.indexOf('/');if(split<1)continue;const key=composite.slice(0,split),field=composite.slice(split+1);if(!patchesByKey.has(key))patchesByKey.set(key,{});patchesByKey.get(key)[field]=value;}
      for(const [key,fields] of patchesByKey){const current=persistRoot[key],expected=expectedMappings.get(key);if(!current||typeof current!=='object'||current.unapprovedAutoImport===true||!expected)continue;if(String(current.providerId||'')!==expected.providerId||providerServiceKey(current)!==expected.providerServiceId)continue;
        for(const [field,value] of Object.entries(fields)){
          if(field==='name') {const nm=String(current.name||'').trim();if(nm&&!/^(?:service|خدمة|service\s*#?\s*\d*|خدمة\s*#?\s*\d*|unknown service|خدمة غير مسماة)$/i.test(nm))continue;}
          if(['providerAvailable','availabilityStatus','providerAvailabilityReason'].includes(field)&&hasExplicitSiteServiceDisable(current))continue;
          if(['providerAvailable','availabilityStatus','providerAvailabilityReason'].includes(field)&&value===true&&!canRestoreProviderAvailability(current))continue;
          current[field]=value;applied++;
        }
      }
      const availabilityFields=['providerMissingChecks','providerMissingLastCheckedAt','providerLastCatalogVerifiedAt','providerAvailable','availabilityStatus','providerAvailabilityReason','providerRemovedConfirmedAt','providerCheckedAt'];
      for(const [key,snapshot] of Object.entries(availabilitySnapshots)){const current=persistRoot[key],expected=expectedMappings.get(key);if(!current||typeof current!=='object'||current.unapprovedAutoImport===true||!expected||String(current.providerId||'')!==expected.providerId||providerServiceKey(current)!==expected.providerServiceId||hasExplicitSiteServiceDisable(current))continue;for(const field of availabilityFields)if(Object.prototype.hasOwnProperty.call(snapshot,field)){current[field]=snapshot[field];applied++;}}
      if(applied){writeCatalogNonStructuralJSON('services.json',persistRoot);markCatalogSeeded();result.storage='hosting-json';result.fieldsApplied=applied;}
    }
    // api_services.json is a compatibility mirror only. Avoid rewriting the whole legacy mirror on every price poll.
    // The authoritative approved catalog above powers API service discovery and order validation.
    result.localUpdated=0;
    cfg=localGlobalPricing();cfg.lastAttemptAt=nowISO();cfg.lastResult={updated:result.updated,skipped:result.skipped,providers:result.providers,localUpdated:result.localUpdated,namesFixed:Number(result.namesFixed||0),imported:0,newServicesRequireApproval:result.newServicesRequireApproval,unavailable:result.unavailable,unverified:result.unverified,recovered:result.recovered,priceVerified:result.priceVerified};cfg.lastError=result.providerErrors.join(' | ').slice(0,700);if(result.updated>0){cfg.lastSuccessAt=nowISO();}else if(!result.providerErrors.length){cfg.lastError='لم يتم العثور على خدمات مطابقة للتحديث'};
    const st=readJSON('settings.json',{});st.pricing=cfg;writeJSON('settings.json',st);try{await firebaseWriteJson('config/pricing',cfg,7000)}catch(_){}
    result.importPolicy='manual-approval-required';result.safetyPolicy='Automatic sync updates approved existing services only. It never creates services/categories; import is available only through the admin selected-service action. Missing/invalid provider rows never trigger bulk deletion.';result.pricing=cfg;return result;
  }catch(e){result.ok=false;result.providerErrors.push(String(e.message||e).slice(0,180));const st=readJSON('settings.json',{});const p=cleanGlobalPricing(st.pricing||{});p.lastAttemptAt=nowISO();p.lastError=result.providerErrors.join(' | ').slice(0,700);st.pricing=p;writeJSON('settings.json',st);try{await firebaseWriteJson('config/pricing',p,5000)}catch(_){}return result;
  }finally{GLOBAL_PRICE_SYNC_RUNNING=false}
}
function isLegacyAutoImportedProviderRow(key,row={}){
  const rowKey=String(key||row.fbKey||row.catalogKey||row.key||'').trim();
  // Explicit re-import by the administrator is an approval boundary, even if an old legacy key/source remains.
  if(row.unapprovedAutoImport!==true&&row.explicitlyApprovedAt)return false;
  return row.unapprovedAutoImport===true||/^svc_auto_/.test(rowKey)||String(row.source||'')==='provider-live-sync';
}
function providerPairKey(row={}){
  const providerId=String(row.providerId||'').trim();
  const providerServiceId=String(row.providerServiceId||row.smmpartyId||row.sourceServiceId||row.provider_service_id||row.service_id||row.serviceId||row.id||'').trim();
  return providerId&&providerServiceId?providerId+'|'+providerServiceId:'';
}
function quarantineUnapprovedAutoImportedServices(){
  // Backwards-compatible no-op. Historical releases could move provider rows and section metadata
  // out of the live catalog during startup, page reads, or price sync. That made existing services
  // disappear without an administrator action. Keep all existing rows in place; the only path that
  // creates a provider service now is POST /api/admin/services/import after an explicit selection.
  const root=readJSON('services.json',{});
  return {changed:0,preserved:Object.keys(root&&typeof root==='object'&&!Array.isArray(root)?root:{}).length,automatic:false,policy:'manual-import-only'};
}

function startGlobalPriceSyncScheduler(){
  // Automatic updates apply only to services already approved in the site catalog. New provider rows require an explicit admin import.
  // Polling is not a webhook; approved prices update in the next successful cycle. The admin autoSync switch controls it.
  const runIfDue=async()=>{try{const p=await getGlobalPricing();if(!p.autoSync)return;const last=Date.parse(p.lastAttemptAt||p.lastSuccessAt||'')||0;const gap=Math.max(5,Number(p.intervalMinutes)||10)*60*1000;if(Date.now()-last<gap)return;await runProviderPriceSync({automatic:true})}catch(e){console.error('Sada pricing scheduler:',String(e.message||e))}};
  const t=setInterval(runIfDue,60*1000);t.unref();const first=setTimeout(runIfDue,120000);first.unref();
}

async function firebaseServiceByKey(fbKey){ const k=firebaseSafeKey(fbKey); const v=await firebaseGetJson('services/'+k); return v&&typeof v==='object'?{...v,fbKey:String(fbKey)}:null; }
async function firebaseUserByUsername(username){ const found=await findRemoteUserByUsername(username); return found?.user&&typeof found.user==='object'?found.user:null; }
function apiKeyFromRequest(req){
  const h=String(req.headers['x-api-key']||'').trim(); if(h)return h;
  const a=String(req.headers.authorization||'').trim(); if(/^Bearer\s+/i.test(a))return a.replace(/^Bearer\s+/i,'').trim();
  const b=req._apiRequestBody&&typeof req._apiRequestBody==='object'?req._apiRequestBody:{};
  return String(b.key||b.api_key||b.apiKey||'').trim();
}
function apiKeyIsPending(rec){
  return !!rec&&!rec.revokedAt&&(String(rec.activationState||'').toLowerCase()==='pending'||String(rec.status||'').toLowerCase()==='pending');
}
function apiKeyUnusedExpiresAt(rec){
  const explicit=Date.parse(String(rec?.unusedExpiresAt||rec?.expiresAt||''));
  if(Number.isFinite(explicit))return explicit;
  const created=Date.parse(String(rec?.createdAt||''));
  return Number.isFinite(created)?created+API_KEY_UNUSED_TTL_MS:0;
}
function apiKeyUnusedExpired(rec,now=Date.now()){
  return apiKeyIsPending(rec)&&!rec.activatedAt&&!rec.lastUsedAt&&apiKeyUnusedExpiresAt(rec)>0&&now>=apiKeyUnusedExpiresAt(rec);
}
async function deleteExpiredApiKey(hash,rec,keys){
  try{
    await firebaseDeleteJson('apiKeys/'+hash,7000);
    const check=await firebaseGetJson('apiKeys/'+hash,7000);
    if(check)throw new Error('Firebase still returns the expired API key record');
    const cache=keys||readJSON('api_keys.json',{});delete cache[hash];writeJSON('api_keys.json',cache);return true;
  }catch(e){console.warn('Unused API key expiration cleanup failed:',String(e.message||e).slice(0,120));return false;}
}
let API_KEY_EXPIRY_SWEEP_BUSY=false;
async function cleanupExpiredUnusedApiKeys(){
  if(API_KEY_EXPIRY_SWEEP_BUSY)return {skipped:true};
  API_KEY_EXPIRY_SWEEP_BUSY=true;
  try{
    const remote=await firebaseGetJson('apiKeys',10000);
    if(!remote||typeof remote!=='object'||Array.isArray(remote))return {checked:0,deleted:0};
    const keys=readJSON('api_keys.json',{});let deleted=0,checked=0;
    for(const [hash,rec] of Object.entries(remote)){
      if(!/^[a-f0-9]{64}$/i.test(hash)||!rec||typeof rec!=='object')continue;
      if(!apiKeyIsPending(rec))continue;checked++;
      if(apiKeyUnusedExpired(rec))if(await deleteExpiredApiKey(hash,rec,keys))deleted++;
    }
    return {checked,deleted};
  }catch(e){console.warn('API key expiry sweep could not reach Firebase:',String(e.message||e).slice(0,120));return {error:true};}
  finally{API_KEY_EXPIRY_SWEEP_BUSY=false;}
}
async function apiKeyUser(req){
  const raw=apiKeyFromRequest(req); if(!raw||raw.length<20)return null;
  const hash=sha256(raw), keys=readJSON('api_keys.json',{}); let rec=null,remoteRead=true;
  try{
    const remote=await firebaseGetJson('apiKeys/'+hash,6500);
    if(remote&&typeof remote==='object'&&!Array.isArray(remote)){
      rec=remote; keys[hash]=remote; writeJSON('api_keys.json',keys);
    }else{
      // A deleted Firebase record must not be resurrected from the local cache if its pending 24-hour window expired.
      const legacy=keys[hash];
      if(apiKeyUnusedExpired(legacy)){delete keys[hash];writeJSON('api_keys.json',keys);req._apiAuthError='key_expired';}
      else if(legacy&&!legacy.revokedAt&&String(legacy.status||'active')==='active'){
        try{
          await firebaseWriteJson('apiKeys/'+hash,legacy,7000);
          const verify=await firebaseGetJson('apiKeys/'+hash,7000);
          if(verify&&verify.username===legacy.username&&verify.masked===legacy.masked){rec=verify;keys[hash]=verify;writeJSON('api_keys.json',keys);}
          else req._apiAuthError='storage_unavailable';
        }catch(e){req._apiAuthError='storage_unavailable';console.warn('Legacy API key durable migration failed:',String(e.message||e).slice(0,120));}
      }
    }
  }catch(e){remoteRead=false;req._apiAuthError='storage_unavailable';console.warn('API key Firebase lookup unavailable:',String(e.message||e).slice(0,140));}
  if(!remoteRead)return null;
  if(apiKeyUnusedExpired(rec)){
    const removed=await deleteExpiredApiKey(hash,rec,keys);
    req._apiAuthError=removed?'key_expired':'storage_unavailable';
    return null;
  }
  if(!rec||rec.revokedAt||['revoked','disabled','inactive'].includes(String(rec.status||'active').toLowerCase())||String(rec.username||'').trim()==='')return null;
  // API access can be blocked centrally per owner without disabling their normal website account.
  try{const apiBlock=await firebaseGetJson('apiKeyBlocks/'+sha256(String(rec.username||'').trim().toLowerCase()),4500);if(apiBlock&&apiBlock.blocked===true){req._apiAuthError='api_user_blocked';return null;}}catch(e){req._apiAuthError='storage_unavailable';console.warn('API owner block status lookup failed:',String(e.message||e).slice(0,100));return null;}
  if(rec.keyHash&&String(rec.keyHash).toLowerCase()!==hash.toLowerCase())return null;
  if(Number(rec.version||0)>=3&&(!Array.isArray(rec.scopes)||!rec.scopes.length))return null;
  let users=readJSON('users.json',{users:{}}).users||{}; let u=users[rec.username];
  if(!u){
    try{
      const remote=await findRemoteUserByUsername(rec.username);
      if(remote?.user&&typeof remote.user==='object'){
        u=remote.user; users[rec.username]=u; const all=readJSON('users.json',{users:{}});all.users=users;writeJSON('users.json',all);
      }
    }catch(e){console.warn('API key user lookup failed:',String(e.message||e).slice(0,140));}
  }
  if(!u)return null;
  // The first valid API-key use activates the key and cancels its unused 24-hour expiry.
  // Existing records remain backwards-compatible; metadata writes are throttled to reduce latency.
  const usedAt=Date.parse(String(rec.lastUsedAt||''));
  if(apiKeyIsPending(rec)||!Number.isFinite(usedAt)||Date.now()-usedAt>=5*60*1000){
    const stamp=nowISO();
    const updated={...rec,status:'active',activationState:'active',activatedAt:rec.activatedAt||stamp,lastUsedAt:stamp};
    try{
      await firebaseWriteJson('apiKeys/'+hash,updated,6500);
      const verify=await firebaseGetJson('apiKeys/'+hash,6500);
      if(!verify||verify.username!==rec.username||String(verify.status||'').toLowerCase()!=='active')throw new Error('API key activation read-back did not match');
      rec=verify;keys[hash]=verify;writeJSON('api_keys.json',keys);
    }catch(e){req._apiAuthError='storage_unavailable';console.warn('API key activation/last-use persistence failed:',String(e.message||e).slice(0,120));return null;}
  }
  return {raw,hash,username:rec.username,record:rec,user:u};
}
setTimeout(()=>cleanupExpiredUnusedApiKeys().catch(()=>{}),90_000).unref();
setInterval(()=>cleanupExpiredUnusedApiKeys().catch(()=>{}),15*60*1000).unref();

function redactSecretObject(value,depth=0){
  if(depth>5)return '[truncated]';
  if(Array.isArray(value))return value.slice(0,100).map(v=>redactSecretObject(v,depth+1));
  if(value&&typeof value==='object'){
    const o={}; for(const [k,v] of Object.entries(value)){
      if(/^(key|api[_-]?key|token|password|secret|authorization)$/i.test(k)) o[k]='[redacted]';
      else o[k]=redactSecretObject(v,depth+1);
    } return o;
  }
  if(typeof value==='string' && value.length>2000)return value.slice(0,2000)+'…';
  return value;
}
// Replace the old raw provider response sanitizer with a redacting version.
safeProviderResponse = function(d){ return redactSecretObject(d); };
function providerAuthErrorText(t){ return /invalid|incorrect|wrong|unauthori[sz]ed|authentication|api\s*key|access\s*denied|expired|login|sign\s*in/i.test(String(t||'')); }
let TELEGRAM_CHANNELS_REMOTE={};
function validTelegramBotToken(value){return /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(String(value||'').trim());}
function normalizeTelegramChatTarget(value){
  let v=String(value||'').trim();if(!v)return '';
  v=v.replace(/^https?:\/\/(?:www\.)?t\.me\//i,'').replace(/[?#].*$/,'').replace(/\/+$/,'').trim();
  if(/^-?\d{5,25}$/.test(v))return v;
  v=v.replace(/^@+/,'').trim();
  // Accept the common accidental trailing @ shown in the admin form (e.g. jbhbhg58@).
  v=v.replace(/@+$/,'').trim();
  return v?'@'+v:'';
}
function validTelegramChatTarget(value){const v=String(value||'').trim();return !v||/^@[A-Za-z][A-Za-z0-9_]{4,63}$/.test(v)||/^-?\d{5,25}$/.test(v);}
function telegramResultSummary(method,result){
  if(!result||typeof result!=='object')return null;
  if(method==='getMe')return {botId:result.id||null,isBot:!!result.is_bot,firstName:String(result.first_name||''),username:String(result.username||'')};
  const chat=result.chat&&typeof result.chat==='object'?result.chat:{};
  return {messageId:result.message_id||null,chat:{id:chat.id??null,type:String(chat.type||''),title:String(chat.title||''),username:String(chat.username||''),firstName:String(chat.first_name||''),lastName:String(chat.last_name||'')}};
}
function readTelegramStoredSecret(settings){
  const tg=settings?.telegram&&typeof settings.telegram==='object'?settings.telegram:{};
  if(tg.tokenEncrypted){if(!telegramEncryptionReady()&&!String(process.env.TELEGRAM_BOT_TOKEN||'').trim()){console.warn('Stored Telegram token is paused because a local encryption key could not be read or created.');return '';}const plain=decryptSecret(tg.tokenEncrypted);if(plain)return plain;}
  // Migrate legacy plaintext only when a stable key can protect it at rest.
  if(tg.token){if(!telegramEncryptionReady()){console.warn('Legacy Telegram token migration paused because an encryption key could not be read or created.');return '';}try{tg.tokenEncrypted=encryptSecret(String(tg.token));delete tg.token;settings.telegram=tg;writeJSON('settings.json',settings);return decryptSecret(tg.tokenEncrypted)||'';}catch(e){console.warn('Telegram token migration failed:',String(e.message||e).slice(0,100));}}
  return '';
}
function telegramConfig(){
  const settings=readJSON('settings.json',{});const cfg=settings.telegram||{};
  const envToken=String(process.env.TELEGRAM_BOT_TOKEN||'').trim();
  const hasStoredCipher=!!String(cfg.tokenEncrypted||'').trim();
  const storedToken=readTelegramStoredSecret(settings);
  // A freshly rotated Railway token takes priority over older encrypted admin-panel data.
  // This lets deployment recover from a leaked/revoked token without plaintext secrets in code.
  const token=String(envToken||storedToken||'').trim();
  const legacyChat=String(process.env.TELEGRAM_CHAT_ID||cfg.chat||'').trim();
  const activationEnv=String(process.env.TELEGRAM_ACTIVATION_CHAT_ID||'-1004403189762').trim();
  const overdueEnv=String(process.env.TELEGRAM_OVERDUE_CHAT_ID||'-1003800848795').trim();
  const adminEnv=String(process.env.TELEGRAM_ADMIN_CHAT_ID||'').trim();
  const legacyChannel=/^@[A-Za-z0-9_]{3,}$/i.test(legacyChat)||/^-100\d{5,}$/.test(legacyChat)?legacyChat:'';
  const activationChat=String(activationEnv||cfg.activationChat||TELEGRAM_CHANNELS_REMOTE.activationChat||legacyChannel).trim();
  const overdueChat=String(overdueEnv||cfg.overdueChat||TELEGRAM_CHANNELS_REMOTE.overdueChat||'').trim();
  const adminChat=String(adminEnv||cfg.adminChat||TELEGRAM_CHANNELS_REMOTE.adminChat||'').trim();
  const envToggle=String(process.env.TELEGRAM_NOTIFICATIONS_ENABLED||'').trim();
  const enabled=envToggle ? envToggle.toLowerCase()!=='false' : (TELEGRAM_CHANNELS_REMOTE.enabled!==undefined?TELEGRAM_CHANNELS_REMOTE.enabled!==false:cfg.enabled!==false);
  const extraEnv=(String(process.env.TELEGRAM_EXTRA_CHAT_IDS||'').trim()||'').split(',').map(x=>x.trim()).filter(Boolean);
  const extraCfg=Array.isArray(cfg.extraChats)?cfg.extraChats.map(x=>String(x||'').trim()).filter(Boolean):[];
  const extra=[...new Set([...extraEnv,...extraCfg])].filter(x=>x!==activationChat&&x!==overdueChat&&x!==adminChat);
  return {enabled,token,tokenSource:envToken?'railway-variable':storedToken?'admin-panel':hasStoredCipher?'stored-unreadable':'none',tokenEncryptionError:!envToken&&hasStoredCipher&&!storedToken,chat:activationChat,activationChat,overdueChat,adminChat,activationEnvLocked:!!activationEnv,overdueEnvLocked:!!overdueEnv,adminEnvLocked:!!adminEnv,extraChats:extra};
}
async function hydrateTelegramChannelsFromFirebase(){
  let any=false;
  try{const remote=await firebaseGetJson('config/telegramChannels',3500);if(remote&&typeof remote==='object'&&!Array.isArray(remote)){TELEGRAM_CHANNELS_REMOTE={activationChat:String(remote.activationChat||''),overdueChat:String(remote.overdueChat||''),adminChat:String(remote.adminChat||''),enabled:remote.enabled!==undefined?remote.enabled:undefined,updatedAt:remote.updatedAt||null};const settings=readJSON('settings.json',{});settings.telegram=settings.telegram||{};if(!process.env.TELEGRAM_ACTIVATION_CHAT_ID&&TELEGRAM_CHANNELS_REMOTE.activationChat&&!settings.telegram.activationChat)settings.telegram.activationChat=TELEGRAM_CHANNELS_REMOTE.activationChat;if(!process.env.TELEGRAM_OVERDUE_CHAT_ID&&TELEGRAM_CHANNELS_REMOTE.overdueChat&&!settings.telegram.overdueChat)settings.telegram.overdueChat=TELEGRAM_CHANNELS_REMOTE.overdueChat;if(!process.env.TELEGRAM_ADMIN_CHAT_ID&&TELEGRAM_CHANNELS_REMOTE.adminChat&&!settings.telegram.adminChat)settings.telegram.adminChat=TELEGRAM_CHANNELS_REMOTE.adminChat;if(process.env.TELEGRAM_NOTIFICATIONS_ENABLED===undefined&&TELEGRAM_CHANNELS_REMOTE.enabled!==undefined)settings.telegram.enabled=TELEGRAM_CHANNELS_REMOTE.enabled;writeJSON('settings.json',settings);any=true}}catch(e){console.warn('Telegram channel hydration skipped:',String(e.message||e).slice(0,120))}
  try{const secret=await firebaseGetJson('config/telegramSecret',3500);if(secret&&typeof secret.tokenEncrypted==='string'&&secret.tokenEncrypted){const settings=readJSON('settings.json',{});settings.telegram=settings.telegram||{};const localCipher=String(settings.telegram.tokenEncrypted||'');const localPlain=localCipher?decryptSecret(localCipher):'';const remotePlain=decryptSecret(secret.tokenEncrypted);if(remotePlain&&(!localCipher||!localPlain)){settings.telegram.tokenEncrypted=secret.tokenEncrypted;delete settings.telegram.token;writeJSON('settings.json',settings);}any=true;}}catch(e){console.warn('Telegram encrypted secret hydration skipped:',String(e.message||e).slice(0,120))}
  return any;
}
function telegramLog(entry){
  const arr=readJSON('telegram_notifications.json',[]);
  arr.push({...entry,createdAt:entry.createdAt||nowISO()});
  writeJSON('telegram_notifications.json',arr.slice(-300));
}
async function telegramApiRequest(token,method,payload,timeoutMs=8000){
  const secret=String(token||'').trim();
  if(!validTelegramBotToken(secret))return {ok:false,error:'صيغة Bot Token غير صحيحة؛ استخدم توكناً جديداً من BotFather.'};
  const apiBase=String(process.env.TELEGRAM_API_BASE||'https://api.telegram.org').replace(/\/+$/,'');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const r=await fetch(`${apiBase}/bot${secret}/${method}`,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(payload||{}),signal:controller.signal});
    const text=await r.text();let d={};try{d=text?JSON.parse(text):{}}catch(_){d={description:text};}
    const summary=telegramResultSummary(method,d.result);
    return {ok:!!(r.ok&&d.ok===true),status:r.status,description:String(d.description||''),messageId:d.result?.message_id||null,resultInfo:summary,raw:r.ok?undefined:redactSecretObject(d)};
  }catch(e){return {ok:false,error:e?.name==='AbortError'?'انتهت مهلة الاتصال بخوادم Telegram':String(e?.message||e)};}
  finally{clearTimeout(timer);}
}
async function telegramRequest(method,payload,timeoutMs=8000){
  const cfg=telegramConfig();
  if(!cfg.enabled)return {ok:false,skipped:true,error:'إشعارات تيليجرام غير مفعلة من الإعدادات'};
  if(!cfg.token)return {ok:false,error:'Bot Token غير محفوظ؛ احفظ توكناً جديداً أولاً'};
  if(method!=='getMe'&&!String(payload?.chat_id||cfg.chat||'').trim())return {ok:false,error:'معرّف الوجهة Chat ID غير محفوظ'};
  return telegramApiRequest(cfg.token,method,payload,timeoutMs);
}
async function telegramTestConnection(){const cfg=telegramConfig();const r=cfg.token?await telegramApiRequest(cfg.token,'getMe',{},8000):{ok:false,error:cfg.tokenEncryptionError?'التوكن المحفوظ لا يمكن فك تشفيره؛ تحقق من ثبات مفتاح التشفير.':'Bot Token غير محفوظ؛ أدخل توكناً جديداً بعد إلغاء التوكن المكشوف.'};telegramLog({kind:'connection_test',ok:r.ok,status:r.status,description:r.description||r.error||'',botId:r.resultInfo?.botId||null,botUsername:r.resultInfo?.username||'',messageId:r.messageId||null});return r;}
async function sendTelegramDetailed(text,meta={}){
  const cfg=telegramConfig();
  const caption=String(text||'').slice(0,1024);
  let r;
  const targetChat=String(meta.chatId||cfg.activationChat||cfg.chat||cfg.adminChat||'').trim();
  if(!targetChat)return {ok:false,error:'معرّف قناة Telegram غير مضبوط'};
  const notificationImage=readStaticAssetBuffer('/telegram-notification.png');
  if(meta.attachPhoto!==false && cfg.enabled!==false && cfg.token && targetChat && notificationImage){
    const apiBase=String(process.env.TELEGRAM_API_BASE||'https://api.telegram.org').replace(/\/+$/,'');
    let photoError='';
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
    try{
      const fd=new FormData();
      fd.append('chat_id',targetChat);
      fd.append('photo',new Blob([notificationImage],{type:'image/png'}),'telegram-notification.png');
      fd.append('caption',caption);
      if(meta.replyMarkup)fd.append('reply_markup',JSON.stringify(meta.replyMarkup));
      const rr=await fetch(`${apiBase}/bot${cfg.token}/sendPhoto`,{method:'POST',body:fd,signal:controller.signal});
      const tx=await rr.text();let dd={};try{dd=tx?JSON.parse(tx):{}}catch(_){dd={description:tx};}
      r={ok:!!(rr.ok&&dd.ok===true),status:rr.status,description:String(dd.description||''),messageId:dd.result?.message_id||null,resultInfo:telegramResultSummary('sendPhoto',dd.result),raw:rr.ok?undefined:redactSecretObject(dd)};
      if(!r.ok)photoError=r.description||'لم يؤكد Telegram إرسال الصورة.';
    }catch(e){photoError=e?.name==='AbortError'?'انتهت مهلة إرسال الصورة إلى Telegram':String(e?.message||e);r={ok:false,error:photoError};}
    finally{clearTimeout(timer)}
    // Network failure and rejected photo uploads both fall back to a real text-message call.
    if(!r.ok){
      const fallback=await telegramRequest('sendMessage',{chat_id:targetChat,text:caption,disable_web_page_preview:true,...(meta.replyMarkup?{reply_markup:meta.replyMarkup}:{})});
      if(fallback.ok)r={...fallback,description:'تم إرسال النص بعد تعذر إرسال الصورة'+(photoError?' — '+photoError:'')};
      else r={...fallback,ok:false,error:fallback.error||fallback.description||photoError||'فشل إرسال الرسالة النصية أيضاً',description:fallback.description||photoError||''};
    }
  }else{
    r=await telegramRequest('sendMessage',{chat_id:targetChat,text:caption,disable_web_page_preview:true,...(meta.replyMarkup?{reply_markup:meta.replyMarkup}:{})});
  }
  telegramLog({kind:meta.kind||'message',ok:r.ok,status:r.status,description:r.description||r.error||'',messageId:r.messageId||null,orderId:meta.orderId||null,media:r.ok&&String(r.description||'').includes('تم إرسال النص')?'text-fallback':'photo-or-text'});
  return r;
}
async function notifyTelegramRecipients(text,meta={}){
  const cfg=telegramConfig();const channel=String(meta.channel||'activation');
  let primaryChat='';let targets=[];
  if(channel==='admin'){primaryChat=cfg.adminChat;targets=[primaryChat];}
  else if(channel==='overdue'){primaryChat=cfg.overdueChat||cfg.adminChat;targets=[primaryChat,cfg.adminChat,...(cfg.extraChats||[])];}
  else{primaryChat=cfg.activationChat;targets=[primaryChat,cfg.adminChat,...(cfg.extraChats||[])];}
  targets=[...new Set(targets.map(x=>String(x||'').trim()).filter(Boolean))];
  if(!cfg.enabled||!cfg.token||!targets.length){const msg=channel==='admin'?'معرّف حساب الأدمن غير محفوظ':channel==='overdue'?'قناة الطلبات المتأخرة وحساب الأدمن غير مضبوطين':'قناة التفعيلات وحساب الأدمن غير مضبوطين';return {ok:false,error:!cfg.enabled?'إشعارات تيليجرام غير مفعلة':!cfg.token?'Bot Token غير محفوظ':msg,results:[]};}
  // Keep the previously working sequential delivery path. Sending to several Telegram chats
  // at once can trigger rate limits and made the activation notification path less reliable.
  const results=[];
  for(const chatId of targets){const r=await sendTelegramDetailed(text,{...meta,chatId});results.push({chatId,ok:!!r.ok,error:r.error||r.description||'',status:r.status||null,messageId:r.messageId||null,chat:r.resultInfo?.chat||null});}
  const primary=results.find(x=>x.chatId===primaryChat);const primaryOk=!!primary?.ok;const deliveredTo=results.filter(x=>x.ok).map(x=>x.chatId);const delivered=deliveredTo.length>0;const fallbackSent=!primaryOk&&delivered;const details=results.map(x=>(x.ok?'نجح ':'فشل ')+x.chatId+(x.error?' — '+x.error:''));return {ok:primaryOk,primaryOk,delivered,fallbackSent,deliveredTo,results,description:primaryOk?'أكد Telegram إرسال الرسالة إلى الوجهة الأساسية.':fallbackSent?'تعذر الإرسال إلى الوجهة الأساسية، لكن وصلت نسخة إلى: '+deliveredTo.join(', ')+'. '+details.join(' | '):details.join(' | ')};
}
async function sendTelegram(text){return (await notifyTelegramRecipients(text,{kind:'message'})).ok;}

function telegramOrderKeys(o={}){
  const rawId=String(o.id||o.siteOrderId||o.orderId||o.order_id||'').trim();
  const rawPublic=String(o.publicOrderNo||o.publicOrderNumber||o.orderNumber||'').trim();
  const numericPublic=/^\d{1,12}$/.test(rawPublic)?String(Number(rawPublic)):'';
  const numericId=/^\d{1,12}$/.test(rawId)?String(Number(rawId)):'';
  const publicNo=numericPublic||(numericId&&Number(numericId)>=3000?numericId:'');
  const userRaw=String(o.user||o.username||o.userName||'').trim(),user=userRaw.toLocaleLowerCase('en-US');
  const keys=[];
  if(publicNo)keys.push('public:'+publicNo+'|u:'+user);
  if(rawId)keys.push('id:'+rawId+'|u:'+userRaw,'id:'+rawId+'|u:'+user);
  if(publicNo)keys.push('id:'+publicNo+'|u:'+userRaw,'id:'+publicNo+'|u:'+user);
  const po=String(o.providerOrderId||o.provider_order_id||o.smmpartyOrderId||'').trim();
  if(po)keys.push('provider:'+String(o.providerId||o.provider_id||'')+'|'+po+'|u:'+user);
  if(!keys.length)keys.push(String(o.source||'')+':'+String(o._firebaseKey||o.firebaseKey||o.createdMs||'')+'|u:'+user);
  return [...new Set(keys)];
}
function telegramOrderIdentity(o={}){return telegramOrderKeys(o)[0]||'';}
function telegramOrderMessage(o={}){
  const text=(v,fallback='—')=>{const x=String(v??'').trim();return x?x:fallback;};
  const numeric=v=>v!==undefined&&v!==null&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
  const rawOrderNo=String(o.publicOrderNo||o.publicOrderNumber||o.orderNumber||(/^[0-9]{1,12}$/.test(String(o.id||''))&&Number(o.id)>=3000?o.id:'')).trim();
  const publicNo=/^[0-9]{1,12}$/.test(rawOrderNo)?String(Number(rawOrderNo)):(/^[0-9]{1,12}$/.test(String(o.id||''))?String(Number(o.id)):'غير متوفر');
  const src=String(o.orderSource||o.origin||o.sourceType||o.source||'').trim().toLowerCase();
  let sourceLine='📍 من داخل التطبيق';
  if(o.externalProviderOrder===true||o.providerDirect===true||['provider','provider-direct','external-provider','provider_link'].includes(src))sourceLine='🏢 طلب مباشر من رابط المزود';
  else if(o.apiCreated===true||['api','public-api','external-api','reseller-api'].includes(src))sourceLine='🌐 عبر API / رابط الربط الخارجي';
  const link=text(o.link||o.url||o.target||o.targetUrl,'');
  let hasValidLink=false;try{const u=new URL(link);hasValidLink=(u.protocol==='http:'||u.protocol==='https:');}catch(_){hasValidLink=false;}
  const quantity=numeric(o.quantity??o.qty)??0;
  const sale=numeric(o.chargeUsd??o.sellingPriceUsd??o.amountUsd??(o.totalIQD!==undefined?Number(o.totalIQD)/FIXED_RATE:undefined));
  const providerCost=numeric(o.providerCostUsd??o.smmCostUsd??(numeric(o.providerRateUsd??o.smmRateUsd)!==null?Number(o.providerRateUsd??o.smmRateUsd)*quantity/1000:undefined));
  const manual=String(o.serviceKind||'')==='manual_support'||o.manualSupport===true;
  const free=o.free===true||o.isFree===true||String(o.category||'').toLowerCase().includes('مجاني')||String(o.category||'').toLowerCase().includes('free')||(sale!==null&&sale<=0);
  const providerName=text(o.providerName||o.provider||o.providerId,manual?'التنفيذ يدوياً عبر الدعم الفني':free?'بدون مزوّد (خدمة مجانية)':'غير مرتبط بمزوّد');
  const providerOrderId=text(o.providerOrderId||o.smmpartyOrderId||o.provider_order_id||o.providerOrderID,manual?'لا يوجد — بانتظار التواصل مع الدعم':'⏳ بانتظار الإرسال');
  const memberName=text(o.userName||o.fullName||o.displayName||o.customerName||o.name||o.user||o.username,'غير متوفر');
  const memberId=text(o.memberId||o.userId||o.uid||o.firebaseUid||o.telegramUserId||o.user||o.username,'غير متوفر');
  const memberEmail=text(o.email||o.userEmail||o.memberEmail,'غير متوفر');
  let time='غير متوفر';
  const date=new Date(o.createdAt||o.created_at||o.timestamp||o.createdMs||Date.now());
  if(Number.isFinite(date.getTime())){try{const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Baghdad',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(x=>[x.type,x.value]));time=`${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;}catch(_){time=date.toISOString().slice(0,16).replace('T',' ');}}
  const platform=text(o.category||o.serviceApp||o.platform||o.app,'غير محدد');
  return `✅ 📦 طلب جديد #${publicNo}
${sourceLine}

━━━━━━━━━━━━━━━
📋 معلومات الطلب
━━━━━━━━━━━━━━━
🔢 | رقم الطلب داخل التطبيق: ${publicNo}
📁 | الخدمة: ${text(o.serviceName||o.service_name||o.name||o.service,'خدمة غير مسماة')}
📱 | المنصة / القسم: ${platform}
♨️ | الكمية: ${quantity.toLocaleString('en-US')}
💵 | سعر الطلب داخل التطبيق: ${sale!==null?'$'+sale.toFixed(4)+(o.totalIQD!==undefined?' · '+Number(o.totalIQD||0).toLocaleString('en-US')+' د.ع':''):'غير مسجل'}
🏭 | تكلفة المزود: ${providerCost!==null?'$'+providerCost.toFixed(4):'غير مسجلة'}
🔗 | الرابط: ${hasValidLink?'افتح الرابط من الزر أدناه ↗':'غير متوفر'}

━━━━━━━━━━━━━━━
🏢 المزود
━━━━━━━━━━━━━━━
🏢 | المزود: ${providerName}
🔑 | رقم الطلب داخل المزود: ${providerOrderId}
🎁 | النوع: ${manual?'خدمة خاصة — تنفيذ يدوي 🛠️':free?'مجاني 🎁':'مدفوع 💳'}

━━━━━━━━━━━━━━━
👤 العضو
━━━━━━━━━━━━━━━
👤 | الاسم: ${memberName}
🆔 | المعرف: ${memberId}
✉️ | البريد: ${memberEmail}
⌚ | الوقت: ${time}`;
}
function telegramOrderReplyMarkup(o={}){
  const raw=String(o.link||o.url||o.target||o.targetUrl||'').trim();
  try{const u=new URL(raw);if(!['http:','https:'].includes(u.protocol))return undefined;return {inline_keyboard:[[{text:'فتح الرابط ↗',url:u.href}]]};}catch(_){return undefined;}
}
function telegramOrderWasDelivered(entry){
  return !!(entry&&typeof entry==='object'&&(entry.primaryOk===true||entry.sentAt||entry.deliveredAt||entry.delivered===true||entry.adminFallbackDelivered===true||(Array.isArray(entry.deliveredTo)&&entry.deliveredTo.length>0)));
}
function mergeTelegramOrderStateEntry(remoteEntry,localEntry){
  if(!remoteEntry)return localEntry||{};
  if(!localEntry)return remoteEntry||{};
  const remoteDelivered=telegramOrderWasDelivered(remoteEntry),localDelivered=telegramOrderWasDelivered(localEntry);
  const remoteTime=Date.parse(remoteEntry.lastAttemptAt||remoteEntry.sentAt||remoteEntry.baselineAt||'')||0;
  const localTime=Date.parse(localEntry.lastAttemptAt||localEntry.sentAt||localEntry.baselineAt||'')||0;
  // Delivered evidence always wins over a stale failed/pending copy from another store.
  const base=remoteDelivered&&!localDelivered?{...localEntry,...remoteEntry}:localDelivered&&!remoteDelivered?{...remoteEntry,...localEntry}:remoteTime>localTime?{...localEntry,...remoteEntry}:{...remoteEntry,...localEntry};
  const deliveredTo=[...new Set([...(Array.isArray(remoteEntry.deliveredTo)?remoteEntry.deliveredTo:[]),...(Array.isArray(localEntry.deliveredTo)?localEntry.deliveredTo:[])].map(x=>String(x||'').trim()).filter(Boolean))];
  return {...base,primaryOk:remoteEntry.primaryOk===true||localEntry.primaryOk===true,adminFallbackDelivered:remoteEntry.adminFallbackDelivered===true||localEntry.adminFallbackDelivered===true,delivered:remoteDelivered||localDelivered,...(remoteEntry.sentAt||localEntry.sentAt?{sentAt:remoteEntry.sentAt||localEntry.sentAt}:{}),...(remoteEntry.deliveredAt||localEntry.deliveredAt?{deliveredAt:remoteEntry.deliveredAt||localEntry.deliveredAt}:{}),...(deliveredTo.length?{deliveredTo}:{}),attempts:Math.max(Number(remoteEntry.attempts||0),Number(localEntry.attempts||0))};
}
async function readTelegramOrderState(){
  const local=readJSON('telegram_order_state.json',{initialized:false,seen:{}});let remote={};
  try{const d=await firebaseGetJson('config/telegramOrderState',4000);if(d&&typeof d==='object'&&!Array.isArray(d))remote=d}catch(_){}
  const remoteSeen=remote.seen&&typeof remote.seen==='object'?remote.seen:{},localSeen=local.seen&&typeof local.seen==='object'?local.seen:{};
  const seen={};for(const key of new Set([...Object.keys(remoteSeen),...Object.keys(localSeen)]))seen[key]=mergeTelegramOrderStateEntry(remoteSeen[key],localSeen[key]);
  const localAt=Date.parse(local.updatedAt||'')||0,remoteAt=Date.parse(remote.updatedAt||'')||0;const stateSource=remoteAt>localAt?remote:local;return {...remote,...local,monitorBuildId:String(stateSource.monitorBuildId||remote.monitorBuildId||local.monitorBuildId||''),monitorStartedAt:Number(stateSource.monitorStartedAt||remote.monitorStartedAt||local.monitorStartedAt||0),initialized:!!(remote.initialized||local.initialized),seen};
}
async function persistTelegramOrderState(state){
  const safe={initialized:!!state.initialized,monitorBuildId:String(state.monitorBuildId||''),monitorStartedAt:Number(state.monitorStartedAt||0),seen:state.seen&&typeof state.seen==='object'?state.seen:{},updatedAt:nowISO()};
  const compact=Object.fromEntries(Object.entries(safe.seen).sort((a,b)=>Date.parse(b[1]?.sentAt||b[1]?.deliveredAt||b[1]?.lastAttemptAt||b[1]?.baselineAt||0)-Date.parse(a[1]?.sentAt||a[1]?.deliveredAt||a[1]?.lastAttemptAt||a[1]?.baselineAt||0)).slice(0,5000));safe.seen=compact;writeJSON('telegram_order_state.json',safe);try{await firebaseWriteJson('config/telegramOrderState',safe,5000);return true}catch(_){return DATA_IS_EXTERNAL;}
}
const TELEGRAM_ORDER_SENDS_IN_FLIGHT=new Map();
async function notifyTelegramNewOrder(o,meta={}){
  const aliases=telegramOrderKeys(o);const key=aliases[0];if(!key)return {ok:false,error:'رقم الطلب غير متوفر'};
  const active=TELEGRAM_ORDER_SENDS_IN_FLIGHT.get(key);if(active)return active;
  const task=(async()=>{
    const st=await readTelegramOrderState();st.seen=st.seen||{};
    const previous=aliases.map(k=>st.seen[k]).find(telegramOrderWasDelivered)||aliases.map(k=>st.seen[k]).find(Boolean)||{};
    if(telegramOrderWasDelivered(previous)){
      const deliveredEntry={...previous,delivered:true};for(const alias of aliases)st.seen[alias]=mergeTelegramOrderStateEntry(st.seen[alias],deliveredEntry);await persistTelegramOrderState(st);
      return {ok:true,primaryOk:previous.primaryOk===true,delivered:true,deliveredTo:Array.isArray(previous.deliveredTo)?previous.deliveredTo:[],skipped:true,description:'تم إرسال إشعار هذا الطلب مسبقاً؛ لن نعيد إرساله.'};
    }
    const previousAttempt=Date.parse(previous.lastAttemptAt||'')||0;
    if(previousAttempt&&Date.now()-previousAttempt<5*60*1000)return {ok:false,primaryOk:false,skipped:true,description:'تأجيل إعادة المحاولة حتى لا يتكرر الإشعار.'};
    const attempt={...previous,lastAttemptAt:nowISO(),attempts:Number(previous.attempts||0)+1,pending:true,source:meta.source||'backend'};
    for(const alias of aliases)st.seen[alias]={...st.seen[alias],...attempt};
    await persistTelegramOrderState(st);
    const result=await notifyTelegramRecipients(telegramOrderMessage(o),{kind:'new_order',orderId:String(o.publicOrderNo||o.publicOrderNumber||o.id||o.siteOrderId||''),replyMarkup:telegramOrderReplyMarkup(o),...meta});
    const latest=await readTelegramOrderState();latest.seen=latest.seen||{};const current=aliases.map(k=>latest.seen[k]).find(Boolean)||attempt;
    const delivered=!!(result.primaryOk||result.delivered||result.ok||(Array.isArray(result.deliveredTo)&&result.deliveredTo.length));
    const settled={...current,lastAttemptAt:attempt.lastAttemptAt,attempts:attempt.attempts,pending:false,primaryOk:!!result.primaryOk,adminFallbackDelivered:!!result.fallbackSent||(!result.primaryOk&&delivered),delivered,deliveredTo:Array.isArray(result.deliveredTo)?result.deliveredTo:[],source:meta.source||'backend',...(delivered?{sentAt:nowISO(),deliveredAt:nowISO()}:{}),lastError:delivered?'':String(result.description||result.error||'تعذر إرسال إشعار الطلب').slice(0,300)};
    for(const alias of aliases)latest.seen[alias]={...latest.seen[alias],...settled};
    await persistTelegramOrderState(latest);return {...result,delivered,deliveredTo:Array.isArray(result.deliveredTo)?result.deliveredTo:[]};
  })();
  TELEGRAM_ORDER_SENDS_IN_FLIGHT.set(key,task);
  try{return await task;}finally{if(TELEGRAM_ORDER_SENDS_IN_FLIGHT.get(key)===task)TELEGRAM_ORDER_SENDS_IN_FLIGHT.delete(key);}
}
const TELEGRAM_ORDER_MONITOR_BOOT_MS=Date.now();
async function runTelegramNewOrdersMonitor(){
  if(TELEGRAM_ORDER_MONITOR_RUNNING)return;TELEGRAM_ORDER_MONITOR_RUNNING=true;
  try{
    const tg=telegramConfig();if(!tg.enabled||!tg.token||!tg.activationChat)return;
    const snap=await loadOrderMonitorSnapshot();if(!snap.firebaseAvailable&&(!snap.rows||!snap.rows.length))return;
    const st=await readTelegramOrderState(),seen={...(st.seen||{})};
    const now=Date.now();
    // Re-baseline once per deployed build. Existing orders are marked as already examined and are NEVER broadcast just because Railway restarted.
    // Only rows with a trustworthy creation timestamp at/after this server process boot are eligible on the first scan.
    if(!st.initialized||String(st.monitorBuildId||'')!==BUILD_ID){
      const createdAfterBoot=[];
      for(const row of (snap.rows||[])){
        const key=telegramOrderIdentity({...row,id:row.siteOrderId||row.id||'',user:row.user||row.username||''});if(!key)continue;
        const createdMs=Number(row.createdMs||0),previous=seen[key];
        if(!row.legacyHistory&&createdMs>=TELEGRAM_ORDER_MONITOR_BOOT_MS){if(!telegramOrderWasDelivered(previous))createdAfterBoot.push(row);continue;}
        if(!telegramOrderWasDelivered(previous))seen[key]={...(previous||{}),baselineAt:previous?.baselineAt||nowISO(),deploymentBaseline:true,source:row.legacyHistory?'legacy-history':'deployment-baseline',pending:false};
      }
      await persistTelegramOrderState({initialized:true,monitorBuildId:BUILD_ID,monitorStartedAt:TELEGRAM_ORDER_MONITOR_BOOT_MS,seen});
      for(const row of createdAfterBoot.slice(0,25)){
        const key=telegramOrderIdentity({...row,id:row.siteOrderId||row.id||'',user:row.user||row.username||''});
        const r=await notifyTelegramNewOrder({...row,id:row.siteOrderId||row.id||'',_firebaseKey:row._firebaseKey||row.firebaseKey||'',source:row.source||''},{source:'monitor-first-scan-new-after-boot'});
        const delivered=!!(r.primaryOk||r.delivered||r.ok||(Array.isArray(r.deliveredTo)&&r.deliveredTo.length));
        seen[key]={...(seen[key]||{}),lastAttemptAt:nowISO(),attempts:Number(seen[key]?.attempts||0)+1,primaryOk:!!r.primaryOk,adminFallbackDelivered:!!r.fallbackSent||(!r.primaryOk&&delivered),delivered,deliveredTo:Array.isArray(r.deliveredTo)?r.deliveredTo:[],...(delivered?{sentAt:nowISO(),deliveredAt:nowISO()}:{}),source:'monitor-first-scan-new-after-boot',lastError:delivered?'':String(r.description||r.error||'تعذر إرسال إشعار القناة').slice(0,300)};
      }
      if(createdAfterBoot.length)await persistTelegramOrderState({initialized:true,monitorBuildId:BUILD_ID,monitorStartedAt:TELEGRAM_ORDER_MONITOR_BOOT_MS,seen});
      return;
    }
    const retryAfterMs=5*60*1000;
    const fresh=(snap.rows||[]).filter(row=>{const key=telegramOrderIdentity({...row,id:row.siteOrderId||row.id||'',user:row.user||row.username||''}),previous=key?seen[key]:null;if(row.legacyHistory||!key||previous?.deploymentBaseline||Number(row.createdMs||0)<Number(st.monitorStartedAt||TELEGRAM_ORDER_MONITOR_BOOT_MS))return false;if(!previous)return true;if(telegramOrderWasDelivered(previous))return false;const last=Date.parse(previous.lastAttemptAt||'')||0;return now-last>=retryAfterMs;}).sort((a,b)=>Number(a.createdMs||0)-Number(b.createdMs||0)).slice(0,25);
    for(const row of fresh){const key=telegramOrderIdentity({...row,id:row.siteOrderId||row.id||'',user:row.user||row.username||''});const siteId=String(row.siteOrderId||row.id||'');const candidateNo=String(row.publicOrderNo||row.publicOrderNumber||row.orderNumber||(/^\d{1,9}$/.test(String(row.id||''))?row.id:'')).trim();const visibleNo=/^\d{1,9}$/.test(candidateNo)?candidateNo:'قيد الترقيم';createUserNotification(row.user||row.username,{type:'order_created',orderId:siteId,status:String(row.status||'pending'),title:'تم استلام طلبك #'+visibleNo,message:'تم استلام طلب '+visibleNo+' لخدمة '+String(row.serviceName||'خدمة')+'، وسيتم تحديث الحالة هنا.',meta:{serviceName:String(row.serviceName||'خدمة'),quantity:Number(row.quantity||0),providerName:String(row.providerName||''),providerOrderId:String(row.providerOrderId||'')}});const r=await notifyTelegramNewOrder({...row,id:siteId,_firebaseKey:row._firebaseKey||row.firebaseKey||'',source:row.source||''},{source:'monitor'});const delivered=!!(r.primaryOk||r.delivered||r.ok||(Array.isArray(r.deliveredTo)&&r.deliveredTo.length));seen[key]={...(seen[key]||{}),lastAttemptAt:nowISO(),attempts:Number(seen[key]?.attempts||0)+1,primaryOk:!!r.primaryOk,adminFallbackDelivered:!!r.fallbackSent||(!r.primaryOk&&delivered),delivered,deliveredTo:Array.isArray(r.deliveredTo)?r.deliveredTo:[],...(delivered?{sentAt:nowISO(),deliveredAt:nowISO()}:{}),source:'monitor',lastError:delivered?'':String(r.description||r.error||'تعذر إرسال إشعار القناة').slice(0,300)};}
    if(fresh.length&&Object.keys(seen).length)await persistTelegramOrderState({initialized:true,monitorBuildId:BUILD_ID,monitorStartedAt:Number(st.monitorStartedAt||TELEGRAM_ORDER_MONITOR_BOOT_MS),seen});
  }catch(e){console.warn('Telegram new-order monitor:',String(e.message||e).slice(0,180))}finally{TELEGRAM_ORDER_MONITOR_RUNNING=false;}
}
let TELEGRAM_ORDER_MONITOR_RUNNING=false;

async function notifyOrderStatusChange(order, oldStatus, newStatus){
  if(!order || String(oldStatus||'')===String(newStatus||'')) return false;
  const labels={processing:'قيد التنفيذ',completed:'مكتمل',partial:'مكتمل جزئياً',cancelled:'ملغي',failed:'فشل',refunded:'تم الاسترداد',pending:'قيد الانتظار'};
  const orderId=String(order.id||order.siteOrderId||order.localId||'');
  createUserNotification(order.user||order.username,{type:'order_status',orderId,status:newStatus,title:'تحديث حالة طلبك #'+orderId,message:'الخدمة: '+String(order.serviceName||'خدمة')+' · الكمية: '+Number(order.quantity||0).toLocaleString('ar-IQ')+' · الحالة الجديدة: '+(labels[newStatus]||newStatus),meta:{serviceName:String(order.serviceName||'خدمة'),quantity:Number(order.quantity||0),providerName:String(order.providerName||''),providerOrderId:String(order.providerOrderId||'')}});
  // Orders/status updates stay in the user's in-app notification center; Telegram channels only receive new-order alerts.
  return false;
}

function providerSafeName(p){return String(p?.name||p?.id||'مزود');}
function normalizeWebsiteOrderService(row,providerId,serviceId,fbKey=''){
  if(!row||typeof row!=='object')return null;
  const hasExplicitRate=row.sellingUsd!==undefined&&row.sellingUsd!==null&&row.sellingUsd!=='' || row.rateUsd!==undefined&&row.rateUsd!==null&&row.rateUsd!=='' || row.rate!==undefined&&row.rate!==null&&row.rate!=='';
  let rateRaw=row.sellingUsd??row.rateUsd??row.rate;
  if(!hasExplicitRate && row.price!==undefined && row.price!==null && row.price!=='')rateRaw=Number(row.price)/FIXED_RATE;
  const sellingUsd=Number(rateRaw);
  const siteServiceId=String(row.siteServiceId||row.catalogId||row.fbKey||fbKey||'').trim();
  const providerServiceId=String(row.providerServiceId||row.sourceServiceId||row.smmpartyId||row.service_id||row.serviceId||serviceId||'').trim();
  return {...row,fbKey:String(row.fbKey||fbKey||''),siteServiceId,id:String(row.id||siteServiceId||serviceId),providerId:String(providerId),providerServiceId,sellingUsd:Number.isFinite(sellingUsd)&&sellingUsd>=0?sellingUsd:NaN,rateUsd:Number.isFinite(sellingUsd)&&sellingUsd>=0?sellingUsd:NaN,min:Number(row.min||100),max:Number(row.max||10000)};
}
function readAdminFreeServices(){
  const v=readJSON('free_services.json',{});return v&&typeof v==='object'&&!Array.isArray(v)?v:{};
}
function adminFreeServiceObject(value){return value&&typeof value==='object'&&!Array.isArray(value)?value:{}}
function adminFreeServiceStateInitialized(value){return !!(value&&typeof value==='object'&&!Array.isArray(value)&&value.initialized===true) || (typeof value==='string'&&value.trim()!=='');}
async function writeAdminFreeServicesFirebase(root,source='admin-update'){
  const clean=adminFreeServiceObject(root),now=nowISO();
  await firebaseWriteJson('adminFreeServices',clean,20000);
  const verify=adminFreeServiceObject(await firebaseGetJson('adminFreeServices',12000));
  if(!catalogValuesEqual(verify,clean))throw new Error('لم يتم التحقق من حفظ الخدمات المجانية في Firebase؛ لم يُعلن نجاح العملية.');
  const prior=await firebaseGetJson('settings/adminFreeServicesInitializedAt',6000).catch(()=>null);
  const marker={initialized:true,initializedAt:(prior&&typeof prior==='object'&&prior.initializedAt)||((typeof prior==='string'&&prior)||now),updatedAt:now,source:String(source||'admin-update'),count:Object.keys(clean).length};
  await firebaseWriteJson('settings/adminFreeServicesInitializedAt',marker,9000);
  const markerCheck=await firebaseGetJson('settings/adminFreeServicesInitializedAt',7000);
  if(!adminFreeServiceStateInitialized(markerCheck))throw new Error('حُفظت الخدمات لكن تعذر التحقق من علامة تهيئة مخزن الخدمات؛ أعد الفحص قبل محاولة جديدة.');
  writeJSON('free_services.json',clean);ADMIN_FREE_SERVICES_READY=true;ADMIN_FREE_SERVICES_SYNC_AT=Date.now();
  return {count:Object.keys(clean).length,verified:true,source:marker.source};
}
async function ensureAdminFreeServicesDurable(options={}){
  const force=options.refresh===true,now=Date.now();
  if(!force&&ADMIN_FREE_SERVICES_READY&&now-ADMIN_FREE_SERVICES_SYNC_AT<ADMIN_FREE_SERVICES_SYNC_TTL_MS)return readAdminFreeServices();
  if(ADMIN_FREE_SERVICES_SYNC_IN_FLIGHT)return ADMIN_FREE_SERVICES_SYNC_IN_FLIGHT;
  ADMIN_FREE_SERVICES_SYNC_IN_FLIGHT=(async()=>{
    let remote,marker;
    try{[remote,marker]=await Promise.all([firebaseGetJson('adminFreeServices',12000),firebaseGetJson('settings/adminFreeServicesInitializedAt',8000)])}
    catch(e){throw new Error('تعذر قراءة مخزن الخدمات المجانية من Firebase؛ احتفظنا بالنسخة المحلية ولم نحذفها. '+String(e.message||e).slice(0,140))}
    const local=adminFreeServiceObject(readJSON('free_services.json',{}));let root;
    const localCount=Object.keys(local).length;
    const markerCount=marker&&typeof marker==='object'&&Number.isFinite(Number(marker.count))?Math.max(0,Math.floor(Number(marker.count))):null;
    const markerSource=String(marker?.source||'');
    const explicitlyCleared=adminFreeServiceStateInitialized(marker)&&markerCount===0&&['admin-update','admin-delete','bulk-delete','admin-clear'].includes(markerSource);
    if(remote&&typeof remote==='object'&&!Array.isArray(remote)){
      const remoteCount=Object.keys(adminFreeServiceObject(remote)).length;
      // Empty/partial Firebase catalogs must not overwrite a known local mirror if the durable
      // marker says more services existed. Fail closed until an administrator checks history/backups.
      if(!explicitlyCleared&&markerCount!==null&&remoteCount<markerCount){
        throw new Error('قائمة Firebase للخدمات المجانية تحتوي '+remoteCount+' خدمة، لكن سجل آخر حفظ يؤكد '+markerCount+'. تم الاحتفاظ بالنسخة المحلية ولم نكتب القائمة الناقصة فوقها؛ راجع سجل Firebase/النسخة الاحتياطية قبل الاستعادة.');
      }
      if(!explicitlyCleared&&remoteCount===0&&localCount>0){
        throw new Error('قائمة Firebase للخدمات المجانية فارغة مع وجود '+localCount+' خدمة في النسخة المحلية. تم الاحتفاظ بالنسخة المحلية ولم نستعدها أو نحذفها تلقائياً؛ يلزم التحقق من سجل/نسخة احتياطية.');
      }
      root=adminFreeServiceObject(remote);
      // Firebase is authoritative only when it is consistent with its durable count marker.
    }else if(!adminFreeServiceStateInitialized(marker)){
      // Safe one-time migration of legacy on-host records. This is allowed only before a marker
      // exists; later deployments must never resurrect records deliberately deleted from Firebase.
      root=local;
      if(Object.keys(root).length){await writeAdminFreeServicesFirebase(root,'one-time-legacy-migration');}
      else{
        const createdAt=nowISO(),fresh={initialized:true,initializedAt:createdAt,updatedAt:createdAt,source:'first-run-empty',count:0};
        await firebaseWriteJson('settings/adminFreeServicesInitializedAt',fresh,9000);
        const check=await firebaseGetJson('settings/adminFreeServicesInitializedAt',7000);
        if(!adminFreeServiceStateInitialized(check))throw new Error('تعذر تهيئة مخزن الخدمات المجانية الدائم.');
      }
    }else{
      if(localCount||markerCount>0)throw new Error('سجل Firebase للخدمات المجانية مفقود رغم وجود مؤشر سابق للخدمات. تم الاحتفاظ بالنسخة المحلية ولم نكتب فوقها؛ يلزم فحص سجل/نسخة احتياطية من الإدارة.');
      root={};
    }
    writeJSON('free_services.json',root);SITE_SERVICE_IDS_DIRTY=true;ensureNumericSiteServiceIds();
    const normalized=adminFreeServiceObject(readJSON('free_services.json',{}));
    if(!catalogValuesEqual(adminFreeServiceObject(remote),normalized)){
      if(remote===null||remote===undefined){
        if(adminFreeServiceStateInitialized(marker)&&Object.keys(normalized).length)throw new Error('لم نعد كتابة نسخة محلية فوق سجل Firebase فارغ؛ نحتاج تحققاً إدارياً من مصدر البيانات.');
        if(Object.keys(normalized).length)await writeAdminFreeServicesFirebase(normalized,'one-time-legacy-migration');
      }else await writeAdminFreeServicesFirebase(normalized,'service-id-normalization');
    }else if(!adminFreeServiceStateInitialized(marker)){
      const createdAt=nowISO(),fresh={initialized:true,initializedAt:createdAt,updatedAt:createdAt,source:'firebase-existing',count:Object.keys(normalized).length};
      await firebaseWriteJson('settings/adminFreeServicesInitializedAt',fresh,9000);
      const check=await firebaseGetJson('settings/adminFreeServicesInitializedAt',7000);if(!adminFreeServiceStateInitialized(check))throw new Error('لم يتم التحقق من تهيئة مخزن الخدمات المجانية.');
    }
    ADMIN_FREE_SERVICES_READY=true;ADMIN_FREE_SERVICES_SYNC_AT=Date.now();return normalized;
  })();
  try{return await ADMIN_FREE_SERVICES_SYNC_IN_FLIGHT;}finally{ADMIN_FREE_SERVICES_SYNC_IN_FLIGHT=null;}
}
async function persistAdminFreeServicesRoot(root,source='admin-update'){
  const clean=adminFreeServiceObject(root);
  return await writeAdminFreeServicesFirebase(clean,source);
}
const CUSTOM_SHOP_PLATFORMS=Object.freeze({Instagram:'إنستغرام',Tiktok:'تيك توك',Youtube:'يوتيوب',Facebook:'فيسبوك',Telegram:'تيليجرام',Twitter:'تويتر / X',Snapchat:'سناب شات',Whatsapp:'واتساب',Linkedin:'لينكدإن',Other:'أخرى'});
let CUSTOM_SHOP_CACHE={at:0,value:null,promise:null};
function customShopRoot(v){return v&&typeof v==='object'&&!Array.isArray(v)?{categories:v.categories&&typeof v.categories==='object'&&!Array.isArray(v.categories)?v.categories:{},services:v.services&&typeof v.services==='object'&&!Array.isArray(v.services)?v.services:{}}:{categories:{},services:{}};}
function customShopKey(prefix='item'){return prefix+'_'+crypto.randomBytes(10).toString('hex');}
function customShopImageUrl(value,fallback=''){const raw=String(value===undefined?fallback:(value||'')).trim().slice(0,2048);if(!raw)return '';if(/^\/media\/custom-shop\/[a-z0-9-]+\.(?:jpg|jpeg|png|webp)$/i.test(raw))return raw;if(/^https:\/\/[^\s\"'<>]+$/i.test(raw))return raw;throw new Error('رابط صورة القسم أو الخدمة غير صالح؛ ارفع صورة من حقل الصورة.');}
function customShopRemoveImage(url){const m=String(url||'').match(/^\/media\/custom-shop\/([a-z0-9-]+\.(?:jpg|jpeg|png|webp))$/i);if(!m)return;try{fs.rmSync(path.join(DATA,'custom-shop-media',m[1]),{force:true})}catch(_){}}
function customShopPlatformKey(value){
  const raw=String(value??'').trim();if(!raw)return '';
  const key=raw.toLocaleLowerCase('ar').normalize('NFKC').replace(/[\u200B-\u200F\uFEFF]/g,'').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/[\s_-]+/g,'');
  if(['all','__all__','الكل','جميعالمنصات','كلالمنصات'].includes(key))return 'all';
  const aliases={
    Instagram:['instagram','insta','انستغرام','انستجرام','انستقرام','انستا','انستغرام'],
    Tiktok:['tiktok','tiktokapp','تيكتوك','تيكتوك','تيكتوك','تيك توك'],
    Youtube:['youtube','يوتيوب'],Facebook:['facebook','فيسبوك','فيس','فيس بوك'],
    Telegram:['telegram','تلجرام','تيليجرام','تليجرام','تلغرام'],Twitter:['twitter','x','x.com','تويتر','تويترx'],
    Snapchat:['snapchat','سناب','سنابشات','سناب شات'],Whatsapp:['whatsapp','واتساب','واتس اب'],
    Linkedin:['linkedin','لينكدان','لينكدإن'],Other:['other','اخرى','أخرى','عام','smm']
  };
  for(const [id,values] of Object.entries(aliases))if(values.some(v=>String(v).toLocaleLowerCase('ar').normalize('NFKC').replace(/[أإآٱ]/g,'ا').replace(/ى/g,'ي').replace(/[\s_-]+/g,'')===key))return id;
  return Object.prototype.hasOwnProperty.call(CUSTOM_SHOP_PLATFORMS,raw)?raw:'';
}
function customShopPlatforms(input){
  const raw=Array.isArray(input)?input:[input];
  const normalized=raw.map(customShopPlatformKey).filter(Boolean);
  if(normalized.includes('all'))return ['all'];
  return [...new Set(normalized)];
}
function customShopIncludesPlatform(row,platform){
  const target=customShopPlatformKey(platform);if(!target||target==='all')return true;
  let list=Array.isArray(row?.platforms)?row.platforms:[];
  if(!list.length){const legacy=row?.platform??row?.app??row?.serviceApp??row?.servicePlatform;if(legacy!==undefined&&legacy!==null&&String(legacy).trim())list=[legacy];else return true;}
  const normalized=list.map(customShopPlatformKey).filter(Boolean);
  return normalized.includes('all')||normalized.includes(target);
}
async function readCustomShopRemote(force=false){
  const now=Date.now();if(!force&&CUSTOM_SHOP_CACHE.value&&now-CUSTOM_SHOP_CACHE.at<12000)return CUSTOM_SHOP_CACHE.value;
  if(!force&&CUSTOM_SHOP_CACHE.promise)return CUSTOM_SHOP_CACHE.promise;
  CUSTOM_SHOP_CACHE.promise=(async()=>{const raw=await firebaseGetJson('customShop',9000);const value=customShopRoot(raw);CUSTOM_SHOP_CACHE={at:Date.now(),value,promise:null};return value;})();
  try{return await CUSTOM_SHOP_CACHE.promise}catch(e){CUSTOM_SHOP_CACHE.promise=null;throw e;}
}
async function writeCustomShopRecord(pathname,value){
  await firebaseWriteJson(pathname,value,10000);const check=await firebaseGetJson(pathname,10000);
  if(value===null){if(check!==null&&check!==undefined)throw new Error('لم يتأكد حذف السجل من Firebase.');}
  else if(!check||typeof check!=='object'||String(check.key||'')!==String(value.key||''))throw new Error('لم يتأكد حفظ السجل في Firebase.');
  CUSTOM_SHOP_CACHE={at:0,value:null,promise:null};return check;
}
async function saveCustomShopCategory(b,root,actor,at){
  const key=String(b.key||'').trim()||customShopKey('section'),name=String(b.name||'').trim(),description=String(b.description||'').trim().slice(0,1500),parentKey=String(b.parentKey||'').trim(),platforms=customShopPlatforms(b.platforms);
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(key))throw new Error('معرّف القسم غير صالح.');
  if(!name||name.length>120)throw new Error('اسم القسم مطلوب، وبحد أقصى 120 حرفاً.');
  if(!platforms.length)throw new Error('اختر منصة واحدة على الأقل أو اختر كل المنصات.');
  if(parentKey&&(!root.categories[parentKey]||root.categories[parentKey].enabled===false||root.categories[parentKey].parentKey))throw new Error('اختر قسماً رئيسياً موجوداً؛ لا يمكن إنشاء أكثر من مستويين للأقسام.');
  if(parentKey&&Array.isArray(root.categories[parentKey]?.platforms)&&!root.categories[parentKey].platforms.includes('all')&&!platforms.includes('all')&&platforms.some(x=>!root.categories[parentKey].platforms.includes(x)))throw new Error('منصات القسم الفرعي يجب أن تكون ضمن منصات القسم الرئيسي.');
  const old=root.categories[key]||{},imageUrl=customShopImageUrl(b.imageUrl,old.imageUrl||''),record={...old,key,name,description,parentKey,platforms,imageUrl,enabled:b.enabled===undefined?old.enabled!==false:b.enabled===true,createdAt:old.createdAt||at,updatedAt:at,createdBy:old.createdBy||actor,updatedBy:actor};
  await writeCustomShopRecord('customShop/categories/'+key,record);if(old.imageUrl&&old.imageUrl!==imageUrl)customShopRemoveImage(old.imageUrl);return record;
}
async function saveCustomShopService(b,root,actor,at){
  const key=String(b.key||'').trim()||customShopKey('service'),categoryKey=String(b.categoryKey||'').trim(),name=String(b.name||'').trim(),description=String(b.description||'').trim().slice(0,4000),platforms=customShopPlatforms(b.platforms),priceIQD=Number(b.priceIQD),minQuantity=Math.floor(Number(b.minQuantity??1)),maxQuantity=Math.floor(Number(b.maxQuantity??1)),inputLabel=String(b.inputLabel||'الرابط أو اسم الحساب').trim().slice(0,100),inputPlaceholder=String(b.inputPlaceholder||'أدخل الرابط أو اسم الحساب').trim().slice(0,180),inputType=String(b.inputType||'text'),requiresInput=b.requiresInput!==false;
  const category=root.categories[categoryKey];if(!category||category.enabled===false)throw new Error('اختر قسماً فعالاً موجوداً.');
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(key))throw new Error('معرّف الخدمة غير صالح.');
  if(!name||name.length>180)throw new Error('اسم الخدمة مطلوب، وبحد أقصى 180 حرفاً.');
  if(!platforms.length)throw new Error('اختر منصة واحدة على الأقل أو اختر كل المنصات.');
  if(!Number.isFinite(priceIQD)||priceIQD<0||priceIQD>1e9)throw new Error('السعر بالدينار يجب أن يكون رقماً بين صفر ومليار.');
  if(!Number.isSafeInteger(minQuantity)||minQuantity<1||!Number.isSafeInteger(maxQuantity)||maxQuantity<minQuantity||maxQuantity>1000000)throw new Error('حدود الكمية غير صحيحة (1–1,000,000).');
  if(!['text','url'].includes(inputType))throw new Error('نوع بيانات المستخدم غير صالح.');
  if(inputType==='url'&&requiresInput===false)throw new Error('خدمة الرابط يجب أن تتطلب إدخال الرابط.');
  const categoryPlatforms=customShopPlatforms(category.platforms);if(!categoryPlatforms.includes('all')&&!platforms.includes('all')&&platforms.some(x=>!categoryPlatforms.includes(x)))throw new Error('منصات الخدمة يجب أن تكون ضمن منصات القسم.');
  const old=root.services[key]||{},imageUrl=customShopImageUrl(b.imageUrl,old.imageUrl||''),record={...old,key,categoryKey,name,description,platforms,imageUrl,priceIQD:Number(priceIQD.toFixed(4)),minQuantity,maxQuantity,inputLabel,inputPlaceholder,inputType,requiresInput,enabled:b.enabled===undefined?old.enabled!==false:b.enabled===true,serviceKind:'custom_shop',createdAt:old.createdAt||at,updatedAt:at,createdBy:old.createdBy||actor,updatedBy:actor};
  await writeCustomShopRecord('customShop/services/'+key,record);if(old.imageUrl&&old.imageUrl!==imageUrl)customShopRemoveImage(old.imageUrl);return record;
}
async function handleCustomShopOrder(req,b,username,orderSession){
  if(String(b.serviceKind||'')!=='custom_shop'&&b.customShop!==true)return null;
  const localId=String(b.localId||'').trim(),serviceKey=String(b.serviceKey||'').trim(),categoryKey=String(b.categoryKey||'').trim(),platform=String(b.platform||'').trim(),quantity=Number(b.quantity),details=String(b.details||b.link||'').trim().slice(0,2000);
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(localId))return {status:422,body:{ok:false,error:'رقم تتبع الطلب غير صالح.'}};
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(serviceKey)||!categoryKey)return {status:422,body:{ok:false,error:'بيانات الخدمة والقسم مطلوبة.'}};
  const localOrders=readJSON('orders.json',[]);let prior=Array.isArray(localOrders)?localOrders.find(o=>String(o.user||o.username||'')===username&&String(o.localId||o.id||'')===localId&&String(o.serviceKind||'')==='custom_shop'):null;
  if(!prior){try{const fb=await firebaseGetJson('orders/'+firebaseSafeKey(localId),5000);if(fb&&String(fb.user||fb.username||'')===username&&String(fb.serviceKind||'')==='custom_shop')prior=fb}catch(_){}}
  if(prior){if(String(prior.customShopServiceKey||'')!==serviceKey)return {status:409,body:{ok:false,error:'رقم تتبع الطلب مستخدم لعملية شراء مختلفة.'}};return {status:200,body:{ok:true,idempotent:true,order:prior,siteOrderId:String(prior.id||localId),publicOrderNo:String(prior.publicOrderNo||''),totalIQD:Number(prior.totalIQD??prior.total??0),supportWhatsappUrl:normalizeWhatsAppUrl(readJSON('settings.json',{}).waUrl||'https://wa.me/9647762267959')}};}
  let root;try{root=await readCustomShopRemote(true)}catch(e){return {status:503,body:{ok:false,error:'تعذر التحقق من الخدمة في Firebase؛ لم يُخصم أي رصيد.'}};}
  const svc=root.services[serviceKey],cat=root.categories[categoryKey];
  if(!svc||svc.enabled===false||String(svc.categoryKey)!==categoryKey||svc.serviceKind!=='custom_shop'||!cat||cat.enabled===false)return {status:409,body:{ok:false,error:'الخدمة أو القسم غير متاح حالياً. حدّث الصفحة وحاول مجدداً.'}};
  if(String(platform)!==''&&!Object.prototype.hasOwnProperty.call(CUSTOM_SHOP_PLATFORMS,platform))return {status:422,body:{ok:false,error:'المنصة المختارة غير صحيحة.'}};
  if(!customShopIncludesPlatform(svc,platform)||!customShopIncludesPlatform(cat,platform))return {status:409,body:{ok:false,error:'الخدمة غير متاحة على المنصة المحددة.'}};
  const min=Math.max(1,Math.floor(Number(svc.minQuantity)||1)),max=Math.max(min,Math.floor(Number(svc.maxQuantity)||min));
  if(!Number.isSafeInteger(quantity)||quantity<min||quantity>max)return {status:422,body:{ok:false,error:'الكمية خارج الحدود المحددة.',min,max}};
  if(svc.requiresInput!==false&&!details)return {status:422,body:{ok:false,error:String(svc.inputLabel||'بيانات الحساب مطلوبة')+' مطلوبة.'}};
  if(details&&String(svc.inputType||'text')==='url'){try{const u=new URL(details);if(!['https:','http:'].includes(u.protocol)||!u.hostname.includes('.')||u.username||u.password)throw new Error();}catch(_){return {status:422,body:{ok:false,error:'الرابط غير صالح؛ تأكد أنه يبدأ بـ https:// أو http://.'}};}}
  const price=Number(svc.priceIQD);if(!Number.isFinite(price)||price<0)return {status:409,body:{ok:false,error:'سعر الخدمة غير صالح؛ لم يُخصم أي رصيد.'}};
  const amountIQD=Number((price*quantity).toFixed(4));if(!Number.isFinite(amountIQD)||amountIQD<0||amountIQD>1e12)return {status:422,body:{ok:false,error:'إجمالي الطلب غير صالح.'}};
  const isAdminSession=orderSession?.role==='admin';let verifiedUser=null,walletUserPath='',localUser=readJSON('users.json',{users:{}}).users?.[username]||{};
  if(!isAdminSession){try{verifiedUser=await findRemoteUserByUsername(username);walletUserPath=String(verifiedUser?.firebasePath||'')}catch(_){return {status:503,body:{ok:false,error:'تعذر التحقق من الرصيد في Firebase؛ لم يُنشأ الطلب.'}};}if(!verifiedUser?.user||!walletUserPath)return {status:503,body:{ok:false,error:'لم يُعثر على سجل رصيد المستخدم في Firebase؛ لم يُنشأ الطلب.'}};}
  let reservation=null;if(!isAdminSession){reservation=await reserveManualSupportUsageAndWallet(username,walletUserPath,'customshop_'+serviceKey,0,localId,amountIQD,serviceKey);if(!reservation.ok){if(reservation.insufficient)return {status:402,body:{ok:false,error:reservation.error,balanceIQD:reservation.balanceIQD}};if(reservation.duplicate)return {status:409,body:{ok:false,error:reservation.error,uncertain:true}};return {status:503,body:{ok:false,error:reservation.error||'تعذر حجز الرصيد بأمان.'}};}}
  let publicOrderNo='';try{publicOrderNo=await nextPublicOrderNumber()}catch(e){if(reservation?.ok)await releaseManualSupportUsageAndWallet(walletUserPath,username,'customshop_'+serviceKey,localId);return {status:503,body:{ok:false,error:'تعذر تخصيص رقم الطلب. لم يتم تأكيد عملية الشراء.'}};}
  const at=nowISO(),profile=verifiedUser?.user||localUser||{},categoryName=String(cat.name||''),siteOrderId=localId;
  const order={id:siteOrderId,localId,publicOrderNo,user:username,userName:String(profile.fullName||profile.displayName||profile.name||profile.username||username),memberId:String(profile.id||profile.userId||profile.uid||username),orderSource:'custom-shop',origin:'app',providerId:'manual-support',providerName:'التنفيذ اليدوي عبر واتساب',providerOrderId:'',providerServiceId:'',serviceId:serviceKey,siteServiceId:serviceKey,customShopServiceKey:serviceKey,customShopCategoryKey:categoryKey,customShopOrder:true,serviceKind:'custom_shop',manualSupportStatus:'awaiting_contact',serviceName:String(svc.name||'خدمة'),description:String(svc.description||''),serviceApp:platform||'Other',platform:platform||'Other',category:categoryName,link:details,customerDetails:details,quantity,unitPriceIQD:Number(price.toFixed(4)),discountPct:0,chargeUsd:Number((amountIQD/FIXED_RATE).toFixed(6)),total:amountIQD,totalIQD:amountIQD,status:'pending',statusText:'بانتظار التواصل عبر واتساب',billingMode:isAdminSession?'admin-test':'user',free:amountIQD<=0,createdAt:at,updatedAt:at,providerCostUnknown:true};
  try{await persistOrderToFirebase(order)}catch(e){let check=null;try{check=await firebaseGetJson('orders/'+firebaseSafeKey(siteOrderId),5000)}catch(_){}if(check&&String(check.id||'')===siteOrderId&&String(check.user||check.username||'')===username&&String(check.serviceKind||'')==='custom_shop'){Object.assign(order,check)}else{if(reservation?.ok)await releaseManualSupportUsageAndWallet(walletUserPath,username,'customshop_'+serviceKey,localId).catch(()=>{});appendJsonLedger('provider_failures.json',{stage:'custom_shop_persist',uncertain:true,user:username,localId,serviceKey,error:String(e.message||e).slice(0,160),createdAt:nowISO()});return {status:503,body:{ok:false,uncertain:true,error:'تعذر تأكيد حفظ الطلب في قاعدة البيانات. تواصل مع الدعم قبل إعادة المحاولة، رقم التتبع: '+localId}};}}
  try{appendJsonLedger('orders.json',order)}catch(e){console.warn('custom shop local order mirror failed:',String(e.message||e).slice(0,100));}
  if(!isAdminSession)try{await finalizeProviderOrderAccounting(username,localId,amountIQD,at)}catch(e){console.warn('custom shop order counters reconciliation:',String(e.message||e).slice(0,100));}
  const wa=normalizeWhatsAppUrl(readJSON('settings.json',{}).waUrl||'https://wa.me/9647762267959');
  try{createUserNotification(username,{type:'order_created',orderId:siteOrderId,status:'pending',title:'تم شراء الخدمة بنجاح #'+publicOrderNo,message:'تم استلام طلبك للخدمة '+String(svc.name||'خدمة')+'. يرجى التواصل مع دعم واتساب لإكمال التنفيذ.',meta:{serviceName:svc.name,quantity,publicOrderNo,serviceKind:'custom_shop'}})}catch(_){}
  notifyTelegramNewOrder(order,{source:'custom-shop'}).catch(()=>{});
  return {status:200,body:{ok:true,order,siteOrderId,publicOrderNo,totalIQD:amountIQD,chargeUsd:order.chargeUsd,supportWhatsappUrl:wa,createdAt:at}};
}
function readAdminManualServices(){
  const v=readJSON('manual_services.json',{});return v&&typeof v==='object'&&!Array.isArray(v)?v:{};
}
function adminManualServicePublic(row,key=''){
  if(!row||typeof row!=='object')return null;
  const siteServiceId=String(row.siteServiceId||row.id||'').trim();
  const description=String(row.description||row.desc||'');
  const category=String(row.category||'خدمات خاصة').trim();
  const platform=String(row.platform||row.serviceApp||'Other');
  const rate=Number(row.orderPriceUsd??row.fixedPriceUsd??row.sellingUsd??row.rateUsd??row.rate??0);
  return {
    key:String(key||row.key||row.fbKey||''),fbKey:String(key||row.key||row.fbKey||''),id:siteServiceId,siteServiceId,internalServiceId:siteServiceId,sadaServiceId:siteServiceId,
    name:String(row.name||'خدمة خاصة'),description,desc:description,descriptionOverride:description,
    category,groups:[category],categories:[category],platform,app:platform,serviceApp:platform,
    providerId:'manual-support',providerName:'التنفيذ عبر الدعم الفني',providerServiceId:'',serviceId:siteServiceId,smmpartyId:'',
    sellingUsd:Number.isFinite(rate)&&rate>=0?rate:0,rateUsd:Number.isFinite(rate)&&rate>=0?rate:0,orderPriceUsd:Number.isFinite(rate)&&rate>=0?rate:0,fixedPriceUsd:Number.isFinite(rate)&&rate>=0?rate:0,manualPriceMode:String(row.manualPriceMode||'fixed_order'),billingUnit:Number(row.billingUnit||((Number(row.max)<1000)?100:1000)),price:Number.isFinite(rate)&&rate>=0?rate*FIXED_RATE:0,
    min:Math.max(1,Math.floor(Number(row.min)||1)),max:Math.max(Math.max(1,Math.floor(Number(row.min)||1)),Math.floor(Number(row.max)||100)),
    perAccountLimit:Math.max(0,Math.floor(Number(row.perAccountLimit)||0)),enabled:row.enabled!==false,providerAvailable:true,
    serviceKind:'manual_support',manualService:true,adminManualService:true,adminManualServiceKey:String(key||row.key||row.fbKey||''),source:'manual-support'
  };
}
function nextManualSiteServiceId(){
  const used=new Set(allSiteServiceRows().map(entry=>currentSiteServiceId(entry.row)).filter(id=>/^\d{4}$/.test(id)));
  return allocateFourDigitSiteServiceId(used);
}
function findAdminManualService(serviceKey='',siteServiceId=''){
  const key=String(serviceKey||'').trim(),sid=String(siteServiceId||'').trim(),root=readAdminManualServices();
  if(key&&root[key])return {key,row:root[key]};
  if(sid){for(const [k,row] of Object.entries(root)){if([String(row?.siteServiceId||''),String(row?.id||''),String(row?.internalServiceId||'')].includes(sid)||serviceRowMatchesSiteId(row,sid))return {key:k,row};}}
  return null;
}
function manualSupportMessage(order={}){
  const safe=v=>String(v??'').replace(/[\r\n]+/g,' ').trim();
  const price=Number(order.chargeUsd??order.sellingPriceUsd??0);
  const lines=[
    '📋 طلب خدمة خاصة — صدى العراق',
    '━━━━━━━━━━━━━━━',
    '🔢 رقم الطلب: #'+safe(order.publicOrderNo||order.id||'غير متوفر'),
    '⚡ الخدمة: '+safe(order.serviceName||'خدمة خاصة'),
    ...(safe(order.description)?['📝 الوصف: '+safe(order.description).slice(0,900)]:[]),
    '📱 المنصة: '+safe(order.serviceApp||order.platform||order.category||'غير محددة'),
    '🔗 الرابط: '+safe(order.link||'غير متوفر'),
    '📦 الكمية: '+Math.max(0,Number(order.quantity)||0).toLocaleString('en-US'),
    '💵 السعر: $'+(Number.isFinite(price)?price:0).toFixed(2),
    '━━━━━━━━━━━━━━━',
    '✅ تم إنشاء طلبك بنجاح',
    '⚠️ طلبك لن يُنفذ تلقائياً. أرسل هذه الرسالة كاملة للدعم الفني حتى تتم متابعة طلبك.',
    'شكراً جزيلاً'
  ];
  return lines.join('\n');
}
function adminFreeServicePublic(row){
  if(!row||typeof row!=='object')return null;
  const out={...row};
  // Supplier cost is private administrative/accounting data. Orders remain server-authoritative.
  for(const k of ['providerRateUsd','smmRateUsd','baseProviderRateUsd','smmRate','provider_rate_usd','providerRateCheckedAt','basePrice'])delete out[k];
  return out;
}
function mirrorAdminFreeServiceUsage(username,serviceKey,localId,state,at=''){
  // Diagnostic/backup mirror only. Firebase user record is the authoritative atomic limiter.
  try{
    const userKey=String(username||'').trim().toLowerCase(),svcKey=String(serviceKey||'').trim(),requestId=String(localId||'').trim();
    if(!userKey||!svcKey||!requestId)return;
    const root=readJSON('free_service_usage.json',{});if(!root||typeof root!=='object'||Array.isArray(root))return;
    const key=sha256(userKey+'|'+svcKey).slice(0,48),rows=Array.isArray(root[key])?[...root[key]]:[],idx=rows.findIndex(x=>String(x?.requestId||'')===requestId);
    if(state==='rejected'){if(idx>=0)rows.splice(idx,1)}
    else if(idx>=0)rows[idx]={...rows[idx],state:String(state||'reserved'),...(at?{at}:{}),updatedAt:nowISO()};
    else rows.push({requestId,at:at||nowISO(),state:String(state||'reserved')});
    root[key]=rows.slice(-200);writeJSON('free_service_usage.json',root);
  }catch(e){console.warn('free service usage backup mirror:',String(e.message||e).slice(0,100));}
}
const ADMIN_FREE_SERVICES_GLOBAL_USAGE_KEY='admin-free-services-global-v1';
const ADMIN_FREE_SERVICES_GLOBAL_DAILY_LIMIT=2;
async function reserveAdminFreeServiceUsage(username,serviceKey,limit,localId,userPath){
  const userKey=String(username||'').trim().toLowerCase(),svcKey=String(serviceKey||'').trim(),requestId=String(localId||'').trim(),path=String(userPath||'').trim();
  if(!userKey||!svcKey||!requestId||!path)return {ok:false,error:'تعذر تثبيت هوية الحساب أو سجل Firebase للطلب المجاني.'};
  // One shared, Firebase-transaction-backed quota covers ALL administrator-funded free services.
  // Older per-service buckets are also counted during migration so users cannot reset the quota by switching services.
  const usageKey=ADMIN_FREE_SERVICES_GLOBAL_USAGE_KEY,now=Date.now(),at=new Date(now).toISOString(),windowMs=24*60*60*1000,max=ADMIN_FREE_SERVICES_GLOBAL_DAILY_LIMIT;
  let tx;
  try{
    tx=await firebaseTransaction(path,current=>{
      if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-record-not-found'}};
      const source=current.sadaAdminFreeServiceUsage&&typeof current.sadaAdminFreeServiceUsage==='object'&&!Array.isArray(current.sadaAdminFreeServiceUsage)?current.sadaAdminFreeServiceUsage:{};
      const usage={...source};let dirty=false;const activeByRequest=new Map();
      for(const [bucket,rawRows] of Object.entries(usage)){
        const rows=Array.isArray(rawRows)?rawRows:[],fresh=[];
        for(const row of rows){
          const timestamp=Date.parse(row?.at||'');
          if(!row||typeof row!=='object'||!Number.isFinite(timestamp)||now-timestamp>=windowMs||String(row.state||'')==='rejected') {dirty=true;continue;}
          fresh.push(row);
          const rid=String(row.requestId||'').trim();
          if(rid){const previous=activeByRequest.get(rid);if(!previous||Date.parse(row.at)<Date.parse(previous.at))activeByRequest.set(rid,row);}
        }
        if(fresh.length!==rows.length){if(fresh.length)usage[bucket]=fresh;else delete usage[bucket];dirty=true;}
      }
      if(activeByRequest.has(requestId)){
        if(dirty){current.sadaAdminFreeServiceUsage=usage;return {write:true,value:current,result:{duplicate:true}};}
        return {write:false,result:{duplicate:true}};
      }
      const activeRows=[...activeByRequest.values()];
      if(activeRows.length>=max){
        const oldest=activeRows.map(x=>Date.parse(x.at||'')).filter(Number.isFinite).sort((a,b)=>a-b)[0]||now;
        const nextAllowedAt=new Date(oldest+windowMs).toISOString();
        if(dirty){current.sadaAdminFreeServiceUsage=usage;return {write:true,value:current,result:{limit:max,nextAllowedAt}};}
        return {write:false,result:{limit:max,nextAllowedAt}};
      }
      const rows=Array.isArray(usage[usageKey])?[...usage[usageKey]]:[];
      rows.push({requestId,at,state:'reserved',serviceKey:svcKey,scope:'all-admin-free-services'});
      usage[usageKey]=rows;current.sadaAdminFreeServiceUsage=usage;current.updatedAt=nowISO();
      return {write:true,value:current,result:{claimed:true}};
    },12000,8);
  }catch(e){console.error('free service Firebase usage reservation failed:',String(e.message||e).slice(0,180));return {ok:false,storageUnavailable:true,error:'تعذر حفظ حد الاستخدام المجاني في Firebase؛ لم نرسل طلباً إلى المزود. حاول لاحقاً.'};}
  const result=tx?.result||{};
  if(result.error)return {ok:false,error:'لم يتم العثور على سجل الحساب في Firebase؛ لم يُرسل طلب مجاني.'};
  if(result.duplicate)return {ok:false,duplicate:true,error:'هذا الطلب المجاني قيد المعالجة أو سبق إرساله. لا تعِد المحاولة برقم طلب جديد قبل التحقق من سجل المزود.'};
  if(result.limit){return {ok:false,limit:max,nextAllowedAt:result.nextAllowedAt,error:'وصلت إلى الحد المشترك لجميع الخدمات المجانية: طلبان فقط لكل حساب خلال 24 ساعة. حاول مجدداً بعد '+new Date(result.nextAllowedAt).toLocaleString('en-GB',{timeZone:'Asia/Baghdad',hour12:false})+' بتوقيت بغداد.'};}
  if(!result.claimed)return {ok:false,error:'تعذر تأكيد حجز استخدام الخدمة المجانية؛ لم يُرسل طلب للمزود.'};
  mirrorAdminFreeServiceUsage(userKey,svcKey,requestId,'reserved',at);
  return {ok:true,usageKey,requestId,limit:max};
}
async function finalizeAdminFreeServiceUsage(username,serviceKey,localId,state,userPath){
  const userKey=String(username||'').trim().toLowerCase(),svcKey=String(serviceKey||'').trim(),requestId=String(localId||'').trim(),path=String(userPath||'').trim();
  if(!userKey||!svcKey||!requestId||!path)return {ok:false,error:'missing-usage-identity'};
  let ok=false;
  try{
    const tx=await firebaseTransaction(path,current=>{
      if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{missing:true}};
      const old=current.sadaAdminFreeServiceUsage&&typeof current.sadaAdminFreeServiceUsage==='object'&&!Array.isArray(current.sadaAdminFreeServiceUsage)?current.sadaAdminFreeServiceUsage:{};
      const usage={...old};let found=false,changed=false;
      // Also finalize pre-upgrade reservations that used per-service buckets.
      for(const [bucket,rawRows] of Object.entries(usage)){
        if(!Array.isArray(rawRows))continue;
        let rows=rawRows.map(row=>({...row}));
        const matches=rows.filter(row=>String(row.requestId||'')===requestId);
        if(!matches.length)continue;
        found=true;
        if(state==='rejected')rows=rows.filter(row=>String(row.requestId||'')!==requestId);
        else rows=rows.map(row=>String(row.requestId||'')===requestId?{...row,state:String(state||'accepted'),updatedAt:nowISO(),serviceKey:row.serviceKey||svcKey,scope:'all-admin-free-services'}:row);
        if(rows.length)usage[bucket]=rows;else delete usage[bucket];changed=true;
      }
      if(!found)return {write:false,result:{missing:true}};
      if(!changed)return {write:false,result:{missing:true}};
      current.sadaAdminFreeServiceUsage=usage;current.updatedAt=nowISO();
      return {write:true,value:current,result:{updated:true}};
    },12000,8);
    ok=!!(tx?.result?.updated||tx?.result?.missing);
    if(!ok)console.warn('free service usage state not confirmed; reservation remains fail-closed');
  }catch(e){console.warn('free service usage finalization failed:',String(e.message||e).slice(0,140));}
  mirrorAdminFreeServiceUsage(userKey,svcKey,requestId,state);
  return {ok};
}

function nextAdminFreeSiteServiceId(){
  const used=new Set(allSiteServiceRows().map(entry=>currentSiteServiceId(entry.row)).filter(id=>/^\d{4}$/.test(id)));
  return allocateFourDigitSiteServiceId(used);
}
function freeServiceGroups(row){return Array.isArray(row?.groups)?row.groups:Array.isArray(row?.categories)?row.categories:[row?.category].filter(Boolean)}
function customAdminFreeServiceMatch(providerId,siteOrCatalogId){
  const pid=String(providerId||'').trim(),needle=String(siteOrCatalogId||'').trim();if(!pid||!needle)return null;
  for(const [key,row] of Object.entries(readAdminFreeServices())){
    if(!row||row.enabled===false||row.adminFreeService!==true||String(row.providerId||'').trim()!==pid)continue;
    if([key,String(row.fbKey||''),String(row.siteServiceId||''),String(row.id||'')].includes(needle)||serviceRowMatchesSiteId(row,needle))return {...row,fbKey:key,adminFreeServiceKey:key,adminFreeService:true,free:true};
  }
  return null;
}
async function authoritativeWebsiteService(providerId, serviceId, firebaseServiceKey){
  const pid=String(providerId||'').trim(), sid=String(serviceId||'').trim(), fkey=String(firebaseServiceKey||'').trim();
  // Administrator-created free services are resolved from their separate store; they never enter or mutate the ordinary catalog.
  const freeRows=readAdminFreeServices();const freeEntry=Object.entries(freeRows).find(([key,row])=>row&&String(row.providerId||'').trim()===pid&&([key,String(row.fbKey||''),String(row.siteServiceId||''),String(row.id||'')].includes(fkey)||serviceRowMatchesSiteId(row,fkey)));
  if(freeEntry){const [freeKey,freeRow]=freeEntry;if(freeRow.adminFreeService!==true||freeRow.enabled===false||freeRow.deleted===true)return null;const freeMatch={...freeRow,fbKey:freeKey,adminFreeServiceKey:freeKey,adminFreeService:true,free:true};return normalizeWebsiteOrderService(freeMatch,pid,String(freeMatch.providerServiceId||sid),String(freeMatch.fbKey||''));}
  // Prefer the hosting catalog: it owns the internal Sada Iraq key, provider mapping, and selling price.
  const localCatalog=readJSON('services.json',{});
  const candidates=Object.entries(localCatalog&&typeof localCatalog==='object'&&!Array.isArray(localCatalog)?localCatalog:{});
  const localMatch=candidates.find(([key,v])=>{
    const vp=String(v?.providerId||'').trim();
    const internalMatch=!!fkey&&(String(key)===fkey||String(v?.fbKey||'')===fkey||String(v?.siteServiceId||v?.catalogId||'')===fkey||serviceRowMatchesSiteId(v,fkey));
    // An explicit internal key must win; falling back to provider ID while it is present can select
    // another site offer that happens to use the same provider service ID.
    return vp===pid && (fkey?internalMatch:false);
  }) || (!fkey ? candidates.find(([,v])=>String(v?.providerId||'').trim()===pid&&!!sid&&String(v?.providerServiceId||v?.smmpartyId||v?.serviceId||'').trim()===sid) : null);
  if(localMatch){const [key,v]=localMatch;return normalizeWebsiteOrderService(v,pid,sid,key);}
  // Compatibility fallback for legacy catalogs which only contain provider service records.
  const cached=findInternalApiService(sid);
  if(cached && String(cached.providerId||'')===pid) return normalizeWebsiteOrderService(cached,pid,sid,cached.fbKey||'');
  return null;
}

function internalApiServices(){
  // The hosting catalog is authoritative. Never create service records from api_services.json on a
  // read/API call; legacy mirror data must be selected and imported by an administrator explicitly.
  ensureNumericSiteServiceIds();
  const root=readJSON('services.json',{});
  const entries=Object.entries(root&&typeof root==='object'&&!Array.isArray(root)?root:{});
  const rows=[];
  for(const [fbKey,raw] of entries){
    if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;
    if(raw.active===false||raw.enabled===false||raw.isActive===false||raw.hidden===true||raw.isHidden===true||raw.deleted===true||raw.unapprovedAutoImport===true||String(raw.status||'').toLowerCase()==='disabled')continue;
    const providerId=String(raw.providerId||'').trim();
    const providerServiceId=String(raw.providerServiceId||raw.smmpartyId||raw.sourceServiceId||raw.service_id||raw.serviceId||'').trim();
    const siteServiceId=String(raw.siteServiceId||raw.internalServiceId||raw.sadaServiceId||'').trim();
    if(!/^\d{4}$/.test(siteServiceId)||!providerId||!providerServiceId)continue;
    const rateRaw=raw.sellingUsd??raw.rateUsd??raw.rate??(raw.price!==undefined?Number(raw.price)/FIXED_RATE:undefined);
    const sellingUsd=Number(rateRaw);
    if(!Number.isFinite(sellingUsd)||sellingUsd<0)continue;
    const groups=Array.isArray(raw.groups)?raw.groups:(Array.isArray(raw.categories)?raw.categories:[raw.category].filter(Boolean));
    rows.push({...raw,id:siteServiceId,siteServiceId,fbKey,providerId,providerServiceId,smmpartyId:providerServiceId,serviceId:siteServiceId,sellingUsd,rateUsd:sellingUsd,providerRateUsd:Number(raw.providerRateUsd??raw.smmRateUsd??raw.providerRate??0)||0,name:String(raw.name||raw.serviceName||'خدمة'),category:String(raw.category||groups[0]||'عام'),groups,min:Math.max(1,Number(raw.min||1)),max:Math.max(Math.max(1,Number(raw.min||1)),Number(raw.max||1000000)),refill:raw.refill===true||raw.refill===1||raw.refill==='1',cancel:raw.cancel===true||raw.cancel===1||raw.cancel==='1'});
  }
  return rows.sort((a,b)=>Number(a.siteServiceId)-Number(b.siteServiceId));
}

function publicApiService(s){
  const rate=Number(s?.sellingUsd??s?.rateUsd??s?.rate??0);
  const out={id:String(s?.siteServiceId||s?.id||''),name:String(s?.name||'خدمة'),category:String(s?.category||((Array.isArray(s?.groups)&&s.groups[0])||'عام')),rate:Number((Number.isFinite(rate)&&rate>=0?rate:0).toFixed(6)),min:Number(s?.min||1),max:Number(s?.max||1000000),refill:!!s?.refill,cancel:!!s?.cancel,type:String(s?.type||'default')};
  const description=String(s?.description||s?.details||'').trim();if(description)out.description=description;
  return out;
}
async function hydrateApiServicesFromFirebase(){const local=internalApiServices();return {count:local.length,source:'hosting-catalog',persistedRemotely:false};}
function findInternalApiService(id){
  const sid=String(id||'').trim();if(!/^\d{4,}$/.test(sid))return null;
  return internalApiServices().find(x=>String(x.siteServiceId)===sid||serviceRowMatchesSiteId(x,sid))||null;
}
function apiOrderPublic(o){return {order_id:String(o.publicOrderNo||o.id||''),internal_order_id:String(o.id||''),status:String(o.status||'pending'),service:String(o.siteServiceId||o.serviceId||''),quantity:Number(o.quantity||0),charge:Number(Number(o.chargeUsd||0).toFixed(6)),chargeUsd:Number(Number(o.chargeUsd||0).toFixed(6)),currency:'USD',remains:o.remains===undefined?null:o.remains,start_count:o.startCount===undefined?null:o.startCount,createdAt:o.createdAt||null};}
function apiSmmStatus(o){const status=String(o?.status||'pending');return {charge:Number(Number(o?.chargeUsd||0).toFixed(6)),currency:'USD',start_count:o?.startCount??null,status,remains:o?.remains??null,order_id:String(o?.publicOrderNo||o?.id||''),service:String(o?.siteServiceId||o?.serviceId||''),quantity:Number(o?.quantity||0),updatedAt:o?.lastCheckedAt||o?.updatedAt||null};}

function apiScopeAllows(auth,scope){
  const scopes=auth?.record?.scopes;
  if(!Array.isArray(scopes)||!scopes.length)return true; // backward compatible legacy keys
  return scopes.includes('*')||scopes.includes(scope);
}
async function readApiRequestBody(req){
  if(req._apiRequestBody&&typeof req._apiRequestBody==='object')return req._apiRequestBody;
  if(req.method==='GET'||req.method==='HEAD'||req.method==='DELETE'){req._apiRequestBody={};return req._apiRequestBody;}
  const contentType=String(req.headers['content-type']||'').toLowerCase();let raw='';
  for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw,'utf8')>256*1024){const e=new Error('حجم طلب API أكبر من المسموح');e.statusCode=413;throw e;}}
  if(!raw){req._apiRequestBody={};return req._apiRequestBody;}
  if(contentType.includes('application/x-www-form-urlencoded')){const out={};for(const [k,v] of new URLSearchParams(raw))out[k]=v;req._apiRequestBody=out;return out;}
  if(contentType.includes('text/plain')){const out={};for(const [k,v] of new URLSearchParams(raw))out[k]=v;req._apiRequestBody=out;return out;}
  try{const v=JSON.parse(raw);if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('يجب أن يكون JSON كائناً');req._apiRequestBody=v;return v;}catch(_){const e=new Error('بيانات API يجب أن تكون JSON صالحاً أو form-urlencoded');e.statusCode=400;throw e;}
}
async function resolveApiWallet(auth){
  let remote;
  try{remote=await findRemoteUserByUsername(auth.username);}catch(e){throw Object.assign(new Error('تعذر قراءة سجل المستخدم من Firebase؛ لم تتغير المحفظة.'),{code:'wallet_database_unavailable',cause:String(e.message||e).slice(0,120)});}
  if(!remote?.user||typeof remote.user!=='object'||!remote.firebasePath)throw Object.assign(new Error('لم يتم العثور على سجل Firebase الموثوق لهذا المستخدم؛ لم تتغير المحفظة.'),{code:'wallet_user_not_found'});
  return {path:String(remote.firebasePath),user:remote.user};
}
function upsertLocalApiOrder(order){
  const rows=readJSON('orders.json',[]);const list=Array.isArray(rows)?rows:[];const idx=list.findIndex(x=>x&&!x.event&&String(x.id||'')===String(order.id||''));
  if(idx>=0)list[idx]={...list[idx],...order};else list.push(order);writeJSON('orders.json',list.slice(-20000));return order;
}
async function loadApiOwnedOrders(username){
  let remote;
  try{remote=await firebaseGetJson('orders',12000);}catch(e){throw Object.assign(new Error('تعذر قراءة الطلبات من Firebase؛ لم نعرض بيانات محلية على أنها كاملة.'),{code:'orders_database_unavailable'});}
  const map=new Map();
  const entries=Array.isArray(remote)?remote.map((v,i)=>[String(i),v]):(remote&&typeof remote==='object'?Object.entries(remote):[]);
  for(const [key,o] of entries){if(!o||typeof o!=='object'||o.event||String(o.user||o.username||'')!==String(username))continue;const id=String(o.id||o.siteOrderId||o.orderId||'');if(!id)continue;map.set(id,{...o,id,_firebaseKey:String(o._firebaseKey||key)});}
  for(const o of (Array.isArray(readJSON('orders.json',[]))?readJSON('orders.json',[]):[])){if(!o||o.event||String(o.user||o.username||'')!==String(username))continue;const id=String(o.id||o.siteOrderId||'');if(!id)continue;const prior=map.get(id);map.set(id,prior?{...o,...prior,id,_firebaseKey:prior._firebaseKey||firebaseSafeKey(id)}:{...o,id,_firebaseKey:firebaseSafeKey(id)});}
  return [...map.values()].sort((a,b)=>(Date.parse(b.createdAt||0)||0)-(Date.parse(a.createdAt||0)||0));
}
async function findApiOwnedOrder(auth,externalId){
  const needle=String(externalId||'').trim();if(!needle) return null;
  const rows=await loadApiOwnedOrders(auth.username);
  return rows.find(o=>String(o.id||'')===needle||String(o.localId||'')===needle||String(o.publicOrderNo||'')===needle)||null;
}
async function persistApiOrderUpdate(order){
  const id=String(order?.id||'');if(!id)throw new Error('رقم الطلب الداخلي مفقود');
  const key=String(order._firebaseKey||firebaseSafeKey(id));
  const clean={...order};delete clean._firebaseKey;delete clean.firebaseKey;
  await firebaseWriteJson('orders/'+key,clean,10000);
  const verify=await firebaseGetJson('orders/'+key,10000);
  if(!verify||String(verify.id||'')!==id)throw new Error('لم يتم تأكيد حفظ تحديث الطلب في Firebase');
  upsertLocalApiOrder({...verify,_firebaseKey:key});return {...verify,_firebaseKey:key};
}
function apiOrderLabel(order){return String(order?.publicOrderNo||order?.id||'');}
function apiSafeError(e){return String(e?.message||e||'تعذر تنفيذ طلب API').replace(/(authorization|api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/ig,'$1=[redacted]').slice(0,220);}
function apiLedgerOnce(entry){
  const arr=readJSON('balance_ledger.json',[]),rows=Array.isArray(arr)?arr:[];const id=String(entry?.id||'');
  if(id&&rows.some(x=>String(x?.id||'')===id))return false;
  rows.push(entry);writeJSON('balance_ledger.json',rows.slice(-10000));
  if(id)firebaseWriteJson('balanceLedger/'+firebaseSafeKey(id),entry,6000).catch(e=>console.warn('API ledger mirror failed:',String(e.message||e).slice(0,90)));
  return true;
}
async function apiMarkRequest(walletPath,requestKey,state,updates={}){
  return firebaseTransaction(walletPath,current=>{
    if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-record-not-found'}};
    const oldRequests=current.sadaApiRequests&&typeof current.sadaApiRequests==='object'?{...current.sadaApiRequests}:{};
    const old=oldRequests[requestKey];if(!old)return {write:false,result:{error:'api-request-reservation-not-found'}};
    if(old.state==='completed'&&state!=='completed')return {write:false,result:{alreadyCompleted:true,request:old,balanceIQD:Number(current.balance||0)}};
    if(state==='complete_and_account'&&old.state!=='completed'){
      const charge=Math.max(0,Number(old.amountIQD||0));current.totalSpent=Number((Math.max(0,Number(current.totalSpent)||0)+charge).toFixed(4));current.totalOrders=Math.max(0,Math.floor(Number(current.totalOrders)||0))+1;
      oldRequests[requestKey]={...old,...updates,state:'completed',completedAt:nowISO()};
    }else oldRequests[requestKey]={...old,...updates,state,updatedAt:nowISO()};
    const sorted=Object.entries(oldRequests).sort((a,b)=>(Date.parse(a[1]?.createdAt||0)||0)-(Date.parse(b[1]?.createdAt||0)||0));while(sorted.length>1500){const [k,v]=sorted.shift();if(v?.state==='reserved'||v?.state==='uncertain') {sorted.push([k,v]);break;}delete oldRequests[k];}
    current.sadaApiRequests=oldRequests;current.updatedAt=nowISO();return {write:true,value:current,result:{updated:true,request:oldRequests[requestKey],balanceIQD:Number(current.balance||0)}};
  },12000,8);
}
async function apiReserveBalance(walletPath,requestKey,requestData,amountIQD){
  return firebaseTransaction(walletPath,current=>{
    if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-record-not-found'}};
    const requests=current.sadaApiRequests&&typeof current.sadaApiRequests==='object'?{...current.sadaApiRequests}:{};
    if(requests[requestKey])return {write:false,result:{duplicate:true,request:requests[requestKey],balanceIQD:Number(current.balance||0)}};
    if(!requestData.idempotencyHash&&requestData.payloadHash){
      const cutoff=Date.now()-120000;
      const prior=Object.entries(requests).reverse().find(([key,row])=>key!==requestKey&&row&&String(row.payloadHash||'')===String(requestData.payloadHash)&&(['reserved','uncertain','completed'].includes(String(row.state||'')))&&(Date.parse(row.createdAt||'')||0)>=cutoff);
      if(prior)return {write:false,result:{duplicate:true,request:prior[1],requestKey:prior[0],balanceIQD:Number(current.balance||0)}};
    }
    const before=Number(current.balance||0);if(!Number.isFinite(before)||before<amountIQD)return {write:false,result:{insufficient:true,balanceIQD:Number.isFinite(before)?before:0}};
    const after=Number((before-amountIQD).toFixed(4));const at=nowISO();current.balance=after;
    requests[requestKey]={...requestData,state:'reserved',amountIQD,beforeIQD:before,afterIQD:after,createdAt:at,updatedAt:at};
    const sorted=Object.entries(requests).sort((a,b)=>(Date.parse(a[1]?.createdAt||0)||0)-(Date.parse(b[1]?.createdAt||0)||0));while(sorted.length>1500){const [k,v]=sorted.shift();if(v?.state==='reserved'||v?.state==='uncertain'){sorted.push([k,v]);break;}delete requests[k];}
    current.sadaApiRequests=requests;current.updatedAt=at;return {write:true,value:current,result:{reserved:true,beforeIQD:before,afterIQD:after,request:requests[requestKey]}};
  },12000,8);
}
async function apiReleaseReservation(walletPath,requestKey,reason){
  return firebaseTransaction(walletPath,current=>{
    if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-record-not-found'}};
    const requests=current.sadaApiRequests&&typeof current.sadaApiRequests==='object'?{...current.sadaApiRequests}:{};const old=requests[requestKey];if(!old)return {write:false,result:{error:'reservation-not-found'}};
    if(['failed','completed','released'].includes(String(old.state||'')))return {write:false,result:{alreadySettled:true,request:old,balanceIQD:Number(current.balance||0)}};
    const amount=Math.max(0,Number(old.amountIQD||0)),before=Number(current.balance||0),after=Number((before+amount).toFixed(4));current.balance=after;
    requests[requestKey]={...old,state:'failed',failureReason:String(reason||'provider_rejected').slice(0,100),releasedAt:nowISO(),refundBeforeIQD:before,refundAfterIQD:after};current.sadaApiRequests=requests;current.updatedAt=nowISO();
    return {write:true,value:current,result:{released:true,amountIQD:amount,beforeIQD:before,afterIQD:after,request:requests[requestKey]}};
  },12000,8);
}
async function apiFindExistingIdempotentOrder(auth,hash){
  if(!hash)return null;
  const local=(Array.isArray(readJSON('orders.json',[]))?readJSON('orders.json',[]):[]).find(o=>!o?.event&&String(o.user||'')===auth.username&&String(o.apiIdempotencyHash||'')===hash);
  if(local)return local;
  const rows=await loadApiOwnedOrders(auth.username);return rows.find(o=>String(o.apiIdempotencyHash||'')===hash)||null;
}
async function apiCreateOrder(auth,body){
  const serviceId=String(body.service??body.service_id??body.serviceId??'').trim();const link=String(body.link||'').trim();const quantity=Number(body.quantity);
  if(!/^\d{4,}$/.test(serviceId))return {http:422,body:{error:'service must be the 4+ digit Sada Iraq service ID'}};
  if(!/^https?:\/\//i.test(link)||link.length>2000||!Number.isInteger(quantity)||quantity<=0)return {http:422,body:{error:'link must be a valid http(s) URL and quantity a positive integer'}};
  try{await ensureLocalServiceCatalogSeeded();await ensureAdminFreeServicesDurable();ensureNumericSiteServiceIds();}catch(e){return {http:503,body:{error:'Service catalog is temporarily unavailable; no provider request was sent.',stage:'service_catalog',details:String(e.message||e).slice(0,120)}};}
  const svc=await guardServicePrice(findInternalApiService(serviceId));if(!svc)return {http:404,body:{error:'Service not found'}};const canonicalServiceId=String(svc.siteServiceId||serviceId).trim();if(!/^\d{4}$/.test(canonicalServiceId))return {http:409,body:{error:'The service does not have a verified four-digit Sada Iraq ID',stage:'site_service_id'}};
  if(svc.providerAvailable===false||String(svc.availabilityStatus||'').toLowerCase()==='unavailable')return {http:409,body:{error:'Service is unavailable at the supplier or its live price could not be verified; no balance was charged and no provider order was sent.',stage:'provider_service_unavailable'}};
  if(quantity<Number(svc.min)||quantity>Number(svc.max))return {http:422,body:{error:'Quantity outside service limits',min:Number(svc.min),max:Number(svc.max)}};
  const rate=Number(svc.sellingUsd);if(!Number.isFinite(rate)||rate<0)return {http:409,body:{error:'Service sale price is not configured'}};
  const providerRateUsd=catalogRate(svc);if(providerRateUsd===null||!Number.isFinite(providerRateUsd)||providerRateUsd<0)return {http:409,body:{error:'Live supplier cost is not verified; no balance was charged and no provider order was sent.',stage:'provider_cost_unverified'}};
  const idempotency=String(body.idempotency_key||body.request_id||'').trim()||String(body.__headerIdempotencyKey||'').trim();if(idempotency.length>200)return {http:422,body:{error:'Idempotency key is too long'}};
  const idemHash=idempotency?sha256(auth.username+'|'+idempotency):'';
  const payloadHash=sha256([auth.username,canonicalServiceId,link,String(quantity)].join('|'));
  if(idemHash){const existing=await apiFindExistingIdempotentOrder(auth,idemHash).catch(()=>null);if(existing)return {http:200,body:{order:apiOrderLabel(existing),order_id:apiOrderLabel(existing),internal_order_id:String(existing.id||''),status:String(existing.status||'pending'),idempotent:true}};}
  let wallet;try{wallet=await resolveApiWallet(auth);}catch(e){return {http:e.code==='wallet_user_not_found'?404:503,body:{error:apiSafeError(e),stage:'wallet_lookup'}};}
  const {pct,total}=calcApiChargeUsd({...svc,sellingUsd:rate},quantity,wallet.user);
  const providerCostUsd=Number((providerRateUsd*quantity/1000).toFixed(6));
  const requiredMarkupPct=Math.max(0,Math.min(1000,Number.isFinite(Number(svc.markupPct))?Number(svc.markupPct):100));
  const minimumChargeUsd=Number((providerCostUsd*(1+requiredMarkupPct/100)).toFixed(6));
  if(total+0.000001<minimumChargeUsd)return {http:422,body:{error:'Discount would reduce the real markup below '+requiredMarkupPct+'% over supplier cost. No balance was charged and no provider order was sent.',stage:'sale_below_required_markup',providerCostUsd,chargeUsd:total,minimumChargeUsd,requiredMarkupPct}};
  const chargeIQD=Number((total*FIXED_RATE).toFixed(4));
  await ensureProviderRuntime(svc.providerId);const {prov}=getProviderById(svc.providerId,{allowSingleFallback:false});if(!prov?.url||!prov?.key)return {http:502,body:{error:'Provider unavailable',stage:'provider_lookup'}};
  const requestKey=idemHash||sha256(auth.username+'|'+crypto.randomUUID());
  const requestData={requestKey,username:auth.username,serviceId:canonicalServiceId,siteServiceId:canonicalServiceId,providerId:svc.providerId,providerServiceId:svc.providerServiceId,quantity,link,chargeUsd:total,payloadHash,idempotencyKey:idempotency||'',idempotencyHash:idemHash||'',createdAt:nowISO()};
  let reserve;try{reserve=await apiReserveBalance(wallet.path,requestKey,requestData,chargeIQD);}catch(e){return {http:503,body:{error:'Could not reserve balance safely in Firebase; no provider request was sent',stage:'wallet_reserve'}};}
  if(reserve.result?.error)return {http:404,body:{error:'User wallet record was not found'}};
  if(reserve.result?.insufficient)return {http:402,body:{error:'Insufficient balance',balance:Number((Number(reserve.result.balanceIQD||0)/FIXED_RATE).toFixed(6)),currency:'USD'}};
  if(reserve.result?.duplicate){const r=reserve.result.request||{};if(r.state==='completed'&&r.orderId)return {http:200,body:{order:String(r.publicOrderNo||r.orderId),order_id:String(r.publicOrderNo||r.orderId),internal_order_id:String(r.orderId),status:'pending',idempotent:true}};return {http:409,body:{error:'This idempotent request is already in progress or has an uncertain provider result; it was not resent.',uncertain:['reserved','uncertain'].includes(String(r.state||'')),state:String(r.state||'unknown')}};}
  const before=Number(reserve.result.beforeIQD||0),after=Number(reserve.result.afterIQD||0);
  const reserveEvent={id:'APIRES_'+requestKey,user:auth.username,type:'order_reservation',amountUSD:Number((-total).toFixed(6)),amountIQD:Number((-chargeIQD).toFixed(4)),beforeIQD:before,afterIQD:after,reason:'حجز رصيد لطلب API قبل إرساله للمزود',admin:'api',reference:requestKey,serviceId:canonicalServiceId,providerServiceId:svc.providerServiceId,createdAt:nowISO()};
  apiLedgerOnce(reserveEvent);
  let publicOrderNo;try{publicOrderNo=await nextPublicOrderNumber();}catch(e){try{const rel=await apiReleaseReservation(wallet.path,requestKey,'public_order_number_failed');if(rel.result?.released&&chargeIQD>0)apiLedgerOnce({id:'APIREL_'+requestKey,user:auth.username,type:'refund',amountUSD:Number(total.toFixed(6)),amountIQD:chargeIQD,beforeIQD:before,afterIQD:rel.result.afterIQD,reason:'إرجاع حجز API لعدم تخصيص رقم طلب',admin:'api',reference:requestKey,createdAt:nowISO()});}catch(_){}return {http:503,body:{error:'Could not allocate order number; provider was not called'}};}
  let providerResponse,providerOrderId;
  try{
    providerResponse=await providerRequest(prov,{action:'add',service:String(svc.providerServiceId),link,quantity});providerOrderId=normalizeProviderOrderId(providerResponse);
    if(!providerOrderId)throw Object.assign(new Error('Provider response did not include a confirmed order ID'),{providerRejected:false,uncertain:true});
  }catch(e){
    const rejected=!!e.providerRejected;
    if(rejected){try{const rel=await apiReleaseReservation(wallet.path,requestKey,String(e.message||'provider_rejected'));if(rel.result?.released)apiLedgerOnce({id:'APIREL_'+requestKey,user:auth.username,type:'refund',amountUSD:Number(total.toFixed(6)),amountIQD:chargeIQD,beforeIQD:rel.result.beforeIQD,afterIQD:rel.result.afterIQD,reason:'إرجاع حجز بعد رفض المزود للطلب بشكل مؤكد',admin:'api-provider-rejection',reference:requestKey,createdAt:nowISO()});}catch(re){console.error('API provider rejection refund failed:',String(re.message||re).slice(0,120));}}
    else{try{await apiMarkRequest(wallet.path,requestKey,'uncertain',{uncertainAt:nowISO(),providerDiagnostic:apiSafeError(e)});}catch(_){} }
    appendJsonLedger('provider_failures.json',{stage:'api_order_create',uncertain:!rejected,username:auth.username,providerId:svc.providerId,siteServiceId:canonicalServiceId,providerServiceId:svc.providerServiceId,quantity,providerHttpStatus:Number(e.httpStatus||0)||null,providerErrorCode:String(e.providerErrorCode||'').slice(0,60),error:apiSafeError(e),requestKey,createdAt:nowISO()});
    return {http:rejected?502:504,body:{error:providerAuthErrorText(e.message)?'Provider API key rejected':apiSafeError(e),stage:'provider_add',uncertain:!rejected,request_id:requestKey}};
  }
  const id='API_'+crypto.randomUUID().replace(/-/g,'');const now=nowISO();
  const grossProfitUsd=Number((total-providerCostUsd).toFixed(6));
  const actualMarkupPct=providerCostUsd>0?Number((grossProfitUsd/providerCostUsd*100).toFixed(2)):null;
  const profitMarginPct=total>0?Number((grossProfitUsd/total*100).toFixed(2)):null;
  const order={id,localId:id,publicOrderNo:String(publicOrderNo),user:auth.username,userName:String(wallet.user.fullName||wallet.user.displayName||wallet.user.username||wallet.user.userName||auth.username),memberId:String(wallet.user.id||wallet.user.userId||wallet.user.user_id||wallet.user.uid||wallet.user.firebaseUid||wallet.user.authUid||auth.username),email:String(wallet.user.email||wallet.user.emailAddress||''),serviceId:canonicalServiceId,siteServiceId:canonicalServiceId,providerServiceId:String(svc.providerServiceId),serviceName:String(svc.name||'خدمة'),category:String(svc.category||''),link,quantity,unitSellingUsd:rate,discountPct:pct,chargeUsd:total,sellingPriceUsd:total,total:chargeIQD,totalIQD:chargeIQD,providerRateUsd,providerCostUsd,providerCostIQD:Number((providerCostUsd*FIXED_RATE).toFixed(4)),grossProfitUsd,grossProfitIQD:Number((grossProfitUsd*FIXED_RATE).toFixed(4)),markupPct:requiredMarkupPct,actualMarkupPct,profitMarginPct,status:'pending',providerStatus:String(providerResponse?.status||'pending'),providerId:String(svc.providerId),providerName:String(prov.name||svc.providerId),providerOrderId:String(providerOrderId),apiCreated:true,orderSource:'api',origin:'api',source:'public-api',free:!!svc.free||total<=0,apiIdempotencyHash:idemHash||'',idempotencyKey:idempotency||null,refillAllowed:!!svc.refill,cancelAllowed:!!svc.cancel,createdAt:now,updatedAt:now};
  try{await persistOrderToFirebase(order);upsertLocalApiOrder(order);}catch(e){try{await apiMarkRequest(wallet.path,requestKey,'uncertain',{providerOrderId:String(providerOrderId),publicOrderNo:String(publicOrderNo),uncertainAt:nowISO(),error:'provider accepted order but Firebase order persistence was not confirmed'});}catch(_){}appendJsonLedger('provider_failures.json',{stage:'api_order_persist',uncertain:true,username:auth.username,siteServiceId:canonicalServiceId,providerServiceId:svc.providerServiceId,providerOrderId:String(providerOrderId),requestKey,error:apiSafeError(e),createdAt:nowISO()});return {http:503,body:{error:'Provider accepted this order, but Firebase did not confirm its saved order record. Do not retry it with a new key.',order:String(publicOrderNo),internal_order_id:id,providerOrderId:String(providerOrderId),uncertain:true}};}
  try{
    const done=await apiMarkRequest(wallet.path,requestKey,'complete_and_account',{orderId:id,publicOrderNo:String(publicOrderNo),providerOrderId:String(providerOrderId),completedAt:nowISO()});
    if(done.result?.error)throw new Error(done.result.error);
    const chargeEvent={id:'APICOM_'+requestKey,user:auth.username,type:'order_commit',amountUSD:0,amountIQD:0,beforeIQD:after,afterIQD:after,reason:'تأكيد الطلب بعد حفظه؛ الخصم مسجل في حجز الطلب',admin:'api',reference:id,createdAt:nowISO()};apiLedgerOnce(chargeEvent);
  }catch(e){appendJsonLedger('provider_failures.json',{stage:'api_order_finalize',uncertain:true,username:auth.username,orderId:id,requestKey,error:apiSafeError(e),createdAt:nowISO()});return {http:503,body:{error:'Order was saved but API accounting finalization needs reconciliation. Do not resend the order.',order:String(publicOrderNo),internal_order_id:id,uncertain:true}};}
  notifyTelegramNewOrder(order,{source:'public-api'}).catch(()=>{});
  const response={order:String(publicOrderNo),order_id:String(publicOrderNo),internal_order_id:id,status:'pending',service:serviceId,quantity,charge:Number(total.toFixed(6)),currency:'USD',createdAt:now};
  return {http:200,body:response};
}
async function apiStatusForOrder(auth,order){
  if(!order?.providerId||!order?.providerOrderId)return {http:409,body:{error:'Order has no linked provider tracking ID'}};
  await ensureProviderRuntime(order.providerId);const {prov}=getProviderById(order.providerId,{allowSingleFallback:false});if(!prov?.url||!prov?.key)return {http:502,body:{error:'Provider unavailable'}};
  try{
    const d=await providerRequest(prov,{action:'status',order:String(order.providerOrderId)},20000);const status=d?.status??d?.data?.status??d?.result?.status??'';const normalized=normalizeProviderStatus(status);
    if(!String(status||'').trim()||normalized==='unknown')return {http:502,body:{error:'Provider status response did not contain a recognized status; the saved order was not marked successful.',stage:'provider_status',uncertain:true}};
    let current={...order,providerStatus:String(status||order.providerStatus||''),status:normalized,lastCheckedAt:nowISO(),updatedAt:nowISO(),providerRaw:safeProviderResponse(d),remains:d?.remains??d?.data?.remains??order.remains,startCount:d?.start_count??d?.startCount??d?.data?.start_count??order.startCount,providerCharge:d?.charge??d?.data?.charge??order.providerCharge,providerCurrency:d?.currency??d?.data?.currency??order.providerCurrency};
    current=await persistApiOrderUpdate(current);
    let refund=null;if(['cancelled','partial'].includes(current.status))refund=await applyVerifiedOrderRefund(current,d,current.status);
    if(refund?.state==='credited'){current.refundState='credited';current.refundAmountIQD=refund.totalRefundIQD;try{current=await persistApiOrderUpdate(current);}catch(_){}}
    return {http:200,body:{...apiSmmStatus(current),status:current.status,normalizedStatus:current.status,remains:current.remains??null,refund:refund?{state:refund.state,credited:!!refund.credited,amountIQD:refund.amountIQD||0}:undefined}};
  }catch(e){return {http:502,body:{error:apiSafeError(e),stage:'provider_status'}};}
}
async function apiCancelOne(auth,externalId){
  let order;try{order=await findApiOwnedOrder(auth,externalId);}catch(e){return {http:503,body:{error:'Order lookup unavailable'}};}
  if(!order)return {http:404,body:{error:'Order not found'}};
  if(!order.cancelAllowed){const svc=findInternalApiService(order.siteServiceId||order.serviceId);if(!svc?.cancel)return {http:409,body:{error:'This service does not advertise cancellation support'}};}
  if(['completed','cancelled','failed','refunded','partial'].includes(normalizeProviderStatus(order.status)))return {http:409,body:{error:'Order status does not allow cancellation',status:order.status}};
  if(!order.providerId||!order.providerOrderId)return {http:409,body:{error:'Order has no provider tracking ID'}};
  // A previous cancellation may have succeeded even if its response was lost. Check status
  // instead of submitting a second mutating request for the same order.
  if(order.cancelRequestedAt){
    const latest=await apiStatusForOrder(auth,order);
    const currentStatus=String(latest.body?.status||'').toLowerCase();
    if(latest.http===200&&['cancelled','partial'].includes(currentStatus))return {http:200,body:{order:String(externalId),cancel:1,status:currentStatus,refund:latest.body.refund||null}};
    if(latest.http===200&&['completed','failed','refunded'].includes(currentStatus))return {http:409,body:{error:'Order is already in a final state; cancellation was not resent',status:currentStatus}};
    return {http:202,body:{order:String(externalId),cancel:1,status:currentStatus||'cancel_pending',pending:true,uncertain:latest.http!==200,message:'A cancellation was already submitted. The provider status was checked; the cancellation will not be sent a second time.'}};
  }
  await ensureProviderRuntime(order.providerId);const {prov}=getProviderById(order.providerId,{allowSingleFallback:false});if(!prov?.url||!prov?.key)return {http:502,body:{error:'Provider unavailable'}};
  // Durably record intent before the one-shot supplier call. If the response times out,
  // future attempts will check status instead of sending a duplicate cancellation.
  order={...order,cancelRequestedAt:nowISO(),cancelRequestState:'submitting',updatedAt:nowISO()};
  try{order=await persistApiOrderUpdate(order);}catch(e){return {http:503,body:{error:'Could not save cancellation intent in Firebase; no cancellation request was sent.',stage:'cancel_reservation'}};}
  try{
    const cancel=await providerRequest(prov,{action:'cancel',orders:String(order.providerOrderId)});
    if(!providerActionSucceeded('cancel',cancel,String(order.providerOrderId))){
      const uncertain={...order,cancelRequestState:'uncertain',cancelRequestRaw:safeProviderResponse(cancel),updatedAt:nowISO()};try{await persistApiOrderUpdate(uncertain);}catch(_){}
      return {http:202,body:{order:String(externalId),cancel:1,status:'cancel_pending',pending:true,uncertain:true,message:'The provider response did not confirm cancellation. The request will not be resent automatically.'}};
    }
    const status=await apiStatusForOrder(auth,order);
    if(status.http===200&&['cancelled','partial'].includes(String(status.body.status)))return {http:200,body:{order:String(externalId),cancel:1,status:status.body.status,refund:status.body.refund||null}};
    if(status.http===200&&['completed','failed','refunded'].includes(String(status.body.status)))return {http:409,body:{error:'Provider reports a final order state; cancellation could not be applied',status:status.body.status}};
    const pending={...order,cancelRequestState:'pending',cancelRequestRaw:safeProviderResponse(cancel),updatedAt:nowISO()};try{await persistApiOrderUpdate(pending);}catch(_){}
    return {http:202,body:{order:String(externalId),cancel:1,status:'cancel_requested',pending:true,message:'Provider accepted the cancellation request but has not confirmed the final status; no refund was issued yet.'}};
  }catch(e){
    if(e?.providerRejected){const rejected={...order,cancelRequestedAt:null,cancelRequestState:'rejected',cancelRequestError:apiSafeError(e),updatedAt:nowISO()};try{await persistApiOrderUpdate(rejected);}catch(_){}return {http:502,body:{error:apiSafeError(e),stage:'provider_cancel',rejected:true}};}
    const uncertain={...order,cancelRequestState:'uncertain',cancelRequestError:apiSafeError(e),updatedAt:nowISO()};try{await persistApiOrderUpdate(uncertain);}catch(_){}
    appendJsonLedger('provider_failures.json',{stage:'api_cancel',uncertain:true,username:auth.username,orderId:String(order.id),providerOrderId:String(order.providerOrderId),error:apiSafeError(e),createdAt:nowISO()});
    return {http:202,body:{order:String(externalId),cancel:1,status:'cancel_pending',pending:true,uncertain:true,message:'The provider result is uncertain. The cancellation will not be resent automatically; check status before any further action.'}};
  }
}
function apiRefillLockPath(username,orderId){return 'apiRefillLocks/'+sha256(String(username||'')+'|'+String(orderId||''));}
async function saveApiRefillRecord(rec,verify=true){
  // Firebase is the durable source of truth: confirm the record before mirroring locally.
  await firebaseWriteJson('apiRefills/'+firebaseSafeKey(rec.id),rec,8000);
  if(verify){const saved=await firebaseGetJson('apiRefills/'+firebaseSafeKey(rec.id),8000);if(!saved||String(saved.id||'')!==String(rec.id)||String(saved.username||'')!==String(rec.username)||String(saved.status||'')!==String(rec.status))throw new Error('Firebase did not confirm the refill record');}
  // Keep the per-user/order idempotency lock in step with the verified refill record.
  await firebaseTransaction(apiRefillLockPath(rec.username,rec.orderId),current=>{
    if(!current||String(current.id||'')!==String(rec.id)||String(current.username||'')!==String(rec.username))return {write:false,result:{lockNotOwned:true}};
    return {write:true,value:{...current,status:String(rec.status||'unknown'),providerRefillId:String(rec.providerRefillId||current.providerRefillId||''),updatedAt:String(rec.updatedAt||nowISO())},result:{updated:true}};
  },8000,8);
  const rows=readJSON('api_refills.json',[]),arr=Array.isArray(rows)?rows:[];const idx=arr.findIndex(x=>String(x?.id||'')===String(rec.id)&&String(x?.username||'')===String(rec.username));if(idx>=0)arr[idx]={...arr[idx],...rec};else arr.push(rec);writeJSON('api_refills.json',arr.slice(-5000));
  return rec;
}
async function apiRefillOne(auth,externalId){
  let order;try{order=await findApiOwnedOrder(auth,externalId);}catch(e){return {http:503,body:{error:'Order lookup unavailable'}};}
  if(!order)return {http:404,body:{error:'Order not found'}};
  const svc=findInternalApiService(order.siteServiceId||order.serviceId);if(!(order.refillAllowed||svc?.refill))return {http:409,body:{error:'This service does not advertise refill support'}};
  if(!order.providerId||!order.providerOrderId)return {http:409,body:{error:'Order has no provider tracking ID'}};
  let remoteRefills;try{remoteRefills=await firebaseGetJson('apiRefills',7000);}catch(e){return {http:503,body:{error:'Cannot check prior refill requests in Firebase; no refill was sent.'}};}
  const localRows=readJSON('api_refills.json',[]),local=Array.isArray(localRows)?localRows:[];
  const remoteRows=remoteRefills&&typeof remoteRefills==='object'&&!Array.isArray(remoteRefills)?Object.values(remoteRefills):Array.isArray(remoteRefills)?remoteRefills:[];
  const orderLabel=String(order.publicOrderNo||order.id);
  const pendingStatuses=new Set(['submitting','pending','processing','accepted','unknown','uncertain']);
  const prior=[...remoteRows,...local].find(x=>x&&String(x.username||'')===auth.username&&String(x.orderId||'')===orderLabel&&pendingStatuses.has(String(x.status||'').toLowerCase()));
  if(prior)return {http:409,body:{error:'A refill request for this order is already pending or uncertain; it was not resent.',refill:prior.id||null,status:prior.status||'pending',uncertain:['submitting','unknown','uncertain'].includes(String(prior.status||'').toLowerCase())}};
  await ensureProviderRuntime(order.providerId);const {prov}=getProviderById(order.providerId,{allowSingleFallback:false});if(!prov?.url||!prov?.key)return {http:502,body:{error:'Provider unavailable'}};
  const id='RF_'+crypto.randomUUID().replace(/-/g,'');const createdAt=nowISO();
  let rec={id,username:auth.username,orderId:orderLabel,siteOrderId:String(order.id),providerId:String(order.providerId),providerOrderId:String(order.providerOrderId),providerRefillId:'',status:'submitting',createdAt,updatedAt:createdAt};
  // Atomic per-user/order lock prevents two concurrent requests from both reaching the provider.
  const lockPath=apiRefillLockPath(auth.username,orderLabel);let claim;
  try{claim=await firebaseTransaction(lockPath,current=>{
    const pending=new Set(['submitting','pending','processing','accepted','unknown','uncertain']);
    if(current&&String(current.username||'')===auth.username&&String(current.orderId||'')===orderLabel&&pending.has(String(current.status||'').toLowerCase()))return {write:false,result:{duplicate:true,record:current}};
    return {write:true,value:{id,username:auth.username,orderId:orderLabel,status:'submitting',createdAt,updatedAt:createdAt},result:{claimed:true}};
  },8000,8);}catch(e){return {http:503,body:{error:'Could not reserve an atomic refill lock in Firebase; no provider request was sent.'}};}
  if(!claim.result?.claimed)return {http:409,body:{error:'A refill request for this order is already pending or uncertain; it was not resent.',refill:claim.result?.record?.id||null,status:claim.result?.record?.status||'pending',uncertain:true}};
  try{await saveApiRefillRecord(rec,true);}catch(e){try{await firebaseTransaction(lockPath,current=>current&&String(current.id||'')===id?{write:true,value:null,result:{released:true}}:{write:false,result:{unchanged:true}},8000,8);}catch(_){}return {http:503,body:{error:'Could not durably reserve the refill record in Firebase; no provider request was sent.',stage:'refill_reservation'}};}
  try{
    // providerRequest guarantees one outbound call for refill; retrying after a timeout may duplicate it.
    const d=await providerRequest(prov,{action:'refill',order:String(order.providerOrderId)});let providerRefillId=d?.refill??d?.refill_id??d?.refillId??d?.data?.refill??d?.data?.refill_id;
    if(providerReturnedError(d))throw Object.assign(new Error('Provider rejected refill'),{providerRejected:true});
    if(providerRefillId===undefined||providerRefillId===null||String(providerRefillId).trim()===''||providerRefillId===true){
      rec={...rec,status:'uncertain',providerDiagnostic:'Provider response did not include a refill ID',updatedAt:nowISO()};await saveApiRefillRecord(rec,true).catch(()=>{});
      appendJsonLedger('provider_failures.json',{stage:'api_refill_response',uncertain:true,username:auth.username,orderId:String(order.id),providerOrderId:String(order.providerOrderId),refillId:id,error:'Provider did not return a refill ID',createdAt:nowISO()});
      return {http:502,body:{error:'Provider response did not include a refill ID. The request will not be resent automatically.',refill:id,uncertain:true}};
    }
    rec={...rec,providerRefillId:String(providerRefillId),status:'pending',providerStatus:String(d?.status||'pending'),updatedAt:nowISO()};
    try{await saveApiRefillRecord(rec,true);}catch(e){appendJsonLedger('provider_failures.json',{stage:'api_refill_persist',uncertain:true,username:auth.username,orderId:String(order.id),providerRefillId:String(providerRefillId),refillId:id,error:apiSafeError(e),createdAt:nowISO()});return {http:503,body:{error:'Provider accepted the refill but Firebase did not confirm tracking data. Do not resubmit this order.',refill:id,uncertain:true}};}
    return {http:200,body:{refill:id,refill_id:id,status:'pending'}};
  }catch(e){
    const rejected=!!e.providerRejected;rec={...rec,status:rejected?'failed':'uncertain',providerDiagnostic:apiSafeError(e),updatedAt:nowISO()};await saveApiRefillRecord(rec,true).catch(()=>{});
    appendJsonLedger('provider_failures.json',{stage:'api_refill_create',uncertain:!rejected,username:auth.username,providerId:order.providerId,providerOrderId:String(order.providerOrderId),refillId:id,error:apiSafeError(e),createdAt:nowISO()});
    return {http:rejected?502:504,body:{error:rejected?'Provider rejected the refill request':apiSafeError(e),refill:id,uncertain:!rejected,stage:'provider_refill'}};
  }
}
async function apiRefillStatusOne(auth,refillId){
  const id=String(refillId||'').trim();if(!id)return {http:422,body:{error:'refill or refill_id is required'}};
  let rec=(Array.isArray(readJSON('api_refills.json',[]))?readJSON('api_refills.json',[]):[]).find(x=>String(x?.id||'')===id&&String(x?.username||'')===auth.username)||null;
  if(!rec){try{const remote=await firebaseGetJson('apiRefills/'+firebaseSafeKey(id),6000);if(remote&&String(remote.username||'')===auth.username)rec=remote;}catch(_){return {http:503,body:{error:'Refill lookup unavailable'}};}}
  if(!rec)return {http:404,body:{error:'Refill not found'}};
  if(!rec.providerRefillId)return {http:rec.status==='failed'?409:202,body:{error:rec.status==='failed'?'Refill was rejected by the provider':'Refill result is uncertain because no provider refill ID was confirmed',refill:id,status:rec.status,uncertain:rec.status!=='failed'}};
  await ensureProviderRuntime(rec.providerId);const {prov}=getProviderById(rec.providerId,{allowSingleFallback:false});if(!prov?.url||!prov?.key)return {http:502,body:{error:'Provider unavailable'}};
  try{
    const d=await providerRequest(prov,{action:'refill_status',refill:String(rec.providerRefillId)},15000);if(providerReturnedError(d))return {http:502,body:{error:'Provider rejected refill status request'}};
    const status=String(d?.status??d?.data?.status??d?.refill_status??'unknown');rec={...rec,status:normalizeProviderStatus(status)==='unknown'?status:normalizeProviderStatus(status),providerStatus:status,providerRaw:safeProviderResponse(d),updatedAt:nowISO()};
    await saveApiRefillRecord(rec,true);
    return {http:200,body:{refill:id,status:rec.status}};
  }catch(e){return {http:502,body:{error:apiSafeError(e),stage:'provider_refill_status'}};}
}
async function handlePublicApiV1(req,res,urlObj,p){
  const path=String(p||'').replace(/\/+$/,'')||'/';const match=path.match(/^\/api\/v([12])(?:\/(.*))?$/);if(!match)return false;
  if(!['GET','POST'].includes(req.method))return json(res,405,{error:'Method not allowed'},{Allow:'GET, POST'}),true;
  const wait=rateLimit(req,'api');if(wait)return json(res,429,{error:'Too Many Requests'},{'Retry-After':String(wait)}),true;
  let body={};try{body=await readApiRequestBody(req);}catch(e){return json(res,Number(e.statusCode||400),{error:apiSafeError(e)}),true;}
  const suffix=String(match[2]||'').replace(/\.php$/i,'');let action='';let fixedOrderId='';
  if(!suffix){action=String(body.action||urlObj.searchParams.get('action')||'').trim().toLowerCase();}
  else if(/^order\/[^/]+$/.test(suffix)){const m=suffix.match(/^order\/(.+)$/);fixedOrderId=decodeURIComponent(m[1]);action=req.method==='GET'?'order_read':'unknown';}
  else if(suffix==='orders/status'||suffix==='orders_status')action='status';
  else if(suffix==='refill-status'||suffix==='refill_status')action='refill_status';
  else action=suffix.toLowerCase();
  const aliases={add:'add',order:'add','order/read':'order_read',services:'services',balance:'balance',status:'status',refill:'refill',refill_status:'refill_status','refill-status':'refill_status',cancel:'cancel',orders:'orders'};action=aliases[action]||action;
  const allowed=['services','balance','orders','order_read','add','status','refill','refill_status','cancel'];
  if(!allowed.includes(action))return json(res,422,{error:'Unsupported API action',supported:['services','balance','add','status','orders','refill','refill_status','cancel']}),true;
  const auth=await apiKeyUser(req);
  if(!auth)return json(res,req._apiAuthError==='storage_unavailable'?503:401,{error:req._apiAuthError==='storage_unavailable'?'API key database is temporarily unavailable; key validation could not be confirmed':'Invalid API key'}),true;
  const scopeByAction={services:'services',balance:'balance',orders:'orders:read',order_read:'orders:read',add:'orders:create',status:'orders:read',refill:'orders:refill',refill_status:'orders:refill',cancel:'orders:cancel'};
  if(!apiScopeAllows(auth,scopeByAction[action]))return json(res,403,{error:'API key does not have permission for this action'}),true;
  if(action==='services'){
    try{await ensureLocalServiceCatalogSeeded();ensureNumericSiteServiceIds();}
    catch(e){return json(res,503,{error:'Service catalog is temporarily unavailable',stage:'service_catalog'}),true;}
    return json(res,200,internalApiServices().map(publicApiService)),true;
  }
  if(action==='balance'){
    let wallet;try{wallet=await resolveApiWallet(auth);}catch(e){return json(res,e.code==='wallet_user_not_found'?404:503,{error:apiSafeError(e),stage:'wallet_lookup'}),true;}
    const iqd=Number(wallet.user.balance||0);if(!Number.isFinite(iqd)||iqd<0)return json(res,503,{error:'User balance record is invalid'}),true;
    return json(res,200,{balance:Number((iqd/FIXED_RATE).toFixed(6)),balanceIQD:Number(iqd.toFixed(4)),currency:'USD'}),true;
  }
  if(action==='orders'){
    let rows;try{rows=await loadApiOwnedOrders(auth.username);}catch(e){return json(res,503,{error:apiSafeError(e),stage:'orders_lookup'}),true;}
    const limit=Math.min(100,Math.max(1,Math.floor(Number(urlObj.searchParams.get('limit')||body.limit||50)||50)));
    return json(res,200,rows.slice(0,limit).map(apiOrderPublic)),true;
  }
  if(action==='order_read'){
    let order;try{order=await findApiOwnedOrder(auth,fixedOrderId);}catch(_){return json(res,503,{error:'Order lookup unavailable'}),true;}
    if(!order)return json(res,404,{error:'Order not found'}),true;return json(res,200,apiOrderPublic(order)),true;
  }
  if(action==='add'){
    if(req.method!=='POST')return json(res,405,{error:'add requires POST'},{Allow:'POST'}),true;
    if(body.__headerIdempotencyKey===undefined)body.__headerIdempotencyKey=String(req.headers['idempotency-key']||'').trim();
    const out=await apiCreateOrder(auth,body);return json(res,out.http,out.body),true;
  }
  if(action==='status'){
    const raw=String(body.orders??body.order??urlObj.searchParams.get('orders')??urlObj.searchParams.get('order')??'').trim();if(!raw)return json(res,422,{error:'order or orders is required'}),true;
    const ids=[...new Set(raw.split(',').map(x=>x.trim()).filter(Boolean))].slice(0,100);if(!ids.length)return json(res,422,{error:'order or orders is required'}),true;
    const outputs=await Promise.all(ids.map(async id=>{let order;try{order=await findApiOwnedOrder(auth,id);}catch(e){return [id,{error:'Order lookup unavailable',http_status:503}];}if(!order)return [id,{error:'Order not found',http_status:404}];const result=await apiStatusForOrder(auth,order);return [id,result.http===200?result.body:{error:result.body.error||'Status lookup failed',http_status:result.http,uncertain:!!result.body.uncertain}]}));
    if(ids.length===1){const [id,value]=outputs[0];if(value?.error)return json(res,Number(value.http_status||404),{error:value.error,order:id,uncertain:!!value.uncertain}),true;return json(res,200,value),true;}
    const ret={};for(const [id,value] of outputs)ret[id]=value;return json(res,200,ret),true;
  }
  if(action==='cancel'){
    const raw=String(body.orders??body.order??'').trim();if(!raw)return json(res,422,{error:'order or orders is required'}),true;
    const ids=[...new Set(raw.split(',').map(x=>x.trim()).filter(Boolean))].slice(0,100);const results=[];
    for(const id of ids){const r=await apiCancelOne(auth,id);results.push({order:id,cancel:r.http===200||r.http===202?1:0,status:r.body.status||undefined,pending:r.http===202||undefined,error:r.http>=400?r.body.error:undefined});}
    return json(res,results.some(x=>x.cancel===0)?207:200,results),true;
  }
  if(action==='refill'){
    const raw=String(body.orders??body.order??'').trim();if(!raw)return json(res,422,{error:'order or orders is required'}),true;
    const ids=[...new Set(raw.split(',').map(x=>x.trim()).filter(Boolean))].slice(0,100);if(ids.length>1)return json(res,422,{error:'Submit one refill order at a time so each refill ID can be tracked'}),true;
    const out=await apiRefillOne(auth,ids[0]);return json(res,out.http,out.body),true;
  }
  if(action==='refill_status'){
    const raw=String(body.refills??body.refill??body.refill_id??'').trim();if(!raw)return json(res,422,{error:'refill or refill_id is required'}),true;
    const ids=[...new Set(raw.split(',').map(x=>x.trim()).filter(Boolean))].slice(0,100);const results=await Promise.all(ids.map(async id=>{const out=await apiRefillStatusOne(auth,id);return [id,out.http===200?out.body:{error:out.body.error||'Refill lookup failed',http_status:out.http,status:out.body.status,uncertain:!!out.body.uncertain}]}));
    if(ids.length===1){const [id,value]=results[0];if(value?.error)return json(res,Number(value.http_status||404),{error:value.error,refill:id,status:value.status,uncertain:!!value.uncertain}),true;return json(res,200,value),true;}const ret={};for(const [id,v] of results)ret[id]=v;return json(res,200,ret),true;
  }
  return json(res,422,{error:'Unsupported API action'}),true;
}

function canonicalServicePlatform(s={}){
  const defs=[['instagram',['instagram','انستغرام','انستجرام','انستا']],['tiktok',['tiktok','tik tok','تيك توك','تيكتوك']],['facebook',['facebook','فيسبوك','فيس بوك']],['youtube',['youtube','يوتيوب']],['telegram',['telegram','تلجرام','تيليجرام','تليجرام']],['twitter',['twitter','تويتر','x.com']],['snapchat',['snapchat','سناب']],['whatsapp',['whatsapp','واتساب']],['linkedin',['linkedin','لينكد']]];
  const normalize=v=>String(v??'').trim().toLowerCase().replace(/[._-]+/g,' ').replace(/\s+/g,' ');
  const match=v=>{const raw=normalize(v);if(!raw)return null;for(const [key,terms] of defs){if(terms.some(term=>raw===normalize(term)||raw.startsWith(normalize(term)+' ')||raw.endsWith(' '+normalize(term))))return key;}for(const [key,terms] of defs){if(terms.some(term=>raw.includes(normalize(term))))return key;}return null};
  // Explicit platform metadata is authoritative. Names/categories often mention a different network
  // (e.g. an Instagram service listed under a provider's generic Telegram category), so never let
  // those text labels override a valid app/serviceApp/platform field.
  for(const candidate of [s.serviceApp,s.app,s.platform,s.platformId,s.servicePlatform,s.imagePlatform]){const key=match(candidate);if(key)return {serviceApp:key,image:'/platform-icons/'+key+'.svg',platformIcon:'/platform-icons/'+key+'.svg'};}
  for(const candidate of [s.apps,s.platforms])if(Array.isArray(candidate)){for(const value of candidate){const key=match(value);if(key)return {serviceApp:key,image:'/platform-icons/'+key+'.svg',platformIcon:'/platform-icons/'+key+'.svg'};}}
  const raw=[s.name,s.serviceName,s.description,s.providerCategory,...(Array.isArray(s.groups)?s.groups:[]),...(Array.isArray(s.categories)?s.categories:[]),s.category].filter(Boolean).join(' ').toLowerCase();
  for(const [key,terms] of defs)if(terms.some(term=>raw.includes(term)))return {serviceApp:key,image:'/platform-icons/'+key+'.svg',platformIcon:'/platform-icons/'+key+'.svg'};
  return {serviceApp:'other',image:'/platform-icons/other.svg',platformIcon:'/platform-icons/other.svg'};
}
function calcApiChargeUsd(s,qty,user){
  const pct=Math.max(0,Math.min(100,Number(user?.discountPct)||0));
  const total=Math.max(0,Number(qty)/1000*Number(s.sellingUsd||s.rateUsd||s.rate||0)*(1-pct/100));
  return {pct,total:Number(total.toFixed(6))};
}
function baghdadDateKey(value){
  const d=value instanceof Date?value:new Date(value||0);if(!Number.isFinite(d.getTime()))return '';
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Baghdad',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);const m={};for(const p of parts)m[p.type]=p.value;return `${m.year}-${m.month}-${m.day}`;
}
function baghdadWeekStartKey(date=new Date()){
  const key=baghdadDateKey(date);if(!key)return '';const [y,m,d]=key.split('-').map(Number);const dt=new Date(Date.UTC(y,m-1,d));const days=(dt.getUTCDay()+6)%7;dt.setUTCDate(dt.getUTCDate()-days);return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
}
function statsSnapshot(range='all',ordersOverride=null){
  const allOrders=Array.isArray(ordersOverride)?ordersOverride:readJSON('orders.json',[]);const reset=readJSON('stats_state.json',{resetAt:null}).resetAt;const now=new Date();const todayKey=baghdadDateKey(now),weekStart=baghdadWeekStartKey(now),monthStart=todayKey.slice(0,7)+'-01',resetKey=reset?baghdadDateKey(reset):'';
  const kept=(Array.isArray(allOrders)?allOrders:[]).filter(o=>o&&!o.event&&(!reset||new Date(o.createdAt||0)>new Date(reset)));
  const list=kept.filter(o=>{const key=baghdadDateKey(o.createdAt);if(!key)return false;if(range==='today')return key===todayKey;if(range==='7d')return key>=weekStart&&key<=todayKey;if(range==='month')return key>=monthStart&&key<=todayKey;return true;});
  const metrics=rows=>{let sales=0,cost=0;for(const o of rows){const sale=Number(o.chargeUsd!==undefined?o.chargeUsd:(Number(o.total||0)/FIXED_RATE));const providerCost=Number(o.providerCostUsd!==undefined?o.providerCostUsd:(Number(o.providerRateUsd||o.smmRateUsd||0)*Number(o.quantity||0)/1000));sales+=Number.isFinite(sale)?sale:0;cost+=Number.isFinite(providerCost)?providerCost:0;}return {orders:rows.length,salesUsd:Number(sales.toFixed(6)),providerCostUsd:Number(cost.toFixed(6)),profitUsd:Number((sales-cost).toFixed(6)),profitMarginPct:sales>0?Number(((sales-cost)/sales*100).toFixed(2)):0};};
  const counts={total:0,today:0,completed:0,processing:0,pending:0,cancelled:0,failed:0,refunded:0,partial:0};const services={},users={},profits={};
  for(const o of list){counts.total++;const st=normalizeProviderStatus(o.status||'pending');if(st in counts)counts[st]++;if(baghdadDateKey(o.createdAt)===todayKey)counts.today++;const sale=Number(o.chargeUsd!==undefined?o.chargeUsd:(Number(o.total||0)/FIXED_RATE));const providerCost=Number(o.providerCostUsd!==undefined?o.providerCostUsd:(Number(o.providerRateUsd||o.smmRateUsd||0)*Number(o.quantity||0)/1000));const sn=String(o.serviceName||o.serviceId||'خدمة');services[sn]=(services[sn]||0)+1;profits[sn]=(profits[sn]||0)+(Number.isFinite(sale)?sale:0)-(Number.isFinite(providerCost)?providerCost:0);const un=String(o.user||o.username||'');users[un]=(users[un]||0)+1;}
  const vals=list.map(o=>Number(o.chargeUsd!==undefined?o.chargeUsd:Number(o.total||0)/FIXED_RATE)).filter(Number.isFinite);const serviceMost=Object.entries(services).sort((a,b)=>b[1]-a[1])[0]||null,userMost=Object.entries(users).sort((a,b)=>b[1]-a[1])[0]||null,profitMost=Object.entries(profits).sort((a,b)=>b[1]-a[1])[0]||null;
  const todayRows=kept.filter(o=>baghdadDateKey(o.createdAt)===todayKey),weekRows=kept.filter(o=>{const k=baghdadDateKey(o.createdAt);return k>=weekStart&&k<=todayKey;});const rangeMetrics=metrics(list),todayMetrics=metrics(todayRows),weekMetrics=metrics(weekRows);
  return {counts,...rangeMetrics,salesUsd:rangeMetrics.salesUsd,providerCostUsd:rangeMetrics.providerCostUsd,profitUsd:rangeMetrics.profitUsd,profitMarginPct:rangeMetrics.profitMarginPct,ordersToday:todayMetrics.orders,ordersWeek:weekMetrics.orders,salesTodayUsd:todayMetrics.salesUsd,salesWeekUsd:weekMetrics.salesUsd,costTodayUsd:todayMetrics.providerCostUsd,costWeekUsd:weekMetrics.providerCostUsd,profitTodayUsd:todayMetrics.profitUsd,profitWeekUsd:weekMetrics.profitUsd,highestOrderUsd:vals.length?Math.max(...vals):0,lowestOrderUsd:vals.length?Math.min(...vals):0,mostOrderedService:serviceMost?.[0]||null,mostOrderingUser:userMost?.[0]||null,highestProfitService:profitMost?{name:profitMost[0],profitUsd:Number(Number(profitMost[1]).toFixed(6))}:null,resetAt:reset||null,source:'local-or-merged',todayDate:todayKey,weekStartDate:weekStart};
}

function stableOrderCountIdentity(o,key=''){
  if(!o||typeof o!=='object'||Array.isArray(o)||o.event)return '';
  const user=String(o.user||o.username||o.userName||'').trim();
  if(o.legacyHistory&&o.legacyImportKey!==undefined&&o.legacyImportKey!==null&&String(o.legacyImportKey).trim())return 'legacy:'+String(o.legacyImportKey).trim();
  const id=String(o.id||o.siteOrderId||o.orderId||o.order_id||o.publicOrderNo||'').trim();
  if(id)return 'order:'+user+':'+id;
  const provider=String(o.providerOrderId||o.provider_order_id||o.smmpartyOrderId||'').trim();
  if(provider)return 'provider:'+user+':'+String(o.providerId||o.provider_id||'')+':'+provider;
  const stamp=String(o.createdAt||o.created_date||o.createdMs||'');
  if(user&&(stamp||o.serviceId||o.serviceName))return 'fallback:'+user+':'+stamp+':'+String(o.serviceId||o.serviceName||'')+':'+String(o.quantity||'');
  return key?'key:'+String(key):'';
}
function uniqueActualOrders(remoteOrders,localOrders=[]){
  const map=new Map();
  for(const [i,o] of collectionEntries(localOrders)){const id=stableOrderCountIdentity(o,'local-'+i);if(id)map.set(id,o);}
  for(const [k,o] of collectionEntries(remoteOrders)){const id=stableOrderCountIdentity(o,k);if(id)map.set(id,{...(map.get(id)||{}),...o});}
  return [...map.values()];
}

const MATH_CAPTCHA_CHALLENGES=new Map();
function issueMathCaptcha(req){
  const now=Date.now();for(const [k,v] of MATH_CAPTCHA_CHALLENGES)if(v.expiresAt<now)MATH_CAPTCHA_CHALLENGES.delete(k);while(MATH_CAPTCHA_CHALLENGES.size>5000)MATH_CAPTCHA_CHALLENGES.delete(MATH_CAPTCHA_CHALLENGES.keys().next().value);
  const a=crypto.randomInt(1,8),b=crypto.randomInt(1,8),captchaId=crypto.randomBytes(18).toString('hex');MATH_CAPTCHA_CHALLENGES.set(captchaId,{answer:String(a+b),ip:clientIp(req),expiresAt:now+5*60*1000});return {captchaId,question:`${a} + ${b} = ؟`};
}
function consumeMathCaptcha(req,b){
  const id=String(b?.captchaId||''),answer=String(b?.captchaAnswer??'').trim(),challenge=MATH_CAPTCHA_CHALLENGES.get(id);if(id)MATH_CAPTCHA_CHALLENGES.delete(id);
  if(!challenge||challenge.expiresAt<Date.now())return 'انتهى سؤال التحقق؛ حدّث السؤال وحاول مجدداً.';if(challenge.ip!==clientIp(req))return 'تغير اتصالك أثناء التحقق؛ حدّث السؤال وحاول مجدداً.';if(!/^\d{1,2}$/.test(answer)||!safeEqual(answer,challenge.answer))return 'ناتج الجمع غير صحيح؛ حاول مرة أخرى.';return '';
}
let googleOAuthClientCached=null,googleOAuthClientAudience='';
function requestHasSameOrigin(req){
  const origin=String(req.headers.origin||'').trim();const host=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim().toLowerCase();
  if(!origin||!host)return false;try{const u=new URL(origin);return ['https:','http:'].includes(u.protocol)&&u.host.toLowerCase()===host;}catch(_){return false;}
}
function getGoogleOAuthClient(){const clientId=String(process.env.GOOGLE_CLIENT_ID||'').trim();if(!clientId)return null;if(!googleOAuthClientCached||googleOAuthClientAudience!==clientId){const {OAuth2Client}=require('google-auth-library');googleOAuthClientCached=new OAuth2Client(clientId);googleOAuthClientAudience=clientId;}return {client:googleOAuthClientCached,clientId};}
function cleanGoogleUser(user={}){const out={...user};delete out.password;delete out.passwordHash;delete out.googleSub;return out;}
async function googleAuthLogin(credential){
  const config=getGoogleOAuthClient();if(!config)throw Object.assign(new Error('تسجيل Google غير مفعّل بعد؛ أضف GOOGLE_CLIENT_ID من Google Cloud إلى متغيرات Railway.'),{statusCode:503});
  const ticket=await config.client.verifyIdToken({idToken:String(credential||''),audience:config.clientId});const payload=ticket.getPayload()||{};
  if(!payload.sub||!payload.email||payload.email_verified!==true)throw Object.assign(new Error('تعذر تأكيد هوية Google أو البريد الإلكتروني غير موثق.'),{statusCode:401});
  const sub=String(payload.sub),email=String(payload.email).trim().toLowerCase(),mapKey=sha256(sub);let accounts=readJSON('google_accounts.json',{}),usersStore=readJSON('users.json',{users:{}}),users=usersStore.users||{},username=String(accounts[mapKey]?.username||'');
  if(!username){try{const remoteMap=await firebaseGetJson('config/googleAccounts/'+mapKey,3500);if(remoteMap?.username)username=String(remoteMap.username)}catch(_){}}
  let user=username?users[username]:null;if(!user&&username){try{const remoteUser=await firebaseGetJson('users/'+firebaseSafeKey(username),3500);if(remoteUser&&typeof remoteUser==='object'){user=remoteUser;users[username]=user;}}catch(_){}}
  if(!user){const found=Object.entries(users).find(([n,u])=>u&&u.role!=='admin'&&(String(u.googleSub||'')===sub||(String(u.email||'').toLowerCase()===email&&u.emailVerified===true)));if(found){username=found[0];user=found[1];}}
  let created=false;if(!user){const local=email.split('@')[0].replace(/[^a-zA-Z0-9_]/g,'_').replace(/^_+|_+$/g,'').slice(0,16)||'googleuser';let base=local;let suffix=sub.slice(-5).replace(/[^a-zA-Z0-9]/g,'')||crypto.randomBytes(3).toString('hex');username=base;if(username===ADMIN_USER||users[username])username=(base.slice(0,10)+'_'+suffix).slice(0,20);let n=2;while(users[username]||username===ADMIN_USER){username=(base.slice(0,15)+'_'+suffix+n).slice(0,24);n++;if(n>100)throw new Error('تعذر إنشاء اسم مستخدم فريد');}
    user={name:String(payload.name||local).slice(0,100),email,emailVerified:true,googleSub:sub,authProvider:'google',picture:String(payload.picture||''),passwordHash:'',balance:0,level:'مبتدئ',telegram:'',phone:'',joined:nowISO(),totalSpent:0,totalOrders:0,role:'user'};created=true;
  }else{if(user.role==='admin'&&!user.googleSub)throw Object.assign(new Error('هذا الحساب الإداري لا يمكن ربطه تلقائياً بتسجيل Google.'),{statusCode:403});user={...user,email, emailVerified:true,googleSub:sub,authProvider:'google',name:String(user.name||payload.name||username).slice(0,100),picture:String(payload.picture||user.picture||''),updatedAt:nowISO()};}
  usersStore.users=users;users[username]=user;usersStore.users[username]=user;accounts[mapKey]={username,email,provider:'google',updatedAt:nowISO()};
  writeJSON('users.json',usersStore);writeJSON('google_accounts.json',accounts);let firebaseSaved=false,firebaseError='';
  try{const profile={username,name:user.name,email,emailVerified:true,authProvider:'google',picture:user.picture||'',balance:Number(user.balance||0),level:user.level||'مبتدئ',telegram:String(user.telegram||''),phone:String(user.phone||''),joined:user.joined||nowISO(),totalSpent:Number(user.totalSpent||0),totalOrders:Number(user.totalOrders||0),role:'user'};await firebaseWriteJson('users/'+firebaseSafeKey(username),profile,7000);await firebaseWriteJson('config/googleAccounts/'+mapKey,{username,email,updatedAt:nowISO()},7000);firebaseSaved=true;}catch(e){firebaseError=String(e.message||e);}
  if(created&&!firebaseSaved&&!DATA_IS_EXTERNAL){delete usersStore.users[username];delete accounts[mapKey];writeJSON('users.json',usersStore);writeJSON('google_accounts.json',accounts);throw Object.assign(new Error('تعذر حفظ الحساب في قاعدة بيانات دائمة؛ تحقق من اتصال Firebase أو اربط Railway Volume ثم أعد المحاولة.'),{statusCode:503});}
  const sessionToken='';return {username,user,sessionToken,firebaseSaved,firebaseError};
}


// -------------------- Private legacy-database import (v1.5.76) --------------------
// The ZIP is uploaded by an authenticated administrator. Personal data is staged only
// under DATA (never in the public project folder or Git source), then orders are merged
// with stable keys into the live Firebase orders node. Existing live orders are not replaced.
const LEGACY_STAGE_FILE = 'legacy_import_staging.json';
const LEGACY_USERS_PRIVATE_FILE = 'legacy_import_users_private.json';
const LEGACY_TRANSACTIONS_PRIVATE_FILE = 'legacy_import_transactions_private.json';
const LEGACY_TRANSACTIONS_REMOTE_PATH = 'config/base44LegacyTransactions';
const LEGACY_SEED_STATUS_FILE = 'legacy_seed_bootstrap_status.json';
const LEGACY_SEED_ENCRYPTED_FILE = 'base44-legacy-seed.enc'; // legacy compatibility only
const LEGACY_SEED_ARCHIVE_RELATIVE = path.join('database','SadaIraq_Database_Export.zip');
const LEGACY_SEED_ID = 'BASE44-EXPORT-20261010-V1';
const LEGACY_IMPORT_STATE_FILE = 'legacy_import_state.json';
const LEGACY_IMPORT_CONFIRM = 'IMPORT_LEGACY_DATABASE_1_5_76';
const LEGACY_IMPORT_MAX_ZIP_BYTES = 18 * 1024 * 1024;
const ZIP_CRC32_TABLE = (()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);t[n]=c>>>0;}return t;})();
function zipCrc32(buffer){let c=0xFFFFFFFF;for(let i=0;i<buffer.length;i++)c=ZIP_CRC32_TABLE[(c^buffer[i])&0xFF]^(c>>>8);return (c^0xFFFFFFFF)>>>0;}
async function readRawRequestBuffer(req,limit=LEGACY_IMPORT_MAX_ZIP_BYTES){const parts=[];let total=0;for await(const chunk of req){total+=chunk.length;if(total>limit)throw Object.assign(new Error('حجم ملف ZIP أكبر من الحد المسموح (18 ميجابايت).'),{statusCode:413});parts.push(chunk);}return Buffer.concat(parts,total);}
function readZipArchive(buffer){
  if(!Buffer.isBuffer(buffer)||buffer.length<22)throw new Error('ملف ZIP غير صالح أو فارغ.');
  const sigEOCD=Buffer.from([0x50,0x4b,0x05,0x06]);let eocd=-1;const min=Math.max(0,buffer.length-65557);
  for(let i=buffer.length-22;i>=min;i--){if(buffer[i]===0x50&&buffer[i+1]===0x4b&&buffer[i+2]===0x05&&buffer[i+3]===0x06){eocd=i;break;}}
  if(eocd<0)throw new Error('لم يتم العثور على فهرس ZIP صالح.');
  const disk=buffer.readUInt16LE(eocd+4),cdDisk=buffer.readUInt16LE(eocd+6),entriesOnDisk=buffer.readUInt16LE(eocd+8),totalEntries=buffer.readUInt16LE(eocd+10),cdSize=buffer.readUInt32LE(eocd+12),cdOffset=buffer.readUInt32LE(eocd+16);
  if(disk!==0||cdDisk!==0||entriesOnDisk!==totalEntries||totalEntries>2000||cdOffset+cdSize>eocd)throw new Error('صيغة ZIP متعددة الأقراص أو ZIP64 غير مدعومة. أعد إنشاء ملف ZIP القياسي.');
  const entries={};let pos=cdOffset,totalUncompressed=0;
  for(let n=0;n<totalEntries;n++){
    if(pos+46>buffer.length||buffer.readUInt32LE(pos)!==0x02014b50)throw new Error('فهرس ZIP تالف.');
    const flags=buffer.readUInt16LE(pos+8),method=buffer.readUInt16LE(pos+10),expectedCrc=buffer.readUInt32LE(pos+16),compressedSize=buffer.readUInt32LE(pos+20),uncompressedSize=buffer.readUInt32LE(pos+24),nameLen=buffer.readUInt16LE(pos+28),extraLen=buffer.readUInt16LE(pos+30),commentLen=buffer.readUInt16LE(pos+32),localOffset=buffer.readUInt32LE(pos+42);
    const name=buffer.subarray(pos+46,pos+46+nameLen).toString('utf8');pos+=46+nameLen+extraLen+commentLen;
    if(!name||name.startsWith('/')||name.split(/[\\/]/).includes('..'))throw new Error('ملف ZIP يحتوي على مسار غير آمن.');
    if(name.endsWith('/'))continue;
    if(flags&1)throw new Error('ملفات ZIP المشفرة بكلمة مرور غير مدعومة.');
    if(uncompressedSize>12*1024*1024)throw new Error('أحد ملفات ZIP أكبر من الحد المسموح.');
    totalUncompressed+=uncompressedSize;if(totalUncompressed>30*1024*1024)throw new Error('إجمالي الملفات بعد فك الضغط أكبر من الحد المسموح.');
    if(localOffset+30>buffer.length||buffer.readUInt32LE(localOffset)!==0x04034b50)throw new Error('رأس ملف داخلي في ZIP تالف.');
    const localNameLen=buffer.readUInt16LE(localOffset+26),localExtraLen=buffer.readUInt16LE(localOffset+28),dataStart=localOffset+30+localNameLen+localExtraLen,dataEnd=dataStart+compressedSize;
    if(dataEnd>buffer.length)throw new Error('بيانات أحد ملفات ZIP غير مكتملة.');
    const compressed=buffer.subarray(dataStart,dataEnd);let output;
    if(method===0)output=Buffer.from(compressed);else if(method===8)output=zlib.inflateRawSync(compressed,{maxOutputLength:12*1024*1024});else throw new Error('طريقة ضغط ZIP غير مدعومة: '+method);
    if(output.length!==uncompressedSize||zipCrc32(output)!==expectedCrc)throw new Error('فشل التحقق من سلامة الملف داخل ZIP: '+name);
    entries[name.replace(/\\/g,'/')]=output;
  }
  return entries;
}
function parseLegacyJsonEntry(entries,name){const key=Object.keys(entries).find(k=>k===name||k.endsWith('/'+name));if(!key)throw new Error('ملف ZIP لا يحتوي على '+name);try{return JSON.parse(entries[key].toString('utf8'));}catch(_){throw new Error('ملف '+name+' ليس JSON صالحاً.');}}
function assertUniqueIds(rows,label){if(!Array.isArray(rows))throw new Error('قائمة '+label+' ليست مصفوفة.');const ids=new Set();for(const row of rows){const id=String(row?.id??'').trim();if(!id)throw new Error('يوجد سجل بلا معرّف في '+label+'.');if(ids.has(id))throw new Error('يوجد معرّف مكرر في '+label+'.');ids.add(id);}return ids;}
function normalizeLegacyBalance(value){const n=Number(value);return Number.isFinite(n)?n:0;}
function legacyUserPrivateRow(u){return {id:String(u?.id||''),email:normalizeEmail(u?.email||''),full_name:String(u?.full_name||'').slice(0,160),arabic_name:String(u?.arabic_name||'').slice(0,160),phone:String(u?.phone||''),balance:normalizeLegacyBalance(u?.balance),free_points:Number(u?.free_points||0)||0,user_code:String(u?.user_code||''),referral_code:String(u?.referral_code||''),referred_by:String(u?.referred_by||''),role:String(u?.role||'user'),status:String(u?.status||''),custom_discount:Number(u?.custom_discount||0)||0,telegram_user_id:String(u?.telegram_user_id||''),created_date:String(u?.created_date||''),updated_date:String(u?.updated_date||'')};}
const LEGACY_USERS_REMOTE_PATH='config/base44LegacyUsers';
const LEGACY_IMPORT_STATE_REMOTE_PATH='config/base44LegacyImportState';
function legacyRemoteUserKey(id){return 'u_'+crypto.createHash('sha256').update(String(id||'')).digest('hex').slice(0,32);}
async function loadLegacyUsersRemote(){
  const raw=await firebaseGetJson(LEGACY_USERS_REMOTE_PATH,12000);
  if(!raw||typeof raw!=='object')return [];
  const rows=Array.isArray(raw.users)?raw.users:collectionEntries(raw.users||raw).map(([,u])=>u);
  return rows.filter(u=>u&&typeof u==='object').map(legacyUserPrivateRow).filter(u=>u.id);
}
async function persistLegacyUsersRemote(rows){
  const clean=(Array.isArray(rows)?rows:[]).map(legacyUserPrivateRow).filter(u=>u.id);
  const users={};for(const u of clean)users[legacyRemoteUserKey(u.id)]=u;
  const record={schemaVersion:1,source:'base44-export',count:clean.length,updatedAt:nowISO(),users};
  await firebaseWriteJson(LEGACY_USERS_REMOTE_PATH,record,18000);
  const check=await firebaseGetJson(LEGACY_USERS_REMOTE_PATH,10000);
  const count=Number(check?.count||Object.keys(check?.users||{}).length||0);
  if(count!==clean.length)throw new Error('عدد مستخدمي Base44 المحفوظين في قاعدة الموقع لا يطابق الملف ('+count+'/'+clean.length+').');
  return {count,updatedAt:record.updatedAt};
}
function legacyOrderPrivateRow(o){return {id:String(o?.id||''),order_number:String(o?.order_number||''),user_id:String(o?.user_id||''),user_name:String(o?.user_name||''),service_id:String(o?.service_id||''),service_name:String(o?.service_name||'خدمة'),platform_name:String(o?.platform_name||''),provider_id:String(o?.provider_id||''),provider_name:String(o?.provider_name||''),provider_order_id:String(o?.provider_order_id||''),quantity:Number(o?.quantity||0)||0,link:String(o?.link||''),total_price:Number(o?.total_price||0)||0,cost:Number(o?.cost||0)||0,status:String(o?.status||'new'),provider_status:String(o?.provider_status||''),is_free:!!o?.is_free,start_count:o?.start_count??null,remains:o?.remains??null,created_date:String(o?.created_date||''),updated_date:String(o?.updated_date||'')};}
function legacyStableFirebaseKey(id){return 'legacy_'+sha256(String(id||'')).slice(0,32);}
function legacyAliasUser(id){return 'legacy_'+sha256(String(id||'unknown')).slice(0,12);}
function legacyStatus(value){const v=String(value||'').trim().toLowerCase().replace(/[\\s-]+/g,'_');const map={new:'pending',pending:'pending',waiting:'pending',processing:'processing',in_progress:'processing',completed:'completed',complete:'completed',partial:'partial',canceled:'cancelled',cancelled:'cancelled',refunded:'refunded',error:'failed',failed:'failed'};return map[v]||'pending';}
function collectionEntries(value){if(Array.isArray(value))return value.map((v,i)=>[String(i),v]);if(value&&typeof value==='object')return Object.entries(value);return [];}
function normalizeCurrentUsers(root){const users=[];const emailMap=new Map(),nameMap=new Map();for(const [key,raw] of collectionEntries(root)){if(!raw||typeof raw!=='object'||Array.isArray(raw))continue;const username=String(raw.username||decodeFirebaseSafeKey(key)||key).trim();if(!username)continue;const item={key,username,user:raw,email:firebaseRecordEmail(raw)};users.push(item);if(item.email){const arr=emailMap.get(item.email)||[];arr.push(item);emailMap.set(item.email,arr);}const n=username.toLowerCase();const arr=nameMap.get(n)||[];arr.push(item);nameMap.set(n,arr);}return {users,emailMap,nameMap};}
function mapLegacyUsersToCurrent(legacyUsers,currentDirectory){const byLegacyId=new Map(),matchedIds=new Set();for(const old of legacyUsers){let match=null;const email=normalizeEmail(old.email||'');const emailRows=email?currentDirectory.emailMap.get(email)||[]:[];if(emailRows.length===1)match=emailRows[0];else if(emailRows.length>1)match=null;/* Only use user_code as a fallback when the export has no email. With an email that does not match, keep the account separate rather than accidentally merging two people. */if(!match&&!email&&old.user_code){const candidates=currentDirectory.nameMap.get(String(old.user_code).trim().toLowerCase())||[];if(candidates.length===1)match=candidates[0];}if(match){byLegacyId.set(String(old.id),match);matchedIds.add(String(old.id));}else byLegacyId.set(String(old.id),null);}return {byLegacyId,matchedIds};}
function legacyPublicOrderNumber(old,duplicateOrderNumbers,liveNumbers,allocatedNumbers){const n=String(old.order_number||'').trim();if(/^\d{1,9}$/.test(n)&&duplicateOrderNumbers.get(n)===1&&!liveNumbers.has(n)&&!allocatedNumbers.has(n)){allocatedNumbers.add(n);return n;}let candidate=0;for(const value of [...liveNumbers,...allocatedNumbers])if(/^\d{1,9}$/.test(String(value||'')))candidate=Math.max(candidate,Number(value));candidate++;while(candidate<=999999999&&(liveNumbers.has(String(candidate))||allocatedNumbers.has(String(candidate))||duplicateOrderNumbers.has(String(candidate))))candidate++;if(candidate>999999999)throw new Error('لا توجد مساحة أرقام طلبات قصيرة متاحة؛ لم يتم دمج الطلبات.');const result=String(candidate);allocatedNumbers.add(result);return result;}
function legacyOrderMatchesLive(old,matchedUsername,liveOrders){if(!matchedUsername)return false;const oldProvider=String(old.provider_id||''),oldProviderOrder=String(old.provider_order_id||'');for(const [,r] of liveOrders){if(!r||typeof r!=='object'||r.legacyHistory)continue;if(String(r.user||r.username||'')!==matchedUsername)continue;const rp=String(r.providerId||r.provider_id||''),rpo=String(r.providerOrderId||r.provider_order_id||r.smmpartyOrderId||'');if(oldProviderOrder&&rpo===oldProviderOrder&&(!oldProvider||!rp||oldProvider===rp))return true;const rid=String(r.publicOrderNo||r.id||r.order_id||'');if(old.order_number&&rid===String(old.order_number)&&String(r.serviceName||r.service||'')===String(old.service_name||'')&&String(r.link||'')===String(old.link||'')&&Number(r.quantity||0)===Number(old.quantity||0))return true;}return false;}
function buildLegacyOrderRecord(old,legacyUser,matched,currentDirectory,publicOrderNo){
  const username=matched?.username||legacyAliasUser(old.user_id);const currentName=matched?.user?.name||matched?.user?.fullName||matched?.user?.full_name||'';const priceUsd=Math.max(0,Number(old.total_price||0)||0);const costUsd=Math.max(0,Number(old.cost||0)||0);const qty=Math.max(0,Number(old.quantity||0)||0);
  return {id:String(publicOrderNo),publicOrderNo:String(publicOrderNo),user:username,userName:String(currentName||legacyUser?.arabic_name||legacyUser?.full_name||old.user_name||username),serviceId:String(old.service_id||''),serviceName:String(old.service_name||'خدمة'),serviceApp:String(old.platform_name||''),platform:String(old.platform_name||''),link:String(old.link||''),quantity:qty,total:Number((priceUsd*FIXED_RATE).toFixed(4)),totalIQD:Number((priceUsd*FIXED_RATE).toFixed(4)),chargeUsd:Number(priceUsd.toFixed(6)),providerCostUsd:Number(costUsd.toFixed(6)),unitSellingUsd:qty?Number((priceUsd*1000/qty).toFixed(6)):0,discountPct:0,status:legacyStatus(old.status),rawLegacyStatus:String(old.status||''),providerStatus:String(old.provider_status||''),providerId:'',providerOrderId:'',providerName:'',legacyProviderId:String(old.provider_id||''),legacyProviderOrderId:String(old.provider_order_id||''),legacyProviderName:String(old.provider_name||''),free:!!old.is_free,remains:old.remains??null,startCount:old.start_count??null,createdAt:String(old.created_date||''),updatedAt:String(old.updated_date||old.created_date||''),legacyHistory:true,readOnly:true,legacyImportKey:String(old.id),legacyOrderId:String(old.id),legacyOrderNumber:String(old.order_number||''),legacyUserId:String(old.user_id||''),legacyEmailHash:legacyUser?.email?sha256(normalizeEmail(legacyUser.email)):'' ,legacySource:'Base44 export'};
}
function legacyTransactionPrivateRow(t){return {id:String(t?.id||''),user_id:String(t?.user_id||''),user_name:String(t?.user_name||'').slice(0,160),amount:Number.isFinite(Number(t?.amount))?Number(t.amount):0,type:String(t?.type||'').slice(0,40),reason:String(t?.reason||'').slice(0,300),balance_after:Number.isFinite(Number(t?.balance_after))?Number(t.balance_after):0,order_id:String(t?.order_id||''),created_date:String(t?.created_date||'')};}
async function persistLegacyTransactionsRemote(rows,sourceId=LEGACY_SEED_ID){
  const clean=(Array.isArray(rows)?rows:[]).map(legacyTransactionPrivateRow).filter(t=>t.id);
  const transactions={};for(const t of clean)transactions['t_'+crypto.createHash('sha256').update(t.id).digest('hex').slice(0,32)]=t;
  const record={schemaVersion:1,source:'base44-export',sourceId,count:clean.length,updatedAt:nowISO(),transactions};
  await firebaseWriteJson(LEGACY_TRANSACTIONS_REMOTE_PATH,record,18000);
  const check=await firebaseGetJson(LEGACY_TRANSACTIONS_REMOTE_PATH,12000);
  const count=Number(check?.count||Object.keys(check?.transactions||{}).length||0);
  if(count!==clean.length)throw new Error('عدد معاملات Base44 المحفوظة لا يطابق الملف ('+count+'/'+clean.length+').');
  return {count,updatedAt:record.updatedAt};
}
async function readLegacyStage(){const stage=readJSON(LEGACY_STAGE_FILE,null);if(!stage||stage.version!==1||!Array.isArray(stage.users)||!Array.isArray(stage.orders))return null;return stage;}
async function getLegacyRemoteSnapshot(){let remoteUsers,remoteOrders;try{[remoteUsers,remoteOrders]=await Promise.all([firebaseGetJson('users',12000),firebaseGetJson('orders',15000)]);}catch(e){throw Object.assign(new Error('تعذر الوصول إلى قاعدة Firebase الحية؛ لم يتم تغيير أي بيانات. '+String(e.message||e).slice(0,140)),{statusCode:503});}return {remoteUsers:remoteUsers||{},remoteOrders:remoteOrders||{}};}
function createLegacyPlan(stage,remoteUsers,remoteOrders){
  const directory=normalizeCurrentUsers(remoteUsers),mapped=mapLegacyUsersToCurrent(stage.users,directory),remoteOrderRows=collectionEntries(remoteOrders).filter(([,o])=>o&&typeof o==='object'&&!o.event),legacyById=new Map();
  for(const [k,o] of remoteOrderRows)if(o.legacyHistory&&o.legacyImportKey)legacyById.set(String(o.legacyImportKey),{key:k,order:o});
  const liveRows=remoteOrderRows.filter(([,o])=>!o.legacyHistory);const liveNumbers=new Set();for(const [,o] of liveRows){for(const n of [o.publicOrderNo,o.id,o.order_id])if(n!==undefined&&n!==null&&String(n).trim())liveNumbers.add(String(n).trim());}
  const numberCounts=new Map();for(const o of stage.orders){const n=String(o.order_number||'').trim();if(n)numberCounts.set(n,(numberCounts.get(n)||0)+1);}
  const allocated=new Set(),upserts={},balanceCandidates=[],oldUserById=new Map(stage.users.map(u=>[String(u.id),u])),legacyOrderCountsByUsername={};let alreadyImported=0,liveDuplicates=0,unmatchedOrderUsers=0;
  for(const old of stage.orders){const oldId=String(old.id),oldUser=oldUserById.get(String(old.user_id));const matched=mapped.byLegacyId.get(String(old.user_id))||null;const existing=legacyById.get(oldId);if(existing)alreadyImported++;
    if(!existing&&legacyOrderMatchesLive(old,matched?.username,liveRows)){liveDuplicates++;continue;}
    const pub=existing?String(existing.order.publicOrderNo||existing.order.id||legacyPublicOrderNumber(old,numberCounts,liveNumbers,allocated)):legacyPublicOrderNumber(old,numberCounts,liveNumbers,allocated);const row=buildLegacyOrderRecord(old,oldUser,matched,directory,pub);
    if(!matched)unmatchedOrderUsers++;
    if(matched)legacyOrderCountsByUsername[matched.username]=(legacyOrderCountsByUsername[matched.username]||0)+1;
    if(existing){upserts[existing.key]={...existing.order,...row,legacyImportKey:oldId,legacyHistory:true,readOnly:true,legacyCountedForUser:!!matched,legacyImportedAt:existing.order.legacyImportedAt||nowISO()};}
    else upserts[legacyStableFirebaseKey(oldId)]={...row,legacyCountedForUser:!!matched,legacyImportedAt:nowISO()};
  }
  const localLedger=readJSON('balance_ledger.json',[]),localPayments=readJSON('payments.json',[]);const existingOrderCounts=new Map();for(const [,o] of liveRows){const u=String(o.user||o.username||'');if(u)existingOrderCounts.set(u,(existingOrderCounts.get(u)||0)+1);}
  let matchedPositiveBalances=0,unmatchedPositiveBalances=0,balancesAlreadyRestored=0,balanceSkippedExisting=0,negativeBalancesSkipped=0;const balanceRestorePlan=[];
  for(const old of stage.users){const oldBalance=Number(old.balance||0);if(oldBalance<0){negativeBalancesSkipped++;continue;}if(oldBalance<=0)continue;const matched=mapped.byLegacyId.get(String(old.id));if(!matched){unmatchedPositiveBalances++;continue;}if(matched.user.legacyBalanceRestoredFromBase44===true){balancesAlreadyRestored++;continue;}
    const bal=Number(matched.user.balance);const hasBalance=matched.user.balance!==undefined&&matched.user.balance!==null&&matched.user.balance!=='';const activeOrders=Number(existingOrderCounts.get(matched.username)||0)>0;const activeTotals=Number(matched.user.totalOrders||0)>0||Number(matched.user.totalSpent||0)>0;const ledgerActivity=localLedger.some(x=>String(x?.user||'')===matched.username)||localPayments.some(x=>String(x?.user||x?.username||'')===matched.username);const active=activeOrders||activeTotals||ledgerActivity;
    if((hasBalance&&Math.abs(bal)>0.000001)||active){balanceSkippedExisting++;continue;}
    balanceRestorePlan.push({old,matched,balanceUsd:oldBalance,balanceIQD:Number((oldBalance*FIXED_RATE).toFixed(4))});matchedPositiveBalances++;
  }
  return {directory,mapped,remoteOrderRows,liveRows,upserts,alreadyImported,liveDuplicates,unmatchedOrderUsers,legacyOrderCountsByUsername,matchedUsers:mapped.matchedIds.size,unmatchedUsers:stage.users.length-mapped.matchedIds.size,balanceRestorePlan,matchedPositiveBalances,unmatchedPositiveBalances,balancesAlreadyRestored,balanceSkippedExisting,negativeBalancesSkipped,legacyUserById:oldUserById,counts:{users:stage.users.length,orders:stage.orders.length,transactions:Number(stage.transactionCount||stage.transactions?.length||0)}};
}
function legacyAccountUsername(old,usedNames){
  const isValid=v=>/^[A-Za-z0-9]{5,32}$/.test(String(v||''))&&!usedNames.has(String(v).toLowerCase())&&String(v).toLowerCase()!==ADMIN_USER.toLowerCase();
  const candidates=[String(old?.user_code||'').trim(),String(old?.email||'').trim().split('@')[0]];
  for(const candidate of candidates){if(isValid(candidate)){usedNames.add(candidate.toLowerCase());return candidate;}}
  const base='b44'+sha256(String(old?.id||old?.email||'legacy-user')).slice(0,20);
  let candidate=base.slice(0,32),n=0;while(!isValid(candidate)){n++;candidate=('b44'+sha256(String(old?.id||'')+'|'+n).slice(0,20)).slice(0,32);}usedNames.add(candidate.toLowerCase());return candidate;
}
async function ensureLegacyUserAccounts(legacyUsers,remoteUsers){
  const directory=normalizeCurrentUsers(remoteUsers||{}),usedNames=new Set(directory.users.map(x=>x.username.toLowerCase()));
  const mapped=mapLegacyUsersToCurrent(legacyUsers,directory),patch={},created=[];
  for(const old of legacyUsers){
    const oldId=String(old?.id||'').trim();if(!oldId)continue;
    const matched=mapped.byLegacyId.get(oldId);
    if(matched)continue; // Never overwrite a current user matched by unique email or user code.
    const email=normalizeEmail(old.email||'');
    // The export has unique emails; reserve them to prevent collisions during one-time seeding.
    const username=legacyAccountUsername(old,usedNames);
    const sourceBalance=Number(old.balance||0);const balanceIQD=Number((sourceBalance*FIXED_RATE).toFixed(4));
    const profile={
      username,
      name:String(old.arabic_name||old.full_name||email.split('@')[0]||username).slice(0,100),
      email,
      emailVerified:false,
      authProvider:'legacy-import',
      passwordHash:'',
      needsPasswordSetup:true,
      passwordSetupRequired:true,
      balance:balanceIQD,
      level:'مبتدئ',
      telegram:'',
      telegramUserId:String(old.telegram_user_id||''),
      phone:String(old.phone||''),
      joined:String(old.created_date||nowISO()),
      totalSpent:0,
      totalOrders:0,
      role:'user',
      status:String(old.status||'active'),
      isDisabled:/^(disabled|inactive|blocked|suspended)$/i.test(String(old.status||'')),
      freePoints:Math.max(0,Number(old.free_points||0)||0),
      free_points:Math.max(0,Number(old.free_points||0)||0),
      userCode:String(old.user_code||''),
      referralCode:String(old.referral_code||''),
      referredBy:String(old.referred_by||''),
      customDiscount:Number(old.custom_discount||0)||0,
      legacyBase44UserId:oldId,
      legacyBase44OriginalBalanceUSD:sourceBalance,
      legacyBalanceRestoredFromBase44:true,
      legacyOriginalRole:String(old.role||'user'),
      legacySource:'Base44 database export',
      createdAt:String(old.created_date||nowISO()),
      updatedAt:nowISO()
    };
    patch[firebaseSafeKey(username)]=profile;created.push({username,email,id:oldId});
  }
  const entries=Object.entries(patch);let written=0;
  for(let i=0;i<entries.length;i+=75){
    const chunk=Object.fromEntries(entries.slice(i,i+75));
    await firebasePatchJson('users',chunk,20000);written+=Object.keys(chunk).length;
  }
  if(written){
    const verify=await firebaseGetJson('users',20000);
    const verifyDirectory=normalizeCurrentUsers(verify||{});
    const present=new Set(verifyDirectory.users.map(x=>x.username.toLowerCase()));
    const missing=created.filter(x=>!present.has(x.username.toLowerCase()));
    if(missing.length)throw new Error('تم حفظ بعض الحسابات القديمة لكن فشل التحقق من '+missing.length+' حساباً؛ أعد التشغيل لإكمال الدمج دون تكرار.');
  }
  return {created:written,alreadyMapped:legacyUsers.length-created.length,verified:true};
}
async function applyLegacyStage(stage,{bundledSeed=false}={}){
  const before=await getLegacyRemoteSnapshot();
  const accounts=await ensureLegacyUserAccounts(stage.users,before.remoteUsers);
  const remote=accounts.created?await getLegacyRemoteSnapshot():before;
  const plan=createLegacyPlan(stage,remote.remoteUsers,remote.remoteOrders);
  let ordersWritten=0;
  if(Object.keys(plan.upserts).length){await firebasePatchJson('orders',plan.upserts,30000);ordersWritten=Math.max(0,Object.keys(plan.upserts).length-plan.alreadyImported);}
  writeJSON(LEGACY_USERS_PRIVATE_FILE,stage.users.map(legacyUserPrivateRow));
  const savedIndex=await persistLegacyUsersRemote(stage.users);
  let transactionsSaved=false,transactionsSavedCount=0;
  if(Array.isArray(stage.transactions)&&stage.transactions.length){
    const tx=await persistLegacyTransactionsRemote(stage.transactions,stage.seedSourceId||LEGACY_SEED_ID);
    writeJSON(LEGACY_TRANSACTIONS_PRIVATE_FILE,stage.transactions.map(legacyTransactionPrivateRow));
    transactionsSaved=true;transactionsSavedCount=tx.count;
  } else {
    try{const tx=await firebaseGetJson(LEGACY_TRANSACTIONS_REMOTE_PATH,6000);transactionsSaved=Number(tx?.count||0)>0;transactionsSavedCount=Number(tx?.count||0)}catch(_){}
  }
  let balancesRestored=0,balanceWriteErrors=0,orderCountersUpdated=0,orderCounterWriteErrors=0;
  const counterUpdates=[];
  for(const [username,targetCountRaw] of Object.entries(plan.legacyOrderCountsByUsername||{})){
    const matched=plan.directory.users.find(x=>x.username===username);if(!matched)continue;
    const targetCount=Math.max(Number(matched.user.legacyBase44OrdersCount||0),Number(targetCountRaw||0));
    const previouslyCounted=Math.max(0,Number(matched.user.legacyBase44OrdersCount||0));
    const delta=Math.max(0,targetCount-previouslyCounted);const totalBefore=Math.max(0,Number(matched.user.totalOrders||0)||0);
    if(delta===0&&Number(matched.user.legacyBase44OrdersCount||0)===targetCount)continue;
    counterUpdates.push({matched,targetCount,newTotalOrders:totalBefore+delta});
  }
  for(let i=0;i<counterUpdates.length;i+=12){
    const chunk=counterUpdates.slice(i,i+12),settled=await Promise.allSettled(chunk.map(async item=>{const patch={totalOrders:item.newTotalOrders,legacyBase44OrdersCount:item.targetCount,legacyOrdersCounterUpdatedAt:nowISO(),updatedAt:nowISO()};await firebasePatchJson('users/'+item.matched.key,patch,9000);return true;}));
    for(const r of settled){if(r.status==='fulfilled')orderCountersUpdated++;else orderCounterWriteErrors++;}
  }
  for(let i=0;i<plan.balanceRestorePlan.length;i+=8){
    const chunk=plan.balanceRestorePlan.slice(i,i+8),settled=await Promise.allSettled(chunk.map(async item=>{const patch={balance:item.balanceIQD,legacyBase44UserId:String(item.old.id),legacyBalanceOriginalUSD:item.balanceUsd,legacyBalanceRestoredFromBase44:true,legacyBalanceRestoredAt:nowISO(),updatedAt:nowISO()};await firebasePatchJson('users/'+item.matched.key,patch,9000);return true;}));
    for(const r of settled){if(r.status==='fulfilled')balancesRestored++;else balanceWriteErrors++;}
  }
  const finalReport={completedAt:nowISO(),sourceFile:stage.sourceFile||'SadaIraq_Database_Export.zip',counts:plan.counts,matchedUsers:plan.matchedUsers,unmatchedUsers:plan.unmatchedUsers,accountProfilesCreated:accounts.created,accountProfilesAlreadyMatched:accounts.alreadyMapped,ordersWritten,ordersAlreadyImported:plan.alreadyImported,duplicatesAlreadyInLiveDatabase:plan.liveDuplicates,unmatchedOrderUsers:plan.unmatchedOrderUsers,orderCountersUpdated,orderCounterWriteErrors,balancesRestored,balanceWriteErrors,unmatchedPositiveBalances:plan.unmatchedPositiveBalances,balanceSkippedExisting:plan.balanceSkippedExisting,negativeBalancesSkipped:plan.negativeBalancesSkipped,balancesAlreadyRestored:plan.balancesAlreadyRestored,exchangeRate:FIXED_RATE,legacyUsersRemoteSaved:true,legacyUsersRemoteCount:savedIndex.count,legacyTransactionsSaved:transactionsSaved,legacyTransactionsRemoteCount:transactionsSavedCount};
  if(stage.seedSourceId||bundledSeed)finalReport.bundledSeedId=stage.seedSourceId||LEGACY_SEED_ID;
  writeJSON(LEGACY_IMPORT_STATE_FILE,finalReport);
  let importStateRemoteSaved=false;try{await firebaseWriteJson(LEGACY_IMPORT_STATE_REMOTE_PATH,finalReport,10000);importStateRemoteSaved=true;}catch(e){console.warn('Legacy import report cloud persistence failed:',String(e.message||e).slice(0,100));}
  finalReport.importStateRemoteSaved=importStateRemoteSaved;writeJSON(LEGACY_IMPORT_STATE_FILE,finalReport);
  const allDone=!balanceWriteErrors&&!orderCounterWriteErrors&&transactionsSaved&&importStateRemoteSaved;
  if(allDone){try{fs.unlinkSync(path.join(DATA,LEGACY_STAGE_FILE));}catch(_){} }
  const warning=(balanceWriteErrors||orderCounterWriteErrors)?'تم حفظ السجلات، لكن تعذر تحديث بعض الأرصدة أو عدادات الطلبات. ملف الترحيل محفوظ لإعادة المحاولة.':(!transactionsSaved?'لم يتم تأكيد حفظ سجل المعاملات؛ بقي ملف الترحيل محفوظاً لإعادة المحاولة.':(!importStateRemoteSaved?'لم يتم تأكيد حفظ سجل اكتمال الدمج في Firebase؛ بقي ملف الترحيل محفوظاً لإعادة المحاولة.':(plan.unmatchedUsers?'بعض حسابات قاعدة Base44 لا تطابق حساباً حالياً بالبريد؛ بقيت كسجلات تاريخية للعرض ولا يمكنها تسجيل الدخول بكلمة مرور Base44 غير الموجودة بالتصدير.':'تم حفظ السجلات التاريخية دون تكرار، وحُفظت فهارس المستخدمين والطلبات والمعاملات.')));
  return {report:finalReport,warning,allDone};
}

function legacyOrderResponseRecord(order,key){return {...order,source:order.legacyHistory?'legacy':'live',readOnly:!!order.legacyHistory,legacyFirebaseKey:order.legacyHistory?String(key||''):undefined};}

const SADA_DB_BACKUP_FORMAT='sadairaq-full-database-backup';
const SADA_DB_BACKUP_FILES=[
  'users.json','google_accounts.json','orders.json','balance_ledger.json','payments.json',
  'notifications.json','user_notifications.json','earn_requests.json','refunds.json',
  'order_audit_state.json','telegram_order_state.json','telegram_notifications.json',
  'notification_seen.json','stats_state.json','api_services.json','api_refills.json','providers.json',
  'providers.runtime.json','settings.json','provider_failures.json','services.json','quarantined_provider_services.json','free_services.json','manual_services.json','free_service_usage.json','category_meta.json','provider_services.json','catalog_settings.json',
  'legacy_import_staging.json','legacy_import_state.json','legacy_import_users_private.json',
  'legacy_import_transactions_private.json','legacy_seed_bootstrap_status.json'
];
function sanitizeBackupValue(value,pathParts=[]){
  if(Array.isArray(value))return value.map(v=>sanitizeBackupValue(v,pathParts)).filter(v=>v!==undefined);
  if(!value||typeof value!=='object')return value;
  const out={};
  for(const [key,val] of Object.entries(value)){
    const lower=String(key).toLowerCase();
    const path=pathParts.map(x=>String(x).toLowerCase());
    if(/^(?:telegramsecret|providersecrets|secretstore|privatekeys|email_challenges|emailchallenges|sessions|sessionstore)$/.test(lower))continue;
    // Keep only already-hashed application-user passwords so users can still sign in after a migration.
    // Plaintext passwords, temporary auth codes, and administrator/provider secrets are never exported.
    const isPasswordHash=/^(?:passwordhash|passhash|password_hash|pass_hash)$/.test(lower);
    const userScope=path.some(p=>p==='users'||p==='users.json'||p==='legacy_import_users_private.json');
    const looksHashed=typeof val==='string'&&(/^(?:scrypt\$|\$2[aby]\$|pbkdf2\$)/.test(val));
    if(isPasswordHash&&userScope&&looksHashed){out[key]=val;continue;}
    if(/token|secret|password|passhash|privatekey|apikey|providerkey|authorization|cookie|csrf|otp|challenge/i.test(lower))continue;
    // Provider credentials are never exported as part of a portable data backup.
    if(lower==='key' && path.some(p=>p.includes('provider')||p.includes('api_keys')||p.includes('apikey')))continue;
    const next=sanitizeBackupValue(val,[...pathParts,key]);
    if(next!==undefined)out[key]=next;
  }
  return out;
}
function backupStableKey(row){
  if(!row||typeof row!=='object')return String(row);
  for(const key of ['id','username','email','reference','orderId','order_id','legacyImportKey','eventId','refundEventId'])if(row[key]!==undefined&&row[key]!==null&&String(row[key]).trim())return key+':'+String(row[key]);
  return JSON.stringify(row);
}
function mergeBackupPreservingExisting(current,incoming){
  if(incoming===undefined)return current;
  if(current===undefined||current===null)return JSON.parse(JSON.stringify(incoming));
  if(Array.isArray(current)&&Array.isArray(incoming)){
    const out=current.map(v=>v&&typeof v==='object'?JSON.parse(JSON.stringify(v)):v);
    const index=new Map();out.forEach((row,i)=>index.set(backupStableKey(row),i));
    for(const row of incoming){
      const k=backupStableKey(row);
      if(index.has(k)){
        const i=index.get(k);
        if(out[i]&&row&&typeof out[i]==='object'&&typeof row==='object'&&!Array.isArray(out[i])&&!Array.isArray(row))out[i]=mergeBackupPreservingExisting(out[i],row);
      }else{out.push(row&&typeof row==='object'?JSON.parse(JSON.stringify(row)):row);index.set(k,out.length-1)}
    }
    return out;
  }
  if(current&&incoming&&typeof current==='object'&&typeof incoming==='object'&&!Array.isArray(current)&&!Array.isArray(incoming)){
    const out={...incoming};
    for(const [k,v] of Object.entries(current))out[k]=Object.prototype.hasOwnProperty.call(incoming,k)?mergeBackupPreservingExisting(v,incoming[k]):v;
    return out;
  }
  // Preserve live values, balances and statuses if the target already has a value.
  return current;
}
async function readAdminBackupBody(req,limit=64*1024*1024){
  const parts=[];let total=0;
  for await(const chunk of req){total+=chunk.length;if(total>limit)throw Object.assign(new Error('ملف النسخة الاحتياطية يتجاوز 64 ميغابايت.'),{statusCode:413});parts.push(chunk);}
  let parsed;try{parsed=JSON.parse(Buffer.concat(parts,total).toString('utf8'))}catch(_){throw Object.assign(new Error('ملف النسخة الاحتياطية ليس JSON صالحاً.'),{statusCode:400});}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Object.assign(new Error('صيغة ملف النسخة الاحتياطية غير صحيحة.'),{statusCode:422});
  return parsed;
}
async function readFirebaseRootForBackup(timeoutMs=30000){
  const data=await firebaseGetJson('/',timeoutMs);
  return data&&typeof data==='object'&&!Array.isArray(data)?data:{};
}
async function patchFirebaseRootForBackup(partial,timeoutMs=60000){
  const data=await firebasePatchJson('/',partial,timeoutMs);
  return data&&typeof data==='object'&&!Array.isArray(data)?data:partial;
}
function currentDatabaseCounts(firebaseRoot,localFiles){
  const count=v=>Array.isArray(v)?v.length:(v&&typeof v==='object'?Object.keys(v).length:0);
  const legacy=firebaseRoot?.config?.base44LegacyUsers||{};
  const legacyTx=firebaseRoot?.config?.base44LegacyTransactions||{};
  const legacyUserCount=Number(legacy.count||count(legacy.users));
  const orderCount=uniqueActualOrders(firebaseRoot?.orders,localFiles?.['orders.json']||[]).length;
  return {currentUsers:count(firebaseRoot?.users),orders:orderCount,legacyUsers:legacyUserCount,legacyTransactions:Number(legacyTx.count||count(legacyTx.transactions)),firebaseTopLevelNodes:count(firebaseRoot),localDataFiles:count(localFiles)};
}

async function adjustAdminUserBalance(username,type,amountUsd,reason,adminName,preferredFirebaseKey='',email=''){
  const wanted=String(username||'').trim(),normalizedEmail=normalizeEmail(email);
  if(!wanted||(normalizedEmail&&!validEmail(normalizedEmail)))return {error:normalizedEmail?'email-invalid':'user-not-found'};
  let remote;
  try{remote=await resolveAdminWalletUser(wanted,normalizedEmail,preferredFirebaseKey)}
  catch(e){throw new Error('تعذر تحديد سجل المستخدم بأمان في Firebase: '+String(e.message||e).slice(0,140));}
  if(!remote?.firebasePath){
    const lookup=await inspectAdminWalletLookup(wanted,normalizedEmail,preferredFirebaseKey);
    console.warn('Admin balance adjustment lookup failed:',{username:wanted,emailProvided:!!normalizedEmail,preferredFirebaseKeyProvided:!!String(preferredFirebaseKey||'').trim(),lookup});
    return {error:'user-not-found',lookup};
  }
  const tx=await firebaseTransaction(remote.firebasePath,current=>{
    if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-not-found'}};
    const currentEmail=firebaseRecordEmail(current);
    if(validEmail(normalizedEmail)&&currentEmail&&currentEmail!==normalizedEmail)return {write:false,result:{error:'email-mismatch'}};
    const before=Number(current.balance||0);if(!Number.isFinite(before)||before<0)return {write:false,result:{error:'invalid-balance'}};
    const amountIQD=type==='clear'?before:Number((Number(amountUsd)*FIXED_RATE).toFixed(4));
    if(type==='deduct'&&amountIQD>before)return {write:false,result:{error:'insufficient-balance',balanceIQD:before}};
    const delta=type==='charge'?amountIQD:type==='deduct'?-amountIQD:-before;const after=Number(Math.max(0,before+delta).toFixed(4));const createdAt=nowISO();
    const event={id:'BAL_'+crypto.randomUUID().replace(/-/g,''),username:remote.username||wanted,user:remote.username||wanted,email:normalizedEmail||currentEmail||'',firebaseKey:String(remote.firebasePath.split('/').slice(1).join('/')),type,amountIQD:Number(Math.abs(delta).toFixed(4)),amountUSD:Number((Math.abs(delta)/FIXED_RATE).toFixed(6)),beforeIQD:before,afterIQD:after,reason:String(reason||'').slice(0,500),admin:String(adminName||ADMIN_USER),createdAt,method:'admin'};
    const history=Array.isArray(current.adminBalanceLedger)?current.adminBalanceLedger.slice(-199):[];history.push(event);current.balance=after;current.adminBalanceLedger=history;current.updatedAt=createdAt;
    return {write:true,value:current,result:{event,balanceIQD:after,updatedUser:current}};
  },12000,8);
  if(tx.result?.error)return tx.result;
  const ev=tx.result.event;let ledgerSaved=true,ledgerError='';try{await firebaseWriteJson('balanceLedger/'+ev.id,ev,8000)}catch(e){ledgerSaved=false;ledgerError=String(e.message||e).slice(0,100)}
  appendJsonLedger('balance_ledger.json',ev);
  const store=readJSON('users.json',{users:{}}),users=store.users||{},localKeys=Object.keys(users);
  const localKey=(validEmail(normalizedEmail)?localKeys.find(k=>firebaseRecordEmail(users[k])===normalizedEmail):'')||localKeys.find(k=>String(users[k]?.username||k).trim().toLowerCase()===String(remote.username||wanted).toLowerCase())||localKeys.find(k=>k.toLowerCase()===String(remote.username||wanted).toLowerCase())||String(remote.username||wanted);
  const effectiveEmail=normalizedEmail||firebaseRecordEmail(tx.result.updatedUser||remote.user)||firebaseRecordEmail(users[localKey])||'';
  users[localKey]={...(users[localKey]||{}),...(tx.result.updatedUser||remote.user||{}),username:String(users[localKey]?.username||remote.username||localKey),email:effectiveEmail,balance:tx.result.balanceIQD,updatedAt:ev.createdAt};store.users=users;writeJSON('users.json',store);
  return {ok:true,event:ev,balanceIQD:tx.result.balanceIQD,balanceUSD:Number((tx.result.balanceIQD/FIXED_RATE).toFixed(6)),email:effectiveEmail,ledgerSaved,ledgerWarning:ledgerSaved?'':('تم تحديث الرصيد، لكن تعذر تسجيل نسخة سجل التدقيق: '+ledgerError)};
}

// Idempotently reconcile a provider order with the user's account counters.
// The unique marker lives on the user record, so retrying an accepted request cannot count it twice.
async function finalizeProviderOrderAccounting(username,localId,amountIQD,createdAt){
  const uname=String(username||'').trim(),id=String(localId||'').trim();if(!uname||!id)return {ok:false,skipped:true};
  const remote=await findRemoteUserByUsername(uname);if(!remote?.firebasePath)return {ok:false,error:'user-record-not-found'};
  const marker=sha256(id+'|'+uname).slice(0,40),amount=Math.max(0,Number(amountIQD)||0),at=String(createdAt||nowISO());
  const tx=await firebaseTransaction(remote.firebasePath,current=>{
    if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-record-not-found'}};
    const seen=current.sadaOrderAccounting&&typeof current.sadaOrderAccounting==='object'?{...current.sadaOrderAccounting}:{};
    const reservations=current.sadaOrderReservations&&typeof current.sadaOrderReservations==='object'?{...current.sadaOrderReservations}:{};
    if(seen[marker]){
      if(reservations[marker]){delete reservations[marker];current.sadaOrderReservations=reservations;current.updatedAt=nowISO();return {write:true,value:current,result:{alreadyCounted:true}};}
      return {write:false,result:{alreadyCounted:true}};
    }
    const reserved=reservations[marker];const finalAmount=Math.max(0,Number(reserved?.amountIQD??amount)||0);
    current.totalSpent=Number((Math.max(0,Number(current.totalSpent)||0)+finalAmount).toFixed(4));
    current.totalOrders=Math.max(0,Math.floor(Number(current.totalOrders)||0))+1;
    seen[marker]={localId:id,amountIQD:finalAmount,createdAt:at,countedAt:nowISO()};
    const entries=Object.entries(seen).sort((a,b)=>(Date.parse(a[1]?.countedAt||a[1]?.createdAt||0)||0)-(Date.parse(b[1]?.countedAt||b[1]?.createdAt||0)||0));
    while(entries.length>1500){const [key]=entries.shift();delete seen[key];}
    delete reservations[marker];current.sadaOrderAccounting=seen;current.sadaOrderReservations=reservations;current.updatedAt=nowISO();
    return {write:true,value:current,result:{counted:true,totalSpent:current.totalSpent,totalOrders:current.totalOrders}};
  },12000,8);
  if(tx.result?.error)return {ok:false,error:tx.result.error};
  return {ok:true,alreadyCounted:!!tx.result?.alreadyCounted,totalSpent:tx.value?.totalSpent??tx.result?.totalSpent,totalOrders:tx.value?.totalOrders??tx.result?.totalOrders};
}

function normalizeTelegramChannelUrl(value){
  try{const u=new URL(String(value||'').trim());if(u.protocol!=='https:'||!['t.me','telegram.me'].includes(u.hostname.toLowerCase())||u.username||u.password||u.port||u.pathname==='/'||u.pathname.length>200)return '';u.hostname='t.me';u.hash='';return u.toString().replace(/\/$/,'');}catch(_){return '';}
}
function isValidTelegramChannelUrl(value){return !!normalizeTelegramChannelUrl(value);}

async function reserveManualSupportUsageAndWallet(username,userPath,serviceKey,limit,localId,amountIQD,siteServiceId){
  const uname=String(username||'').trim(),path=String(userPath||'').trim(),requestId=String(localId||'').trim(),svcKey=String(serviceKey||'').trim();
  if(!uname||!path||!requestId||!svcKey)return {ok:false,error:'تعذر تثبيت حساب المستخدم وبيانات الخدمة في Firebase.'};
  const marker=sha256(requestId+'|'+uname).slice(0,40),usageKey=sha256(svcKey).slice(0,40),now=Date.now(),at=new Date(now).toISOString(),windowMs=24*60*60*1000,max=Math.max(0,Math.min(100,Math.floor(Number(limit)||0))),amount=Math.max(0,Number(amountIQD)||0);
  let tx;
  try{
    tx=await firebaseTransaction(path,current=>{
      if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-record-not-found'}};
      const reservations=current.sadaOrderReservations&&typeof current.sadaOrderReservations==='object'&&!Array.isArray(current.sadaOrderReservations)?{...current.sadaOrderReservations}:{};
      if(reservations[marker])return {write:false,result:{duplicate:true,state:String(reservations[marker].state||'reserved')}};
      const src=current.sadaManualSupportUsage&&typeof current.sadaManualSupportUsage==='object'&&!Array.isArray(current.sadaManualSupportUsage)?current.sadaManualSupportUsage:{};
      const usage={...src};let rows=(Array.isArray(usage[usageKey])?usage[usageKey]:[]).filter(x=>x&&typeof x==='object'&&Number.isFinite(Date.parse(x.at||''))&&now-Date.parse(x.at||'')<windowMs);
      if(rows.some(x=>String(x.requestId||'')===requestId))return {write:false,result:{duplicate:true,state:'usage-reserved'}};
      if(max>0&&rows.length>=max){const first=rows.map(x=>Date.parse(x.at||'')).filter(Number.isFinite).sort((a,b)=>a-b)[0]||now;return {write:false,result:{limit:max,nextAllowedAt:new Date(first+windowMs).toISOString()}};}
      const balance=Number(current.balance??current.balanceIQD??0);
      if(!Number.isFinite(balance)||balance<amount)return {write:false,result:{insufficient:true,balanceIQD:Number.isFinite(balance)?balance:0}};
      current.balance=Number((balance-amount).toFixed(4));
      reservations[marker]={localId:requestId,amountIQD:amount,state:'reserved',createdAt:at,providerId:'manual-support',siteServiceId:String(siteServiceId),serviceKind:'manual_support'};
      current.sadaOrderReservations=reservations;
      if(max>0){rows.push({requestId,at,state:'reserved'});usage[usageKey]=rows.slice(-200);current.sadaManualSupportUsage=usage;}
      current.updatedAt=at;
      return {write:true,value:current,result:{reserved:true,balanceBeforeIQD:balance,balanceAfterIQD:current.balance,marker,usageKey}};
    },12000,8);
  }catch(e){console.warn('manual support wallet reservation failed:',String(e.message||e).slice(0,150));return {ok:false,storageUnavailable:true,error:'تعذر حفظ حجز الطلب في Firebase؛ لم يتم إنشاء الطلب أو خصم الرصيد بشكل مؤكد.'};}
  const result=tx?.result||{};
  if(result.error)return {ok:false,error:'لم يُعثر على سجل المستخدم في Firebase.'};
  if(result.duplicate)return {ok:false,duplicate:true,error:'يوجد طلب بنفس رقم التتبع قيد المعالجة؛ لم يُخصم رصيد إضافي.'};
  if(result.limit)return {ok:false,limit:result.limit,nextAllowedAt:result.nextAllowedAt,error:'وصلت إلى الحد المسموح لهذه الخدمة خلال 24 ساعة. حاول بعد '+new Date(result.nextAllowedAt).toLocaleString('en-GB',{timeZone:'Asia/Baghdad',hour12:false})+' بتوقيت بغداد.'};
  if(result.insufficient)return {ok:false,insufficient:true,balanceIQD:result.balanceIQD,error:'رصيدك غير كافٍ لتكلفة هذه الخدمة.'};
  if(!result.reserved)return {ok:false,error:'تعذر تأكيد إنشاء الطلب؛ لم يتم إرسال طلب إلى مزود ولم نعتبره ناجحاً.'};
  return {ok:true,marker,usageKey,balanceBeforeIQD:result.balanceBeforeIQD,balanceAfterIQD:result.balanceAfterIQD,amountIQD:amount};
}
async function releaseManualSupportUsageAndWallet(userPath,username,serviceKey,localId){
  const path=String(userPath||'').trim(),uname=String(username||'').trim(),requestId=String(localId||'').trim(),svcKey=String(serviceKey||'').trim();if(!path||!uname||!requestId||!svcKey)return {ok:false};
  const marker=sha256(requestId+'|'+uname).slice(0,40),usageKey=sha256(svcKey).slice(0,40);
  try{
    const tx=await firebaseTransaction(path,current=>{
      if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{missing:true}};
      const reservations=current.sadaOrderReservations&&typeof current.sadaOrderReservations==='object'&&!Array.isArray(current.sadaOrderReservations)?{...current.sadaOrderReservations}:{};
      const reservation=reservations[marker];if(!reservation)return {write:false,result:{missing:true}};
      const amount=Math.max(0,Number(reservation.amountIQD)||0),balance=Number(current.balance??current.balanceIQD??0);
      current.balance=Number((balance+amount).toFixed(4));delete reservations[marker];current.sadaOrderReservations=reservations;
      const src=current.sadaManualSupportUsage&&typeof current.sadaManualSupportUsage==='object'&&!Array.isArray(current.sadaManualSupportUsage)?{...current.sadaManualSupportUsage}:{};
      if(Array.isArray(src[usageKey])){const rows=src[usageKey].filter(x=>String(x?.requestId||'')!==requestId);if(rows.length)src[usageKey]=rows;else delete src[usageKey];current.sadaManualSupportUsage=src;}
      current.updatedAt=nowISO();return {write:true,value:current,result:{released:true,amountIQD:amount,balanceIQD:current.balance}};
    },12000,8);
    if(tx?.result?.released){if(tx.result.amountIQD>0)appendJsonLedger('balance_ledger.json',{user:uname,type:'refund',amountUSD:Number((tx.result.amountIQD/FIXED_RATE).toFixed(6)),amountIQD:tx.result.amountIQD,beforeIQD:null,afterIQD:tx.result.balanceIQD,reason:'إلغاء حجز خدمة يدوية لأن الطلب لم يُحفظ',admin:'system-manual-support',reference:requestId,createdAt:nowISO()});return {ok:true,released:true};}
    return {ok:true,alreadyReleased:true};
  }catch(e){console.error('manual support reservation release failed:',String(e.message||e).slice(0,150));return {ok:false,error:String(e.message||e)};}
}
async function handleManualSupportOrder(req,res,b,username,orderSession){
  const providerId=String(b.providerId||'').trim();let serviceKey=String(b.manualServiceKey||b.adminManualServiceKey||'').trim();const serviceKind=String(b.serviceKind||'').trim();
  const isManual=serviceKind==='manual_support'||b.manualService===true||providerId==='manual-support';
  if(!isManual)return null;
  const supportWhatsappUrl=normalizeWhatsAppUrl(readJSON('settings.json',{}).waUrl||readJSON('settings.json',{}).waNum||'https://wa.me/9647762267959');
  const localId=String(b.localId||'').trim(),requestedSiteId=String(b.siteServiceId||b.serviceId||b.catalogServiceId||'').trim();
  // Some legacy catalog rows do not expose their Firebase key after the picker normalizes them.
  // Resolve by the site's internal ID, but only among records with no actual upstream provider.
  const isProviderlessCatalogRow=(row)=>{
    if(!row||typeof row!=='object'||Array.isArray(row)||row.deleted===true||row.enabled===false||row.adminFreeService===true)return false;
    const pid=String(row.providerId||'').trim();
    const externalId=String(row.smmpartyId||row.providerServiceId||row.provider_service_id||row.smmServiceId||row.supplierServiceId||'').trim();
    const source=String(row.source||row.providerType||'').trim().toLowerCase();
    if(pid&&pid!=='manual-support')return false;
    if(externalId)return false;
    if(['smmparty','provider_catalog','provider','external-provider','imported_provider','provider-import'].includes(source))return false;
    return true;
  };
  if(!serviceKey&&requestedSiteId){
    try{const all=catalogReadPath('services').value||{};const hit=Object.entries(all).find(([key,row])=>isProviderlessCatalogRow(row)&&String(row.siteServiceId||row.internalServiceId||row.sadaServiceId||row.id||'').trim()===requestedSiteId);if(hit)serviceKey=String(hit[0]);}catch(_){}
  }
  if(!localId||localId.length>100||!/^[A-Za-z0-9_-]+$/.test(localId))return {status:422,body:{ok:false,error:'رقم تتبع الطلب غير صالح.',stage:'manual_validate'}};
  const ownedLocal=(readJSON('orders.json',[])||[]).find(o=>String(o.user||o.username||'')===username&&String(o.localId||'')===localId&&String(o.serviceKind||'')==='manual_support');
  let oldOrder=ownedLocal||null;
  if(!oldOrder){try{const remoteOrder=await firebaseGetJson('orders/'+firebaseSafeKey(localId),5000);if(remoteOrder&&String(remoteOrder.user||remoteOrder.username||'')===username&&String(remoteOrder.localId||'')===localId&&String(remoteOrder.serviceKind||'')==='manual_support')oldOrder=remoteOrder;}catch(_){} }
  if(oldOrder){
    if(serviceKey&&String(oldOrder.manualServiceKey||'')!==serviceKey)return {status:409,body:{ok:false,error:'رقم التتبع مستخدم مسبقاً لطلب خدمة مختلفة.',stage:'manual_duplicate'}};
    const supportMessage=String(oldOrder.supportMessage||manualSupportMessage(oldOrder));
    return {status:200,body:{ok:true,idempotent:true,siteOrderId:String(oldOrder.id||localId),publicOrderNo:String(oldOrder.publicOrderNo||''),siteServiceId:String(oldOrder.siteServiceId||''),serviceId:String(oldOrder.siteServiceId||''),serviceName:String(oldOrder.serviceName||'خدمة خاصة'),providerId:'manual-support',providerName:'التنفيذ عبر الدعم الفني',providerOrderId:'',chargeUsd:Number(oldOrder.chargeUsd||0),totalIQD:Number(oldOrder.totalIQD??oldOrder.total??0),createdAt:oldOrder.createdAt||nowISO(),supportWhatsappUrl,supportMessage,order:oldOrder}};
  }
  if(!serviceKey)return {status:422,body:{ok:false,error:'معرّف الخدمة اليدوية مطلوب.',stage:'manual_service_key'}};
  let found=findAdminManualService(serviceKey,requestedSiteId);
  // Services manually created from the primary Admin Services screen live in the normal
  // Firebase catalog. Normalize providerless rows into the server-side manual workflow instead
  // of letting the generic provider order path reject them. Real provider-backed services fail closed.
  if(!found&&serviceKey){
    let candidate=null;
    try{candidate=catalogReadPath('services/'+serviceKey).value;}catch(_){}
    if(!candidate||typeof candidate!=='object'){
      try{candidate=await firebaseGetJson('services/'+firebaseSafeKey(serviceKey),8000);}catch(_){}
    }
    if(isProviderlessCatalogRow(candidate)){
      found={key:serviceKey,row:{...candidate,siteServiceId:String(candidate.siteServiceId||candidate.internalServiceId||candidate.sadaServiceId||candidate.id||''),providerId:'manual-support',serviceKind:'manual_support',manualService:true,adminManualService:true,catalogLocalManual:true}};
    }
  }
  const svc=found?.row;
  if(!found||!svc||found.key!==serviceKey||svc.serviceKind!=='manual_support'||svc.manualService!==true||svc.adminManualService!==true||svc.deleted===true||svc.enabled===false||!isProviderlessCatalogRow(svc))return {status:409,body:{ok:false,error:'الخدمة اليدوية غير متاحة حالياً أو مرتبطة بمزوّد خارجي. حدّث قائمة الخدمات قبل إعادة الطلب.',stage:'manual_service_lookup'}};
  const siteServiceId=String(svc.siteServiceId||svc.id||'').trim();
  if(!siteServiceId|| (requestedSiteId&&requestedSiteId!==siteServiceId))return {status:409,body:{ok:false,error:'معرّف خدمة صدى العراق لا يطابق الخدمة اليدوية المحددة.',stage:'manual_service_id'}};
  const link=String(b.link||'').trim(),quantity=Number(b.quantity);
  if(!link||!Number.isSafeInteger(quantity)||quantity<=0)return {status:422,body:{ok:false,error:'أدخل الرابط والكمية الصحيحة.',stage:'manual_validate'}};
  if(!/^https?:\/\//i.test(link))return {status:422,body:{ok:false,error:'أدخل رابطاً يبدأ بـ https:// أو http://.',stage:'manual_validate'}};
  try{const u=new URL(link);if(!['https:','http:'].includes(u.protocol)||!u.hostname.includes('.')||u.username||u.password)return {status:422,body:{ok:false,error:'الرابط غير صالح.',stage:'manual_validate'}};}catch(_){return {status:422,body:{ok:false,error:'الرابط غير صالح.',stage:'manual_validate'}};}
  const min=Math.max(1,Math.floor(Number(svc.min)||1)),max=Math.max(min,Math.floor(Number(svc.max)||100));
  if(quantity<min||quantity>max)return {status:422,body:{ok:false,error:'الكمية خارج حدود الخدمة المحددة.',stage:'manual_quantity',min,max}};
  const serviceRate=Number(svc.orderPriceUsd??svc.fixedPriceUsd??svc.sellingUsd??svc.rateUsd??((Number(svc.price)||0)/FIXED_RATE));
  if(!Number.isFinite(serviceRate)||serviceRate<0)return {status:409,body:{ok:false,error:'السعر الثابت للطلب غير مضبوط؛ لم يُنشأ الطلب.',stage:'manual_price'}};
  const isAdminSession=orderSession?.role==='admin';let verifiedUser=null,walletUserPath='',localUser=readJSON('users.json',{users:{}}).users?.[username]||{};
  if(!isAdminSession){try{verifiedUser=await findRemoteUserByUsername(username);walletUserPath=String(verifiedUser?.firebasePath||'');}catch(e){return {status:503,body:{ok:false,error:'تعذر التحقق من رصيد المستخدم في Firebase؛ لم يتم إنشاء الطلب.',stage:'manual_wallet_lookup'}};}if(!verifiedUser?.user||!walletUserPath)return {status:503,body:{ok:false,error:'لم يُعثر على سجل رصيد المستخدم في Firebase؛ لم يتم إنشاء الطلب.',stage:'manual_wallet_lookup'}};}
  const userDiscount=Math.max(0,Math.min(100,Number(verifiedUser?.user?.discountPct??verifiedUser?.user?.discount??localUser.discountPct??orderSession?.discountPct??0)||0));
  const billingUnit=Number(svc.max)<1000?100:1000;const calculatedChargeUsd=Number((Math.max(0,serviceRate*(quantity/billingUnit)*(1-userDiscount/100))).toFixed(6));
  const chargedUsd=isAdminSession?0:calculatedChargeUsd,chargeIQD=Number((chargedUsd*FIXED_RATE).toFixed(4));
  let reservation=null;
  if(!isAdminSession){
    reservation=await reserveManualSupportUsageAndWallet(username,walletUserPath,serviceKey,Math.floor(Number(svc.perAccountLimit)||0),localId,chargeIQD,siteServiceId);
    if(!reservation.ok){if(reservation.limit)return {status:429,body:{ok:false,error:reservation.error,stage:'manual_service_limit',limit:reservation.limit,nextAllowedAt:reservation.nextAllowedAt}};if(reservation.insufficient)return {status:402,body:{ok:false,error:reservation.error,stage:'manual_insufficient_balance',balanceIQD:reservation.balanceIQD}};if(reservation.duplicate)return {status:409,body:{ok:false,error:reservation.error,stage:'manual_duplicate',uncertain:true}};return {status:503,body:{ok:false,error:reservation.error||'تعذر حجز الطلب بأمان.',stage:'manual_wallet_reservation'}};}
  }
  let publicOrderNo='';
  try{publicOrderNo=await nextPublicOrderNumber();}
  catch(e){if(reservation?.ok){const rel=await releaseManualSupportUsageAndWallet(walletUserPath,username,serviceKey,localId);if(!rel.ok)return {status:503,body:{ok:false,uncertain:true,error:'تعذر تخصيص رقم الطلب وتعذر تأكيد استرجاع الحجز؛ تواصل مع الدعم قبل إعادة المحاولة.',stage:'manual_release'}};}return {status:503,body:{ok:false,error:'تعذر تخصيص رقم طلب؛ لم يتم حفظ الطلب.',stage:'manual_public_number'}};}
  const createdAt=nowISO(),profile=verifiedUser?.user||localUser||{},siteOrderId=localId;
  const order={id:siteOrderId,localId,publicOrderNo,user:username,userName:String(profile.fullName||profile.displayName||profile.name||profile.userName||profile.username||username),memberId:String(profile.id||profile.userId||profile.user_id||profile.uid||profile.firebaseUid||profile.authUid||username),orderSource:'app',origin:'app',providerId:'manual-support',providerName:'التنفيذ عبر الدعم الفني',providerOrderId:'',providerServiceId:'',serviceId:siteServiceId,siteServiceId,manualServiceKey:serviceKey,serviceKind:'manual_support',manualSupport:true,manualSupportStatus:'awaiting_contact',serviceName:String(svc.name||'خدمة خاصة'),description:String(svc.description||svc.desc||''),serviceApp:String(svc.platform||svc.serviceApp||'Other'),platform:String(svc.platform||svc.serviceApp||'Other'),category:String(svc.category||''),link,quantity,unitSellingUsd:serviceRate,orderPriceUsd:serviceRate,manualPriceMode:(Number(svc.max)<1000?'per_100':'per_1000'),billingUnit,discountPct:userDiscount,chargeUsd:chargedUsd,sellingPriceUsd:calculatedChargeUsd,quotedChargeUsd:calculatedChargeUsd,total:chargeIQD,totalIQD:chargeIQD,status:'pending',statusText:'بانتظار التواصل مع الدعم',billingMode:isAdminSession?'admin-test':'user',free:calculatedChargeUsd<=0,createdAt,updatedAt:createdAt,providerCostUnknown:true};
  order.supportMessage=manualSupportMessage(order);
  try{await persistOrderToFirebase(order);}
  catch(e){
    let check=null;try{check=await firebaseGetJson('orders/'+firebaseSafeKey(siteOrderId),5000);}catch(_){}
    if(check&&String(check.id||'')===siteOrderId&&String(check.user||check.username||'')===username&&String(check.serviceKind||'')==='manual_support'){
      Object.assign(order,check);order.supportMessage=String(check.supportMessage||manualSupportMessage(order));
    }else{
      if(check===null){/* A null read-back is not proof that a timed-out write did not commit; keep reservation fail-closed. */}
      appendJsonLedger('provider_failures.json',{stage:'manual_support_persist',uncertain:true,user:username,localId,siteServiceId,serviceKey,error:String(e.message||e).slice(0,180),createdAt:nowISO()});
      return {status:503,body:{ok:false,uncertain:true,error:'تعذر تأكيد حفظ الطلب في قاعدة البيانات. لم نعلن نجاحه ولم نحرر الحجز تلقائياً؛ تواصل مع الدعم وأعطهم رقم التتبع '+localId+'.',stage:'manual_persist'}};
    }
  }
  try{appendJsonLedger('orders.json',order);}catch(e){console.warn('manual support local order mirror failed:',String(e.message||e).slice(0,100));}
  if(!isAdminSession){try{await finalizeProviderOrderAccounting(username,localId,chargeIQD,createdAt);}catch(e){console.warn('manual support account counters reconciliation:',String(e.message||e).slice(0,100));}}
  try{createUserNotification(username,{type:'order_created',orderId:siteOrderId,status:'pending',title:'تم إنشاء طلب خدمة خاصة #'+publicOrderNo,message:'تم استلام طلبك لخدمة '+String(order.serviceName||'خدمة خاصة')+'. أرسل رسالة الطلب إلى الدعم الفني لإتمام التنفيذ.',meta:{serviceName:order.serviceName,quantity,publicOrderNo,serviceKind:'manual_support'}});}catch(_){}
  notifyTelegramNewOrder(order,{source:'manual-support'}).catch(()=>{});
  return {status:200,body:{ok:true,siteOrderId,publicOrderNo,siteServiceId,serviceId:siteServiceId,serviceName:order.serviceName,quantity,totalIQD:chargeIQD,supportWhatsappUrl,providerId:'manual-support',providerName:'التنفيذ عبر الدعم الفني',providerOrderId:'',chargeUsd:calculatedChargeUsd,discountPct:userDiscount,createdAt,supportMessage:order.supportMessage,order}};
}

async function routeAPI(req,res,urlObj){
  const p=normalizedPath(urlObj.pathname);
  const maintenanceState=readJSON('settings.json',{}).maintenance||{};
  const currentSession=session(req);
  const maintenanceAllow=new Set(['/api/config','/api/health','/api/session','/api/auth','/api/auth/login','/api/auth/register','/api/auth/forgot-password','/api/auth/reset-password','/api/auth/verify-email']);
  if(maintenanceState.enabled===true&&currentSession?.role!=='admin'&&!maintenanceAllow.has(p))return json(res,503,{ok:false,maintenance:true,title:String(maintenanceState.title||'التطبيق متوقف مؤقتاً'),message:String(maintenanceState.message||maintenanceState.reason||'التطبيق تحت الصيانة المؤقتة. يرجى المحاولة لاحقاً.'),reason:String(maintenanceState.reason||''),imageUrl:String(maintenanceState.imageUrl||''),error:'التطبيق متوقف مؤقتاً للصيانة.'});
  if(p==='/api/admin/maintenance'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const m=readJSON('settings.json',{}).maintenance||{};return json(res,200,{ok:true,maintenance:{enabled:m.enabled===true,title:String(m.title||'التطبيق متوقف مؤقتاً'),message:String(m.message||''),reason:String(m.reason||''),imageUrl:String(m.imageUrl||'')},storageMode:DATA_IS_EXTERNAL?'persistent-volume':'release-local',warning:!DATA_IS_EXTERNAL?'اربط Railway Volume دائم حتى تبقى إعدادات الصيانة والصورة بعد إعادة النشر.':''});
  }
  if(p==='/api/admin/maintenance'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req,4*1024*1024),store=readJSON('settings.json',{}),old=store.maintenance&&typeof store.maintenance==='object'?store.maintenance:{};
    const title=String(b.title||old.title||'التطبيق متوقف مؤقتاً').trim().slice(0,120),message=String(b.message||'').trim().slice(0,1200),reason=String(b.reason||'').trim().slice(0,500);
    if(b.enabled===true&&!message&&!reason)return json(res,422,{ok:false,error:'اكتب رسالة أو سبباً يظهر للمستخدم قبل تفعيل الصيانة.'});
    let imageUrl=String(old.imageUrl||'');
    if(b.removeImage===true){try{const fname=imageUrl.match(/^\/media\/maintenance\/([a-z0-9-]+\.(?:jpg|jpeg|png|webp))$/i)?.[1];if(fname)fs.unlinkSync(path.join(DATA,'maintenance-media',fname));}catch(_){}imageUrl='';}
    const dataUrl=String(b.imageData||'');
    if(dataUrl){const match=dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i);if(!match)return json(res,422,{ok:false,error:'صيغة صورة الصيانة غير مدعومة.'});const bytes=Buffer.from(match[2],'base64');if(!bytes.length||bytes.length>1400*1024)return json(res,413,{ok:false,error:'صورة الصيانة يجب أن تكون أقل من 1.4 ميغابايت بعد الضغط.'});const ext=match[1].toLowerCase().replace('jpeg','jpg'),dir=path.join(DATA,'maintenance-media');fs.mkdirSync(dir,{recursive:true});const file='maintenance-'+crypto.randomUUID().replace(/-/g,'')+'.'+ext;fs.writeFileSync(path.join(dir,file),bytes,{flag:'wx'});imageUrl='/media/maintenance/'+file;}
    store.maintenance={enabled:b.enabled===true,title,message,reason,imageUrl,updatedAt:nowISO(),updatedBy:String(currentSession?.username||ADMIN_USER)};writeJSON('settings.json',store);
    return json(res,200,{ok:true,maintenance:store.maintenance,storageMode:DATA_IS_EXTERNAL?'persistent-volume':'release-local',warning:!DATA_IS_EXTERNAL?'تم الحفظ بالمجلد الحالي؛ اربط Railway Volume دائم حتى لا تضيع الإعدادات والصورة بعد إعادة النشر.':''});
  }
  // Separate, administrator-managed no-provider shop: customShop/catalog stays isolated from SMM services.
  if(p==='/api/custom-shop'&&req.method==='GET'){
    try{const root=await readCustomShopRemote(false),settings=readJSON('settings.json',{});const cats=Object.entries(root.categories).map(([key,v])=>({...v,key})).filter(c=>c&&c.enabled!==false);const catMap=new Map(cats.map(c=>[String(c.key),c]));const visibleCats=cats.filter(c=>!c.parentKey||catMap.has(String(c.parentKey)));const services=Object.entries(root.services).map(([key,v])=>({...v,key})).filter(s=>s&&s.enabled!==false&&s.serviceKind==='custom_shop'&&catMap.has(String(s.categoryKey))&&catMap.get(String(s.categoryKey)).enabled!==false);return json(res,200,{ok:true,categories:visibleCats,services,supportWhatsappUrl:normalizeWhatsAppUrl(settings.waUrl||settings.waNum||'https://wa.me/9647762267959'),source:'firebase-customShop',checkedAt:nowISO()});}catch(e){return json(res,503,{ok:false,error:'تعذر تحميل قسم من عندك من Firebase: '+String(e.message||e).slice(0,140)});}
  }
  if(p==='/api/admin/custom-shop'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    try{const root=await readCustomShopRemote(true);return json(res,200,{ok:true,categories:Object.entries(root.categories).map(([key,v])=>({...v,key})).sort((a,b)=>(Date.parse(a.createdAt||0)||0)-(Date.parse(b.createdAt||0)||0)),services:Object.entries(root.services).map(([key,v])=>({...v,key})).sort((a,b)=>(Date.parse(b.updatedAt||b.createdAt||0)||0)-(Date.parse(a.updatedAt||a.createdAt||0)||0)),storage:'Firebase Realtime Database',path:'customShop'});}catch(e){return json(res,503,{ok:false,error:'تعذر قراءة قسم من عندك من Firebase: '+String(e.message||e).slice(0,160)});}
  }
  if(p==='/api/admin/custom-shop/image'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    try{const b=await bodyJSON(req,512*1024),data=String(b.imageData||'').trim(),m=data.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i);if(!m)return json(res,422,{ok:false,error:'صيغة الصورة غير مدعومة. استخدم PNG أو JPG أو WebP.'});const bytes=Buffer.from(m[2],'base64');if(!bytes.length||bytes.length>320*1024)return json(res,413,{ok:false,error:'حجم الصورة بعد الضغط يجب ألا يتجاوز 320 كيلوبايت.'});const type=m[1].toLowerCase().replace('jpeg','jpg'),sig=type==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):type==='jpg'?bytes[0]===255&&bytes[1]===216:type==='webp'?bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP':false;if(!sig)return json(res,422,{ok:false,error:'محتوى الصورة لا يطابق نوع الملف.'});const ext=type==='jpg'?'jpg':type,dir=path.join(DATA,'custom-shop-media');fs.mkdirSync(dir,{recursive:true});const file='custom-'+crypto.randomUUID().replace(/-/g,'')+'.'+ext;fs.writeFileSync(path.join(dir,file),bytes,{flag:'wx'});return json(res,200,{ok:true,imageUrl:'/media/custom-shop/'+file,size:bytes.length,storageMode:DATA_IS_EXTERNAL?'persistent-volume':'release-local',warning:!DATA_IS_EXTERNAL?'لضمان بقاء الصور بعد إعادة النشر، اربط Railway Volume واضبط SADA_DATA_DIR.':''});}catch(e){return json(res,500,{ok:false,error:'تعذر حفظ صورة القسم/الخدمة: '+String(e.message||e).slice(0,140)});}
  }
  if(p==='/api/admin/custom-shop'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req,512*1024),action=String(b.action||''),actor=String(session(req)?.username||ADMIN_USER),at=nowISO();
    try{
      const root=await readCustomShopRemote(true);
      if(action==='category_save'){const category=await saveCustomShopCategory(b,root,actor,at);return json(res,200,{ok:true,category,storage:'firebase',verified:true});}
      if(action==='service_save'){const service=await saveCustomShopService(b,root,actor,at);return json(res,200,{ok:true,service,storage:'firebase',verified:true});}
      if(action==='service_delete'){
        const key=String(b.key||'').trim();if(!key||!root.services[key])return json(res,404,{ok:false,error:'الخدمة غير موجودة في قاعدة البيانات.'});
        await writeCustomShopRecord('customShop/services/'+key,null);customShopRemoveImage(root.services[key]?.imageUrl);return json(res,200,{ok:true,deleted:true,key,storage:'firebase',verified:true});
      }
      if(action==='service_unlink_platform'){
        const key=String(b.key||'').trim(),platform=String(b.platform||'').trim(),old=root.services[key];if(!old)return json(res,404,{ok:false,error:'الخدمة غير موجودة.'});if(!Object.prototype.hasOwnProperty.call(CUSTOM_SHOP_PLATFORMS,platform))return json(res,422,{ok:false,error:'اختر منصة صحيحة لإزالتها.'});
        let current=customShopPlatforms(old.platforms);if(current.includes('all'))current=Object.keys(CUSTOM_SHOP_PLATFORMS).filter(x=>x!==platform);else current=current.filter(x=>x!==platform);
        if(!current.length){await writeCustomShopRecord('customShop/services/'+key,null);return json(res,200,{ok:true,deleted:true,key,platform,storage:'firebase',verified:true});}
        const updated={...old,platforms:current,updatedAt:at,updatedBy:actor};await writeCustomShopRecord('customShop/services/'+key,updated);return json(res,200,{ok:true,service:updated,removedPlatform:platform,storage:'firebase',verified:true});
      }
      if(action==='category_delete'){
        const key=String(b.key||'').trim();if(!key||!root.categories[key])return json(res,404,{ok:false,error:'القسم غير موجود في قاعدة البيانات.'});if(b.confirmation!=='DELETE_CUSTOM_SHOP_SECTION')return json(res,422,{ok:false,error:'تأكيد حذف القسم غير صحيح.'});
        const targets=new Set([key]);let changed=true;while(changed){changed=false;for(const [k,c] of Object.entries(root.categories))if(c&&targets.has(String(c.parentKey||''))&&!targets.has(k)){targets.add(k);changed=true;}}
        const serviceKeys=Object.entries(root.services).filter(([,x])=>x&&targets.has(String(x.categoryKey||''))).map(([k])=>k);const patch={};for(const k of targets)patch['categories/'+k]=null;for(const k of serviceKeys)patch['services/'+k]=null;
        await firebasePatchJsonSilent('customShop',patch,20000);const verify=customShopRoot(await firebaseGetJson('customShop',12000));if([...targets].some(k=>verify.categories[k])||serviceKeys.some(k=>verify.services[k]))throw new Error('لم يتم تأكيد إزالة كل السجلات التابعة للقسم.');for(const k of targets)customShopRemoveImage(root.categories[k]?.imageUrl);for(const k of serviceKeys)customShopRemoveImage(root.services[k]?.imageUrl);CUSTOM_SHOP_CACHE={at:0,value:null,promise:null};return json(res,200,{ok:true,deleted:true,key,deletedCategories:targets.size,deletedServices:serviceKeys.length,storage:'firebase',verified:true});
      }
      return json(res,422,{ok:false,error:'الإجراء غير مدعوم.'});
    }catch(e){return json(res,503,{ok:false,error:'لم يتم تأكيد حفظ التغيير في Firebase: '+String(e.message||e).slice(0,180),verified:false});}
  }

  // Administrator-created manual/support services are isolated from all supplier-backed catalog records.
  if(p==='/api/admin/manual-services'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});ensureNumericSiteServiceIds();
    const services=Object.entries(readAdminManualServices()).filter(([,v])=>v&&v.serviceKind==='manual_support'&&v.deleted!==true).map(([key,v])=>({...adminManualServicePublic(v,key),...v,key,fbKey:key})).sort((a,b)=>(Date.parse(b.updatedAt||b.createdAt||0)||0)-(Date.parse(a.updatedAt||a.createdAt||0)||0));
    return json(res,200,{ok:true,services,storageMode:DATA_IS_EXTERNAL?'persistent-volume':'release-local',warning:!DATA_IS_EXTERNAL?'اربط Railway Volume على /data وثبّت SADA_DATA_DIR=/data حتى تبقى الخدمات اليدوية بعد إعادة النشر.':''});
  }
  if(p==='/api/admin/manual-services'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});ensureNumericSiteServiceIds();
    const b=await bodyJSON(req,512*1024),action=String(b.action||'save'),key=String(b.key||'').trim(),root=readAdminManualServices(),actor=String(currentSession?.username||ADMIN_USER),at=nowISO();
    if(action==='delete'){
      if(!key||!root[key]||root[key].deleted===true)return json(res,404,{ok:false,error:'الخدمة اليدوية غير موجودة.'});
      root[key]={...root[key],enabled:false,deleted:true,deletedAt:at,updatedAt:at,updatedBy:actor};writeJSON('manual_services.json',root);return json(res,200,{ok:true,deleted:true,key});
    }
    if(action==='toggle'){
      if(!key||!root[key]||root[key].deleted===true)return json(res,404,{ok:false,error:'الخدمة اليدوية غير موجودة أو محذوفة.'});
      root[key]={...root[key],enabled:b.enabled===true,updatedAt:at,updatedBy:actor};writeJSON('manual_services.json',root);return json(res,200,{ok:true,service:{...adminManualServicePublic(root[key],key),...root[key],key}});
    }
    if(action!=='save')return json(res,422,{ok:false,error:'الإجراء غير مدعوم.'});
    const name=String(b.name||'').trim(),description=String(b.description||'').trim(),platform=String(b.platform||'Other').trim(),category=String(b.category||'').trim();
    const min=Math.floor(Number(b.min)),max=Math.floor(Number(b.max)),perAccountLimit=Math.floor(Number(b.perAccountLimit)),sellingUsd=Number(b.orderPriceUsd??b.fixedPriceUsd??b.sellingUsd);
    if(!name||name.length>200||!category||category.length>160)return json(res,422,{ok:false,error:'أدخل اسم الخدمة والقسم. الحد الأقصى للاسم 200 حرف والقسم 160 حرفاً.'});
    if(description.length>4000)return json(res,422,{ok:false,error:'الوصف طويل جداً؛ الحد الأقصى 4000 حرف.'});
    if(!Number.isSafeInteger(min)||min<1||!Number.isSafeInteger(max)||max<min||max>1000000000)return json(res,422,{ok:false,error:'حدود الكمية غير صحيحة.'});
    if(!Number.isSafeInteger(perAccountLimit)||perAccountLimit<0||perAccountLimit>100)return json(res,422,{ok:false,error:'حد الطلبات لكل حساب يجب أن يكون بين 0 و100. استخدم صفر لإلغاء الحد.'});
    if(!Number.isFinite(sellingUsd)||sellingUsd<0||sellingUsd>1000000)return json(res,422,{ok:false,error:'السعر الثابت للطلب بالدولار يجب أن يكون رقماً صحيحاً غير سالب.'});
    const validPlatforms=new Set(['Instagram','Tiktok','Youtube','Facebook','Telegram','Twitter','Snapchat','Whatsapp','Linkedin','Other']);if(!validPlatforms.has(platform))return json(res,422,{ok:false,error:'المنصة المختارة غير مدعومة.'});
    let serviceKey=key,old=null;
    if(key){old=root[key];if(!old||old.deleted===true||old.serviceKind!=='manual_support')return json(res,404,{ok:false,error:'الخدمة المراد تعديلها غير موجودة.'});}
    else{serviceKey='manual_'+crypto.randomBytes(12).toString('hex');}
    const siteServiceId=String(old?.siteServiceId||nextManualSiteServiceId());
    const record={...(old||{}),key:serviceKey,fbKey:serviceKey,id:siteServiceId,siteServiceId,internalServiceId:siteServiceId,sadaServiceId:siteServiceId,name,description,desc:description,platform,serviceApp:platform,category,groups:[category],categories:[category],sellingUsd:Number(sellingUsd.toFixed(6)),rateUsd:Number(sellingUsd.toFixed(6)),orderPriceUsd:Number(sellingUsd.toFixed(6)),fixedPriceUsd:Number(sellingUsd.toFixed(6)),manualPriceMode:(max<1000?'per_100':'per_1000'),billingUnit:(max<1000?100:1000),price:Number((sellingUsd*FIXED_RATE).toFixed(4)),min,max,perAccountLimit,enabled:b.enabled===undefined?(old?.enabled!==false):b.enabled===true,deleted:false,serviceKind:'manual_support',manualService:true,adminManualService:true,providerId:'manual-support',providerName:'التنفيذ عبر الدعم الفني',providerServiceId:'',createdAt:old?.createdAt||at,updatedAt:at,createdBy:old?.createdBy||actor,updatedBy:actor};
    root[serviceKey]=record;writeJSON('manual_services.json',root);
    return json(res,200,{ok:true,service:{...adminManualServicePublic(record,serviceKey),...record,key:serviceKey,siteServiceId},storageMode:DATA_IS_EXTERNAL?'persistent-volume':'release-local',warning:!DATA_IS_EXTERNAL?'تم الحفظ داخل مجلد النشر الحالي؛ اربط Railway Volume حتى تبقى الخدمة بعد إعادة النشر.':''});
  }
  // Administrator-managed free offers are isolated from ordinary provider services.
  if(p==='/api/admin/free-services'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    try{await ensureAdminFreeServicesDurable({refresh:true});ensureNumericSiteServiceIds()}catch(e){return json(res,503,{ok:false,error:'تعذر تأكيد بيانات الخدمات المجانية من Firebase. لم نحذف النسخة المحلية ولم نعرض بيانات غير مؤكدة. '+String(e.message||e).slice(0,180),storageMode:'firebase+verified-cache'})}
    const cfg=providerStore(),deletedIds=cfg.deletedProviderIds instanceof Set?cfg.deletedProviderIds:new Set(Array.isArray(cfg.deletedProviderIds)?cfg.deletedProviderIds.map(String):[]),providers=Object.entries(cfg.providers||{}).filter(([id,v])=>v&&!deletedIds.has(String(id))).map(([id,v])=>({id:String(id),name:String(v.name||id),configured:!!(v.url&&v.key)}));
    return json(res,200,{ok:true,services:Object.entries(readAdminFreeServices()).filter(([,v])=>v&&!v.deleted).map(([key,v])=>({...v,key,fbKey:key,providerRateUsd:catalogRate(v)})).sort((a,b)=>(Date.parse(b.updatedAt||b.createdAt||0)||0)-(Date.parse(a.updatedAt||a.createdAt||0)||0)),providers,storageMode:DATA_IS_EXTERNAL?'persistent-volume':'release-local',warning:!DATA_IS_EXTERNAL?'اربط Railway Volume على /data وثبّت SADA_DATA_DIR=/data حتى تبقى إعدادات الخدمات المجانية بعد إعادة النشر.':''});
  }
  if(p==='/api/admin/free-services/provider-catalog'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const providerId=String(urlObj.searchParams.get('providerId')||'').trim();
    if(!providerId)return json(res,422,{ok:false,error:'اختر المزود أولاً.'});
    try{
      await ensureProviderRuntime(providerId);const {prov}=getProviderById(providerId,{allowSingleFallback:false});
      if(!prov?.url||!prov?.key)return json(res,404,{ok:false,error:'المزود غير موجود أو لم تُحفظ بيانات API الخاصة به.'});
      const remote=normalizeProviderServices(await providerRequest(prov,{action:'services'},30000));
      const seen=new Set(),services=[];let invalidRates=0;
      for(const row of remote){
        const id=String(row.service||'').trim();if(!id||seen.has(id))continue;seen.add(id);
        const rateValid=row.ratePresent===true&&Number.isFinite(Number(row.rate))&&Number(row.rate)>=0;if(!rateValid)invalidRates++;
        services.push({service:id,name:String(row.name||('خدمة رقم '+id)).slice(0,240),rate:rateValid?Number(row.rate):null,rateValid,min:Math.max(1,Math.floor(Number(row.min||row.minimum||1)||1)),max:Math.max(Math.max(1,Math.floor(Number(row.min||row.minimum||1)||1)),Math.floor(Number(row.max||row.maximum||1000000)||1000000)),description:String(providerServiceDescription(row)||row.description||'').slice(0,3000),providerDescription:String(providerServiceDescription(row)||row.description||'').slice(0,3000),refill:!!row.refill,cancel:!!row.cancel,category:String(row.category||row.category_name||row.categoryName||'').slice(0,160),type:String(row.rawType||row.type||row.service_type||'').slice(0,80)});
      }
      const capped=services.slice(0,15000);
      return json(res,200,{ok:true,providerId,providerName:String(prov.name||providerId),services:capped,total:services.length,returned:capped.length,truncated:services.length>capped.length,invalidRateCount:invalidRates,loadedAt:nowISO()});
    }catch(e){return json(res,502,{ok:false,error:'تعذر جلب كتالوج المزود: '+String(e.message||e).slice(0,200)});}
  }
  if(p==='/api/admin/free-services/verify-service'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req,256*1024),providerId=String(b.providerId||'').trim(),providerServiceId=String(b.providerServiceId||'').trim();
    if(!providerId||!providerServiceId)return json(res,422,{ok:false,error:'اختر المزود وأدخل رقم الخدمة لديه.'});
    try{
      await ensureProviderRuntime(providerId);const {prov}=getProviderById(providerId,{allowSingleFallback:false});if(!prov?.url||!prov?.key)return json(res,404,{ok:false,error:'المزود غير موجود أو لم تُحفظ بيانات API الخاصة به.'});
      const remote=normalizeProviderServices(await providerRequest(prov,{action:'services'},25000));const found=remote.find(x=>String(x.service||'').trim()===providerServiceId);
      if(!found)return json(res,404,{ok:false,error:'رقم الخدمة غير موجود في كتالوج المزود الحالي. تحقق من المزود ورقم الخدمة.'});
      if(found.ratePresent!==true||!Number.isFinite(Number(found.rate))||Number(found.rate)<0)return json(res,422,{ok:false,error:'المزود لم يرجع تكلفة رقمية موثوقة لهذه الخدمة، لذلك لم نضفها لتجنب تسجيل تكلفة خاطئة.'});
      return json(res,200,{ok:true,providerId,providerName:String(prov.name||providerId),providerServiceId,service:{name:String(found.name||('خدمة رقم '+providerServiceId)),description:String(found.description||''),rate:Number(found.rate),min:Math.max(1,Number(found.min||found.minimum||1)||1),max:Math.max(Math.max(1,Number(found.min||found.minimum||1)||1),Number(found.max||found.maximum||1000000)||1000000),refill:!!found.refill,cancel:!!found.cancel,category:String(found.category||found.category_name||found.categoryName||''),rawType:String(found.type||found.service_type||'')},checkedAt:nowISO()});
    }catch(e){return json(res,502,{ok:false,error:'تعذر التحقق من الخدمة لدى المزود: '+String(e.message||e).slice(0,200)});}
  }
  if(p==='/api/admin/free-services'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    try{await ensureAdminFreeServicesDurable({refresh:true});ensureNumericSiteServiceIds()}catch(e){return json(res,503,{ok:false,error:'تعذر تحميل بيانات الخدمات المجانية الموثوقة؛ لم يتم تعديل أي خدمة. '+String(e.message||e).slice(0,180)})}
    const b=await bodyJSON(req,512*1024),action=String(b.action||'save'),key=String(b.key||'').trim(),root=readAdminFreeServices();
    if(action==='delete'){
      if(!key||!root[key])return json(res,404,{ok:false,error:'الخدمة المجانية غير موجودة.'});
      root[key]={...root[key],enabled:false,deleted:true,deletedAt:nowISO(),updatedAt:nowISO(),updatedBy:String(currentSession?.username||ADMIN_USER)};try{await persistAdminFreeServicesRoot(root,'admin-delete')}catch(e){return json(res,503,{ok:false,error:'لم نتأكد من حفظ حذف الخدمة في Firebase؛ حدّث القائمة قبل أي محاولة ثانية. '+String(e.message||e).slice(0,140)})}return json(res,200,{ok:true,deleted:true,key,storageMode:'firebase+verified-cache'});
    }
    if(action==='toggle'){
      if(!key||!root[key]||root[key].deleted===true)return json(res,404,{ok:false,error:'الخدمة المجانية غير موجودة أو محذوفة.'});
      root[key]={...root[key],enabled:b.enabled===true,updatedAt:nowISO(),updatedBy:String(currentSession?.username||ADMIN_USER)};try{await persistAdminFreeServicesRoot(root,'admin-toggle')}catch(e){return json(res,503,{ok:false,error:'لم نتأكد من حفظ حالة الخدمة في Firebase؛ حدّث القائمة قبل المحاولة مجدداً. '+String(e.message||e).slice(0,140)})}return json(res,200,{ok:true,service:{...root[key],key},storageMode:'firebase+verified-cache'});
    }
    if(action==='save-bulk'){
      const providerId=String(b.providerId||'').trim(),serviceIds=[...new Set((Array.isArray(b.serviceIds)?b.serviceIds:[]).map(x=>String(x??'').trim()).filter(Boolean))],category=String(b.category||'').trim().slice(0,160),platform=String(b.platform||'Other').trim(),description=String(b.description||'').trim().slice(0,3000);
      if(!providerId)return json(res,422,{ok:false,error:'اختر المزود أولاً.'});
      if(!serviceIds.length)return json(res,422,{ok:false,error:'حدد خدمة واحدة على الأقل من كتالوج المزود.'});
      if(serviceIds.length>250)return json(res,422,{ok:false,error:'يمكن إضافة 250 خدمة كحد أقصى في العملية الواحدة. قسّم الاختيار إلى دفعات.'});
      if(!category)return json(res,422,{ok:false,error:'اختر القسم الذي ستظهر بداخله الخدمات.'});
      const validPlatforms=new Set(['Instagram','Tiktok','Youtube','Facebook','Telegram','Twitter','Snapchat','Whatsapp','Linkedin','Other']);
      if(!validPlatforms.has(platform))return json(res,422,{ok:false,error:'المنصة المختارة غير مدعومة.'});
      let categoryExists=false;const serviceRoot=readJSON('services.json',{}),metaRoot=readJSON('category_meta.json',{});
      for(const row of Object.values(serviceRoot&&typeof serviceRoot==='object'?serviceRoot:{}))if(freeServiceGroups(row).some(g=>String(g).trim()===category)){categoryExists=true;break;}
      if(!categoryExists)categoryExists=Object.entries(metaRoot&&typeof metaRoot==='object'?metaRoot:{}).some(([k,v])=>String(v?.name||k).trim()===category);
      if(!categoryExists){try{const remoteMeta=await firebaseGetJson('categoryMeta',6500);if(remoteMeta&&typeof remoteMeta==='object')categoryExists=Object.entries(remoteMeta).some(([k,v])=>String(v?.name||k).trim()===category);}catch(_){}}
      if(!categoryExists)return json(res,422,{ok:false,error:'القسم المختار غير موجود حالياً. اختر قسماً مستخدماً في الموقع.'});
      try{
        await ensureProviderRuntime(providerId);const {prov}=getProviderById(providerId,{allowSingleFallback:false});
        if(!prov?.url||!prov?.key)return json(res,404,{ok:false,error:'المزود غير موجود أو لم تُحفظ بيانات API الخاصة به.'});
        const remote=normalizeProviderServices(await providerRequest(prov,{action:'services'},30000));
        const writeRoot=readAdminFreeServices();
        const byId=new Map();for(const row of remote){const id=String(row.service||'').trim();if(id&&!byId.has(id))byId.set(id,row);}
        const missing=serviceIds.filter(id=>!byId.has(id));if(missing.length)return json(res,404,{ok:false,error:'بعض الخدمات المحددة لم تعد موجودة في كتالوج المزود ('+missing.slice(0,8).join(', ')+(missing.length>8?'…':'')+'). لم نحفظ أي خدمة؛ حدّث القائمة ثم أعد الاختيار.'});
        const invalid=serviceIds.filter(id=>{const row=byId.get(id);return row.ratePresent!==true||!Number.isFinite(Number(row.rate))||Number(row.rate)<0;});
        if(invalid.length)return json(res,422,{ok:false,error:'لا توجد تكلفة رقمية موثوقة للخدمات المحددة: '+invalid.slice(0,8).join(', ')+(invalid.length>8?'…':'')+'. لم نحفظ أي خدمة.'});
        const providerName=String(prov.name||providerId),at=nowISO(),usedSiteIds=new Set(allSiteServiceRows().map(entry=>currentSiteServiceId(entry.row)).filter(Boolean));
        const existingSources=new Set(Object.values(writeRoot).filter(row=>row&&!row.deleted&&row.adminFreeService===true&&String(row.providerId||'')===providerId).map(row=>String(row.providerServiceId||'')));
        const added=[],skipped=[];
        for(const id of serviceIds){
          if(existingSources.has(id)){skipped.push({service:id,reason:'مضافة مسبقاً'});continue;}
          const found=byId.get(id),serviceKey='free_'+crypto.randomBytes(12).toString('hex');
          const siteServiceId=allocateFourDigitSiteServiceId(usedSiteIds);usedSiteIds.add(siteServiceId);existingSources.add(id);
          const providerMin=Math.max(1,Math.floor(Number(found.min||found.minimum||1)||1));
          const providerMax=Math.max(providerMin,Math.floor(Number(found.max||found.maximum||1000000)||1000000));
          const providerRate=Number(found.rate),serviceName=String(found.name||('خدمة رقم '+id)).trim().slice(0,200),serviceDescription=(description||String(found.description||'')).trim().slice(0,3000),groups=[category],apps=[platform];
          const record={fbKey:serviceKey,adminFreeServiceKey:serviceKey,adminFreeService:true,free:true,enabled:true,id:siteServiceId,siteServiceId,internalServiceId:siteServiceId,serviceId:siteServiceId,providerId,providerName,providerServiceId:id,smmpartyId:id,source:'smmparty',sourceType:'admin-free',name:serviceName,description:serviceDescription,desc:serviceDescription,category,groups,categories:groups,app:platform,apps,platforms:apps,min:providerMin,max:providerMax,perAccountLimit:ADMIN_FREE_SERVICES_GLOBAL_DAILY_LIMIT,limitHours:24,sellingUsd:0,rateUsd:0,rate:0,price:0,basePrice:Number((providerRate*FIXED_RATE).toFixed(6)),providerRateUsd:providerRate,smmRateUsd:providerRate,baseProviderRateUsd:providerRate,smmRate:providerRate,providerRateCheckedAt:at,providerAvailable:true,availabilityStatus:'available',refill:!!found.refill,cancel:!!found.cancel,quality:String(found.rawType||found.type||'SMM').slice(0,80),createdAt:at,updatedAt:at,updatedBy:String(currentSession?.username||ADMIN_USER)};
          writeRoot[serviceKey]=record;added.push({key:serviceKey,service:serviceName,providerServiceId:id,siteServiceId,providerRateUsd:providerRate,min:providerMin,max:providerMax});
        }
        if(added.length){try{await persistAdminFreeServicesRoot(writeRoot,'admin-bulk-import')}catch(e){return json(res,503,{ok:false,error:'تعذر التحقق من حفظ الخدمات المحددة في Firebase؛ لم تُعرض العملية كنجاح. '+String(e.message||e).slice(0,160),addedInMemory:added.length})}}
        return json(res,200,{ok:true,added:added.length,skipped:skipped.length,services:added,skippedServices:skipped,globalPerAccountLimit:ADMIN_FREE_SERVICES_GLOBAL_DAILY_LIMIT,limitHours:24,storageMode:'firebase+verified-cache',warning:''});
      }catch(e){return json(res,502,{ok:false,error:'تعذر إضافة الخدمات المجانية المحددة: '+String(e.message||e).slice(0,200)});}
    }
    if(action!=='save')return json(res,422,{ok:false,error:'الإجراء غير مدعوم.'});
    const providerId=String(b.providerId||'').trim(),providerServiceId=String(b.providerServiceId||'').trim(),name=String(b.name||'').trim().slice(0,200),category=String(b.category||'').trim().slice(0,160),platform=String(b.platform||'Other').trim();
    const min=Math.floor(Number(b.min)),max=Math.floor(Number(b.max)),perAccountLimit=ADMIN_FREE_SERVICES_GLOBAL_DAILY_LIMIT;
    if(!providerId||!providerServiceId||!name||!category)return json(res,422,{ok:false,error:'أكمل المزود ورقم الخدمة واسم الخدمة والقسم.'});
    if(!Number.isSafeInteger(min)||min<1||!Number.isSafeInteger(max)||max<min||max>1000000000)return json(res,422,{ok:false,error:'حدود الكمية غير صحيحة؛ يجب أن تكون الكمية العليا مساوية للأدنى أو أكبر.'});
    const validPlatforms=new Set(['Instagram','Tiktok','Youtube','Facebook','Telegram','Twitter','Snapchat','Whatsapp','Linkedin','Other']);if(!validPlatforms.has(platform))return json(res,422,{ok:false,error:'المنصة المختارة غير مدعومة.'});
    let categoryExists=false;const serviceRoot=readJSON('services.json',{}),metaRoot=readJSON('category_meta.json',{});
    for(const row of Object.values(serviceRoot&&typeof serviceRoot==='object'?serviceRoot:{}))if(freeServiceGroups(row).some(g=>String(g).trim()===category)){categoryExists=true;break;}
    if(!categoryExists)categoryExists=Object.entries(metaRoot&&typeof metaRoot==='object'?metaRoot:{}).some(([k,v])=>String(v?.name||k).trim()===category);
    if(!categoryExists){try{const remote=await firebaseGetJson('categoryMeta',6500);if(remote&&typeof remote==='object')categoryExists=Object.entries(remote).some(([k,v])=>String(v?.name||k).trim()===category);}catch(_){}}
    if(!categoryExists)return json(res,422,{ok:false,error:'القسم المختار غير موجود حالياً. اختر قسماً مستخدماً في الموقع.'});
    try{
      await ensureProviderRuntime(providerId);const {prov}=getProviderById(providerId,{allowSingleFallback:false});if(!prov?.url||!prov?.key)return json(res,404,{ok:false,error:'المزود غير موجود أو لم تُحفظ بيانات API الخاصة به.'});
      const remote=normalizeProviderServices(await providerRequest(prov,{action:'services'},25000));const found=remote.find(x=>String(x.service||'').trim()===providerServiceId);
      if(!found)return json(res,404,{ok:false,error:'لم يتم العثور على رقم الخدمة لدى المزود؛ لم يتم حفظ أي تغيير.'});
      if(found.ratePresent!==true||!Number.isFinite(Number(found.rate))||Number(found.rate)<0)return json(res,422,{ok:false,error:'لا توجد تكلفة رقمية موثوقة لدى المزود؛ لم نحفظ الخدمة.'});
      const preserve=key&&root[key]?root[key]:null;if(key&&!preserve)return json(res,404,{ok:false,error:'تعذر العثور على الخدمة المراد تعديلها.'});
      // Do not allow changing the source identity of an existing offer silently; a different supplier item gets a new service key and usage history.
      const sameSource=!!preserve&&String(preserve.providerId)===providerId&&String(preserve.providerServiceId)===providerServiceId;
      const serviceKey=preserve?(sameSource?key:('free_'+crypto.randomBytes(12).toString('hex'))):('free_'+crypto.randomBytes(12).toString('hex'));
      const siteServiceId=preserve?(sameSource?String(preserve.siteServiceId):nextAdminFreeSiteServiceId()):nextAdminFreeSiteServiceId();
      const groups=[category],apps=[platform],providerRate=Number(found.rate),at=nowISO();
      const record={...(preserve||{}),fbKey:serviceKey,adminFreeServiceKey:serviceKey,adminFreeService:true,free:true,enabled:b.enabled!==false,id:siteServiceId,siteServiceId,internalServiceId:siteServiceId,serviceId:siteServiceId,providerId,providerName:String(prov.name||providerId),providerServiceId,smmpartyId:providerServiceId,source:'smmparty',sourceType:'admin-free',name,description:String(b.description||'').trim().slice(0,3000),desc:String(b.description||'').trim().slice(0,3000),category,groups,categories:groups,app:platform,apps,platforms:apps,min,max,perAccountLimit,limitHours:24,sellingUsd:0,rateUsd:0,rate:0,price:0,basePrice:Number((providerRate*FIXED_RATE).toFixed(6)),providerRateUsd:providerRate,smmRateUsd:providerRate,baseProviderRateUsd:providerRate,smmRate:providerRate,providerRateCheckedAt:nowISO(),providerAvailable:true,availabilityStatus:'available',refill:!!found.refill,cancel:!!found.cancel,quality:String(found.rawType||'SMM').slice(0,80),createdAt:preserve?.createdAt||at,updatedAt:at,updatedBy:String(currentSession?.username||ADMIN_USER)};
      // A changed provider mapping must get a fresh site ID and service key. Preserve the previous item only when the source matches.
      if(preserve&&!sameSource){root[key]={...preserve,enabled:false,deleted:true,deletedAt:nowISO(),updatedAt:nowISO(),updatedBy:String(currentSession?.username||ADMIN_USER)};}
      root[serviceKey]=record;try{await persistAdminFreeServicesRoot(root,'admin-save')}catch(e){return json(res,503,{ok:false,error:'تعذر تأكيد حفظ الخدمة في Firebase؛ لم نعرضها كعملية ناجحة. '+String(e.message||e).slice(0,160)})}
      return json(res,200,{ok:true,service:{...record,key:serviceKey},storageMode:'firebase+verified-cache',warning:''});
    }catch(e){return json(res,502,{ok:false,error:'تعذر حفظ الخدمة المجانية: '+String(e.message||e).slice(0,200)});}
  }
  // Safe, admin-only migration for the legacy Firebase service catalog.
  // The remote node is not removed unless a persistent host volume, verified copy and explicit confirmation are present.
  if(p==='/api/admin/catalog/migration'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    try{
      const remote=await firebaseGetJson('services',12000);
      const local=readJSON('services.json',{});
      const remoteRoot=remote&&typeof remote==='object'&&!Array.isArray(remote)?remote:{};
      const localRoot=local&&typeof local==='object'&&!Array.isArray(local)?local:{};
      const remoteKeys=Object.keys(remoteRoot),localKeys=Object.keys(localRoot);
      return json(res,200,{ok:true,remoteCount:remoteKeys.length,localCount:localKeys.length,remoteOnlyCount:remoteKeys.filter(k=>!Object.prototype.hasOwnProperty.call(localRoot,k)).length,storageMode:DATA_IS_EXTERNAL?'persistent-volume':'release-local',canDeleteRemote:DATA_IS_EXTERNAL&&localKeys.length>0,warning:!DATA_IS_EXTERNAL?'لا تحذف خدمات Firebase قبل ربط Railway Volume دائم على /data وضبط SADA_DATA_DIR=/data.':''});
    }catch(e){return json(res,503,{ok:false,error:'تعذر قراءة كتالوج Firebase؛ لم يتم نقل أو حذف شيء. '+String(e.message||e).slice(0,160)});}
  }
  if(p==='/api/admin/catalog/migration'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    return json(res,410,{ok:false,error:'تم تعطيل نقل/نسخ كتالوج الخدمات حتى لا تُنشأ نسخ احتياطية أو تُحذف بيانات من مسار غير مقصود. استخدم إدارة الخدمات والأقسام للحذف النهائي من Firebase.'});
  }
  // Server-backed host-file catalog API. Only these catalog nodes leave Firebase.
  if(p==='/api/catalog'&&req.method==='GET'){
    const raw=String(urlObj.searchParams.get('path')||'services');const spec=catalogPathSpec(raw);
    if(!spec)return json(res,422,{ok:false,error:'مسار الكتالوج غير مسموح'});
    let seed;try{seed=await ensureLocalServiceCatalogSeeded();}catch(e){return json(res,503,{ok:false,error:'تعذر تحميل كتالوج الخدمات من Firebase؛ لم يتم استخدام نسخة Railway قديمة بدلاً منه. '+String(e.message||e).slice(0,180),source:'firebase',storageMode:'firebase'});}
    if(raw==='services'||raw.startsWith('services/')){try{await ensureAdminFreeServicesDurable()}catch(e){return json(res,503,{ok:false,error:'تعذر تأكيد مخزن الخدمات المجانية في Firebase؛ لم نعرض تصنيفاً أو خدمة من نسخة غير موثوقة. '+String(e.message||e).slice(0,150),source:'firebase',storageMode:'firebase+verified-cache'})}ensureNumericSiteServiceIds();const got=catalogReadPath(raw);let value=got.value;if(raw==='services'&&value&&typeof value==='object'&&!Array.isArray(value)){const includeUnapproved=isAdmin(req)&&urlObj.searchParams.get('includeUnapprovedAutoImports')==='1';value=Object.fromEntries(Object.entries(value).filter(([,v])=>v&&typeof v==='object'&&(includeUnapproved||v.unapprovedAutoImport!==true)&&(isAdmin(req)||!hasExplicitSiteServiceDisable(v))));if(includeUnapproved){const archived=readJSON('quarantined_provider_services.json',{});for(const [archiveKey,archiveRow] of Object.entries(archived&&typeof archived==='object'&&!Array.isArray(archived)?archived:{}))if(archiveRow&&typeof archiveRow==='object')value[archiveKey]=archiveRow;}for(const [freeKey,freeRow] of Object.entries(readAdminFreeServices())){if(!freeRow||freeRow.adminFreeService!==true||freeRow.enabled===false||freeRow.deleted===true)continue;const safeRow=isAdmin(req)?{...freeRow,fbKey:freeKey,adminFreeServiceKey:freeKey}:{...adminFreeServicePublic({...freeRow,fbKey:freeKey,adminFreeServiceKey:freeKey})};value[freeKey]=safeRow;}for(const [manualKey,manualRow] of Object.entries(readAdminManualServices())){if(!manualRow||manualRow.serviceKind!=='manual_support'||manualRow.enabled===false||manualRow.deleted===true)continue;value[manualKey]=adminManualServicePublic(manualRow,manualKey);}}else if(raw.startsWith('services/')){const serviceKey=raw.slice('services/'.length),freeRow=readAdminFreeServices()[serviceKey],manualFound=findAdminManualService(serviceKey,'');if(freeRow&&freeRow.adminFreeService===true)value=(freeRow.enabled===false||freeRow.deleted===true)?null:(isAdmin(req)?{...freeRow,fbKey:serviceKey,adminFreeServiceKey:serviceKey}:{...adminFreeServicePublic({...freeRow,fbKey:serviceKey,adminFreeServiceKey:serviceKey})});else if(manualFound&&manualFound.row?.serviceKind==='manual_support')value=(manualFound.row.enabled===false||manualFound.row.deleted===true)?null:adminManualServicePublic(manualFound.row,manualFound.key);else if(!isAdmin(req)&&value&&typeof value==='object'&&hasExplicitSiteServiceDisable(value))value=null;}if(value&&typeof value==='object'&&value.unapprovedAutoImport===true&&!(isAdmin(req)&&urlObj.searchParams.get('includeUnapprovedAutoImports')==='1'))value=null;return json(res,200,{ok:true,value,source:'firebase',storage:'firebase+verified-server-cache',storageMode:'firebase',warning:''});}
    const got=catalogReadPath(raw);let value=got.value;
    if(raw==='categoryMeta'&&value&&typeof value==='object'&&!Array.isArray(value)){
      // Firebase remains the source of truth, but orphan metadata created by a provider probe
      // is not presented as a real section until ordered or linked to a saved service.
      const services=catalogObject(readJSON('services.json',{})),order=catalogObject(readJSON('catalog_settings.json',{}).catalogOrder),explicit=new Set((Array.isArray(order.categories)?order.categories:[]).map(normalizeCatalogLabel)),groups=new Set(),serviceKeys=new Set(Object.keys(services));
      for(const row of Object.values(services))for(const group of catalogRowGroups(row)){const norm=normalizeCatalogLabel(group);if(norm)groups.add(norm);}
      value=Object.fromEntries(Object.entries(value).filter(([key,meta])=>{const name=String(meta?.name||key),norm=normalizeCatalogLabel(name);const linked=Array.isArray(meta?.serviceKeys)&&meta.serviceKeys.some(k=>serviceKeys.has(String(k)));return (norm&&explicit.has(norm))||linked||(norm&&groups.has(norm));}));
    }
    return json(res,200,{ok:true,value,source:'firebase',storage:'firebase+verified-server-cache',storageMode:'firebase',warning:''});
  }

  // Dedicated global catalog deletion: remove live service rows, section metadata, section order,
  // and any old backups from this same operation. This destructive action intentionally retains no backup.
  if(p==='/api/admin/catalog/delete-all'&&(req.method==='GET'||req.method==='POST')){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    let servicesBefore,metaBefore,remoteOrder;
    try{
      await ensureLocalServiceCatalogSeeded();
      const loaded=await Promise.all([
        firebaseGetJson('services',15000),
        firebaseGetJson('categoryMeta',12000),
        firebaseGetJson('settings/catalogOrder',10000)
      ]);
      servicesBefore=catalogObject(loaded[0]);metaBefore=catalogObject(loaded[1]);remoteOrder=loaded[2];
    }catch(e){return json(res,503,{ok:false,error:'تعذر قراءة كتالوج Firebase؛ لم تُحذف أي بيانات. '+String(e.message||e).slice(0,160)});}
    const settingsBefore=readJSON('catalog_settings.json',{});
    const orderBefore=remoteOrder&&typeof remoteOrder==='object'&&!Array.isArray(remoteOrder)?remoteOrder:(settingsBefore.catalogOrder||{categories:[],services:{}});
    const sectionNames=new Map();
    const addSection=name=>{const label=String(name??'').trim(),key=normalizeCatalogLabel(label);if(label&&key&&!sectionNames.has(key))sectionNames.set(key,label);};
    for(const row of Object.values(servicesBefore))for(const name of catalogRowGroups(row))addSection(name);
    for(const [key,meta] of Object.entries(metaBefore))addSection(meta?.name||key);
    for(const name of (Array.isArray(orderBefore.categories)?orderBefore.categories:[]))addSection(name);
    if(req.method==='GET')return json(res,200,{ok:true,source:'firebase',verified:true,total:Object.keys(servicesBefore).length,sections:sectionNames.size});
    const b=await bodyJSON(req,1024*1024);
    if(b.confirmation!=='DELETE_ALL_SERVICES')return json(res,422,{ok:false,error:'يلزم تأكيد حذف جميع الخدمات والأقسام.'});
    const at=nowISO(),version=String(Date.now()),emptyOrder={categories:[],services:{}};
    const settingsNext={...settingsBefore,catalogOrder:emptyOrder,catalogUpdatedAt:at,lastDeleteAllServicesAt:at,firebaseSvcsVersion:version,firebaseCatalogLastVerifiedCounts:{services:0,sections:0}};
    // Clear the persistent host mirror before the remote mutation. If Firebase cannot confirm the
    // deletion, reloadLocalCatalogFromFirebase() restores the mirror from the still-authoritative DB.
    try{
      writeJSON('services.json',{});writeJSON('category_meta.json',{});writeJSON('catalog_settings.json',settingsNext);
      ensureNumericSiteServiceIds();
      const patch={services:null,categoryMeta:null,'settings/catalogOrder':emptyOrder,'settings/svcsVersion':version};
      await persistFirebaseCatalogPatch(patch,{verify:true,atomic:true,timeoutMs:60000});
      CATALOG_FIREBASE_READY=true;
      const localServices=readJSON('services.json',{}),localMeta=readJSON('category_meta.json',{}),localSettings=readJSON('catalog_settings.json',{});
      if(Object.keys(localServices).length||Object.keys(localMeta).length||!Array.isArray(localSettings.catalogOrder?.categories)||localSettings.catalogOrder.categories.length||Object.keys(localSettings.catalogOrder?.services||{}).length)throw new Error('لم يتم تنظيف نسخة كتالوج الاستضافة والتحقق منها.');
    }catch(e){
      try{await reloadLocalCatalogFromFirebase();}catch(reloadError){console.error('Global catalog delete recovery reload failed:',String(reloadError.message||reloadError));}
      return json(res,503,{ok:false,persisted:false,error:'لم يتم تأكيد حذف الكتالوج في Firebase؛ راجع القائمة قبل إعادة المحاولة. '+String(e.message||e).slice(0,160)});
    }
    purgeCatalogServiceSnapshots();
    return json(res,200,{ok:true,deleted:Object.keys(servicesBefore).length,deletedSections:sectionNames.size,remainingServices:0,remainingSections:0,storage:'firebase+verified-server-cache',verified:true,backupCreated:false,message:'تم حذف الخدمات وبيانات الأقسام وترتيبها من Firebase ونسخة الاستضافة. لم تُنشأ نسخة احتياطية، وتم تنظيف النسخ القديمة الخاصة بحذف الكل.'});
  }

  // Admin service maintenance: filter, reclassify or delete provider-backed catalog services.
  // Every mutation is Firebase-first, verified, permanently applied and admin-only; catalog snapshots are not retained.
  if(p==='/api/admin/catalog/delete-services'&&(req.method==='GET'||req.method==='POST')){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const normPlatform=value=>{
      const key=normalizeCatalogLabel(String(value??''));
      const defs={
        Instagram:['instagram','insta','انستجرام','انستغرام','انستا'],
        Tiktok:['tiktok','tik tok','تيك توك','تيكتوك'],
        Facebook:['facebook','فيسبوك','فيس بوك'],
        Youtube:['youtube','يوتيوب'],
        Telegram:['telegram','تلجرام','تيليجرام','تليجرام'],
        Twitter:['twitter','تويتر','x.com'],
        Snapchat:['snapchat','سناب شات','سناب'],
        Whatsapp:['whatsapp','واتساب','واتس اب'],
        Linkedin:['linkedin','لينكدان','لينكدإن'],
        Other:['other','عام','اخرى','أخرى','smm']
      };
      for(const [platform,aliases] of Object.entries(defs))if(aliases.some(a=>key===normalizeCatalogLabel(a)))return platform;
      return '';
    };
    const platformOf=row=>{
      for(const value of [row?.servicePlatform,row?.platform,...(Array.isArray(row?.platforms)?row.platforms:[]),...(Array.isArray(row?.apps)?row.apps:[]),row?.app]){
        const exact=normPlatform(value);if(exact)return exact;
      }
      return 'Other';
    };
    const providerOf=row=>String(row?.providerId??row?.providerID??row?.provider??row?.sourceProviderId??'').trim();
    const providerNameMap=()=>{
      const root=readJSON('providers.runtime.json',readJSON('providers.json',{}));
      const providers=root?.providers&&typeof root.providers==='object'?root.providers:{};
      return providers;
    };
    if(req.method==='GET'){
      let services;
      try{await ensureLocalServiceCatalogSeeded();services=catalogObject(await firebaseGetJson('services',12000));}catch(e){return json(res,503,{ok:false,error:'تعذر قراءة الخدمات من Firebase؛ لم يتم عرض قائمة قديمة. '+String(e.message||e).slice(0,150)});}
      const provs=providerNameMap();
      const providerIds=new Set(Object.keys(provs));
      for(const row of Object.values(services))if(providerOf(row))providerIds.add(providerOf(row));
      const providers=[...providerIds].map(id=>({id,name:String(provs[id]?.name||provs[id]?.title||id)})).sort((a,b)=>a.name.localeCompare(b.name,'ar'));
      const items=Object.entries(services).map(([key,row])=>({
        key,name:String(row?.name||row?.title||'خدمة بدون اسم'),
        platform:platformOf(row),providerId:providerOf(row),
        providerName:String(provs[providerOf(row)]?.name||provs[providerOf(row)]?.title||providerOf(row)||'بدون مزود'),
        providerServiceId:String(row?.providerServiceId||row?.smmpartyId||row?.sourceServiceId||row?.serviceId||''),
        category:String(row?.category||row?.groups?.[0]||row?.categories?.[0]||'عام'),
        categories:[...new Set([row?.category,...(Array.isArray(row?.groups)?row.groups:[]),...(Array.isArray(row?.categories)?row.categories:[])].map(x=>String(x||'').trim()).filter(Boolean))],
        price:Number(row?.sellingUsd??row?.rateUsd??row?.price??0),
        active:row?.active!==false&&row?.enabled!==false&&row?.hidden!==true&&row?.deleted!==true
      }));
      return json(res,200,{ok:true,source:'firebase',verified:true,providers,items,total:items.length});
    }
    const b=await bodyJSON(req,5*1024*1024);
    const action=String(b.action||'').trim();
    const platform=normPlatform(b.platform);
    const providerId=String(b.providerId??'all').trim()||'all';
    if(action==='reclassify'){
      const newPlatform=normPlatform(b.newPlatform);
      const keys=[...new Set((Array.isArray(b.keys)?b.keys:[]).map(x=>String(x??'').trim()).filter(Boolean))];
      if(!newPlatform||newPlatform==='all')return json(res,422,{ok:false,error:'اختر المنصة الصحيحة التي تريد نقل الخدمات إليها.'});
      if(!keys.length||keys.length>1000)return json(res,422,{ok:false,error:'حدد من خدمة واحدة إلى 1000 خدمة لتصحيح منصتها.'});
      if(b.confirmation!=='RECLASSIFY_PLATFORM')return json(res,422,{ok:false,error:'يلزم تأكيد تصحيح المنصة.'});
      let services;
      try{await ensureLocalServiceCatalogSeeded();services=catalogObject(await firebaseGetJson('services',12000));}catch(e){return json(res,503,{ok:false,error:'تعذر قراءة Firebase؛ لم يتم تعديل أي خدمة. '+String(e.message||e).slice(0,150)});}
      const patch={};let changed=0;
      for(const key of keys){
        const old=services[key];if(!old||typeof old!=='object')return json(res,409,{ok:false,error:'تغيّرت قائمة الخدمات أو لم تعد الخدمة موجودة؛ حدّث القائمة وأعد الاختيار.'});
        const row={...old,app:newPlatform,apps:[newPlatform],platforms:[newPlatform],platform:newPlatform,servicePlatform:newPlatform,imagePlatform:newPlatform,updatedAt:nowISO(),updatedBy:String(session(req)?.username||ADMIN_USER)};
        patch['services/'+key]=row;changed++;
      }
      patch['settings/svcsVersion']=String(Date.now());
      try{await persistFirebaseCatalogPatch(patch,{verify:true,atomic:true,timeoutMs:45000});
        const localServices=readJSON('services.json',{});
        const runtimeFields=['providerAvailable','availabilityStatus','providerAvailabilityReason','providerCheckedAt','lastProviderCheckAt','providerMissingSince','lastProviderError','providerSyncError'];
        for(const key of keys){
          const localRow=localServices[key]||services[key],updated=patch['services/'+key];
          localServices[key]={...localRow,...updated};
          for(const field of runtimeFields)if(localRow&&localRow[field]!==undefined)localServices[key][field]=localRow[field];
        }
        writeJSON('services.json',localServices);markCatalogSeeded();
      }
      catch(e){return json(res,503,{ok:false,error:'لم يتم تأكيد تصحيح المنصة داخل Firebase. '+String(e.message||e).slice(0,150)});}
      return json(res,200,{ok:true,action,changed,platform:newPlatform,storage:'firebase',verified:true});
    }
    if(action!=='selected'&&action!=='all')return json(res,422,{ok:false,error:'اختر حذف المحدد أو حذف كل الخدمات المطابقة للتصفية.'});
    const categoryFilter=normalizeCatalogLabel(String(b.category??''));
    const categoryNamesOf=row=>[row?.category,...(Array.isArray(row?.groups)?row.groups:[]),...(Array.isArray(row?.categories)?row.categories:[])].map(x=>normalizeCatalogLabel(String(x??''))).filter(Boolean);
    if(action==='all'&&!platform&&providerId==='all'&&!categoryFilter)return json(res,422,{ok:false,error:'اختر منصة أو مزوداً أو قسماً محدداً قبل حذف مجموعة خدمات.'});
    if(b.confirmation!=='DELETE_PLATFORM_SERVICES')return json(res,422,{ok:false,error:'تأكيد الحذف غير صحيح.'});
    let servicesBefore,metaBefore,remoteOrder;
    try{
      await ensureLocalServiceCatalogSeeded();
      const loaded=await Promise.all([firebaseGetJson('services',12000),firebaseGetJson('categoryMeta',12000),firebaseGetJson('settings/catalogOrder',9000)]);
      servicesBefore=catalogObject(loaded[0]);metaBefore=catalogObject(loaded[1]);remoteOrder=loaded[2];
    }catch(e){return json(res,503,{ok:false,error:'تعذر قراءة كتالوج Firebase؛ لم يتم حذف أي خدمة. '+String(e.message||e).slice(0,150)});}
    const localServicesBefore=readJSON('services.json',{}),settingsBefore=readJSON('catalog_settings.json',{});
    if(remoteOrder&&typeof remoteOrder==='object'&&!Array.isArray(remoteOrder))settingsBefore.catalogOrder=canonicalCatalogOrder(remoteOrder,metaBefore);
    const matchesFilter=(row)=>(!platform||platformOf(row)===platform)&&(providerId==='all'||(providerId==='__none__'?!providerOf(row):providerOf(row)===providerId))&&(!categoryFilter||categoryNamesOf(row).includes(categoryFilter));
    let keys=[];
    if(action==='all'){
      keys=Object.entries(servicesBefore).filter(([,row])=>matchesFilter(row)).map(([key])=>key);
    }else{
      const requested=[...new Set((Array.isArray(b.keys)?b.keys:[]).map(x=>String(x??'').trim()).filter(Boolean))];
      if(!requested.length||requested.length>1000)return json(res,422,{ok:false,error:'حدد من خدمة واحدة إلى 1000 خدمة للحذف، أو استخدم حذف الكل بعد اختيار المنصة والمزود.'});
      const invalid=requested.filter(key=>!servicesBefore[key]||!matchesFilter(servicesBefore[key]));
      if(invalid.length)return json(res,409,{ok:false,error:'بعض الخدمات لا تطابق المنصة أو المزود المحدد. حدّث القائمة وأعد الاختيار.'});
      keys=requested;
    }
    if(!keys.length)return json(res,404,{ok:false,error:'لا توجد خدمات تطابق المنصة والمزود المحددين.'});
    if(keys.length>8000)return json(res,413,{ok:false,error:'عدد الخدمات كبير جدًا لعملية حذف واحدة؛ اختر مزودًا محددًا أو احذفها على دفعات.'});
    const selected=new Set(keys);
    const servicesNext={...servicesBefore};for(const key of keys)delete servicesNext[key];
    const metaNext={...metaBefore};
    for(const [metaKey,meta] of Object.entries(metaNext)){
      if(meta&&typeof meta==='object'&&Array.isArray(meta.serviceKeys)){
        const serviceKeys=meta.serviceKeys.map(String).filter(key=>!selected.has(key));
        if(serviceKeys.length!==meta.serviceKeys.length)metaNext[metaKey]={...meta,serviceKeys};
      }
    }
    const settingsNext={...settingsBefore};
    const order=settingsNext.catalogOrder&&typeof settingsNext.catalogOrder==='object'?settingsNext.catalogOrder:{categories:[],services:{}};
    const orderServices=order.services&&typeof order.services==='object'&&!Array.isArray(order.services)?{...order.services}:{};
    for(const [bucket,ids] of Object.entries(orderServices))if(Array.isArray(ids))orderServices[bucket]=ids.map(String).filter(key=>!selected.has(key));
    settingsNext.catalogOrder=canonicalCatalogOrder({...order,services:orderServices},metaNext);settingsNext.catalogUpdatedAt=nowISO();settingsNext.lastServiceDeleteAt=nowISO();
    const remotePatch={};
    for(const key of keys)remotePatch['services/'+key]=null;
    for(const [metaKey,meta] of Object.entries(metaNext))if(!catalogValuesEqual(metaBefore[metaKey]??null,meta))remotePatch['categoryMeta/'+metaKey]=meta;
    remotePatch['settings/catalogOrder']=settingsNext.catalogOrder;remotePatch['settings/svcsVersion']=String(Date.now());
    try{
      await persistFirebaseCatalogPatch(remotePatch,{verify:true,atomic:true,timeoutMs:60000});
      const localServicesNext={...localServicesBefore};for(const key of keys)delete localServicesNext[key];
      writeJSON('services.json',localServicesNext);writeJSON('category_meta.json',metaNext);
      settingsNext.firebaseSvcsVersion=String(Date.now());writeJSON('catalog_settings.json',settingsNext);markCatalogSeeded();
    }catch(e){
      return json(res,503,{ok:false,persisted:false,error:'لم يتم تأكيد حذف الخدمات في Firebase؛ راجع القائمة قبل إعادة المحاولة. '+String(e.message||e).slice(0,160)});
    }
    purgeCatalogServiceSnapshots();
    return json(res,200,{ok:true,action,platform,providerId,deleted:keys.length,deletedKeys:keys,backupCreated:false,storage:'firebase',verified:true});
  }

  if(p==='/api/admin/catalog/sections'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    try{await ensureLocalServiceCatalogSeeded();}catch(e){return json(res,503,{ok:false,error:'تعذر الاتصال بقاعدة Firebase؛ لم يتم تعديل الأقسام: '+String(e.message||e).slice(0,160)});}
    const b=await bodyJSON(req,2*1024*1024),action=String(b.action||'').trim().toLowerCase();
    const labelKey=value=>normalizeCatalogLabel(String(value??'').normalize('NFKC').replace(/[\u200B-\u200F\uFEFF]/g,'').replace(/\s+/g,' '));
    const metaKeyFor=(root,name)=>Object.keys(root||{}).find(k=>labelKey(root[k]?.name||k)===labelKey(name))||'';
    const allowedPlatforms=new Set(['Instagram','Tiktok','Facebook','Youtube','Telegram','Twitter','Snapchat','Whatsapp','Linkedin','Other']);
    const allowedImagePresets=new Set(['Instagram','Tiktok','Facebook','Youtube','Telegram','Twitter','Snapchat','Whatsapp','Linkedin','Other','Followers','Likes','Views','Comments','Growth','SMM','VIP']);
    const cleanPlatforms=value=>[...new Set((Array.isArray(value)?value:[value]).map(x=>String(x??'').trim()).filter(x=>allowedPlatforms.has(x)))].slice(0,10);
    const serviceName=(row)=>String(row?.name||row?.title||'').trim();
    const categoryName=String(b.name||'').replace(/[\u200B-\u200F\uFEFF]/g,'').replace(/\s+/g,' ').trim().slice(0,150);
    const servicesBefore=readJSON('services.json',{}),metaBefore=readJSON('category_meta.json',{}),settingsBefore=readJSON('catalog_settings.json',{});
    let servicesNext={...servicesBefore},metaNext={...metaBefore},settingsNext={...settingsBefore};
    try{
      if(action==='create'){
        const raw=Array.isArray(b.sections)?b.sections:[];
        if(!raw.length||raw.length>100)return json(res,422,{ok:false,error:'أدخل من قسم واحد إلى 100 قسم في العملية الواحدة.'});
        const seen=new Set(),requested=[];
        for(const item of raw){
          const name=String(item?.name??'').replace(/[\u200B-\u200F\uFEFF]/g,'').replace(/\s+/g,' ').trim().slice(0,150);
          if(!name)return json(res,422,{ok:false,error:'يوجد اسم قسم فارغ؛ لم يتم حفظ أي تغيير.'});
          const n=labelKey(name);if(seen.has(n))continue;seen.add(n);
          const platforms=cleanPlatforms(item?.platforms??b.platforms);
          const imagePreset55=String(item?.imagePreset55||'').trim();if(imagePreset55&&!allowedImagePresets.has(imagePreset55))return json(res,422,{ok:false,error:'اختيار صورة القسم غير موجود في مكتبة المشروع.'});const pinScopeRaw=String(item?.pinScope||'').trim();const pinScope=pinScopeRaw==='platform'?'platform':pinScopeRaw==='all'?'all':'';const pinnedPlatform=String(item?.pinnedPlatform||'').trim();if(pinScope==='platform'&&item?.pinned===true&&!allowedPlatforms.has(pinnedPlatform))return json(res,422,{ok:false,error:'اختر منصة صحيحة لتثبيت القسم.'});requested.push({name,platforms,pinned:typeof item?.pinned==='boolean'?item.pinned:(typeof b.pinned==='boolean'?b.pinned:false),image:String(item?.image||'').trim().slice(0,2000),imagePreset55,pinScope,pinnedPlatform});
        }
        if(!requested.length)return json(res,422,{ok:false,error:'لا توجد أسماء أقسام فريدة للحفظ.'});
        for(const item of requested){
          let key=metaKeyFor(metaNext,item.name)||normalizeCatalogKey(item.name),suffix=1;
          while(Object.prototype.hasOwnProperty.call(metaNext,key)&&labelKey(metaNext[key]?.name||key)!==labelKey(item.name)){key=(normalizeCatalogKey(item.name)+'_'+suffix++).slice(0,100);}
          const old=metaNext[key]&&typeof metaNext[key]==='object'?metaNext[key]:{};
          metaNext[key]={...old,name:item.name,platforms:item.platforms.length?item.platforms:(Array.isArray(old.platforms)?old.platforms:[]),...(item.image?{image:item.image}:{}),...(item.imagePreset55?{imagePreset55:item.imagePreset55}:{}),pinned:item.pinned===true||old.pinned===true,pinScope:item.pinScope||old.pinScope||'all',pinnedPlatform:item.pinScope==='all'?'':(item.pinnedPlatform||old.pinnedPlatform||''),createdAt:old.createdAt||nowISO(),updatedAt:nowISO(),updatedBy:String(session(req)?.username||ADMIN_USER)};
          if(!Array.isArray(settingsNext.catalogOrder?.categories))settingsNext.catalogOrder={...(settingsNext.catalogOrder||{}),categories:[],services:settingsNext.catalogOrder?.services||{}};
          if(!settingsNext.catalogOrder.categories.some(x=>labelKey(x)===labelKey(item.name)))settingsNext.catalogOrder.categories.push(item.name);
        }
        settingsNext.catalogOrder=canonicalCatalogOrder(settingsNext.catalogOrder,metaNext);settingsNext.catalogUpdatedAt=nowISO();
        const remotePatch={};for(const [key,row] of Object.entries(metaNext))if(!catalogValuesEqual(metaBefore[key]??null,row))remotePatch['categoryMeta/'+key]=row;
        remotePatch['settings/catalogOrder']=settingsNext.catalogOrder;remotePatch['settings/svcsVersion']=String(Date.now());
        try{await persistFirebaseCatalogPatch(remotePatch,{verify:true,atomic:true,timeoutMs:35000});}catch(e){return json(res,503,{ok:false,error:'لم يتم حفظ الأقسام في Firebase، لذلك لم نعلن نجاح الإضافة: '+String(e.message||e).slice(0,160)});}
        writeJSON('category_meta.json',metaNext);writeJSON('catalog_settings.json',settingsNext);
        return json(res,200,{ok:true,action,created:requested.length,sections:requested.map(x=>x.name),storage:'firebase',storageMode:'firebase',verified:true});
      }
      if(action==='pin'){
        const name=categoryName;if(!name)return json(res,422,{ok:false,error:'اسم القسم مطلوب.'});
        if(typeof b.pinned!=='boolean')return json(res,422,{ok:false,error:'حدد حالة التثبيت.'});
        let key=metaKeyFor(metaNext,name)||normalizeCatalogKey(name);const old=metaNext[key]&&typeof metaNext[key]==='object'?metaNext[key]:{};
        const pinScope=b.pinScope===undefined?String(old.pinScope||'all'):(String(b.pinScope)==='platform'?'platform':'all');const pinnedPlatform=b.pinnedPlatform===undefined?String(old.pinnedPlatform||'') : String(b.pinnedPlatform||'');if(b.pinned===true&&pinScope==='platform'&&!allowedPlatforms.has(pinnedPlatform))return json(res,422,{ok:false,error:'اختر منصة صحيحة لتثبيت القسم.'});metaNext[key]={...old,name:String(old.name||name),pinned:b.pinned,pinScope,pinnedPlatform,createdAt:old.createdAt||nowISO(),updatedAt:nowISO(),updatedBy:String(session(req)?.username||ADMIN_USER)};
        const ord=settingsNext.catalogOrder&&typeof settingsNext.catalogOrder==='object'?settingsNext.catalogOrder:{categories:[],services:{}};
        if(!Array.isArray(ord.categories))ord.categories=[];if(!ord.categories.some(x=>labelKey(x)===labelKey(name)))ord.categories.push(name);
        settingsNext.catalogOrder=canonicalCatalogOrder(ord,metaNext);settingsNext.catalogUpdatedAt=nowISO();
        const remotePatch={};for(const [metaKey,metaValue] of Object.entries(metaNext))if(!catalogValuesEqual(metaBefore[metaKey]??null,metaValue))remotePatch['categoryMeta/'+metaKey]=metaValue;
        remotePatch['settings/catalogOrder']=settingsNext.catalogOrder;remotePatch['settings/svcsVersion']=String(Date.now());
        try{await persistFirebaseCatalogPatch(remotePatch,{verify:true,atomic:true,timeoutMs:30000});}catch(e){return json(res,503,{ok:false,error:'تعذر تثبيت القسم في Firebase؛ لم يتم تأكيد الحفظ: '+String(e.message||e).slice(0,150)});}
        writeJSON('category_meta.json',metaNext);writeJSON('catalog_settings.json',settingsNext);
        return json(res,200,{ok:true,action,pinned:b.pinned,pinScope,pinnedPlatform,name,storage:'firebase',storageMode:'firebase',verified:true});
      }
      if(action==='update'){
        const name=categoryName;if(!name)return json(res,422,{ok:false,error:'اسم القسم مطلوب.'});
        const imagePreset55=String(b.imagePreset55||'').trim();
        if(!allowedImagePresets.has(imagePreset55))return json(res,422,{ok:false,error:'اختر صورة من مكتبة الصور الموجودة داخل المشروع.'});
        const pinScope=String(b.pinScope||'all')==='platform'?'platform':'all';
        const pinned=b.pinned===true;
        const pinnedPlatform=String(b.pinnedPlatform||'').trim();
        if(pinned&&pinScope==='platform'&&!allowedPlatforms.has(pinnedPlatform))return json(res,422,{ok:false,error:'اختر منصة صحيحة لتثبيت القسم.'});
        const key=metaKeyFor(metaNext,name)||normalizeCatalogKey(name);const old=metaNext[key]&&typeof metaNext[key]==='object'?metaNext[key]:{};
        metaNext[key]={...old,name:String(old.name||name),platforms:Array.isArray(b.platforms)?cleanPlatforms(b.platforms):(Array.isArray(old.platforms)?old.platforms:[]),image:'',imagePreset55,customImage:false,imageIsCustom:false,pinned,pinScope,pinnedPlatform:pinScope==='platform'?pinnedPlatform:'',createdAt:old.createdAt||nowISO(),updatedAt:nowISO(),updatedBy:String(session(req)?.username||ADMIN_USER)};
        const ord=settingsNext.catalogOrder&&typeof settingsNext.catalogOrder==='object'?settingsNext.catalogOrder:{categories:[],services:{}};
        if(!Array.isArray(ord.categories))ord.categories=[];
        if(!ord.categories.some(x=>labelKey(x)===labelKey(name)))ord.categories.push(name);
        // Platform-only pins must not remain at the global top from an older global-pin setting.
        if(pinned&&pinScope==='platform'){ord.categories=ord.categories.filter(x=>labelKey(x)!==labelKey(name));ord.categories.push(name);}
        settingsNext.catalogOrder=canonicalCatalogOrder(ord,metaNext);settingsNext.catalogUpdatedAt=nowISO();
        const remotePatch={};for(const [metaKey,metaValue] of Object.entries(metaNext))if(!catalogValuesEqual(metaBefore[metaKey]??null,metaValue))remotePatch['categoryMeta/'+metaKey]=metaValue;
        remotePatch['settings/catalogOrder']=settingsNext.catalogOrder;remotePatch['settings/svcsVersion']=String(Date.now());
        try{await persistFirebaseCatalogPatch(remotePatch,{verify:true,atomic:true,timeoutMs:30000});}catch(e){return json(res,503,{ok:false,error:'تعذر حفظ صورة وتثبيت القسم في Firebase؛ لم يتم تأكيد التعديل: '+String(e.message||e).slice(0,150)});}
        writeJSON('category_meta.json',metaNext);writeJSON('catalog_settings.json',settingsNext);
        return json(res,200,{ok:true,action,name,imagePreset55,pinned,pinScope,pinnedPlatform:pinScope==='platform'?pinnedPlatform:'',storage:'firebase',storageMode:'firebase',verified:true});
      }
      if(action==='delete'){
        const name=categoryName;if(!name)return json(res,422,{ok:false,error:'اسم القسم مطلوب.'});
        if(b.confirmation!=='DELETE_SECTION')return json(res,422,{ok:false,error:'تأكيد الحذف غير صحيح.'});
        const target=labelKey(name),matchedMetaKeys=Object.keys(metaNext).filter(k=>labelKey(metaNext[k]?.name||k)===target);
        const serviceIdsDeleted=[],serviceIdsUnlinked=[];let matches=0;
        for(const [key,row] of Object.entries(servicesNext)){
          if(!row||typeof row!=='object')continue;const groups=catalogRowGroups(row);if(!groups.some(g=>labelKey(g)===target))continue;matches++;
          const remaining=groups.filter(g=>labelKey(g)!==target);const isAll=row.showInAll===true||String(row.scope||'').toLowerCase()==='all';
          if(!remaining.length&&!isAll){delete servicesNext[key];serviceIdsDeleted.push(key);continue;}
          servicesNext[key]={...row,groups:remaining,categories:remaining,category:remaining[0]||'',...(isAll?{scope:'all',showInAll:true}:{})};serviceIdsUnlinked.push(key);
        }
        for(const key of matchedMetaKeys)delete metaNext[key];
        // Purge dangling service references from every remaining section metadata record.
        const remainingIds=new Set(Object.keys(servicesNext));
        for(const [metaKey,meta] of Object.entries(metaNext))if(meta&&typeof meta==='object'&&Array.isArray(meta.serviceKeys))metaNext[metaKey]={...meta,serviceKeys:[...new Set(meta.serviceKeys.map(String))].filter(k=>remainingIds.has(k))};
        const order=settingsNext.catalogOrder&&typeof settingsNext.catalogOrder==='object'?settingsNext.catalogOrder:{categories:[],services:{}};
        order.categories=(Array.isArray(order.categories)?order.categories:[]).filter(x=>labelKey(x)!==target);
        const orderServices=order.services&&typeof order.services==='object'&&!Array.isArray(order.services)?order.services:{};
        for(const [bucket,ids] of Object.entries(orderServices)){
          if(labelKey(bucket)===target||matchedMetaKeys.some(k=>labelKey(k)===labelKey(bucket))){delete orderServices[bucket];continue;}
          if(Array.isArray(ids))orderServices[bucket]=ids.map(String).filter(k=>!serviceIdsDeleted.includes(k)&&remainingIds.has(k));
        }
        order.services=orderServices;settingsNext.catalogOrder=canonicalCatalogOrder(order,metaNext);settingsNext.catalogUpdatedAt=nowISO();settingsNext.lastSectionDeleteAt=nowISO();
        let wroteServices=false,wroteMeta=false,wroteSettings=false;
        try{writeJSON('services.json',servicesNext);wroteServices=true;ensureNumericSiteServiceIds();writeJSON('category_meta.json',metaNext);wroteMeta=true;writeJSON('catalog_settings.json',settingsNext);wroteSettings=true;}
        catch(e){try{if(wroteServices)writeJSON('services.json',servicesBefore);if(wroteMeta)writeJSON('category_meta.json',metaBefore);if(wroteSettings)writeJSON('catalog_settings.json',settingsBefore);ensureNumericSiteServiceIds();}catch(rollbackError){console.error('Catalog section delete rollback failed:',String(rollbackError.message||rollbackError));}throw e;}
        // Firebase is the authoritative catalog: delete exclusive services, update shared services,
        // remove the deleted category metadata and persist the final ordering in one verified patch.
        const remotePatch={};
        for(const key of serviceIdsDeleted)remotePatch['services/'+key]=null;
        for(const key of serviceIdsUnlinked)remotePatch['services/'+key]=servicesNext[key];
        for(const key of matchedMetaKeys)remotePatch['categoryMeta/'+key]=null;
        for(const [metaKey,meta] of Object.entries(metaNext))if(!catalogValuesEqual(metaBefore[metaKey]??null,meta))remotePatch['categoryMeta/'+metaKey]=meta;
        remotePatch['settings/catalogOrder']=settingsNext.catalogOrder;remotePatch['settings/svcsVersion']=String(Date.now());
        try{await persistFirebaseCatalogPatch(remotePatch,{verify:true,atomic:true,timeoutMs:45000});}
        catch(e){try{writeJSON('services.json',servicesBefore);writeJSON('category_meta.json',metaBefore);writeJSON('catalog_settings.json',settingsBefore);ensureNumericSiteServiceIds();}catch(rollbackError){console.error('Catalog Firebase rollback failed:',String(rollbackError.message||rollbackError));}return json(res,503,{ok:false,error:'فشل تأكيد حذف القسم وتعديل الخدمات في Firebase؛ لم تُعرض العملية كنجاح. '+String(e.message||e).slice(0,160)});}
        purgeCatalogServiceSnapshots();
        return json(res,200,{ok:true,action,name,matchedServices:matches,deletedServices:serviceIdsDeleted.length,unlinkedServices:serviceIdsUnlinked.length,deletedServiceKeys:serviceIdsDeleted,deletedMetadataKeys:matchedMetaKeys,backupCreated:false,storage:'firebase',storageMode:'firebase',firebaseVerified:true});
      }
      return json(res,422,{ok:false,error:'عملية الأقسام غير مدعومة. استخدم create أو pin أو delete.'});
    }catch(e){return json(res,500,{ok:false,error:'تعذر حفظ تغيير الأقسام. لم نعرض العملية كنجاح: '+String(e.message||e).slice(0,180)});}
  }
  if(p==='/api/admin/catalog'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req,10*1024*1024);const rawPath=String(b.path||'');const mode=String(b.mode||'set');
    try{await ensureLocalServiceCatalogSeeded();}catch(e){return json(res,503,{ok:false,error:'تعذر الاتصال بقاعدة Firebase؛ لم يتم حفظ التغيير: '+String(e.message||e).slice(0,160)});}
    const out=catalogMutatePath(rawPath,mode,b.value);if(!out.ok)return json(res,422,out);
    try{const verified=await persistCatalogPathMutation(rawPath,mode,b.value);const spec=catalogPathSpec(rawPath);if(spec&&(spec.bucket==='services'||spec.bucket==='categoryMeta')){const cfg=readJSON('catalog_settings.json',{});if(cfg.catalogOrder)await firebaseWriteJson('settings/catalogOrder',cfg.catalogOrder,12000);await firebaseWriteJson('settings/svcsVersion',String(Date.now()),8000);}return json(res,200,{ok:true,persisted:true,storage:'firebase',storageMode:'firebase',path:verified.path,verified:true});}
    catch(e){try{await reloadLocalCatalogFromFirebase();}catch(reloadError){console.error('Firebase catalog rollback reload failed:',String(reloadError.message||reloadError));}return json(res,503,{ok:false,persisted:false,path:rawPath,error:'لم يتم تأكيد حفظ التغيير في Firebase؛ أُلغيت نتيجة العملية ولم تُعرض كنجاح. '+String(e.message||e).slice(0,160)});}
  }
  if(p==='/api/admin/catalog/batch'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req,10*1024*1024);const out=catalogApplyBatch(b.updates);if(!out.ok)return json(res,422,out);
    try{await persistCatalogBatchToFirebase(b.updates||{});await firebaseWriteJson('settings/svcsVersion',String(Date.now()),8000);return json(res,200,{ok:true,persisted:true,count:out.count,storage:'firebase',storageMode:'firebase',verified:true});}
    catch(e){try{await reloadLocalCatalogFromFirebase();}catch(reloadError){console.error('Firebase catalog batch rollback reload failed:',String(reloadError.message||reloadError));}return json(res,503,{ok:false,persisted:false,error:'فشل تأكيد حفظ دفعة الكتالوج في Firebase؛ لم تُعلن العملية كنجاح. '+String(e.message||e).slice(0,160)});}
  }
  // v1.5.97: retired manual database upload/import/backup/restore tools.
  if(/^\/api\/admin\/(?:reset|database\/(?:backup|restore)|legacy-import\/(?:upload|preview|apply|status)|firebase\/import-catalog)$/.test(p)){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    return json(res,410,{ok:false,error:'تم تعطيل أدوات رفع واستيراد ونسخ واستعادة أو حذف قاعدة البيانات من لوحة الإدارة حفاظاً على البيانات.'});
  }

  // Download an admin-only portable snapshot. Secrets/Telegram tokens/provider keys are excluded.
  if(p==='/api/admin/database/backup'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    try{
      const firebaseRoot=await readFirebaseRootForBackup();
      const safeFirebase=sanitizeBackupValue(firebaseRoot);
      const localFiles={};
      for(const name of SADA_DB_BACKUP_FILES){
        const full=path.join(DATA,name);
        if(!fs.existsSync(full))continue;
        try{const val=JSON.parse(fs.readFileSync(full,'utf8'));localFiles[name]=sanitizeBackupValue(val,[name]);}catch(_){}
      }
      let legacySeedArchiveBase64='',legacySeedEncBase64='';
      const archivePath=path.join(ROOT,LEGACY_SEED_ARCHIVE_RELATIVE),encryptedSeedPath=path.join(ROOT,LEGACY_SEED_ENCRYPTED_FILE);
      if(fs.existsSync(archivePath))legacySeedArchiveBase64=fs.readFileSync(archivePath).toString('base64');
      else if(fs.existsSync(encryptedSeedPath))legacySeedEncBase64=fs.readFileSync(encryptedSeedPath).toString('base64');
      const backup={format:SADA_DB_BACKUP_FORMAT,schemaVersion:1,appVersion:APP_VERSION,buildId:BUILD_ID,createdAt:nowISO(),secretsIncluded:false,notes:['هذه النسخة تحتوي بيانات شخصية خاصة بالمستخدمين والطلبات؛ احفظها بسرية ولا ترفعها إلى مستودع عام.','تم استبعاد التوكنات ومفاتيح API وأسرار المزودين وكلمات المرور النصية وبيانات التحقق المؤقتة. تصدير Base44 لا يحتوي كلمات المرور الأصلية.','الاستعادة تدمج السجلات الناقصة وتحافظ على قيم الإنتاج الحالية. لا توجد قاعدة Base44 مضمّنة في هذا الإصدار، ولا يحدث استيراد تلقائي.'],counts:currentDatabaseCounts(safeFirebase,localFiles),firebaseData:safeFirebase,serverData:localFiles,legacySeedArchiveBase64,legacySeedEncryptedBase64:legacySeedEncBase64};
      const output=Buffer.from(JSON.stringify(backup));
      res.statusCode=200;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="SadaIraq_Database_Backup_${new Date().toISOString().slice(0,10)}.json"`);res.setHeader('Cache-Control','no-store');res.setHeader('Content-Length',String(output.length));return res.end(output);
    }catch(e){return json(res,503,{ok:false,error:'تعذر إنشاء نسخة كاملة من قاعدة الموقع. لم يتم تنزيل نسخة ناقصة: '+String(e.message||e).slice(0,180)});}
  }
  // Restore a portable snapshot by merging missing keys only, not overwriting current balances/orders/settings.
  if(p==='/api/admin/database/restore'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const backup=await readAdminBackupBody(req);
    if(backup.format!==SADA_DB_BACKUP_FORMAT||backup.schemaVersion!==1||!backup.firebaseData||typeof backup.firebaseData!=='object'||Array.isArray(backup.firebaseData))return json(res,422,{ok:false,error:'ملف قاعدة الموقع غير متوافق أو لا يحتوي بيانات Firebase. اختر النسخة الكاملة الصادرة من صدى العراق.'});
    const incoming=sanitizeBackupValue(backup.firebaseData);
    let current;
    try{current=await readFirebaseRootForBackup();}catch(e){return json(res,503,{ok:false,error:'تعذر قراءة قاعدة Firebase الحالية؛ لم تبدأ الاستعادة. '+String(e.message||e).slice(0,120)});}
    const rootPatch={};
    for(const [key,val] of Object.entries(incoming)){rootPatch[key]=mergeBackupPreservingExisting(current[key],val);}
    try{if(Object.keys(rootPatch).length)await patchFirebaseRootForBackup(rootPatch);}catch(e){return json(res,503,{ok:false,error:'فشل حفظ بيانات النسخة في Firebase. لم يتم إعلان نجاح الاستعادة. '+String(e.message||e).slice(0,160)});}
    const restoredFiles=[];
    if(backup.serverData&&typeof backup.serverData==='object'&&!Array.isArray(backup.serverData)){
      for(const name of SADA_DB_BACKUP_FILES){if(!Object.prototype.hasOwnProperty.call(backup.serverData,name))continue;const incomingLocal=sanitizeBackupValue(backup.serverData[name],[name]);const currentLocal=readJSON(name,null);const merged=mergeBackupPreservingExisting(currentLocal,incomingLocal);try{writeJSON(name,merged);restoredFiles.push(name)}catch(e){console.warn('Local database restore file failed:',name,String(e.message||e).slice(0,100));}}
    }
    let seedRestored=false;
    if(typeof backup.legacySeedArchiveBase64==='string'&&backup.legacySeedArchiveBase64){
      const seedPath=path.join(ROOT,LEGACY_SEED_ARCHIVE_RELATIVE);
      if(!fs.existsSync(seedPath)){try{const bytes=Buffer.from(backup.legacySeedArchiveBase64,'base64');if(bytes.length>0&&bytes.length<15*1024*1024){const entries=readZipArchive(bytes);const dbKey=Object.keys(entries).find(k=>k==='sadairaq.db'||k.endsWith('/sadairaq.db'));if(dbKey&&entries[dbKey].subarray(0,16).toString('binary')==='SQLite format 3\u0000'){fs.mkdirSync(path.dirname(seedPath),{recursive:true});fs.writeFileSync(seedPath,bytes,{flag:'wx',mode:0o600});seedRestored=true;}}}catch(e){console.warn('Bundled database archive restore rejected:',String(e.message||e).slice(0,100));}}
    }else if(typeof backup.legacySeedEncryptedBase64==='string'&&backup.legacySeedEncryptedBase64){
      const seedPath=path.join(ROOT,LEGACY_SEED_ENCRYPTED_FILE);
      if(!fs.existsSync(seedPath)){try{const bytes=Buffer.from(backup.legacySeedEncryptedBase64,'base64');if(bytes.length>0&&bytes.length<15*1024*1024&&bytes.subarray(0,8).toString('ascii')==='SADAENC1'){fs.writeFileSync(seedPath,bytes,{flag:'wx',mode:0o600});seedRestored=true;}}catch(_){}}
    }
    let verify={};try{const check=await readFirebaseRootForBackup();verify=currentDatabaseCounts(check,{});}catch(_){}
    return json(res,200,{ok:true,mergedOnly:true,restoredLocalFiles:restoredFiles,legacySeedRestored:seedRestored,counts:verify,message:'اكتملت عملية الدمج. السجلات والقيم الموجودة مسبقاً لم يتم استبدالها. أعد تحميل لوحة الإدارة للتحقق من الأعداد.'});
  }

  if(p==='/api/public/site-order-count'&&req.method==='GET'){
    try{
      const latest=await ensurePublicOrderCounter();
      const latestPublicOrderNo=latest>=3000?latest:null;
      // The homepage needs the latest public number; never download the whole orders collection per visitor.
      return json(res,200,{ok:true,count:latestPublicOrderNo||0,latestPublicOrderNo,source:'firebase-counter',complete:false,totalOrders:null,updatedAt:nowISO()});
    }catch(e){return json(res,503,{ok:false,error:'تعذر قراءة عدّاد الطلبات من Firebase؛ لم نعرض رقماً تخمينياً.',complete:false});}
  }

  if(p==='/api/admin/users-directory'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    let remoteUsers={},remoteOrders={},ordersAvailable=true,warning='';
    try{remoteUsers=await firebaseGetJson('users',12000);remoteUsers=remoteUsers||{};}catch(e){return json(res,503,{ok:false,error:'تعذر قراءة حسابات Firebase: '+String(e.message||e).slice(0,160)});}
    try{remoteOrders=await firebaseGetJson('orders',15000);remoteOrders=remoteOrders||{};}catch(e){ordersAvailable=false;warning='تم تحميل المستخدمين، لكن تعذرت قراءة الطلبات الحقيقية: '+String(e.message||e).slice(0,120);}
    const directory=normalizeCurrentUsers(remoteUsers);
    const orders=ordersAvailable?uniqueActualOrders(remoteOrders,readJSON('orders.json',[])):[];
    const countsByUser=new Map(),countsByLegacyId=new Map();
    for(const o of orders){
      const username=String(o.user||o.username||o.userName||'').trim();if(username)countsByUser.set(username,(countsByUser.get(username)||0)+1);
      const legacyId=String(o.legacyUserId||'').trim();if(legacyId)countsByLegacyId.set(legacyId,(countsByLegacyId.get(legacyId)||0)+1);
    }
    const storedOld=readJSON(LEGACY_USERS_PRIVATE_FILE,[]);
    const stage=await readLegacyStage();
    let remoteLegacyUsers=[];let remoteLegacyError='';
    try{remoteLegacyUsers=await loadLegacyUsersRemote();}catch(e){remoteLegacyError=String(e.message||e).slice(0,120);}
    let legacyUsers=Array.isArray(storedOld)&&storedOld.length?storedOld:(remoteLegacyUsers.length?remoteLegacyUsers:(Array.isArray(stage?.users)?stage.users:[]));
    // Migrate an older local-only snapshot to durable Firebase storage when it is still available.
    if(Array.isArray(storedOld)&&storedOld.length&&!remoteLegacyUsers.length){try{await persistLegacyUsersRemote(storedOld);remoteLegacyUsers=storedOld.map(legacyUserPrivateRow);legacyUsers=storedOld;}catch(e){remoteLegacyError=String(e.message||e).slice(0,120);}}
    const stageOrders=Array.isArray(stage?.orders)?stage.orders:[];
    const legacyStageCounts=new Map();for(const o of stageOrders){const id=String(o.user_id||'');if(id)legacyStageCounts.set(id,(legacyStageCounts.get(id)||0)+1);}
    const mapped=mapLegacyUsersToCurrent(legacyUsers,directory);
    const result=directory.users.map(row=>{
      const count=ordersAvailable?(countsByUser.get(row.username)||0):Number(row.user.totalOrders||0);
      return {username:row.username,name:String(row.user.name||row.user.fullName||row.user.full_name||row.username),email:row.email||'',balance:Number(row.user.balance||0),totalOrders:count,storedTotalOrders:Number(row.user.totalOrders||0),level:String(row.user.level||'مبتدئ'),phone:String(row.user.phone||''),telegram:String(row.user.telegram||''),joined:String(row.user.joined||row.user.createdAt||''),role:String(row.user.role||'user'),readOnlyLegacy:false,hasCurrentAccount:true,firebaseKey:row.key,legacyUserIds:[]};
    });
    const currentByKey=new Map(result.map((u,i)=>[directory.users[i].key,u]));
    let matchedLegacyUsers=0,legacyOnlyUsers=0;
    for(const old of legacyUsers){
      const current=mapped.byLegacyId.get(String(old.id));
      if(current){matchedLegacyUsers++;const row=currentByKey.get(current.key);if(row){row.legacyUserIds.push(String(old.id));if(ordersAvailable){const base=Math.max(countsByLegacyId.get(String(old.id))||0,0);if(base>0)row.totalOrders=Math.max(row.totalOrders,base);}}continue;}
      legacyOnlyUsers++;
      const id=String(old.id||'');
      const count=ordersAvailable?(countsByLegacyId.get(id)||0):(legacyStageCounts.get(id)||0);
      result.push({username:legacyAliasUser(id),name:String(old.arabic_name||old.full_name||old.fullName||('مستخدم قديم '+id.slice(0,8))),email:String(old.email||''),balance:Number((Number(old.balance||0)*FIXED_RATE).toFixed(4)),totalOrders:count,storedTotalOrders:count,level:'سجل قديم',phone:'',telegram:'',joined:String(old.created_date||''),role:'legacy',readOnlyLegacy:true,hasCurrentAccount:false,firebaseKey:'',legacyUserId:id,legacyPending:!storedOld.length});
    }
    const q=String(urlObj.searchParams.get('q')||'').trim().toLowerCase();
    const filtered=result.filter(u=>!q||[u.username,u.name,u.email,u.legacyUserId].some(v=>String(v||'').toLowerCase().includes(q)));
    filtered.sort((a,b)=>Number(b.totalOrders||0)-Number(a.totalOrders||0)||String(b.joined||'').localeCompare(String(a.joined||''))||String(a.name||'').localeCompare(String(b.name||''),'ar'));
    return json(res,200,{ok:true,users:filtered,total:result.length,currentUsers:directory.users.length,legacyUsers:legacyUsers.length,matchedLegacyUsers,legacyOnlyUsers,ordersAvailable,storageDurable:DATA_IS_EXTERNAL||remoteLegacyUsers.length>0,legacyUsersSavedRemotely:remoteLegacyUsers.length>0,source:ordersAvailable?'firebase+server-ledger':'firebase-users-only',warning:warning||(remoteLegacyError?'تعذر قراءة النسخة الدائمة لمستخدمي Base44: '+remoteLegacyError:(!DATA_IS_EXTERNAL&&!remoteLegacyUsers.length?'قائمة المستخدمين القديمة غير محفوظة سحابياً بعد. ارفع ملف التصدير وادمجه مرة أخيرة لحفظها بشكل دائم.':''))});
  }

  if(p==='/api/admin/recharge-stats'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const sources=[
      ['asiacellTransfers',()=>firebaseGetJson('asiacellTransfers',14000)],
      ['payments',()=>firebaseGetJson('payments',14000)],
      ['balanceLedger',()=>firebaseGetJson('balanceLedger',14000)],
      ['users',()=>firebaseGetJson('users',16000)],
    ];
    const settled=await Promise.allSettled(sources.map(async ([name,fn])=>[name,await fn()]));
    const root={},errors=[];
    for(let i=0;i<settled.length;i++){
      const item=settled[i];if(item.status==='fulfilled')root[item.value[0]]=item.value[1]||{};
      else errors.push(sources[i][0]+': '+String(item.reason?.message||item.reason||'failed').slice(0,100));
    }
    const localLedger=readJSON('balance_ledger.json',[]);const candidates=[];
    const add=(value,key='',owner='')=>{
      if(!value||typeof value!=='object'||Array.isArray(value))return;
      const method=String(value.method||value.methodName||value.provider||'').toLowerCase();
      const src=String(value.source||'').toLowerCase(),type=String(value.type||'').toLowerCase(),status=String(value.status||value.state||'completed').toLowerCase();
      const hasTransfer=!!String(value.transferPid||value.transferPID||'').trim();
      const transferIdentity=String(value.id||key||'').trim();
      const sourceConfirmsAutomatic=/(?:asia.?cell|asiacell|آسياسيل)[ _-]*auto|automatic[ _-]*(?:asia.?cell|asiacell)/i.test(src);
      const hasAutomaticEvidence=value.automatic===true||sourceConfirmsAutomatic||(/^AC_/i.test(transferIdentity)&&hasTransfer);
      const isAsia=/asia.?cell|asiacell|آسياسيل/i.test(method+' '+src)||hasTransfer;
      const completed=['completed','complete','success','successful','done','approved','paid'].includes(status);
      if(!isAsia||!hasAutomaticEvidence||!completed||type==='refund'||type==='chargeback'||/manual|admin/i.test(src)||value.manual===true||value.automatic===false)return;
      const amountIQD=Number(value.amountIQD??value.amountIqd??value.amount??value.totalIQD??0);
      if(!Number.isFinite(amountIQD)||amountIQD<=0)return;
      const transferPid=String(value.transferPid||value.transferPID||'').trim();
      const rawId=String(value.id||key||transferPid||'').trim();
      const identity=transferPid?'transfer:'+transferPid:(/^AC_/i.test(rawId)?'transfer:'+rawId.replace(/^AC_/i,''):rawId?'id:'+rawId:'');
      if(!identity)return;
      const username=String(value.username||value.user||value.account||owner||'').trim();
      candidates.push({identity,id:rawId,transferPid,username,amountIQD:Number(amountIQD.toFixed(4)),amountUSD:Number((Number(value.amountUSD??value.amountUsd??(amountIQD/FIXED_RATE))||0).toFixed(6)),method:'آسياسيل تلقائي',createdAt:String(value.createdAt||value.timestamp||value.date||''),status,automatic:true});
    };
    for(const [key,v] of collectionEntries(root.asiacellTransfers))add(v,key,v?.username||v?.user);
    for(const [key,v] of collectionEntries(root.payments))add(v,key,v?.username||v?.user);
    for(const [key,v] of collectionEntries(root.balanceLedger))add(v,key,v?.username||v?.user);
    for(const [username,user] of collectionEntries(root.users)){
      if(!user||typeof user!=='object')continue;
      for(const [key,v] of collectionEntries(user.asiacellTransferIds))add(v,key,String(user.username||username));
      for(const [idx,v] of (Array.isArray(user.rechargeHistory)?user.rechargeHistory:[]).entries())add(v,String(v?.id||idx),String(user.username||username));
    }
    for(const [idx,v] of (Array.isArray(localLedger)?localLedger:[]).entries())add(v,String(v?.id||idx),String(v?.username||v?.user||''));
    const merged=new Map();
    for(const row of candidates){
      const old=merged.get(row.identity);
      // Merge duplicate mirrors of the same transfer; prefer a row carrying username and date.
      if(!old)merged.set(row.identity,row);
      else merged.set(row.identity,{...old,...row,username:row.username||old.username,createdAt:row.createdAt||old.createdAt,amountIQD:Math.max(old.amountIQD,row.amountIQD),amountUSD:Math.max(old.amountUSD,row.amountUSD)});
    }
    const allRows=[...merged.values()].sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));
    const perMap=new Map();let unresolved=0;
    for(const row of allRows){if(!row.username){unresolved++;continue;}const x=perMap.get(row.username)||{username:row.username,count:0,totalIQD:0,totalUSD:0,lastRecharge:''};x.count++;x.totalIQD+=row.amountIQD;x.totalUSD+=row.amountUSD;if((Date.parse(row.createdAt)||0)>(Date.parse(x.lastRecharge)||0))x.lastRecharge=row.createdAt;perMap.set(row.username,x)}
    const perUser=[...perMap.values()].map(x=>({...x,totalIQD:Number(x.totalIQD.toFixed(4)),totalUSD:Number(x.totalUSD.toFixed(6))})).sort((a,b)=>b.totalIQD-a.totalIQD);
    return json(res,200,{ok:true,source:'firebase-asiacell-transfer-records',total:allRows.length,totalIQD:Number(allRows.reduce((n,x)=>n+x.amountIQD,0).toFixed(4)),totalUSD:Number(allRows.reduce((n,x)=>n+x.amountUSD,0).toFixed(6)),perUser,rows:allRows.slice(0,1000),totalRows:allRows.length,displayedRows:Math.min(1000,allRows.length),unresolvedUsernameCount:unresolved,warning:errors.length?'تعذر قراءة بعض مصادر السجل؛ الإحصائيات تشمل المصادر التي أمكن قراءتها فقط: '+errors.join(' | '):unresolved?'بعض التحويلات ليس لها اسم مستخدم محفوظ؛ تظهر ضمن الإجمالي ولا تُنسب إلى حساب بالتخمين.':'',checkedAt:nowISO()});
  }

  if(p==='/api/admin/wallets'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const localStore=readJSON('users.json',{users:{}}),localEntries=Object.entries(localStore.users||{}).filter(([,u])=>u&&typeof u==='object'&&!Array.isArray(u));
    const merged=new Map(),fold=v=>String(v??'').trim().toLocaleLowerCase('en-US');
    const ids=u=>['username','userName','user','handle','login','loginName','email','mail','emailAddress','phone','phoneNumber','uid','firebaseUid','authUid','userId','user_id','authUserId','firebaseKey','databaseKey'].map(k=>fold(u?.[k])).filter(Boolean);
    for(const [key,u] of localEntries){const username=String(u.username||key).trim();if(username)merged.set(fold(username),{...u,username,_source:'local',_firebaseKey:''});}
    let remoteAvailable=false,remoteError='';
    try{
      const root=await firebaseGetJson('users',12000);
      if(root===null||root===undefined)throw new Error('مسار users فارغ في قاعدة Firebase التي يتصل بها الخادم؛ تحقّق من FIREBASE_DATABASE_URL قبل تعديل أي رصيد.');
      if(typeof root!=='object'||Array.isArray(root))throw new Error('شكل بيانات users في Firebase غير متوقع');
      const remoteRows=collectionEntries(root);
      for(const [key,u] of remoteRows){
        if(!u||typeof u!=='object'||Array.isArray(u))continue;
        const decoded=decodeFirebaseSafeKey(key),remoteIds=new Set([...ids(u),fold(key),fold(decoded)].filter(Boolean));
        const localMatches=localEntries.filter(([lk,lu])=>ids({...lu,username:lu.username||lk}).some(value=>remoteIds.has(value)));
        // Link an alias only when a single local profile matches; ambiguous identities must not
        // cause an administrative credit to be applied to the wrong Firebase child.
        const localMatch=localMatches.length===1?localMatches[0]:null;
        const ownUsername=String(u.username||u.userName||u.user||u.handle||u.login||u.loginName||'').trim();
        const username=String(localMatch?.[1]?.username||localMatch?.[0]||ownUsername||decoded||key).trim();
        const mkey=fold(username),prior=merged.get(mkey)||{};
        merged.set(mkey,{...prior,...u,username,_firebaseKey:String(key),_source:localMatch?'firebase+local':'firebase'});
      }
      remoteAvailable=true;
    }catch(e){remoteError=String(e.message||e).slice(0,170);}
    if(!remoteAvailable&&!merged.size)return json(res,503,{ok:false,error:'تعذر جلب المستخدمين من Firebase والخادم. '+remoteError});
    const users=[...merged.values()].filter(u=>String(u.role||'user')!=='admin').map(u=>({username:String(u.username),name:String(u.name||u.fullName||u.full_name||u.username),email:String(firebaseRecordEmail(u)||u.email||u.mail||u.emailAddress||u.email_address||'').trim(),balanceIQD:Number(u.balance||0),balanceUSD:Number((Number(u.balance||0)/FIXED_RATE).toFixed(6)),discountPct:Number(u.discountPct??u.discount??0),level:String(u.level||'مبتدئ'),role:String(u.role||'user'),joined:String(u.joined||u.createdAt||''),source:u._source||'local',firebaseKey:String(u._firebaseKey||''),hasFirebaseRecord:!!String(u._firebaseKey||'')})).sort((a,b)=>a.username.localeCompare(b.username,'ar'));
    return json(res,200,{ok:true,users,source:remoteAvailable?'firebase+local':'local-fallback',partial:!remoteAvailable,warning:remoteAvailable?'':('تعذر الوصول إلى Firebase؛ القائمة الحالية محلية ولا يمكن تعديل أرصدة حسابات غير موجودة في Firebase. '+remoteError),checkedAt:nowISO()});
  }
  if(p==='/api/admin/users/balance'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req),username=String(b.username||'').trim(),email=normalizeEmail(b.email),firebaseKey=String(b.firebaseKey||'').trim(),newBalance=Number(b.balanceIQD),reason=String(b.reason||'تعديل رصيد من لوحة الإدارة').trim().slice(0,500);
    if(!username||(email&&!validEmail(email))||!Number.isFinite(newBalance)||newBalance<0||newBalance>1e12)return json(res,422,{ok:false,error:'حدد اسم المستخدم (والبريد إذا كان متاحاً) ورصيداً غير سالب ضمن النطاق المسموح'});
    try{
      const remote=await resolveAdminWalletUser(username,email,firebaseKey);if(!remote?.firebasePath){const lookup=await inspectAdminWalletLookup(username,email,firebaseKey);return json(res,404,{ok:false,error:walletLookupFailureMessage(lookup),diagnostic:lookup});}
      const tx=await firebaseTransaction(remote.firebasePath,current=>{
        if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-not-found'}};
        const currentEmail=firebaseRecordEmail(current);if(validEmail(email)&&currentEmail&&currentEmail!==email)return {write:false,result:{error:'email-mismatch'}};
        const before=Number(current.balance||0);if(!Number.isFinite(before)||before<0)return {write:false,result:{error:'invalid-balance'}};
        const after=Number(newBalance.toFixed(4));if(before===after)return {write:false,result:{before,after,unchanged:true,user:current}};
        const at=nowISO(),delta=after-before,event={id:'BAL_'+crypto.randomUUID().replace(/-/g,''),username:remote.username||username,user:remote.username||username,email,firebaseKey:String(remote.firebasePath.split('/').slice(1).join('/')),type:delta>0?'charge':delta<0?'deduct':'adjust',amountIQD:Number(Math.abs(delta).toFixed(4)),amountUSD:Number((Math.abs(delta)/FIXED_RATE).toFixed(6)),beforeIQD:before,afterIQD:after,reason,admin:String(session(req)?.username||ADMIN_USER),createdAt:at,method:'admin-set-balance'};
        const history=Array.isArray(current.adminBalanceLedger)?current.adminBalanceLedger.slice(-199):[];history.push(event);current.balance=after;current.adminBalanceLedger=history;current.updatedAt=at;
        return {write:true,value:current,result:{before,after,event,user:current}};
      },12000,8);
      if(tx.result?.error)return json(res,tx.result.error==='email-mismatch'?409:404,{ok:false,error:tx.result.error==='email-mismatch'?'البريد الإلكتروني لا يطابق سجل Firebase؛ لم يتم تغيير الرصيد.':'المستخدم غير موجود أو رصيده غير صالح'});
      const event=tx.result.event;let ledgerSaved=true,ledgerWarning='';if(event){try{await firebaseWriteJson('balanceLedger/'+event.id,event,8000)}catch(e){ledgerSaved=false;ledgerWarning='تم حفظ الرصيد، لكن تعذر حفظ نسخة سجل التدقيق: '+String(e.message||e).slice(0,100)}appendJsonLedger('balance_ledger.json',event)}
      const updated=tx.value||tx.result.user||remote.user;const store=readJSON('users.json',{users:{}});store.users=store.users||{};const localKey=Object.keys(store.users).find(k=>normalizeEmail(store.users[k]?.email||store.users[k]?.mail||store.users[k]?.emailAddress)===email)||Object.keys(store.users).find(k=>k.toLowerCase()===String(remote.username||username).toLowerCase())||String(remote.username||username);store.users[localKey]={...(store.users[localKey]||{}),...updated,username:String(store.users[localKey]?.username||localKey),email,balance:Number(updated.balance||tx.result.after||0)};writeJSON('users.json',store);
      return json(res,200,{ok:true,username:localKey,email,balanceIQD:Number(tx.result.after??updated.balance??0),balanceUSD:Number((Number(tx.result.after??updated.balance??0)/FIXED_RATE).toFixed(6)),beforeIQD:Number(tx.result.before??updated.balance??0),unchanged:!!tx.result.unchanged,ledgerSaved,warning:ledgerWarning||undefined});
    }catch(e){return json(res,502,{ok:false,error:'تعذر حفظ الرصيد في Firebase: '+String(e.message||e).slice(0,160)})}
  }
  if(p==='/api/admin/users/discount'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req),username=String(b.username||'').trim(),email=normalizeEmail(b.email),firebaseKey=String(b.firebaseKey||'').trim(),pct=Number(b.discountPct);
    if(!username||(email&&!validEmail(email))||!Number.isFinite(pct)||pct<0||pct>100)return json(res,422,{ok:false,error:'حدد المستخدم والبريد الصحيح إن وجد ونسبة خصم بين 0 و100'});
    try{
      const found=await resolveAdminWalletUser(username,email,firebaseKey);
      if(!found?.firebasePath||!found?.user)return json(res,404,{ok:false,error:'لم يُعثر على سجل Firebase مطابق وفريد لهذا المستخدم؛ لم يتم تعديل أي بيانات.'});
      const userPath=found.firebasePath;
      const tx=await firebaseTransaction(userPath,current=>{
        if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-not-found'}};
        const currentEmail=firebaseRecordEmail(current);
        if(validEmail(email)&&currentEmail&&currentEmail!==email)return {write:false,result:{error:'email-mismatch'}};
        const before=Number(current.discountPct??current.discount??0),after=Number(pct.toFixed(2));
        if(before===after)return {write:false,result:{before,after,unchanged:true}};
        current.discountPct=after;current.updatedAt=nowISO();return {write:true,value:current,result:{before,after}};
      },10000,8);
      if(tx.result?.error)return json(res,tx.result.error==='email-mismatch'?409:404,{ok:false,error:tx.result.error==='email-mismatch'?'البريد الإلكتروني لا يطابق سجل Firebase؛ لم يتم حفظ الخصم.':'لم يتطابق سجل المستخدم عند التحديث؛ لم يُحفظ الخصم.'});
      const ev={id:'DIS_'+crypto.randomUUID().replace(/-/g,''),user:username,username,discountPct:Number(pct.toFixed(2)),before:Number(tx.result.before||0),after:Number(pct.toFixed(2)),admin:String(session(req)?.username||ADMIN_USER),createdAt:nowISO()};
      try{await firebaseWriteJson('discountLedger/'+ev.id,ev,8000)}catch(e){console.warn('discount audit Firebase write failed:',String(e.message||e).slice(0,100))}
      appendJsonLedger('discount_ledger.json',ev);
      return json(res,200,{ok:true,username,discountPct:ev.after,unchanged:!!tx.result.unchanged,logged:true});
    }catch(e){return json(res,502,{ok:false,error:'تعذر حفظ الخصم في Firebase: '+String(e.message||e).slice(0,160)})}
  }

  if(p==='/api/admin/users/ban'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req),username=String(b.username||'').trim(),email=normalizeEmail(b.email),firebaseKey=String(b.firebaseKey||'').trim(),banned=b.banned===true,reason=String(b.reason||'').trim().slice(0,500);
    if(!username||(email&&!validEmail(email)))return json(res,422,{ok:false,error:'حدد اسم المستخدم والبريد الصحيح إن توفر.'});
    if(banned&&reason.length<4)return json(res,422,{ok:false,error:'اكتب سبب الحظر من 4 أحرف على الأقل.'});
    try{
      const found=await resolveAdminWalletUser(username,email,firebaseKey);
      if(!found?.firebasePath||!found?.user)return json(res,404,{ok:false,error:'لم يُعثر على سجل Firebase مطابق وفريد لهذا المستخدم؛ لم يتم تغيير الحساب.'});
      if(String(found.user.role||'user')==='admin')return json(res,409,{ok:false,error:'لا يمكن حظر حساب إدارة من قسم كشف الرصيد.'});
      const actor=String(session(req)?.username||ADMIN_USER),at=nowISO();
      const tx=await firebaseTransaction(found.firebasePath,current=>{
        if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-not-found'}};
        if(String(current.role||'user')==='admin')return {write:false,result:{error:'admin-target'}};
        const currentEmail=firebaseRecordEmail(current);if(validEmail(email)&&currentEmail&&currentEmail!==email)return {write:false,result:{error:'email-mismatch'}};
        const was=isSadaAdminBannedAccount(current);
        if(was===banned)return {write:false,result:{unchanged:true,banned:was,user:current}};
        if(banned){
          current.statusBeforeSadaBan=String(current.status||current.accountStatus||'active');
          current.accountStatusBeforeSadaBan=String(current.accountStatus||current.status||'active');
          current.adminBanned=true;current.siteBanned=true;current.banned=true;current.status='banned';current.accountStatus='banned';current.banReason=reason;current.bannedAt=at;current.bannedBy=actor;
        }else{
          current.adminBanned=false;current.siteBanned=false;current.banned=false;
          current.status=String(current.statusBeforeSadaBan||'active');current.accountStatus=String(current.accountStatusBeforeSadaBan||current.status||'active');
          current.unbannedAt=at;current.unbannedBy=actor;current.unbanReason=reason||'رفع الحظر من لوحة الإدارة';
          delete current.statusBeforeSadaBan;delete current.accountStatusBeforeSadaBan;delete current.banReason;delete current.bannedAt;delete current.bannedBy;
        }
        const history=Array.isArray(current.adminBanLedger)?current.adminBanLedger.slice(-99):[];history.push({at,by:actor,action:banned?'ban':'unban',reason:reason||'',username:String(current.username||found.username||username)});current.adminBanLedger=history.slice(-100);current.updatedAt=at;
        return {write:true,value:current,result:{banned,user:current,unchanged:false}};
      },12000,8);
      if(tx.result?.error){const e=tx.result.error;return json(res,e==='email-mismatch'?409:e==='admin-target'?409:404,{ok:false,error:e==='email-mismatch'?'البريد الإلكتروني لا يطابق حساب Firebase.':e==='admin-target'?'لا يمكن حظر حساب إدارة.':'المستخدم غير موجود.'});}
      const verified=await firebaseGetJson(found.firebasePath,10000);if(!verified||isSadaAdminBannedAccount(verified)!==banned)throw new Error('لم يؤكد Firebase حالة الحظر بعد الحفظ.');
      const canonical=String(found.username||verified.username||username).trim(),lower=canonical.toLowerCase();if(banned)SADA_ADMIN_BANNED_USERNAMES.add(lower);else SADA_ADMIN_BANNED_USERNAMES.delete(lower);
      const store=readJSON('users.json',{users:{}});store.users=store.users&&typeof store.users==='object'?store.users:{};
      const localKey=Object.keys(store.users).find(k=>String(store.users[k]?.username||k).toLowerCase()===lower)||Object.keys(store.users).find(k=>email&&normalizeEmail(firebaseRecordEmail(store.users[k])||store.users[k]?.email)===email)||canonical;
      store.users[localKey]={...(store.users[localKey]||{}),...verified,username:String(store.users[localKey]?.username||canonical)};writeJSON('users.json',store);
      const ev={id:'UB_'+crypto.randomUUID().replace(/-/g,''),username:canonical,email:firebaseRecordEmail(verified)||email,action:banned?'ban':'unban',reason,admin:actor,createdAt:at};let ledgerSaved=true;try{await firebaseWriteJson('userBanLedger/'+ev.id,ev,8000)}catch(e){ledgerSaved=false;console.warn('user ban ledger mirror failed:',String(e.message||e).slice(0,100))}
      return json(res,200,{ok:true,username:canonical,banned,unchanged:!!tx.result?.unchanged,verified:true,ledgerSaved,message:banned?'تم حظر المستخدم من دخول الحساب والتحقق من حفظ الحالة.':'تم رفع الحظر والتحقق من حفظ الحالة.'});
    }catch(e){return json(res,502,{ok:false,error:'تعذر تثبيت حالة الحظر في Firebase: '+String(e.message||e).slice(0,160)});}
  }

  if(p==='/api/payments'&&req.method==='POST'){
    const actor=session(req);if(!actor||!['user','admin'].includes(String(actor.role||'')))return json(res,401,{ok:false,error:'سجّل الدخول أولاً'});
    const b=await bodyJSON(req);const inputAmount=Number(b.amount);const inputCurrency=String(b.currency||'IQD').trim().toUpperCase();
    if(!Number.isFinite(inputAmount)||inputAmount<=0||inputAmount>1000000000)return json(res,422,{ok:false,error:'أدخل مبلغاً صالحاً أكبر من صفر'});
    if(!['IQD','USD'].includes(inputCurrency))return json(res,422,{ok:false,error:'عملة المبلغ غير مدعومة'});
    const amountIQD=Number((inputCurrency==='USD'?inputAmount*FIXED_RATE:inputAmount).toFixed(4));
    const settings=readJSON('settings.json',{}),minimum=Math.max(0,Number(settings.minCharge||1000));
    if(amountIQD<minimum)return json(res,422,{ok:false,error:'الحد الأدنى للشحن هو '+minimum.toLocaleString('en-US')+' د.ع'});
    const method=String(b.method||'').trim().slice(0,80),methodName=String(b.methodName||method||'').trim().slice(0,100),sender=String(b.sender||'').trim().slice(0,180),transactionId=String(b.transactionId||'').trim().slice(0,180);
    if(!method||!sender)return json(res,422,{ok:false,error:'حدد طريقة الدفع ومعلومات المرسل'});
    const id=String(b.id||('PAY_'+Date.now().toString(36)+'_'+crypto.randomBytes(5).toString('hex'))).trim();
    if(!/^[A-Za-z0-9_-]{3,140}$/.test(id))return json(res,422,{ok:false,error:'معرّف طلب الشحن غير صالح'});
    const key=firebaseSafeKey(id),pathName='payments/'+key;
    try{
      const existing=await firebaseGetJson(pathName,7000);
      if(existing){if(String(existing.user||'')===String(actor.username||''))return json(res,200,{ok:true,id,key,payment:existing,idempotent:true});return json(res,409,{ok:false,error:'معرّف طلب الشحن مستخدم مسبقاً'});}
      const payment={id,user:String(actor.username),amount:amountIQD,amountIQD,currency:'IQD',enteredAmount:inputAmount,enteredCurrency:inputCurrency,sender,transactionId,method,methodName,status:'pending',createdAt:nowISO(),source:'site-payment-request'};
      await firebaseWriteJson(pathName,payment,10000);const check=await firebaseGetJson(pathName,10000);
      if(!check||String(check.id||'')!==id||String(check.user||'')!==String(actor.username)||Number(check.amountIQD??check.amount)!==amountIQD)throw new Error('تعذر تأكيد حفظ طلب الشحن في Firebase');
      const local=readJSON('payments.json',[]);if(Array.isArray(local)&&!local.some(x=>String(x.id||'')===id)){local.push({...payment,_key:key});writeJSON('payments.json',local.slice(-5000));}
      return json(res,201,{ok:true,id,key,payment:check,idempotent:false});
    }catch(e){return json(res,503,{ok:false,error:'لم يتم تأكيد حفظ طلب الشحن: '+String(e.message||e).slice(0,170)});}
  }
  if(p==='/api/payments/mine'&&req.method==='GET'){
    const actor=session(req);if(!actor||!['user','admin'].includes(String(actor.role||'')))return json(res,401,{ok:false,error:'سجّل الدخول أولاً'});
    try{const q=String(actor.username||'').trim();const remote=await firebaseGetQueryJson('payments',{orderBy:JSON.stringify('user'),equalTo:JSON.stringify(q),limitToLast:100},12000);const items=collectionEntries(remote).filter(([,p])=>p&&typeof p==='object'&&!Array.isArray(p)&&String(p.user||p.username||'').toLowerCase()===q.toLowerCase()).map(([key,p])=>({...p,_k:key,amountIQD:Number(p.amountIQD??(String(p.enteredCurrency||p.currency||'IQD').toUpperCase()==='USD'?Number(p.amount||0)*FIXED_RATE:Number(p.amount||0)))})).sort((a,b)=>(Date.parse(b.createdAt||'')||0)-(Date.parse(a.createdAt||'')||0)).slice(0,15);return json(res,200,{ok:true,items,source:'firebase-indexed-user',checkedAt:nowISO()});}
    catch(e){return json(res,503,{ok:false,error:'تعذر تحميل عمليات الشحن: '+String(e.message||e).slice(0,150)});}
  }
  if(p==='/api/admin/payments'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const limit=Math.max(1,Math.min(200,parseInt(urlObj.searchParams.get('limit')||'100',10)||100));
    const now=Date.now();
    if(ADMIN_PAYMENTS_CACHE.value&&ADMIN_PAYMENTS_CACHE.limit===limit&&now-ADMIN_PAYMENTS_CACHE.at<15000)return json(res,200,{...ADMIN_PAYMENTS_CACHE.value,cached:true});
    if(ADMIN_PAYMENTS_CACHE.promise&&ADMIN_PAYMENTS_CACHE.limit===limit){try{return json(res,200,{...(await ADMIN_PAYMENTS_CACHE.promise),cached:true});}catch(_) {}}
    ADMIN_PAYMENTS_CACHE.limit=limit;
    ADMIN_PAYMENTS_CACHE.promise=(async()=>{
      const recent=await firebaseGetQueryJson('payments',{orderBy:'"$key"',limitToLast:limit},12000);
      const merged=new Map();
      const add=(key,pay)=>{if(!pay||typeof pay!=='object'||Array.isArray(pay))return;merged.set(String(key),{...pay,_k:String(key),amountIQD:Number(pay.amountIQD??(String(pay.enteredCurrency||pay.currency||'IQD').toUpperCase()==='USD'?Number(pay.amount||0)*FIXED_RATE:Number(pay.amount||0)))});};
      for(const [key,pay] of collectionEntries(recent))add(key,pay);
      // Include the host-side payment ledger too; no status/createdAt query (and no index prerequisite) is needed.
      const localPayments=readJSON('payments.json',[]);for(const pay of Array.isArray(localPayments)?localPayments:[])if(pay&&typeof pay==='object')add(String(pay._key||pay.id||pay.transactionId||'local-'+merged.size),pay);
      const items=[...merged.values()].sort((a,b)=>(Date.parse(b.createdAt||'')||0)-(Date.parse(a.createdAt||'')||0));
      const pendingCount=items.filter(pay=>String(pay.status||'pending')==='pending').length;
      return {ok:true,items:items.slice(0,Math.max(limit,items.filter(p=>String(p.status||'pending')==='pending').length)),pendingCount,totalLoaded:items.length,totalIsComplete:false,source:'firebase-key-window-plus-hosting-ledger',checkedAt:nowISO()};
    })();
    try{
      const payload=await ADMIN_PAYMENTS_CACHE.promise;ADMIN_PAYMENTS_CACHE={at:Date.now(),value:payload,promise:null,limit};return json(res,200,payload);
    }catch(e){ADMIN_PAYMENTS_CACHE={at:0,value:null,promise:null,limit:0};return json(res,503,{ok:false,error:'تعذر تحميل المدفوعات من Firebase: '+String(e.message||e).slice(0,170),source:'unavailable'});}
  }
  if(p==='/api/admin/payments/decision'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req);const key=String(b.key||'').trim(),action=String(b.action||'').trim().toLowerCase(),reason=String(b.reason||'').trim().slice(0,300);
    if(!/^[A-Za-z0-9_-]{1,200}$/.test(key)||!['approve','reject'].includes(action))return json(res,422,{ok:false,error:'بيانات قرار الشحن غير صالحة'});
    const paymentPath='payments/'+key;
    try{
      let payment=await firebaseGetJson(paymentPath,8000);if(!payment||typeof payment!=='object'||Array.isArray(payment))return json(res,404,{ok:false,error:'طلب الشحن غير موجود'});
      if(action==='reject'){
        const tx=await firebaseTransaction(paymentPath,current=>{
          if(!current||typeof current!=='object')return {write:false,result:{error:'missing'}};
          if(String(current.status||'pending')==='rejected')return {write:false,result:{alreadyDone:true,status:'rejected',payment:current}};
          if(String(current.status||'pending')==='approved')return {write:false,result:{error:'already-approved'}};
          if(String(current.status||'pending')!=='pending')return {write:false,result:{error:'processing'}};
          const next={...current,status:'rejected',rejectReason:reason,rejectedAt:nowISO(),rejectedBy:String(session(req)?.username||ADMIN_USER)};
          return {write:true,value:next,result:{status:'rejected',payment:next}};
        },10000,8);
        if(tx.result?.error)return json(res,409,{ok:false,error:tx.result.error==='already-approved'?'طلب الشحن تمت الموافقة عليه ولا يمكن رفضه.':'طلب الشحن قيد المعالجة أو تغيرت حالته؛ حدّث القائمة.'});
        ADMIN_PAYMENTS_CACHE={at:0,value:null,promise:null,limit:0};ADMIN_DASHBOARD_CACHE={at:0,value:null,promise:null};
        return json(res,200,{ok:true,status:'rejected',idempotent:!!tx.result?.alreadyDone});
      }
      // Claim pending approval first. Retrying a stuck `processing` payment is safe because the user's
      // transaction below stores a per-payment idempotency marker in the same atomic user update.
      const claim=await firebaseTransaction(paymentPath,current=>{
        if(!current||typeof current!=='object')return {write:false,result:{error:'missing'}};
        const status=String(current.status||'pending');
        if(status==='approved')return {write:false,result:{alreadyApproved:true,payment:current}};
        if(status==='rejected')return {write:false,result:{error:'rejected'}};
        if(status==='processing'&&String(current.processingType||'')==='approve')return {write:false,result:{continueApproval:true,payment:current}};
        if(status!=='pending')return {write:false,result:{error:'processing'}};
        const next={...current,status:'processing',processingType:'approve',processingAt:nowISO()};
        return {write:true,value:next,result:{continueApproval:true,payment:next}};
      },10000,8);
      if(claim.result?.alreadyApproved)return json(res,200,{ok:true,status:'approved',idempotent:true,creditedBalanceIQD:Number(claim.result.payment?.creditedBalanceIQD||0)});
      if(claim.result?.error)return json(res,409,{ok:false,error:claim.result.error==='rejected'?'طلب الشحن مرفوض بالفعل.':'طلب الشحن قيد المعالجة؛ حدّث القائمة وحاول مجدداً.'});
      payment=claim.value||claim.result?.payment||payment;
      const username=String(payment.user||payment.username||'').trim();if(!username){await firebasePatchJson(paymentPath,{status:'pending',processingType:null,processingAt:null}).catch(()=>{});return json(res,422,{ok:false,error:'طلب الشحن لا يحتوي اسم المستخدم'});}
      const amountIQD=Number(payment.amountIQD??(String(payment.enteredCurrency||payment.currency||'IQD').toUpperCase()==='USD'?Number(payment.amount||0)*FIXED_RATE:Number(payment.amount||0)));
      if(!Number.isFinite(amountIQD)||amountIQD<=0||amountIQD>1e12){await firebasePatchJson(paymentPath,{status:'pending',processingType:null,processingAt:null}).catch(()=>{});return json(res,422,{ok:false,error:'مبلغ طلب الشحن غير صالح'});}
      const userRecord=await findRemoteUserByUsername(username,String(payment.firebaseUserKey||''));if(!userRecord?.firebasePath){await firebasePatchJson(paymentPath,{status:'pending',processingType:null,processingAt:null}).catch(()=>{});return json(res,404,{ok:false,error:'تعذر العثور على حساب المستخدم في Firebase؛ لم تتم إضافة الرصيد.'});}
      const marker=crypto.createHash('sha256').update(key).digest('hex').slice(0,40);const now=nowISO();
      const creditTx=await firebaseTransaction(userRecord.firebasePath,current=>{
        if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-not-found'}};
        const credits=current.sadaPaymentCredits&&typeof current.sadaPaymentCredits==='object'&&!Array.isArray(current.sadaPaymentCredits)?{...current.sadaPaymentCredits}:{};
        if(credits[marker])return {write:false,result:{alreadyCredited:true,balanceIQD:Number(current.balance||0),event:credits[marker].event||null}};
        const before=Number(current.balance||0);if(!Number.isFinite(before)||before<0)return {write:false,result:{error:'invalid-balance'}};
        const after=Number((before+amountIQD).toFixed(4)),event={id:'PAYBAL_'+crypto.randomUUID().replace(/-/g,''),username:userRecord.username||username,user:userRecord.username||username,type:'deposit',amountIQD:Number(amountIQD.toFixed(4)),amountUSD:Number((amountIQD/FIXED_RATE).toFixed(6)),beforeIQD:before,afterIQD:after,reason:'اعتماد طلب شحن '+key,admin:String(session(req)?.username||ADMIN_USER),createdAt:now,method:String(payment.methodName||payment.method||'payment')};
        credits[marker]={paymentKey:key,amountIQD:Number(amountIQD.toFixed(4)),creditedAt:now,event};
        const creditEntries=Object.entries(credits).sort((a,b)=>(Date.parse(a[1]?.creditedAt||'')||0)-(Date.parse(b[1]?.creditedAt||'')||0));while(creditEntries.length>1000){const [oldKey]=creditEntries.shift();delete credits[oldKey];}
        const ledger=Array.isArray(current.adminBalanceLedger)?current.adminBalanceLedger.slice(-199):[];ledger.push(event);current.balance=after;current.sadaPaymentCredits=credits;current.adminBalanceLedger=ledger;current.updatedAt=now;
        return {write:true,value:current,result:{balanceIQD:after,event,alreadyCredited:false}};
      },12000,8);
      if(creditTx.result?.error){await firebasePatchJson(paymentPath,{status:'pending',processingType:null,processingAt:null}).catch(()=>{});return json(res,404,{ok:false,error:'تعذر تحديث رصيد المستخدم في Firebase؛ لم يتم اعتماد طلب الشحن.'});}
      const balanceIQD=Number(creditTx.result?.balanceIQD??creditTx.value?.balance??0),event=creditTx.result?.event||null;
      if(event){appendJsonLedger('balance_ledger.json',event);await firebaseWriteJson('balanceLedger/'+event.id,event,8000).catch(e=>console.warn('Payment approval ledger mirror failed:',String(e.message||e).slice(0,100)));}
      await firebasePatchJson(paymentPath,{status:'approved',approvedAt:nowISO(),approvedBy:String(session(req)?.username||ADMIN_USER),creditedAmountIQD:Number(amountIQD.toFixed(4)),creditedBalanceIQD:balanceIQD,approvalEventId:event?.id||null,processingType:null,processingAt:null},12000);
      ADMIN_PAYMENTS_CACHE={at:0,value:null,promise:null,limit:0};ADMIN_DASHBOARD_CACHE={at:0,value:null,promise:null};
      return json(res,200,{ok:true,status:'approved',username,balanceIQD,balanceUSD:Number((balanceIQD/FIXED_RATE).toFixed(6)),idempotent:!!creditTx.result?.alreadyCredited});
    }catch(e){return json(res,503,{ok:false,error:'تعذر تثبيت قرار الشحن بالكامل. حدّث القائمة؛ إعادة المحاولة لا تضيف الرصيد مرتين. '+String(e.message||e).slice(0,150)});}
  }
  if(p==='/api/admin/services/import'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req,10*1024*1024);const services=Array.isArray(b.services)?b.services:[];
    if(!services.length||services.length>500)return json(res,422,{ok:false,error:'حدد من 1 إلى 500 خدمة صالحة للاستيراد.'});
    try{await ensureLocalServiceCatalogSeeded();}catch(e){return json(res,503,{ok:false,error:'تعذر تحميل قاعدة Firebase؛ لم يبدأ الاستيراد: '+String(e.message||e).slice(0,160)});}
    const dest=String(b.destination||'__all__').trim().slice(0,100),at=nowISO();
    const categoryKey=dest==='__all__'?'':String(b.categoryKey||dest.replace(/[^a-zA-Z0-9_\-\u0600-\u06ff]+/g,'_')).slice(0,150)||'category';
    const root=readJSON('services.json',{}),metaRoot=readJSON('category_meta.json',{}),quarantineArchive=readJSON('quarantined_provider_services.json',{});const servicesBeforeImport=JSON.parse(JSON.stringify(root)),metaBeforeImport=JSON.parse(JSON.stringify(metaRoot)),quarantineBeforeImport=JSON.parse(JSON.stringify(quarantineArchive)),settingsBeforeImport=JSON.parse(JSON.stringify(readJSON('catalog_settings.json',{})));let added=0,updated=0,skipped=0,restoredArchived=0;const serviceKeys=[];
    for(const item of services){
      const data=item&&item.data&&typeof item.data==='object'?item.data:null;if(!data){skipped++;continue;}
      const providerId=String(data.providerId||'').trim(),sourceId=String(data.providerServiceId||data.smmpartyId||data.sourceServiceId||data.serviceId||'').trim(),name=String(data.name||'').trim(),price=Number(data.sellingUsd??(Number(data.price||0)/FIXED_RATE));
      if(!providerId||!sourceId||!name||!Number.isFinite(price)||price<0){skipped++;continue;}
      let key=Object.keys(root).find(k=>String(root[k]?.providerId||'')===providerId&&String(root[k]?.providerServiceId||root[k]?.smmpartyId||root[k]?.serviceId||'')===sourceId);
      let archivedKey='';if(!key)archivedKey=Object.keys(quarantineArchive).find(k=>String(quarantineArchive[k]?.providerId||'')===providerId&&String(quarantineArchive[k]?.providerServiceId||quarantineArchive[k]?.smmpartyId||quarantineArchive[k]?.serviceId||'')===sourceId)||'';
      const fromArchive=!key&&!!archivedKey;if(fromArchive)key=archivedKey;
      const existing=key?(fromArchive?quarantineArchive[key]:root[key]):null;
      const category=dest==='__all__'?(String(data.category||data.groups?.[0]||'عام')):dest;
      const groups=dest==='__all__'?(Array.isArray(data.groups)?data.groups:[category]):[dest];
      const wasQuarantined=existing?.unapprovedAutoImport===true||fromArchive||!!(existing&&isLegacyAutoImportedProviderRow(key,existing));const row={...(existing||{}),...data,providerId,providerServiceId:sourceId,smmpartyId:sourceId,serviceId:sourceId,name,category,groups:[...new Set(groups.map(x=>String(x||'').trim()).filter(Boolean))],categories:[...new Set(groups.map(x=>String(x||'').trim()).filter(Boolean))],sellingUsd:Number(price.toFixed(6)),price:Number((price*FIXED_RATE).toFixed(4)),basePrice:(Number.isFinite(Number(data.basePrice))&&Number(data.basePrice)>=0?Number(Number(data.basePrice).toFixed(4)):Number((price*FIXED_RATE).toFixed(4))),source:'smmparty',createdAt:existing?.createdAt||at,updatedAt:at,...(wasQuarantined?{unapprovedAutoImport:false,active:true,providerAvailable:true,availabilityStatus:'available',providerAvailabilityReason:'',explicitlyApprovedAt:at,explicitlyApprovedBy:String(session(req)?.username||ADMIN_USER)}:{})};if(wasQuarantined)delete row.unapprovedAutoImport;
      if(!key)key='svc_'+crypto.randomBytes(12).toString('hex');root[key]=row;if(fromArchive){delete quarantineArchive[key];restoredArchived++;}serviceKeys.push(key);if(existing&&!fromArchive)updated++;else if(fromArchive)updated++;else added++;
    }
    if(!serviceKeys.length)return json(res,422,{ok:false,error:'لم توجد خدمات صالحة؛ تأكد من اسم الخدمة وProvider ID وService ID والسعر.',skipped});
    if(dest!=='__all__'){
      const old=metaRoot[categoryKey]&&typeof metaRoot[categoryKey]==='object'?metaRoot[categoryKey]:{};
      metaRoot[categoryKey]={...old,...(b.categoryMeta&&typeof b.categoryMeta==='object'?b.categoryMeta:{}),name:dest,serviceKeys:[...new Set([...serviceKeys,...(Array.isArray(old.serviceKeys)?old.serviceKeys.map(String):[])])],updatedAt:at,updatedBy:String(session(req)?.username||ADMIN_USER)};
    }
    let firebasePatchAccepted=false;
    try{writeJSON('services.json',root);ensureNumericSiteServiceIds();if(restoredArchived)writeJSON('quarantined_provider_services.json',quarantineArchive);writeJSON('category_meta.json',metaRoot);const cfg=readJSON('catalog_settings.json',{});cfg.legacySeedAttempted=true;cfg.catalogUpdatedAt=at;cfg.lastImportCount=serviceKeys.length;const order=cfg.catalogOrder&&typeof cfg.catalogOrder==='object'?cfg.catalogOrder:{categories:[],services:{}};if(!Array.isArray(order.categories))order.categories=[];if(!order.services||typeof order.services!=='object'||Array.isArray(order.services))order.services={};if(dest!=='__all__'&&!order.categories.some(x=>normalizeCatalogLabel(x)===normalizeCatalogLabel(dest)))order.categories.push(dest);const destBucket=dest==='__all__'?'__all__':(categoryKey||normalizeCatalogKey(dest));for(const bucket of new Set([destBucket,'__all__'])){const previous=Array.isArray(order.services[bucket])?order.services[bucket].map(String):[];order.services[bucket]=[...serviceKeys,...previous.filter(k=>!serviceKeys.includes(k))];}cfg.catalogOrder=canonicalCatalogOrder(order,metaRoot);writeJSON('catalog_settings.json',cfg);const verify=readJSON('services.json',{});const missing=serviceKeys.filter(k=>!verify[k]||String(verify[k].providerServiceId||verify[k].smmpartyId||'')==='');if(missing.length)throw new Error('فشل التحقق من '+missing.length+' خدمة بعد الحفظ المحلي.');
      const freshRoot=readJSON('services.json',{}),freshMeta=readJSON('category_meta.json',{}),freshCfg=readJSON('catalog_settings.json',{}),remotePatch={};
      for(const key of serviceKeys){if(!freshRoot[key])throw new Error('الخدمة '+key+' غير موجودة في الكتالوج بعد الحفظ المحلي.');remotePatch['services/'+key]=freshRoot[key];}
      if(dest!=='__all__'&&freshMeta[categoryKey])remotePatch['categoryMeta/'+categoryKey]=freshMeta[categoryKey];
      if(freshCfg.catalogOrder)remotePatch['settings/catalogOrder']=freshCfg.catalogOrder;
      const importVersion=String(Date.now());remotePatch['settings/svcsVersion']=importVersion;
      // Never download Firebase's entire database as a PATCH response. Silent PATCH is followed by
      // bounded read-back of only the service catalog, target category, order and version.
      await firebasePatchJsonSilent('',remotePatch,45000);firebasePatchAccepted=true;
      const [remoteServicesAfter,remoteMetaAfter,remoteOrderAfter,remoteVersionAfter]=await Promise.all([
        firebaseGetJson('services',25000),
        dest!=='__all__'?firebaseGetJson('categoryMeta/'+categoryKey,12000):Promise.resolve(null),
        firebaseGetJson('settings/catalogOrder',12000),
        firebaseGetJson('settings/svcsVersion',8000)
      ]);
      const remoteCatalog=catalogObject(remoteServicesAfter);
      const unverifiable=serviceKeys.filter(key=>!remoteCatalog[key]||!catalogValuesEqual(remoteCatalog[key],freshRoot[key]));
      if(unverifiable.length)throw new Error('لم يتأكد حفظ '+unverifiable.length+' خدمة داخل Firebase.');
      if(dest!=='__all__'&&freshMeta[categoryKey]&&!catalogValuesEqual(remoteMetaAfter,freshMeta[categoryKey]))throw new Error('لم يتأكد حفظ بيانات القسم داخل Firebase.');
      if(freshCfg.catalogOrder&&!catalogValuesEqual(remoteOrderAfter,freshCfg.catalogOrder))throw new Error('لم يتأكد حفظ ترتيب الأقسام داخل Firebase.');
      if(String(remoteVersionAfter??'')!==importVersion)throw new Error('لم يتأكد تحديث إصدار الكتالوج داخل Firebase.');
      return json(res,200,{ok:true,added,updated,restoredArchived,skipped,total:serviceKeys.length,serviceKeys,verified:true,firebaseVerified:true,destination:dest,storage:'firebase',storageMode:'firebase',verificationMode:'bounded-catalog-readback',checkedAt:nowISO()});}
    catch(e){try{if(firebasePatchAccepted){await reloadLocalCatalogFromFirebase();}else{writeJSON('services.json',servicesBeforeImport);writeJSON('category_meta.json',metaBeforeImport);writeJSON('catalog_settings.json',settingsBeforeImport);writeJSON('quarantined_provider_services.json',quarantineBeforeImport);SITE_SERVICE_IDS_DIRTY=true;}}catch(rollbackError){console.error('Firebase service import reconciliation failed:',String(rollbackError.message||rollbackError));}return json(res,503,{ok:false,persisted:false,uncertain:firebasePatchAccepted,error:firebasePatchAccepted?'تم إرسال البيانات إلى Firebase، لكن تعذر تأكيد كل القراءات. اضغط تحديث القائمة وتحقق من الخدمات قبل إعادة الاستيراد. '+String(e.message||e).slice(0,140):'لم يتم تأكيد حفظ الخدمات في Firebase، وأُعيدت الملفات المحلية إلى حالتها السابقة. '+String(e.message||e).slice(0,180)});}
  }
  // Support chat is served through the privileged server SDK, never by granting clients write access to chats.
  if(p==='/api/support/chat'&&req.method==='GET'){
    const s=session(req);if(!s||s.role!=='user')return json(res,401,{ok:false,error:'سجّل الدخول أولاً'});const username=String(s.username||''),base='chats/'+firebaseSafeKey(username);try{const root=await firebaseGetJson(base,10000);const rows=collectionEntries(root).map(([id,m])=>({id,...(m&&typeof m==='object'?m:{})})).filter(x=>x.message).sort((a,b)=>(Date.parse(a.createdAt)||0)-(Date.parse(b.createdAt)||0)).slice(-100);const patches={};for(const m of rows)if(m.from==='admin'&&!m.readByUser)patches[base+'/'+m.id+'/readByUser']=true;if(Object.keys(patches).length)await firebasePatchJson('',patches,8000).catch(()=>{});return json(res,200,{ok:true,username,messages:rows})}catch(e){return json(res,503,{ok:false,error:'تعذر تحميل محادثة الدعم: '+String(e.message||e).slice(0,150)})}
  }
  if(p==='/api/support/chat'&&req.method==='POST'){
    const s=session(req);if(!s||s.role!=='user')return json(res,401,{ok:false,error:'سجّل الدخول أولاً'});const b=await bodyJSON(req);const message=String(b.message||'').trim().slice(0,1200);if(!message)return json(res,422,{ok:false,error:'اكتب الرسالة أولاً'});const username=String(s.username||''),base='chats/'+firebaseSafeKey(username),id='m_'+crypto.randomUUID().replace(/-/g,'');const row={user:username,from:'user',message,createdAt:nowISO(),readByAdmin:false,readByUser:true};try{await firebaseWriteJson(base+'/'+id,row,10000);return json(res,200,{ok:true,message:{id,...row}})}catch(e){return json(res,503,{ok:false,error:'لم تُرسل الرسالة؛ تعذر حفظها في قاعدة البيانات: '+String(e.message||e).slice(0,150)})}
  }
  if(p==='/api/admin/support/chats'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});try{const [chatRoot,userRoot]=await Promise.all([firebaseGetJson('chats',12000),firebaseGetJson('users',12000)]);const accountNames=new Map(collectionEntries(userRoot).map(([k,u])=>[k,String(u?.username||decodeFirebaseSafeKey(k)||k)]));const rows=[];for(const [key,thread] of collectionEntries(chatRoot)){if(!thread||typeof thread!=='object')continue;const messages=collectionEntries(thread).map(([id,m])=>({id,...(m&&typeof m==='object'?m:{})})).filter(m=>m.message);if(!messages.length)continue;messages.sort((a,b)=>(Date.parse(a.createdAt)||0)-(Date.parse(b.createdAt)||0));const username=String(messages.find(m=>m.user)?.user||accountNames.get(key)||decodeFirebaseSafeKey(key)||key);rows.push({username,lastMessage:messages[messages.length-1],total:messages.length,unread:messages.filter(m=>m.from==='user'&&!m.readByAdmin).length,lastTime:messages[messages.length-1].createdAt||''})}rows.sort((a,b)=>(Date.parse(b.lastTime)||0)-(Date.parse(a.lastTime)||0));return json(res,200,{ok:true,chats:rows})}catch(e){return json(res,503,{ok:false,error:'تعذر جلب محادثات الدعم من Firebase: '+String(e.message||e).slice(0,150)})}
  }
  if(p==='/api/admin/support/chat'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const username=String(urlObj.searchParams.get('username')||'').trim();if(!username)return json(res,422,{ok:false,error:'اسم المستخدم مطلوب'});const base='chats/'+firebaseSafeKey(username);try{const root=await firebaseGetJson(base,10000);const messages=collectionEntries(root).map(([id,m])=>({id,...(m&&typeof m==='object'?m:{})})).filter(m=>m.message).sort((a,b)=>(Date.parse(a.createdAt)||0)-(Date.parse(b.createdAt)||0)).slice(-100);const patches={};for(const m of messages)if(m.from==='user'&&!m.readByAdmin)patches[base+'/'+m.id+'/readByAdmin']=true;if(Object.keys(patches).length)await firebasePatchJson('',patches,8000).catch(()=>{});return json(res,200,{ok:true,username,messages})}catch(e){return json(res,503,{ok:false,error:'تعذر تحميل المحادثة: '+String(e.message||e).slice(0,150)})}
  }
  if(p==='/api/admin/support/chat'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);const username=String(b.username||'').trim(),message=String(b.message||'').trim().slice(0,1200);if(!/^[A-Za-z0-9_@.\-]{1,150}$/.test(username)||!message)return json(res,422,{ok:false,error:'اسم المستخدم أو نص الرسالة غير صالح'});const id='m_'+crypto.randomUUID().replace(/-/g,'');const row={user:username,from:'admin',message,createdAt:nowISO(),readByAdmin:true,readByUser:false};try{await firebaseWriteJson('chats/'+firebaseSafeKey(username)+'/'+id,row,10000);createUserNotification(username,{id:'SUP'+sha256(username+'|'+id).slice(0,24),type:'support_reply',title:'رد جديد من الدعم الفني',message:message.slice(0,380),meta:{chatMessageId:id}});return json(res,200,{ok:true,message:{id,...row}})}catch(e){return json(res,503,{ok:false,error:'لم يُرسل رد الإدارة؛ تعذر حفظ الرسالة: '+String(e.message||e).slice(0,150)})}
  }
  if(p==='/api/admin/support/chats'&&req.method==='DELETE'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);const username=String(b.username||'').trim();try{if(username)await firebaseDeleteJson('chats/'+firebaseSafeKey(username),8000);else await firebaseDeleteJson('chats',10000);return json(res,200,{ok:true})}catch(e){return json(res,503,{ok:false,error:'تعذر مسح المحادثات: '+String(e.message||e).slice(0,120)})}
  }

  // Administrator-only legacy database workflow. Uploaded archive is validated and stored
  // in the private DATA directory; database content is never served as static files.
  if(p==='/api/admin/legacy-import/upload'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const ct=String(req.headers['content-type']||'').toLowerCase();if(!ct.includes('application/zip')&&!ct.includes('application/octet-stream'))return json(res,415,{ok:false,error:'ارفع ملف ZIP بصيغة application/zip.'});
    const bytes=await readRawRequestBuffer(req);const entries=readZipArchive(bytes);const dbKey=Object.keys(entries).find(k=>k==='sadairaq.db'||k.endsWith('/sadairaq.db'));if(!dbKey||entries[dbKey].subarray(0,16).toString('binary')!=='SQLite format 3\u0000')return json(res,422,{ok:false,error:'ملف SQLite غير موجود أو تالف داخل ZIP.'});
    const users=parseLegacyJsonEntry(entries,'sadairaq-users.json'),orders=parseLegacyJsonEntry(entries,'sadairaq-orders.json'),transactions=parseLegacyJsonEntry(entries,'sadairaq-transactions.json');
    const userIds=assertUniqueIds(users,'المستخدمين'),orderIds=assertUniqueIds(orders,'الطلبات'),transactionIds=assertUniqueIds(transactions,'المعاملات');const linkedOrders=orders.filter(o=>userIds.has(String(o?.user_id||''))).length;
    if(!users.length||!orders.length||linkedOrders!==orders.length)return json(res,422,{ok:false,error:'فشل التحقق من العلاقات بين المستخدمين والطلبات؛ لم يتم حفظ أي بيانات.',counts:{users:users.length,orders:orders.length,linkedOrders}});
    const privateUsers=users.map(legacyUserPrivateRow);const privateOrders=orders.map(legacyOrderPrivateRow);
    const stage={version:1,uploadedAt:nowISO(),sourceFile:'SadaIraq_Database_Export.zip',sourceZipBytes:bytes.length,users:privateUsers,orders:privateOrders,transactions:transactions.map(legacyTransactionPrivateRow),transactionCount:transactions.length,counts:{users:users.length,orders:orders.length,transactions:transactions.length}};
    writeJSON(LEGACY_STAGE_FILE,stage);
    return json(res,200,{ok:true,uploaded:true,zipBytes:bytes.length,counts:stage.counts,linkedOrders,checks:{sqliteHeader:true,zipCrcsValid:true,userIdsUnique:userIds.size===users.length,orderIdsUnique:orderIds.size===orders.length,transactionIdsUnique:transactionIds.size===transactions.length,allOrdersLinkedToUsers:linkedOrders===orders.length},storageDurable:DATA_IS_EXTERNAL,storageWarning:DATA_IS_EXTERNAL?'تم حفظ الملف في مجلد بيانات دائم.':'تحذير: تم حفظ الملف في مجلد التشغيل الحالي فقط، وقد يضيع بعد إعادة النشر. اربط Railway Volume واجعل SADA_DATA_DIR=/data قبل الاعتماد على الترحيل.',message:'تم فحص الملف وتخزين بيانات الترحيل بشكل خاص. لم يتم تعديل قاعدة Firebase بعد.'});
  }
  if(p==='/api/admin/legacy-import/preview'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const stage=await readLegacyStage();if(!stage)return json(res,404,{ok:false,error:'لم يتم رفع ملف قاعدة البيانات بعد. اختر ملف ZIP أولاً.'});
    try{const remote=await getLegacyRemoteSnapshot();const plan=createLegacyPlan(stage,remote.remoteUsers,remote.remoteOrders);return json(res,200,{ok:true,ready:true,counts:plan.counts,matchedUsers:plan.matchedUsers,unmatchedUsers:plan.unmatchedUsers,ordersToAdd:Object.keys(plan.upserts).length-plan.alreadyImported,ordersAlreadyImported:plan.alreadyImported,duplicatesAlreadyInLiveDatabase:plan.liveDuplicates,unmatchedOrderUsers:plan.unmatchedOrderUsers,balancesToRestore:plan.balanceRestorePlan.length,unmatchedPositiveBalances:plan.unmatchedPositiveBalances,balanceSkippedExisting:plan.balanceSkippedExisting,negativeBalancesSkipped:plan.negativeBalancesSkipped,balancesAlreadyRestored:plan.balancesAlreadyRestored,exchangeRate:FIXED_RATE,warning:'سيتم ربط الطلبات بالبريد المطابق فقط. الحسابات القديمة التي لا تملك حساباً مطابقاً تبقى ظاهرة للإدارة باسم سجل قديم ولا يمكنها تسجيل الدخول بكلمة مرور Base44 القديمة.'});}catch(e){return json(res,503,{ok:false,error:String(e.message||e)});}
  }
  if(p==='/api/admin/legacy-import/apply'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req);if(String(b.confirm||'')!==LEGACY_IMPORT_CONFIRM)return json(res,422,{ok:false,error:'اكتب تأكيد الدمج الصحيح من لوحة الإدارة.'});
    const stage=await readLegacyStage();if(!stage)return json(res,404,{ok:false,error:'ملف الترحيل غير موجود. لا توجد قاعدة مضمّنة في هذا الإصدار؛ ارفع ملفاً تاريخياً تملكه إذا أردت الاستيراد اليدوي.'});
    try{const result=await applyLegacyStage(stage,{bundledSeed:!!stage.seedSourceId});return json(res,result.allDone?200:207,{ok:result.allDone,report:result.report,warning:result.warning});}
    catch(e){return json(res,503,{ok:false,error:'تعذر إكمال دمج قاعدة البيانات. لم يتم حذف ملف الترحيل؛ يمكن إعادة المحاولة دون تكرار الطلبات. '+String(e.message||e).slice(0,180)});}
  }
  if(p==='/api/admin/legacy-import/status'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const stage=await readLegacyStage();let report=readJSON(LEGACY_IMPORT_STATE_FILE,null),remoteUsersCount=0,remoteReadError='';
    try{const raw=await firebaseGetJson(LEGACY_USERS_REMOTE_PATH,8000);remoteUsersCount=Number(raw?.count||Object.keys(raw?.users||{}).length||0);}catch(e){remoteReadError=String(e.message||e).slice(0,100);}
    if(!report){try{const remoteState=await firebaseGetJson(LEGACY_IMPORT_STATE_REMOTE_PATH,7000);if(remoteState&&typeof remoteState==='object')report=remoteState;}catch(_){}}
    return json(res,200,{ok:true,uploaded:!!stage,stagedCounts:stage?.counts||null,lastImport:report||null,seedBootstrap:readJSON(LEGACY_SEED_STATUS_FILE,{}),importedSnapshotAvailable:remoteUsersCount>0,importedUsersCount:remoteUsersCount,storageDurable:DATA_IS_EXTERNAL||remoteUsersCount>0,remoteReadError,storageWarning:remoteUsersCount>0?'تم حفظ قائمة مستخدمي Base44 في قاعدة الموقع الدائمة؛ لا تحتاج إعادة رفع ملف ZIP بعد كل تحديث.':(remoteReadError?'تعذر فحص نسخة مستخدمي Base44 السحابية: '+remoteReadError:'لم يتأكد حفظ فهرس المستخدمين في Firebase بعد. لا توجد قاعدة تاريخية مضمّنة؛ ارفع نسخة تملكها واستخدم الاستيراد اليدوي فقط إذا أردت نقل سجل تاريخي.')});
  }
  if(p==='/api/admin/user-order-stats'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});let remoteUsers={},remoteOrders={};let firebaseAvailable=true;try{[remoteUsers,remoteOrders]=await Promise.all([firebaseGetJson('users',12000),firebaseGetJson('orders',15000)]);remoteUsers=remoteUsers||{};remoteOrders=remoteOrders||{};}catch(e){firebaseAvailable=false;return json(res,503,{ok:false,error:'تعذر قراءة المستخدمين والطلبات من Firebase: '+String(e.message||e).slice(0,140)});}
    const directory=normalizeCurrentUsers(remoteUsers),currentByUsername=new Map(directory.users.map(u=>[u.username,u]));let oldUsers=readJSON(LEGACY_USERS_PRIVATE_FILE,[]);if(!Array.isArray(oldUsers)||!oldUsers.length){try{oldUsers=await loadLegacyUsersRemote();}catch(_){oldUsers=[];}}
    const oldById=new Map((Array.isArray(oldUsers)?oldUsers:[]).map(u=>[String(u.id),u]));const legacyMatches=mapLegacyUsersToCurrent(oldUsers,directory);const localOrders=readJSON('orders.json',[]);const dedup=new Map();
    const addOrder=(o,source,key='')=>{if(!o||typeof o!=='object'||Array.isArray(o)||o.event)return;const user=String(o.user||o.username||o.userName||'').trim();if(!user)return;const identity=String(o.legacyHistory?'legacy:'+o.legacyImportKey:(o.id||o.siteOrderId||o.orderId||o.order_id||o.providerOrderId||o.smmpartyOrderId||key||o.createdAt||''));if(!identity)return;dedup.set(user+'|'+identity,{o,user,source});};
    for(const [i,o] of (Array.isArray(localOrders)?localOrders:[]).entries())addOrder(o,'local',String(i));for(const [k,o] of collectionEntries(remoteOrders))addOrder(o,o.legacyHistory?'legacy':'firebase',k);
    const groups=new Map();
    const ensureGroup=(groupKey,base={})=>{let g=groups.get(groupKey);if(!g){g={username:String(base.username||''),name:String(base.name||base.username||'مستخدم'),orderCount:0,legacyOrderCount:0,newOrderCount:0,balanceUsd:base.balanceUsd==null?null:Number(base.balanceUsd),balanceSource:base.balanceSource||'current-account',legacyUserId:base.legacyUserId||null,hasCurrentAccount:!!base.hasCurrentAccount,email:String(base.email||''),joined:String(base.joined||'')};groups.set(groupKey,g);}return g;};
    // Include accounts even when they have zero orders, then enrich them from actual order rows.
    for(const curr of directory.users){ensureGroup('current:'+curr.username,{username:curr.username,name:String(curr.user.name||curr.user.fullName||curr.username),balanceUsd:Number(curr.user.balance||0)/FIXED_RATE,balanceSource:'current-account',hasCurrentAccount:true,email:curr.email,joined:curr.user.joined||curr.user.createdAt||curr.user.created_date||''});}
    for(const old of (Array.isArray(oldUsers)?oldUsers:[])){const oldId=String(old.id||'');if(!oldId)continue;const matched=legacyMatches.byLegacyId.get(oldId);const groupKey=matched?'current:'+matched.username:'legacy:'+oldId;const g=ensureGroup(groupKey,matched?{username:matched.username,name:String(matched.user.name||matched.user.fullName||old.arabic_name||old.full_name||matched.username),balanceUsd:Number(matched.user.balance||0)/FIXED_RATE,balanceSource:'current-account',hasCurrentAccount:true,email:matched.email,joined:matched.user.joined||matched.user.createdAt||''}:{username:legacyAliasUser(oldId),name:String(old.arabic_name||old.full_name||('مستخدم قديم '+oldId.slice(0,8))),balanceUsd:Number(old.balance||0),balanceSource:'legacy-snapshot',legacyUserId:oldId,hasCurrentAccount:false,email:old.email,joined:old.created_date});if(!matched)g.legacyUserId=oldId;}
    for(const {o,user} of dedup.values()){
      const legacyId=String(o.legacyUserId||'');const old=oldById.get(legacyId);const matched=legacyId?legacyMatches.byLegacyId.get(legacyId):null;const curr=currentByUsername.get(user);const groupKey=matched?'current:'+matched.username:(curr?'current:'+user:(legacyId?'legacy:'+legacyId:'current:'+user));
      const g=ensureGroup(groupKey,{username:matched?matched.username:(curr?user:(legacyId?legacyAliasUser(legacyId):user)),name:String(matched?.user.name||curr?.user.name||curr?.user.fullName||old?.arabic_name||old?.full_name||o.userName||o.name||user),balanceUsd:matched?Number(matched.user.balance||0)/FIXED_RATE:(curr?Number(curr.user.balance||0)/FIXED_RATE:Number(old?.balance||0)),balanceSource:(matched||curr)?'current-account':'legacy-snapshot',legacyUserId:legacyId||null,hasCurrentAccount:!!(matched||curr),email:matched?.email||curr?.email||old?.email||''});
      g.orderCount++;if(o.legacyHistory)g.legacyOrderCount++;else g.newOrderCount++;if(curr||matched){const account=matched||curr;g.name=String(account.user.name||account.user.fullName||g.name);g.balanceUsd=Number(account.user.balance||0)/FIXED_RATE;g.balanceSource='current-account';g.hasCurrentAccount=true;}
    }
    const q=String(urlObj.searchParams.get('q')||'').trim().toLowerCase();const limit=Math.min(1000,Math.max(5,Number(urlObj.searchParams.get('limit')||100)));const rows=[...groups.values()].filter(x=>!q||[x.name,x.username,x.email,x.legacyUserId].some(v=>String(v||'').toLowerCase().includes(q))).sort((a,b)=>b.orderCount-a.orderCount||a.name.localeCompare(b.name,'ar')).slice(0,limit);return json(res,200,{ok:true,users:rows,total:groups.size,orders:dedup.size,currentUsers:directory.users.length,legacyUsers:(Array.isArray(oldUsers)?oldUsers.length:0),firebaseAvailable,source:oldUsers.length?'firebase-users+legacy-snapshot':'firebase-users-only'});
  }

  // -------------------- Admin-only API key / database alignment diagnostics --------------------
  if(p==='/api/admin/api-key-diagnostics' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const db=firebaseDatabaseDiagnosticInfo();
    const local=readJSON('api_keys.json',{});const localRows=local&&typeof local==='object'&&!Array.isArray(local)?Object.values(local).filter(x=>x&&typeof x==='object'):[];
    try{
      const [remoteKeys,remoteUsers]=await Promise.all([firebaseGetJson('apiKeys',9000),firebaseGetJson('users',9000)]);
      const keyRows=remoteKeys&&typeof remoteKeys==='object'&&!Array.isArray(remoteKeys)?Object.values(remoteKeys).filter(x=>x&&typeof x==='object'&&!Array.isArray(x)):[];
      const statusOf=x=>String(x?.status||'active').trim().toLowerCase();
      const active=keyRows.filter(x=>!x.revokedAt&&!apiKeyIsPending(x)&&!['revoked','disabled','inactive'].includes(statusOf(x))&&String(x.username||'').trim()).length;
      const pending=keyRows.filter(x=>apiKeyIsPending(x)&&!apiKeyUnusedExpired(x)&&String(x.username||'').trim()).length;
      const revoked=keyRows.filter(x=>!!x.revokedAt||['revoked','disabled','inactive'].includes(statusOf(x))).length;
      const userCount=remoteUsers&&typeof remoteUsers==='object'?Object.keys(remoteUsers).length:0;
      return json(res,200,{ok:true,version:APP_VERSION,buildId:BUILD_ID,database:{host:db.host,source:db.source,databaseProjectHint:db.databaseProjectHint,serviceAccountProjectId:db.serviceAccountProjectId||null,configuredWebProjectId:db.configuredWebProjectId||null,serviceAccountProjectMatch:db.serviceAccountProjectMatch},keys:{firebaseReadable:true,firebaseRecordCount:keyRows.length,firebaseActiveCount:active,firebasePendingUnusedCount:pending,firebaseRevokedOrDisabledCount:revoked,localCacheRecordCount:localRows.length,validationPath:'apiKeys/<sha256(full API key)>',hashAlgorithm:'SHA-256'},users:{firebaseUsersRootPresent:!!(remoteUsers&&typeof remoteUsers==='object'&&Object.keys(remoteUsers).length),firebaseRecordCount:userCount}});
    }catch(e){
      return json(res,503,{ok:false,error:'تعذر قراءة سجل مفاتيح API من قاعدة Firebase المحددة؛ لم يتم إجراء أي تغيير.',code:'api_key_database_unavailable',database:{host:db.host,source:db.source,databaseProjectHint:db.databaseProjectHint,serviceAccountProjectId:db.serviceAccountProjectId||null,configuredWebProjectId:db.configuredWebProjectId||null,serviceAccountProjectMatch:db.serviceAccountProjectMatch}});
    }
  }

  // -------------------- Public API key management --------------------
  if(p==='/api/user/api-key' && req.method==='GET'){
    const u=userFromSession(req); if(!u)return json(res,401,{ok:false,error:'يجب تسجيل الدخول'});
    const keys=readJSON('api_keys.json',{}); let rec=null;
    try{
      const remote=await firebaseGetJson('apiKeys',6500);
      if(remote&&typeof remote==='object'&&!Array.isArray(remote)){
        for(const [hash,candidate] of Object.entries(remote)){
          if(!candidate||candidate.username!==u||candidate.revokedAt)continue;
          if(apiKeyUnusedExpired(candidate)){await deleteExpiredApiKey(hash,candidate,keys);continue;}
          rec=candidate;keys[hash]=candidate;break;
        }
        writeJSON('api_keys.json',keys);
      }
    }catch(e){console.warn('API key status Firebase lookup failed:',String(e.message||e).slice(0,100));}
    if(!rec){
      for(const [hash,candidate] of Object.entries(keys)){
        if(!candidate||candidate.username!==u||candidate.revokedAt||apiKeyUnusedExpired(candidate))continue;
        rec=candidate;break;
      }
    }
    const pending=apiKeyIsPending(rec);
    return json(res,200,{ok:true,exists:!!rec,masked:rec?.masked||null,status:rec?(pending?'pending':'active'):'none',activatedAt:rec?.activatedAt||null,expiresAt:pending?new Date(apiKeyUnusedExpiresAt(rec)).toISOString():null,unusedTtlHours:pending?24:null});
  }
  if(p==='/api/user/api-key' && req.method==='POST'){
    if(!telegramEncryptionReady())return json(res,503,{ok:false,error:'تعذر إنشاء مفتاح API بأمان: لا يتوفر مفتاح تشفير ثابت. اضبط SADA_ENCRYPTION_KEY أو SESSION_SECRET ثابتاً قوياً، أو تحقق من اعتماد Firebase الخادمي والتخزين الدائم.'});
    const wait=rateLimit(req,'auth'); if(wait)return json(res,429,{ok:false,error:'محاولات كثيرة، أعد المحاولة لاحقاً'},{'Retry-After':String(wait)});
    const u=userFromSession(req); if(!u)return json(res,401,{ok:false,error:'يجب تسجيل الدخول'});
    await cleanupExpiredUnusedApiKeys();
    const keys=readJSON('api_keys.json',{});
    for(const [h,v] of Object.entries(keys))if(v?.username===u&&!v.revokedAt){v.revokedAt=nowISO();try{await firebaseWriteJson('apiKeys/'+h,v,5000)}catch(e){console.warn('Old API key revoke Firebase sync failed:',String(e.message||e).slice(0,100));}}
    try{const remoteKeys=await firebaseGetJson('apiKeys',7000);if(remoteKeys&&typeof remoteKeys==='object'&&!Array.isArray(remoteKeys)){for(const [h,v] of Object.entries(remoteKeys)){if(v?.username===u&&!v.revokedAt){v.revokedAt=nowISO();await firebaseWriteJson('apiKeys/'+h,v,5000);if(keys[h])keys[h]=v;}}}}catch(e){return json(res,503,{ok:false,error:'تعذر التحقق من مفاتيح API السابقة في Firebase؛ لم يتم إصدار مفتاح جديد حتى لا تبقى مفاتيح قديمة نشطة. أعد المحاولة بعد استعادة اتصال قاعدة البيانات.',code:'api_key_rotation_check_failed'});}
    const raw=newApiKey(),hash=sha256(raw),createdAt=nowISO(),unusedExpiresAt=new Date(Date.now()+API_KEY_UNUSED_TTL_MS).toISOString(),record={username:u,createdAt,unusedExpiresAt,masked:raw.slice(0,7)+'…'+raw.slice(-4),encrypted:encryptSecret(raw),keyHash:hash,hashAlgorithm:'sha256',version:3,status:'pending',activationState:'pending',scopes:['services','balance','orders:read','orders:create','orders:cancel','orders:refill']};
    try{
      await firebaseWriteJson('apiKeys/'+hash,record,8000);
      const verify=await firebaseGetJson('apiKeys/'+hash,8000);
      if(!verify||verify.username!==u||verify.masked!==record.masked)throw new Error('Firebase read-back did not match the saved API key record');
    }catch(e){return json(res,503,{ok:false,error:'تعذر حفظ مفتاح API والتحقق منه في قاعدة Firebase الدائمة؛ لم يتم إصدار المفتاح. افحص اتصال Firebase وصلاحيات الخادم ثم أعد المحاولة.',code:'api_key_persistence_failed'});}
    keys[hash]=record;writeJSON('api_keys.json',keys);
    return json(res,200,{ok:true,apiKey:raw,masked:record.masked,createdAt:record.createdAt,status:'pending',activationState:'pending',expiresAt:record.unusedExpiresAt,unusedTtlHours:24});
  }
  if(p==='/api/user/api-key/revoke' && req.method==='POST'){
    const u=userFromSession(req); if(!u)return json(res,401,{ok:false,error:'يجب تسجيل الدخول'}); const keys=readJSON('api_keys.json',{}); let found=0;
    for(const [h,v] of Object.entries(keys))if(v?.username===u&&!v.revokedAt){v.revokedAt=nowISO();found++;try{await firebaseWriteJson('apiKeys/'+h,v,5000)}catch(e){console.warn('API key revoke Firebase sync failed:',String(e.message||e).slice(0,100));}}
    try{const remote=await firebaseGetJson('apiKeys',7000);if(remote&&typeof remote==='object'&&!Array.isArray(remote)){for(const [h,v] of Object.entries(remote)){if(v?.username===u&&!v.revokedAt){v.revokedAt=nowISO();await firebaseWriteJson('apiKeys/'+h,v,5000);if(!keys[h])found++;keys[h]=v;}}}}catch(e){return json(res,503,{ok:false,error:'تعذر تأكيد إلغاء جميع مفاتيح API في Firebase. أعد المحاولة بعد استعادة الاتصال.',code:'api_key_revoke_sync_failed'});}
    writeJSON('api_keys.json',keys);return json(res,200,{ok:true,revoked:found});
  }
  if(p==='/api/user/api-key/reveal' && req.method==='POST'){
    const u=userFromSession(req); if(!u)return json(res,401,{ok:false,error:'يجب تسجيل الدخول'}); const b=await bodyJSON(req); if(String(b.confirm||'')!=='reveal')return json(res,422,{ok:false,error:'تأكيد الإظهار مطلوب'});
    const keys=readJSON('api_keys.json',{}); let rec=null;
    try{const remote=await firebaseGetJson('apiKeys',6500);if(remote&&typeof remote==='object'&&!Array.isArray(remote)){for(const [hash,candidate] of Object.entries(remote)){if(!candidate||candidate.username!==u||candidate.revokedAt)continue;if(apiKeyUnusedExpired(candidate)){await deleteExpiredApiKey(hash,candidate,keys);continue;}rec=candidate;keys[hash]=candidate;break;}writeJSON('api_keys.json',keys);}}catch(e){console.warn('API key reveal Firebase lookup failed:',String(e.message||e).slice(0,100));}
    if(!rec){rec=Object.values(keys).find(x=>x&&x.username===u&&!x.revokedAt&&!apiKeyUnusedExpired(x))||null;}
    if(!rec?.encrypted)return json(res,404,{ok:false,error:'لا يوجد مفتاح API صالح للإظهار'});
    const raw=decryptSecret(rec.encrypted); if(!raw)return json(res,500,{ok:false,error:'تعذر فك مفتاح API؛ تحقق من ثبات مفتاح التشفير المستخدم عند إنشاء المفتاح.'}); return json(res,200,{ok:true,apiKey:raw});
  }


  // -------------------- Admin API developer center: key owners, safe status, revoke --------------------
  if(p==='/api/admin/api-users' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    try{
      const [remoteKeys,remoteUsers,remoteOrders,remoteBlocks]=await Promise.all([
        firebaseGetJson('apiKeys',10000),firebaseGetJson('users',10000),firebaseGetJson('orders',12000),firebaseGetJson('apiKeyBlocks',9000)
      ]);
      if(!remoteKeys||typeof remoteKeys!=='object'||Array.isArray(remoteKeys))return json(res,503,{ok:false,error:'عقدة مفاتيح API غير متاحة أو ليست كائناً صالحاً في Firebase؛ لم نعرض قائمة فارغة مضللة.'});
      const users=normalizeCurrentUsers(remoteUsers||{});
      const ownerOf=o=>String(o?.user||o?.username||o?.userName||o?.customerUsername||o?.customer_username||'').trim().toLowerCase();
      const orderCount=new Map();
      for(const [id,o] of collectionEntries(remoteOrders)){
        if(!o||typeof o!=='object'||o.event)continue;
        const u=ownerOf(o);if(!u)continue;
        const identity=String(o.id||o.siteOrderId||o.orderId||o.order_id||o.providerOrderId||o.smmpartyOrderId||id);
        const m=orderCount.get(u)||new Set();m.add(identity);orderCount.set(u,m);
      }
      const local=readJSON('api_keys.json',{});const merged=new Map();
      for(const [hash,rec] of Object.entries(local&&typeof local==='object'&&!Array.isArray(local)?local:{}))if(/^[a-f0-9]{64}$/i.test(hash)&&rec&&typeof rec==='object')merged.set(hash,{...rec});
      for(const [hash,rec] of Object.entries(remoteKeys))if(/^[a-f0-9]{64}$/i.test(hash)&&rec&&typeof rec==='object'&&!Array.isArray(rec))merged.set(hash,{...(merged.get(hash)||{}),...rec});
      const rows=[];
      for(const [hash,rec] of merged){
        if(apiKeyUnusedExpired(rec)){await deleteExpiredApiKey(hash,rec,local);merged.delete(hash);continue;}
        const username=String(rec.username||'').trim();if(!username)continue;
        const user=users.nameMap.get(username.toLowerCase())?.[0]?.user||{};
        const status=String(rec.status||'active').trim().toLowerCase();const revoked=!!rec.revokedAt||['revoked','disabled','inactive'].includes(status);const pending=!revoked&&apiKeyIsPending(rec)&&!apiKeyUnusedExpired(rec);const apiBlocked=remoteBlocks?.[sha256(username.toLowerCase())]?.blocked===true;
        rows.push({keyHash:hash,username,masked:String(rec.masked||'مفتاح مخفي'),createdAt:String(rec.createdAt||''),expiresAt:pending?new Date(apiKeyUnusedExpiresAt(rec)).toISOString():'',activatedAt:String(rec.activatedAt||''),lastUsedAt:String(rec.lastUsedAt||''),revokedAt:String(rec.revokedAt||''),apiBlocked,status:revoked?'revoked':apiBlocked?'blocked':pending?'pending':'active',scopes:Array.isArray(rec.scopes)?rec.scopes.map(x=>String(x)).slice(0,30):[],balanceIQD:Number(user.balance??0),orderCount:orderCount.get(username.toLowerCase())?.size||0});
      }
      rows.sort((a,b)=>Number(a.status==='active')-Number(b.status==='active')||String(b.createdAt).localeCompare(String(a.createdAt))||a.username.localeCompare(b.username,'ar'));
      return json(res,200,{ok:true,keys:rows,summary:{total:rows.length,active:rows.filter(x=>x.status==='active').length,pending:rows.filter(x=>x.status==='pending').length,blocked:rows.filter(x=>x.status==='blocked').length,revoked:rows.filter(x=>x.status==='revoked').length,users:[...new Set(rows.map(x=>x.username.toLowerCase()))].length},source:'firebase-apiKeys+firebase-users+firebase-orders',checkedAt:nowISO()});
    }catch(e){return json(res,503,{ok:false,error:'تعذر تحميل بيانات إدارة API من Firebase. لم نعرض أرقاماً افتراضية ولم نغيّر أي مفتاح.',details:String(e.message||e).slice(0,160)});}
  }
  if(p==='/api/admin/api-users/activity' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const username=String(urlObj.searchParams.get('username')||'').trim();
    if(!username||username.length>120)return json(res,422,{ok:false,error:'اسم المستخدم غير صالح.'});
    try{
      const [remoteUsers,remoteOrders,remoteKeys]=await Promise.all([firebaseGetJson('users',10000),firebaseGetJson('orders',12000),firebaseGetJson('apiKeys',10000)]);
      const normalized=normalizeCurrentUsers(remoteUsers||{});const matched=normalized.nameMap.get(username.toLowerCase())||[];const userRow=matched[0]||null;const user=userRow?.user||{};
      const ownerUsername=o=>String(o?.user||o?.username||o?.userName||o?.customerUsername||o?.customer_username||o?.user_name||'').trim().toLowerCase();
      const idSet=new Set([user.id,user.uid,user.user_id,user.userId,userRow?.key].filter(Boolean).map(String));
      const matches=[];const seenOrders=new Set();let totalSpent=0;let currency='USD';
      for(const [key,o] of collectionEntries(remoteOrders)){
        if(!o||typeof o!=='object'||o.event)continue;
        const owner=ownerUsername(o),orderUid=String(o.user_id||o.userId||o.uid||'');
        if(owner!==username.toLowerCase()&&(!orderUid||!idSet.has(orderUid)))continue;
        const id=String(o.id||o.siteOrderId||o.orderId||o.order_id||key);if(seenOrders.has(id))continue;seenOrders.add(id);
        const price=Number(o.total_price??o.totalPrice??o.charge??o.price??o.total??o.amount??0);if(Number.isFinite(price))totalSpent+=price;
        const item={id,orderNumber:String(o.order_number||o.orderNumber||o.siteOrderId||o.id||key),service:String(o.service_name||o.serviceName||o.service||o.name||'خدمة'),platform:String(o.platform_name||o.platform||''),provider:String(o.provider_name||o.providerName||o.provider||''),providerOrderId:String(o.provider_order_id||o.providerOrderId||o.externalOrderId||''),quantity:Number(o.quantity||o.qty||0)||0,link:String(o.link||o.url||''),price:Number.isFinite(price)?price:0,status:String(o.status||o.order_status||'غير معروف'),createdAt:String(o.created_date||o.createdAt||o.created_at||o.timestamp||''),updatedAt:String(o.updated_date||o.updatedAt||o.updated_at||'')};
        matches.push(item);
      }
      matches.sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));
      const balanceRaw=user.balance??user.balanceUSD??user.balance_usd??user.wallet??0;
      const balanceCurrency=String(user.currency||user.balanceCurrency||user.balance_currency||(user.balanceUSD!==undefined||user.balance_usd!==undefined?'USD':'IQD'));
      const account={username:String(user.username||userRow?.username||username),arabicName:String(user.arabic_name||user.arabicName||''),fullName:String(user.full_name||user.fullName||''),name:String(user.name||user.displayName||''),email:firebaseRecordEmail(user)||String(user.email||''),phone:String(user.phone||user.phone_number||user.mobile||''),balance:Number(balanceRaw)||0,balanceDisplay:(Number(balanceRaw)||0).toLocaleString('en-US',{maximumFractionDigits:4})+(balanceCurrency.toUpperCase()==='IQD'?' د.ع':' '+balanceCurrency),balanceCurrency,role:String(user.role||'user'),status:String(user.status||user.accountStatus||'غير محدد'),createdAt:String(user.created_at||user.createdAt||user.created_date||user.registeredAt||''),lastLogin:String(user.lastLogin||user.last_login||user.lastSeen||''),userId:String(user.id||user.uid||user.user_id||user.userId||userRow?.key||''),freePoints:Number(user.free_points??user.freePoints??0)||0,userCode:String(user.user_code||user.userCode||''),referralCode:String(user.referral_code||user.referralCode||''),customDiscount:Number(user.custom_discount??user.customDiscount??0)||0};
      const keys=collectionEntries(remoteKeys).filter(([hash,k])=>k&&String(k.username||'').toLowerCase()===username.toLowerCase()&&/^[a-f0-9]{64}$/i.test(hash)).map(([hash,k])=>({keyHash:hash,masked:String(k.masked||'مفتاح مخفي'),status:k.revokedAt?'revoked':String(k.status||'active'),createdAt:String(k.createdAt||''),lastUsedAt:String(k.lastUsedAt||''),activatedAt:String(k.activatedAt||''),expiresAt:String(k.unusedExpiresAt||k.expiresAt||'')}));
      return json(res,200,{ok:true,username,account,keys,orders:matches.slice(0,100),summary:{orderCount:matches.length,totalSpent:Number(totalSpent.toFixed(4)),currency},source:'firebase-users+firebase-orders+firebase-apiKeys',checkedAt:nowISO()});
    }catch(e){return json(res,503,{ok:false,error:'تعذر تحميل نشاط حساب API من Firebase؛ لم يتم عرض بيانات افتراضية.',details:String(e.message||e).slice(0,150)});}
  }
  if(p==='/api/admin/api-users/block' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req);const username=String(b.username||'').trim();const blocked=b.blocked===true;
    if(!username||username.length>120)return json(res,422,{ok:false,error:'اسم المستخدم غير صالح.'});
    try{
      const hash=sha256(username.toLowerCase());const record={username,blocked,updatedAt:nowISO(),updatedBy:String(session(req)?.username||'admin'),scope:'api-only'};
      await firebaseWriteJson('apiKeyBlocks/'+hash,record,8000);
      const verify=await firebaseGetJson('apiKeyBlocks/'+hash,8000);
      if(!verify||verify.blocked!==blocked||String(verify.username||'').toLowerCase()!==username.toLowerCase())throw new Error('لم يطابق سجل الحظر نتيجة التحقق بعد الكتابة.');
      return json(res,200,{ok:true,username,blocked:verify.blocked,updatedAt:verify.updatedAt,message:blocked?'تم حظر جميع مفاتيح API لهذا المستخدم دون تعطيل حساب الموقع.':'تم رفع حظر API عن المستخدم.'});
    }catch(e){return json(res,503,{ok:false,error:'تعذر حفظ حالة حظر API والتحقق منها في Firebase.',details:String(e.message||e).slice(0,140)});}
  }
  if(p==='/api/admin/api-users/revoke' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req),hash=String(b.keyHash||'').trim().toLowerCase();
    if(!/^[a-f0-9]{64}$/.test(hash))return json(res,422,{ok:false,error:'معرّف مفتاح API غير صالح.'});
    try{
      const rec=await firebaseGetJson('apiKeys/'+hash,7000);
      if(!rec||typeof rec!=='object'||Array.isArray(rec))return json(res,404,{ok:false,error:'المفتاح غير موجود في Firebase؛ لم يتم تغيير شيء.'});
      if(rec.revokedAt||['revoked','disabled','inactive'].includes(String(rec.status||'active').toLowerCase()))return json(res,200,{ok:true,revoked:true,alreadyRevoked:true,message:'هذا المفتاح ملغى مسبقاً.'});
      const updated={...rec,revokedAt:nowISO(),status:'revoked'};
      await firebaseWriteJson('apiKeys/'+hash,updated,8000);
      const verify=await firebaseGetJson('apiKeys/'+hash,8000);
      if(!verify||!verify.revokedAt||String(verify.status||'').toLowerCase()!=='revoked')throw new Error('لم ينجح التحقق من حالة الإلغاء بعد الكتابة.');
      const local=readJSON('api_keys.json',{});if(local&&local[hash]){local[hash]={...local[hash],revokedAt:verify.revokedAt,status:'revoked'};writeJSON('api_keys.json',local);}
      return json(res,200,{ok:true,revoked:true,username:String(verify.username||''),revokedAt:verify.revokedAt,message:'تم إلغاء المفتاح والتحقق من الحالة المحفوظة في Firebase.'});
    }catch(e){return json(res,503,{ok:false,error:'تعذر تأكيد إلغاء المفتاح في Firebase؛ لم نعرض العملية على أنها ناجحة. أعد المحاولة بعد استقرار الاتصال.',details:String(e.message||e).slice(0,140)});}
  }

  // -------------------- Public customer API (durable Firebase wallet + SMM actions) --------------------
  if(await handlePublicApiV1(req,res,urlObj,p))return;

  // -------------------- Admin order audit / diagnostics --------------------
  if(p==='/api/admin/order-audit/settings' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const settings=await getOrderAuditSettings();
    return json(res,200,{ok:true,settings,defaultDelayHours:3,monitorIntervalMinutes:1,storageMode:DATA_IS_EXTERNAL?'persistent-directory':'release-local'});
  }
  if(p==='/api/admin/order-audit/settings' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req);const previous=await getOrderAuditSettings();
    const delayHours=Number(b.delayHours??previous.delayHours);
    if(!Number.isInteger(delayHours)||delayHours<1||delayHours>72)return json(res,422,{ok:false,error:'مدة التأخير يجب أن تكون بين ساعة و72 ساعة'});
    const saved=await saveOrderAuditSettings({...previous,delayHours,notifyAdmin:b.notifyAdmin===undefined?previous.notifyAdmin:b.notifyAdmin===true,notifyAdminExplicit:b.notifyAdmin!==undefined?true:previous.notifyAdminExplicit===true});
    return json(res,200,{ok:true,...saved,warning:saved.persistent?'':'تم حفظ الإعداد محلياً فقط؛ اربط تخزيناً دائماً أو تحقق من صلاحيات Firebase حتى يبقى بعد إعادة النشر.'});
  }
  if(p==='/api/admin/order-audit' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const snapshot=await loadOrderAuditSnapshot(String(urlObj.searchParams.get('refresh')||'')==='1');
    if(!snapshot.firebaseAvailable&&!snapshot.rows.length)return json(res,502,{ok:false,error:'تعذر قراءة قاعدة الطلبات من Firebase، ولم يتوفر سجل خادم بديل. لم يتم عرض نتائج فارغة على أنها مؤكدة.',details:snapshot.firebaseError||'Firebase unavailable'});
    const settings=await getOrderAuditSettings();
    const result=auditPageFilter(snapshot.rows,{view:urlObj.searchParams.get('view'),q:urlObj.searchParams.get('q'),numberType:urlObj.searchParams.get('numberType'),provider:urlObj.searchParams.get('provider'),platform:urlObj.searchParams.get('platform'),service:urlObj.searchParams.get('service'),status:urlObj.searchParams.get('status'),delay:urlObj.searchParams.get('delay'),range:urlObj.searchParams.get('range'),sort:urlObj.searchParams.get('sort'),page:urlObj.searchParams.get('page'),limit:urlObj.searchParams.get('limit')},settings);
    result.items=await orderAuditEnrichUsers(result.items);
    result.source={...result.source,orderCount:snapshot.rows.length,readAt:new Date(snapshot.at).toISOString(),warning:!snapshot.firebaseAvailable?'عرض جزئي من سجل الخادم؛ تعذر تأكيد بيانات Firebase.':''};
    return json(res,200,{ok:true,...result});
  }
  if(p==='/api/admin/order-audit/check' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req);const number=String(b.number||b.orderId||'').trim();const numberType=String(b.numberType||'site');
    if(!number)return json(res,422,{ok:false,error:'أدخل رقم الطلب أولاً'});
    const snapshot=await loadOrderAuditSnapshot(true);
    if(!snapshot.firebaseAvailable&&!snapshot.rows.length)return json(res,502,{ok:false,error:'تعذر قراءة سجل الطلبات الأساسي: '+(snapshot.firebaseError||'Firebase unavailable')});
    let candidates=snapshot.rows;
    if(String(b.sourceKey||'').trim())candidates=candidates.filter(r=>String(r._firebaseKey||r.firebaseKey||'')===String(b.sourceKey).trim());
    else if(numberType==='provider')candidates=candidates.filter(r=>String(r.providerOrderId||'')===number);
    else candidates=candidates.filter(r=>String(r.siteOrderId||r.id||'')===number||String(r.publicOrderNo||'')===number);
    candidates.sort((a,b)=>Number(b.createdMs||0)-Number(a.createdMs||0));
    const raw=candidates[0];if(!raw)return json(res,404,{ok:false,error:numberType==='provider'?'لم يُعثر على رقم طلب المزوّد في سجلات الموقع. لا يمكن فحص رقم غير مرتبط بطلب محفوظ.':'رقم الطلب غير موجود في قاعدة بيانات الموقع.'});
    const cfg=await getOrderAuditSettings();let order=await orderAuditEnrichUsers([auditPublicRecord(raw,Date.now(),cfg.delayHours)]).then(x=>x[0]);
    if(!raw.providerId||!raw.providerOrderId){return json(res,200,{ok:true,externalVerified:false,saved:false,order,warning:'تم العثور على الطلب وحالته المخزنة، لكن لا توجد بيانات ربط مكتملة بالمزوّد؛ لم يتم إجراء فحص خارجي.'});}
    try{
      await ensureProviderRuntime(raw.providerId);const resolved=getProviderById(raw.providerId,{allowSingleFallback:false});const prov=resolved.prov;
      if(!prov?.url||!prov?.key)return json(res,200,{ok:true,externalVerified:false,saved:false,order,warning:'تم عرض آخر حالة مخزنة، لكن تعذر العثور على إعدادات المزود المحفوظة لهذا الطلب؛ لم يتم تغيير حالته.'});
      const d=await providerRequest(prov,{action:'status',order:String(raw.providerOrderId)});
      const providerRawStatus=String(d?.status??d?.data?.status??d?.result?.status??'').trim();const normalized=auditStatus(providerRawStatus);const checkedAt=nowISO();let saved=true;let saveError='';
      const update={providerStatus:providerRawStatus,lastCheckedAt:checkedAt,updatedAt:checkedAt};
      if(normalized!=='unknown')update.status=normalized;
      if(d?.remains!==undefined)update.remains=d.remains;
      if(d?.start_count!==undefined||d?.startCount!==undefined)update.startCount=d.start_count??d.startCount;
      if(raw._firebaseKey||raw.firebaseKey){try{await firebasePatchJson('orders/'+String(raw._firebaseKey||raw.firebaseKey),update,10000)}catch(e){saved=false;saveError=String(e.message||e).slice(0,160)}}
      const localRows=readJSON('orders.json',[]);let localChanged=false;
      if(Array.isArray(localRows)){
        for(let i=0;i<localRows.length;i++){
          const x=localRows[i];if(!x||x.event)continue;
          const same=(raw.id&&String(x.id||x.publicOrderNo||'')===String(raw.id))&&(!raw.user||String(x.user||'')===String(raw.user));
          const sameProvider=String(x.providerId||'')===String(raw.providerId)&&String(x.providerOrderId||x.smmpartyOrderId||'')===String(raw.providerOrderId);
          if(same||sameProvider){localRows[i]={...x,...update};localChanged=true;}
        }
      }
      if(localChanged){try{writeJSON('orders.json',localRows)}catch(e){saved=false;saveError=saveError||String(e.message||e).slice(0,160)}}
      const oldStatus=auditStatus(raw.status||raw.rawStatus);const newStatus=normalized==='unknown'?oldStatus:normalized;
      if(saved&&['cancelled','partial'].includes(newStatus)){const full=await resolveFinancialOrder({...raw,...(raw._firebaseKey?{_firebaseKey:raw._firebaseKey}:{}),user:raw.user,providerId:raw.providerId,providerOrderId:raw.providerOrderId});update.refundResult=await applyVerifiedOrderRefund({...full,...update,status:newStatus},d,newStatus);}
      if(saved&&oldStatus!==newStatus&&newStatus!=='unknown')notifyOrderStatusChange({...raw,...update,user:raw.user},oldStatus,newStatus).catch(()=>{});
      const mergedOrder={...order,status:newStatus,rawStatus:providerRawStatus||order.rawStatus,lastCheckedAt:checkedAt,remains:update.remains??order.remains,startCount:update.startCount??order.startCount};
      return json(res,200,{ok:true,externalVerified:true,saved,order:mergedOrder,providerStatus:providerRawStatus,providerNormalizedStatus:normalized,refund:update.refundResult||null,checkedAt,warning:normalized==='unknown'?'اتصل النظام بالمزوّد، لكن رد الحالة غير معروف؛ حافظنا على الحالة المخزنة ولم نعتبر الطلب مكتملاً.':(!saved?'تم فحص المزود لكن تعذر حفظ الحالة الجديدة في قاعدة الموقع: '+saveError:'')});
    }catch(e){
      appendJsonLedger('provider_failures.json',{stage:'admin_order_audit_status',siteOrderId:raw.id,providerId:raw.providerId,providerOrderId:raw.providerOrderId,error:String(e.message||e).slice(0,180),createdAt:nowISO()});
      return json(res,200,{ok:true,externalVerified:false,saved:false,order,warning:'تعذر التحقق من المزود الآن. الحالة المعروضة هي آخر حالة محفوظة ولم نغيّرها. السبب: '+String(e.message||'فشل الاتصال').slice(0,180)});
    }
  }

  // -------------------- Admin API / audit / stats --------------------
  if(p==='/api/admin/pricing' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const pricing=await getGlobalPricing();return json(res,200,{ok:true,pricing,guard:{...PRICE_GUARD_STATUS,cacheTtlSeconds:PRICE_GUARD_TTL_MS/1000,watchMinutes:PRICE_WATCH_MS/60000}});
  }
  if(p==='/api/admin/pricing' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req);const pct=Number(b.markupPct);if(!Number.isFinite(pct)||pct<0||pct>1000)return json(res,422,{ok:false,error:'نسبة الزيادة على تكلفة المزود يجب أن تكون بين 0 و1000%.'});
    const minutes=Number(b.intervalMinutes??10);if(![5,10,15,30,60].includes(minutes))return json(res,422,{ok:false,error:'اختر فترة تحديث من 5 أو 10 أو 15 أو 30 أو 60 دقيقة'});
    const previous=await getGlobalPricing();const saved=await saveGlobalPricing({...previous,markupPct:pct,autoSync:b.autoSync!==false,intervalMinutes:minutes,lastAttemptAt:previous.lastAttemptAt,lastSuccessAt:previous.lastSuccessAt});
    if(!saved.persistedRemotely)return json(res,503,{ok:false,persistedRemotely:false,error:'لم يتم تأكيد حفظ نسبة الربح في Firebase. لم نعلن نجاح الحفظ ولم نشغّل تحديث الأسعار. السبب: '+String(saved.remoteError||'تعذر التحقق من قاعدة البيانات').slice(0,180),pricing:saved.pricing});
    let cached={updated:0,skipped:0,localUpdated:0},cachedError='';try{cached=await applyCachedGlobalMarkup(pct)}catch(e){cachedError=String(e.message||e).slice(0,180)}
    let live={ok:false,updated:0,providerErrors:[]};if(b.syncNow===true){live=await runProviderPriceSync({manual:true})}
    return json(res,200,{ok:true,pricing:await getGlobalPricing(),persistedRemotely:true,remoteError:'',cached,cachedError,live});
  }
  if(p==='/api/admin/pricing/sync' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const result=await runProviderPriceSync({manual:true});return json(res,200,result);
  }
  if(p==='/api/admin/service-sync' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req,10*1024*1024);const list=Array.isArray(b.services)?b.services:[];if(list.length>25000)return json(res,413,{ok:false,error:'عدد الخدمات كبير جداً'});
    const safe=list.map(s=>{const providerServiceId=String(s?.smmpartyId||s?.providerServiceId||s?.serviceId||'').trim();const fbId=String(s?.fbKey||s?.id||'').trim();return {id:providerServiceId,fbId,name:String(s?.name||'خدمة'),category:String(s?.category||((Array.isArray(s?.groups)&&s.groups[0])||'عام')),sellingUsd:Number(s?.sellingUsd ?? (Number(s?.price||0)/FIXED_RATE)),rateUsd:Number(s?.sellingUsd||s?.smmRateUsd||s?.rateUsd||0),min:Number(s?.min||100),max:Number(s?.max||10000),refill:!!s?.refill,cancel:!!s?.cancel,providerId:String(s?.providerId||''),providerServiceId,smmRateUsd:Number(s?.smmRateUsd||s?.rate||0),updatedAt:nowISO()};}).filter(x=>x.id&&x.providerId);
    try{await ensureLocalServiceCatalogSeeded();}catch(e){return json(res,503,{ok:false,error:'تعذر تحميل Firebase؛ لم يبدأ تحديث الخدمات: '+String(e.message||e).slice(0,150)});}
    const root=readJSON('services.json',{}),rootBefore=JSON.parse(JSON.stringify(root));let merged=0,skippedUnapprovedNew=0;const accepted=[],changedKeys=[];
    for(const x of safe){let key=x.fbId&&root[x.fbId]?x.fbId:Object.keys(root).find(k=>!root[k]?.unapprovedAutoImport&&String(root[k]?.providerId||'')===x.providerId&&String(root[k]?.providerServiceId||root[k]?.smmpartyId||root[k]?.serviceId||'')===x.id);
      // This compatibility endpoint may refresh existing rows only. Adding new rows requires /api/admin/services/import.
      if(!key){skippedUnapprovedNew++;continue;}const old=root[key]||{};if(old.unapprovedAutoImport===true){skippedUnapprovedNew++;continue;}
      root[key]={...old,...x,fbKey:key,smmpartyId:x.id,serviceId:x.id,source:old.source||'smmparty',name:old.name||x.name,groups:Array.isArray(old.groups)?old.groups:[x.category],categories:Array.isArray(old.categories)?old.categories:[x.category],price:Number(old.price??(x.sellingUsd*FIXED_RATE)),basePrice:Number(old.basePrice??(x.sellingUsd*FIXED_RATE)),createdAt:old.createdAt||nowISO()};merged++;accepted.push(x);changedKeys.push(key);}
    try{if(merged)writeJSON('services.json',root);if(accepted.length)writeJSON('api_services.json',accepted);const cfg=readJSON('catalog_settings.json',{});cfg.legacySeedAttempted=true;cfg.catalogUpdatedAt=nowISO();cfg.lastSyncCount=merged;cfg.lastUnapprovedSyncRows=skippedUnapprovedNew;writeJSON('catalog_settings.json',cfg);
      const latest=readJSON('services.json',{}),patch={};for(const key of changedKeys)patch['services/'+key]=latest[key];if(cfg.catalogOrder)patch['settings/catalogOrder']=cfg.catalogOrder;if(merged)patch['settings/svcsVersion']=String(Date.now());if(Object.keys(patch).length)await persistFirebaseCatalogPatch(patch,{verify:true,atomic:true,timeoutMs:45000});
      return json(res,200,{ok:true,count:merged,received:safe.length,skippedUnapprovedNew,catalogCount:Object.keys(root).length,syncedAt:nowISO(),persistedRemotely:true,storage:'firebase',importPolicy:'manual-approval-required',storageMode:'firebase',verified:true});}
    catch(e){try{writeJSON('services.json',rootBefore);SITE_SERVICE_IDS_DIRTY=true;}catch(_){}return json(res,503,{ok:false,error:'تعذر تأكيد تحديث الخدمات في Firebase؛ لم نعلن التحديث نجاحاً. '+String(e.message||e).slice(0,160)});}
  }
  if(p==='/api/admin/sync-users' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);const list=Array.isArray(b.users)?b.users:[];const store=readJSON('users.json',{users:{}});let n=0;for(const x of list.slice(0,10000)){const u=String(x?.username||'').trim();const bal=Number(x?.balance);if(!u||!Number.isFinite(bal)||bal<0)continue;store.users[u]={...(store.users[u]||{name:u,role:'user'}),balance:Number(bal.toFixed(4)),totalSpent:Number(x?.totalSpent||store.users[u]?.totalSpent||0),totalOrders:Number(x?.totalOrders||store.users[u]?.totalOrders||0),discountPct:Number(x?.discountPct??store.users[u]?.discountPct??0)};n++;}writeJSON('users.json',store);ADMIN_USERS_COUNT_CACHE={at:0,value:null};ADMIN_DASHBOARD_CACHE={at:0,value:null,promise:null};return json(res,200,{ok:true,count:n});
  }
  if(p==='/api/admin/stats' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const range=String(urlObj.searchParams.get('range')||'all');if(!['today','7d','month','all'].includes(range))return json(res,422,{ok:false,error:'نطاق غير صالح'});
    const local=readJSON('orders.json',[]),map=new Map();const keyOf=(o,k='')=>String(o?.id||o?.siteOrderId||o?.orderId||o?.order_id||o?.providerOrderId||(String(o?.user||o?.username||'')+'|'+String(o?.createdAt||'')+'|'+String(o?.serviceId||'')+'|'+String(o?.quantity||''))||k);
    for(const o of Array.isArray(local)?local:[])if(o&&!o.event)map.set(keyOf(o),o);let firebaseAvailable=false,firebaseError='';
    try{const remote=await firebaseGetJson('orders',6000);firebaseAvailable=true;if(remote&&typeof remote==='object'){const entries=Array.isArray(remote)?remote.map((o,i)=>[String(i),o]):Object.entries(remote);for(const [k,o] of entries){if(!o||typeof o!=='object'||o.event)continue;const key=keyOf(o,k);map.set(key,{...(map.get(key)||{}),...o,...(map.get(key)?.providerCostUsd!==undefined&&o.providerCostUsd===undefined?{providerCostUsd:map.get(key).providerCostUsd}:{})});}}}catch(e){firebaseError=String(e.message||e).slice(0,160);}
    const stats=statsSnapshot(range,[...map.values()]);stats.source=firebaseAvailable?'firebase+local':'local-only';stats.firebaseAvailable=firebaseAvailable;return json(res,200,{ok:true,range,stats,warning:firebaseAvailable?'':('تعذر قراءة طلبات Firebase؛ الأرقام محسوبة من سجل الخادم المتاح فقط. '+firebaseError)});
  }
  if(p==='/api/admin/dashboard'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const nowMs=Date.now();
    if(ADMIN_DASHBOARD_CACHE.value&&nowMs-ADMIN_DASHBOARD_CACHE.at<60000)return json(res,200,{...ADMIN_DASHBOARD_CACHE.value,cached:true});
    if(ADMIN_DASHBOARD_CACHE.promise){try{return json(res,200,{...(await ADMIN_DASHBOARD_CACHE.promise),cached:true});}catch(_) {}}
    ADMIN_DASHBOARD_CACHE.promise=(async()=>{
      const localUsersStore=readJSON('users.json',{users:{}}),localUsers=localUsersStore&&localUsersStore.users&&typeof localUsersStore.users==='object'?localUsersStore.users:{};
      const localOrders=readJSON('orders.json',[]),localPayments=readJSON('payments.json',[]);
      let remoteOrders=null,remotePayments=null,orderWarning='',paymentWarning='',remoteUserKeys=null,userCountWarning='';
      // Shallow read returns keys only, not user balances/profiles. Cache the key count for 60 seconds: shallow mode returns keys only, with minimal RTDB bytes.
      try{if(ADMIN_USERS_COUNT_CACHE.value&&nowMs-ADMIN_USERS_COUNT_CACHE.at<60*1000){remoteUserKeys=ADMIN_USERS_COUNT_CACHE.value;}else{remoteUserKeys=await firebaseGetQueryJson('users',{shallow:'true'},10000);ADMIN_USERS_COUNT_CACHE={at:Date.now(),value:remoteUserKeys};}}catch(e){userCountWarning=String(e.message||e).slice(0,120);remoteUserKeys=null;}
      // `$key` is Firebase's built-in ordering and does not require adding `.indexOn` rules.
      // Only a bounded recent window is read; older records are already mirrored in the hosting ledger.
      try{remoteOrders=await firebaseGetQueryJson('orders',{orderBy:'"$key"',limitToLast:1000},10000);}catch(e){orderWarning=String(e.message||e).slice(0,140);}
      try{remotePayments=await firebaseGetQueryJson('payments',{orderBy:'"$key"',limitToLast:300},8000);}catch(e){paymentWarning=String(e.message||e).slice(0,140);}
      const orderMap=new Map();
      const addOrder=(o,key='')=>{if(!o||typeof o!=='object'||Array.isArray(o)||o.event)return;const id=String(o.id||o.siteOrderId||o.orderId||key);if(!id)return;const prior=orderMap.get(id)||{};orderMap.set(id,{...prior,...o});};
      for(const o of Array.isArray(localOrders)?localOrders:[])addOrder(o,o.id);
      for(const [key,o] of collectionEntries(remoteOrders))addOrder(o,key);
      const orders=[...orderMap.values()];
      const completed=orders.filter(o=>normalizeProviderStatus(o.status||'pending')==='completed');
      const revenueIQD=Number(completed.reduce((sum,o)=>{const amount=o.total!==undefined&&o.total!==null?Number(o.total):Number(o.chargeIQD??o.chargeIqd??((Number(o.chargeUsd)||0)*FIXED_RATE));return sum+(Number.isFinite(amount)&&amount>0?amount:0);},0).toFixed(4));
      const pendingOrders=orders.filter(o=>['pending','processing','in progress','in_progress','queued','awaiting'].includes(String(o.status||'pending').toLowerCase().replace(/[_-]+/g,' '))).length;
      const payMap=new Map();
      for(const p of Array.isArray(localPayments)?localPayments:[])if(p&&typeof p==='object')payMap.set(String(p._key||p.id||p.transactionId||p.createdAt||payMap.size),p);
      for(const [key,p] of collectionEntries(remotePayments))if(p&&typeof p==='object'&&!Array.isArray(p))payMap.set(String(key),p);
      const pendingPayments=[...payMap.values()].filter(p=>String(p.status||'pending')==='pending').length;
      const localNonAdmins=Object.entries(localUsers).filter(([k,u])=>u&&String(u.role||'user')!=='admin').map(([k,u])=>String(u.username||k).trim().toLowerCase()).filter(Boolean);
      const localUserKeys=new Set(localNonAdmins);
      let usersCount=localUserKeys.size,usersApproximate=true,userCountSource='local-ledger';
      if(remoteUserKeys&&typeof remoteUserKeys==='object'&&!Array.isArray(remoteUserKeys)){
        const keys=Object.keys(remoteUserKeys);const knownAdmin=new Set([String(ADMIN_USER||'').toLowerCase(),...Object.entries(localUsers).filter(([,u])=>String(u?.role||'')==='admin').flatMap(([k,u])=>[String(k||'').toLowerCase(),String(u?.username||'').toLowerCase()])].filter(Boolean));
        // RTDB shallow mode returns names only; exclude the configured administrator key if it is among those names.
        usersCount=keys.filter(k=>!knownAdmin.has(String(k).toLowerCase())).length;usersApproximate=false;userCountSource='firebase-shallow-keys';
      }
      // Exact Firebase key count via a shallow/key-only response, cached separately for 10 minutes.
      const payload={ok:true,source:'bounded-firebase-window+hosting-ledger',users:usersCount,usersApproximate,usersCountSource:userCountSource,orders:orders.length,revenueIQD,pendingOrders,pendingPayments,checkedAt:nowISO(),window:{orders:Math.min(1000,orders.length),payments:Math.min(300,payMap.size)},warning:[orderWarning,paymentWarning,userCountWarning].filter(Boolean).join(' | ')||undefined};
      ADMIN_DASHBOARD_CACHE={at:Date.now(),value:payload,promise:null};return payload;
    })();
    try{return json(res,200,await ADMIN_DASHBOARD_CACHE.promise);}catch(e){ADMIN_DASHBOARD_CACHE.promise=null;return json(res,503,{ok:false,error:'تعذر تحديث الإحصائيات: '+String(e.message||e).slice(0,180),source:'unavailable'});}
  }
  if(p==='/api/admin/stats/reset' && req.method==='POST'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);if(String(b.confirm||'')!=='RESET_STATS')return json(res,422,{ok:false,error:'تأكيد التصفير غير صحيح'});const now=nowISO();writeJSON('stats_state.json',{resetAt:now});return json(res,200,{ok:true,resetAt:now});}
  if(p==='/api/admin/balance-adjust' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req);const username=String(b.username||'').trim(),email=normalizeEmail(b.email),firebaseKey=String(b.firebaseKey||'').trim(),usd=Number(b.usd),type=String(b.type||''),reason=String(b.reason||'').trim();
    if(!username||(email&&!validEmail(email))||!Number.isFinite(usd)||usd<=0||usd>1000000||!['charge','deduct'].includes(type)||reason.length<4||reason.length>500)return json(res,422,{ok:false,error:'اسم المستخدم (والبريد إذا كان متاحاً) والمبلغ الصحيح وسبب العملية مطلوبة'});
    try{const out=await adjustAdminUserBalance(username,type,usd,reason,session(req)?.username||ADMIN_USER,firebaseKey,email);if(out.error){const status=out.error==='user-not-found'?404:out.error==='insufficient-balance'?409:422;return json(res,status,{ok:false,error:out.error==='user-not-found'?walletLookupFailureMessage(out.lookup):out.error==='email-required'?'البريد الإلكتروني الصحيح مطلوب لتحديد الحساب':out.error==='email-mismatch'?'البريد الإلكتروني لا يطابق سجل Firebase؛ لم يتم تغيير الرصيد.':'رصيد المستخدم أقل من مبلغ الخصم أو رصيد الحساب غير صالح',diagnostic:out.lookup||undefined});}return json(res,200,{...out,afterUsd:out.balanceUSD,beforeUsd:Number((out.event.beforeIQD/FIXED_RATE).toFixed(6))});}catch(e){return json(res,502,{ok:false,error:'تعذر تعديل الرصيد في Firebase: '+String(e.message||e).slice(0,180)});}
  }
  if(p==='/api/admin/balance-ledger' && req.method==='GET'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const user=String(urlObj.searchParams.get('user')||'');const rows=readJSON('balance_ledger.json',[]).filter(x=>!user||String(x.user||'')===user).slice(-500).reverse();return json(res,200,{ok:true,ledger:rows});}
  if(p==='/api/admin/user-finance' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const username=String(urlObj.searchParams.get('username')||'').trim(),email=normalizeEmail(urlObj.searchParams.get('email')||''),firebaseKey=String(urlObj.searchParams.get('firebaseKey')||'').trim();if(!username&&!validEmail(email))return json(res,422,{ok:false,error:'البريد الإلكتروني أو اسم المستخدم مطلوب'});
    const store=readJSON('users.json',{users:{}}),users=store.users||{};const localKey=(validEmail(email)?Object.keys(users).find(k=>normalizeEmail(users[k]?.email||users[k]?.mail||users[k]?.emailAddress)===email):'')||Object.keys(users).find(k=>String(k).toLowerCase()===username.toLowerCase()||String(users[k]?.username||'').toLowerCase()===username.toLowerCase());const local=localKey?users[localKey]:null;
    let remote=null,remoteError='';try{remote=validEmail(email)?await findRemoteUserByEmail(email,firebaseKey,username):await findRemoteUserByUsername(username,firebaseKey);}catch(e){remoteError=String(e.message||e).slice(0,140);}
    if(!remote?.user&&!local)return json(res,404,{ok:false,error:remoteError?'تعذر جلب سجل المستخدم من Firebase: '+remoteError:'المستخدم غير موجود في Firebase أو ملف المستخدمين المحلي.'});
    const user={...(local||{}),...(remote?.user||{}),username:String(remote?.username||local?.username||localKey||username)};
    const aliases=new Set([username,user.username,String(localKey||''),user.email,user.mail,user.emailAddress,user.phone,user.phoneNumber,user.uid,user.firebaseUid,user.authUid].map(x=>String(x||'').trim().toLowerCase()).filter(Boolean));
    const orderMap=new Map();const addOrder=o=>{if(!o||o.event||!aliases.has(String(o.user||o.username||o.userName||'').trim().toLowerCase()))return;const id=String(o.legacyHistory?'legacy:'+o.legacyImportKey:(o.id||o.siteOrderId||o.orderId||o.order_id||o.providerOrderId||o.createdAt||''));if(id)orderMap.set(id,{...(orderMap.get(id)||{}),...o});};
    for(const o of readJSON('orders.json',[]))addOrder(o);
    // Only query this user's orders; never download the whole orders collection for one profile.
    let ordersAvailable=false;
    const canonicalNames=[...new Set([username,user.username,localKey].map(x=>String(x||'').trim()).filter(Boolean))];
    const orderQueries=await Promise.allSettled(canonicalNames.map(name=>firebaseGetQueryJson('orders',{orderBy:'"user"',equalTo:JSON.stringify(name)},10000)));
    for(const result of orderQueries){if(result.status==='fulfilled'){for(const [key,o] of collectionEntries(result.value))addOrder(o);ordersAvailable=true;}else remoteError=remoteError||String(result.reason?.message||result.reason||'orders unavailable').slice(0,140);}
    const ledgerMap=new Map();const addLedger=(ev,key='')=>{if(!ev||typeof ev!=='object'||Array.isArray(ev))return;const who=String(ev.username||ev.user||ev.account||'').trim().toLowerCase();if(who&&!aliases.has(who))return;const id=String(ev.id||key||'');if(id)ledgerMap.set(id,{...(ledgerMap.get(id)||{}),...ev});};
    for(const ev of readJSON('balance_ledger.json',[]))addLedger(ev);
    for(const ev of (Array.isArray(user.adminBalanceLedger)?user.adminBalanceLedger:[]))addLedger(ev);
    // Read only the selected user's ledger entries (bounded to the newest 300); local and embedded history remains available.
    const ledgerQueries=await Promise.allSettled(canonicalNames.flatMap(name=>[
      firebaseGetQueryJson('balanceLedger',{orderBy:'"user"',equalTo:JSON.stringify(name),limitToLast:300},7000),
      firebaseGetQueryJson('balanceLedger',{orderBy:'"username"',equalTo:JSON.stringify(name),limitToLast:300},7000)
    ]));
    for(const result of ledgerQueries){if(result.status==='fulfilled'){for(const [key,ev] of collectionEntries(result.value))addLedger(ev,key);}else remoteError=remoteError||String(result.reason?.message||result.reason||'ledger unavailable').slice(0,140);}
    const ledger=[...ledgerMap.values()];const deposits=ledger.filter(x=>['charge','deposit'].includes(String(x.type||'').toLowerCase())).reduce((a,x)=>a+Number(x.amountUSD ?? x.amountUsd ?? (Number(x.amountIQD||0)/FIXED_RATE)),0);
    const orders=[...orderMap.values()];const spent=orders.reduce((a,o)=>a+Math.max(0,Number(o.chargeUsd??o.totalUsd??(Number(o.total||o.totalIQD||0)/FIXED_RATE))||0),0);
    return json(res,200,{ok:true,source:remote?.user?'firebase+local':'local-only',warning:!remote?.user?'لا يوجد سجل Firebase مطابق؛ التفاصيل المعروضة من الملف المحلي فقط، ولا يُسمح بتعديل رصيد Firebase دون سجل موثوق.':(ordersAvailable?'':'تعذر تحميل كل تفاصيل الطلبات من Firebase.'),user:{username,name:String(user.name||user.fullName||user.full_name||username),balanceUsd:Number((Number(user.balance||0)/FIXED_RATE).toFixed(6)),totalDepositsUsd:Number(deposits.toFixed(6)),totalSpentUsd:Number(spent.toFixed(6)),totalOrders:orders.length,legacyOrders:orders.filter(o=>o.legacyHistory).length,discountPct:Number(user.discountPct??user.discount??0),hasFirebaseRecord:!!remote?.firebasePath}});
  }
  if(p==='/api/admin/telegram' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    await hydrateTelegramChannelsFromFirebase().catch(()=>{});
    const cfg=telegramConfig(),storedCfg=readJSON('settings.json',{}).telegram||{};
    return json(res,200,{ok:true,telegram:{enabled:cfg.enabled,tokenSet:!!cfg.token,tokenSource:cfg.tokenSource,tokenProblem:cfg.tokenEncryptionError?'التوكن المحفوظ مشفّر لكن تعذّر فك تشفيره. تحقق من ثبات SADA_ENCRYPTION_KEY أو SESSION_SECRET نفسه المستخدم عند الحفظ.':'',encryptionReady:telegramEncryptionReady(),durableStorage:DATA_IS_EXTERNAL,tokenFromEnvironment:!!String(process.env.TELEGRAM_BOT_TOKEN||'').trim(),tokenStoredEncrypted:!!storedCfg.tokenEncrypted,chat:cfg.chat||'',activationChat:cfg.activationChat||'',overdueChat:cfg.overdueChat||'',adminChat:cfg.adminChat||'',activationEnvLocked:cfg.activationEnvLocked,overdueEnvLocked:cfg.overdueEnvLocked,adminEnvLocked:cfg.adminEnvLocked,extraChatsCount:(cfg.extraChats||[]).length}});
  }
  if(p==='/api/admin/telegram' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req),cfg=readJSON('settings.json',{}),tg=cfg.telegram||{};
    if(b.enabled!==undefined)tg.enabled=!!b.enabled;
    const newToken=String(b.token||'').trim();let verifiedBot=null;
    if(newToken){
      if(!validTelegramBotToken(newToken))return json(res,422,{ok:false,error:'صيغة التوكن غير صحيحة. أنشئ توكناً جديداً من BotFather ولا تستخدم التوكن المكشوف سابقاً.'});
      if(!telegramEncryptionReady())return json(res,503,{ok:false,error:'لم يُحفظ التوكن لحمايته. اضبط SADA_ENCRYPTION_KEY أو SESSION_SECRET ثابتاً قوياً في Railway، أو اربط Volume دائماً، ثم أعد النشر.'});
      const check=await telegramApiRequest(newToken,'getMe',{},7000);
      if(!check.ok){const status=Number(check.status||0);return json(res,status===401||status===404?422:503,{ok:false,error:status===401||status===404?'Telegram رفض التوكن. ألغِ التوكن المكشوف وأنشئ توكناً جديداً من BotFather.':'تعذر التحقق من التوكن عبر Telegram؛ لم يتم حفظه. '+String(check.description||check.error||'تحقق من اتصال الخادم وحاول مجدداً.'),telegramStatus:status||null});}
      verifiedBot=check.resultInfo||null;tg.tokenEncrypted=encryptSecret(newToken);delete tg.token;
    }
    const chatUpdates=[['adminChat','adminEnvLocked'],['activationChat','activationEnvLocked'],['overdueChat','overdueEnvLocked']];
    if(b.chat!==undefined&&!telegramConfig().activationEnvLocked){const v=normalizeTelegramChatTarget(b.chat);if(!validTelegramChatTarget(v))return json(res,422,{ok:false,error:'معرّف الوجهة غير صالح. استخدم @اسم_قناة أو رقم Chat ID.'});tg.chat=v;tg.activationChat=v;}
    for(const [field,lock] of chatUpdates){if(b[field]===undefined)continue;const current=telegramConfig();if(current[lock])continue;const value=normalizeTelegramChatTarget(b[field]);if(!validTelegramChatTarget(value))return json(res,422,{ok:false,error:field==='adminChat'?'معرّف حساب الأدمن غير صالح.':'معرّف القناة غير صالح. استخدم @اسم_قناة أو رقم Chat ID.'});tg[field]=value;if(field==='activationChat')tg.chat=value;}
    if(tg.token&&!tg.tokenEncrypted){if(!telegramEncryptionReady())return json(res,503,{ok:false,error:'التوكن القديم لم يمكن تشفيره بأمان. اضبط مفتاح تشفير ثابتاً في Railway قبل الحفظ.'});tg.tokenEncrypted=encryptSecret(tg.token);delete tg.token;}
    cfg.telegram=tg;writeJSON('settings.json',cfg);
    let firebaseChannelsSaved=false,firebaseSecretSaved=false;
    try{const channelData={activationChat:tg.activationChat||tg.chat||'',overdueChat:tg.overdueChat||'',adminChat:tg.adminChat||'',enabled:tg.enabled!==false,updatedAt:nowISO()};await firebaseWriteJson('config/telegramChannels',channelData,6000);TELEGRAM_CHANNELS_REMOTE=channelData;firebaseChannelsSaved=true;}catch(e){console.warn('Telegram channel persistence Firebase failed:',String(e.message||e).slice(0,100));}
    if(tg.tokenEncrypted){try{await firebaseWriteJson('config/telegramSecret',{tokenEncrypted:tg.tokenEncrypted,updatedAt:nowISO()},6000);firebaseSecretSaved=true;}catch(e){console.warn('Encrypted Telegram secret Firebase persistence failed:',String(e.message||e).slice(0,100));}}
    const durable=DATA_IS_EXTERNAL||firebaseChannelsSaved&&(!tg.tokenEncrypted||firebaseSecretSaved);
    if(!durable)return json(res,503,{ok:false,error:'لم يتأكد الحفظ الدائم. تم رفض اعتبار الإعدادات محفوظة؛ اربط Railway Volume على /data مع SADA_DATA_DIR=/data أو أصلح صلاحيات الكتابة في Firebase ثم أعد الحفظ.',persistent:false});
    return json(res,200,{ok:true,persistent:true,storageMode:firebaseChannelsSaved?'firebase+local':'external-volume',verifiedBot,warning:tg.tokenEncrypted&&!firebaseSecretSaved?'تم تشفير التوكن وحفظه على مساحة دائمة، لكن النسخة المشفرة في Firebase لم تتحدث.':undefined,telegram:{enabled:tg.enabled!==false,tokenSet:!!(tg.tokenEncrypted||process.env.TELEGRAM_BOT_TOKEN),tokenSource:tg.tokenEncrypted?'admin-panel':process.env.TELEGRAM_BOT_TOKEN?'railway-variable':'none',chat:tg.activationChat||tg.chat||'',activationChat:tg.activationChat||tg.chat||'',adminChat:tg.adminChat||'',overdueChat:tg.overdueChat||''}});
  }
  if(p==='/api/admin/telegram/test' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req),cfg=telegramConfig(),target=String(b.target||'activation');
    const chatId=target==='admin'?cfg.adminChat:target==='overdue'?(cfg.overdueChat||cfg.adminChat):(cfg.activationChat||cfg.chat||cfg.adminChat);
    if(!chatId)return json(res,422,{ok:false,error:target==='admin'?'معرّف حساب الأدمن غير محفوظ.':'معرّف القناة غير محفوظ. أدخل الوجهة من لوحة الإعدادات.'});
    const r=await sendTelegramDetailed(String(b.text||'✅ اختبار إشعارات صدى العراق'),{kind:'manual_test',chatId});
    return json(res,r.ok?200:502,{ok:r.ok,error:r.ok?'أكد Telegram إرسال رسالة الاختبار فعلياً.':(r.description||r.error||'فشل إرسال اختبار Telegram'),status:r.status||null,messageId:r.messageId||null,chat:r.resultInfo?.chat||null,target});
  }
  if(p==='/api/admin/telegram/test-connection' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const r=await telegramTestConnection();
    return json(res,r.ok?200:502,{ok:r.ok,error:r.ok?'تم التحقق من هوية البوت عبر Telegram':'فشل التحقق من Telegram: '+(r.description||r.error||'خطأ غير معروف'),status:r.status||null,bot:r.resultInfo||null});
  }
  if(p==='/api/admin/telegram/test-order' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const sample='🧪 اختبار إشعار طلب\n🆔 رقم طلب صدى العراق: #TEST-001\n👤 المستخدم: اختبار\n📦 الخدمة: خدمة تجريبية\n🔗 الرابط: https://example.com\n🔢 الكمية: 1,000\n💰 السعر: $0.50\n📊 الحالة: Pending\n🕐 الوقت: '+new Date().toLocaleString('en-GB',{hour12:false});const r=await sendTelegramDetailed(sample,{kind:'test_order',orderId:'TEST-001'});
    return json(res,r.ok?200:502,{ok:r.ok,error:r.ok?'أكد Telegram إرسال إشعار الطلب التجريبي':(r.description||r.error||'فشل إرسال إشعار الطلب'),status:r.status||null,messageId:r.messageId||null,chat:r.resultInfo?.chat||null});
  }
  if(p==='/api/admin/telegram/test-channel' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req);const requestedChannel=String(b.channel||'activation');
    const channel=['overdue','admin'].includes(requestedChannel)?requestedChannel:'activation';const r=await notifyTelegramRecipients(String(b.text||('🧪 اختبار '+(channel==='overdue'?'قناة الطلبات المتأخرة':channel==='admin'?'حساب مدير صدى العراق':'قناة التفعيلات')+' — صدى العراق')),{channel,kind:'manual_channel_test'});
    const perTarget=(r.results||[]).map(x=>(x.ok?'✅ نجح ':'❌ فشل ')+String(x.chatId||'وجهة')+(x.messageId?' · رسالة #'+x.messageId:'')+(x.error?' — '+String(x.error):'')).join(' | ');const summary=r.primaryOk?'أكد Telegram الإرسال إلى الوجهة المطلوبة.':r.fallbackSent?'تنبيه: لم تصل الرسالة إلى الوجهة المطلوبة، لكن وصلت إلى الوجهة الاحتياطية. أضف البوت إلى قناة التفعيلات بصلاحية نشر الرسائل حتى تصل هناك.':'لم تصل الرسالة إلى الوجهة المطلوبة ولا توجد وجهة احتياطية أكدت الاستلام.';return json(res,r.ok?200:502,{ok:r.ok,primaryOk:!!r.primaryOk,delivered:!!r.delivered,fallbackSent:!!r.fallbackSent,deliveredTo:r.deliveredTo||[],error:summary,description:r.description||'',results:r.results||[],target:channel});
  }
  if(p==='/api/admin/telegram/logs' && req.method==='GET'){if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});return json(res,200,{ok:true,logs:readJSON('telegram_notifications.json',[]).slice(-50).reverse()});}

  if(p==='/api/welcome-settings' && req.method==='GET'){
    const settings=readJSON('settings.json',{});let remote=null;try{remote=await firebaseGetJson('config/welcomePopup',3500)}catch(_){}
    const localWelcome=settings.welcomePopup&&typeof settings.welcomePopup==='object'?settings.welcomePopup:{};const remoteWelcome=remote&&typeof remote==='object'?remote:{};const v=(Date.parse(remoteWelcome.updatedAt||'')||0)>=(Date.parse(localWelcome.updatedAt||'')||0)?{...localWelcome,...remoteWelcome}:{...remoteWelcome,...localWelcome};
    const safeUrl=value=>{try{const u=new URL(String(value||''));return u.protocol==='https:'?u.toString():''}catch(_){return ''}};
    const cfg={welcome:{enabled:v.enabled!==false,showEveryEntry:v.showEveryEntry!==false,splashEnabled:v.splashEnabled!==false,title:String(v.title||'مرحباً بكم في صدى العراق!').slice(0,100),subtitle:String(v.subtitle||'مرحباً بك، يسعدنا حضورك. نحن إلى جانبك في كل وقت.').slice(0,240),tutorialTitle:String(v.tutorialTitle||'شرح التطبيق').slice(0,60),tutorialSubtitle:String(v.tutorialSubtitle||'شاهد شرح الاستخدام بالتفصيل').slice(0,100),tutorialUrl:safeUrl(v.tutorialUrl||settings.tutorialUrl||settings.youtubeUrl||'https://youtu.be/vVZv3xv8LnU?si=cvSbqCAgwSB1VLJE'),whatsappTitle:String(v.whatsappTitle||'دعم الواتساب').slice(0,60),whatsappSubtitle:String(v.whatsappSubtitle||'تحدث معنا على واتساب').slice(0,100),whatsappUrl:safeUrl(v.whatsappUrl||settings.waUrl||settings.waNum||'https://wa.me/9647762267959')||normalizeWhatsAppUrl(settings.waUrl||settings.waNum||''),telegramTitle:String(v.telegramTitle||'قناة التليجرام').slice(0,60),telegramSubtitle:String(v.telegramSubtitle||'تابع آخر الأخبار والتحديثات').slice(0,100),telegramUrl:(()=>{const u=safeUrl(v.telegramUrl||settings.telegramChannelUrl||'https://t.me/jbhbhg58')||'https://t.me/jbhbhg58';return /^https:\/\/t\.me\/(?:hddjh55|jgkhfcvn)\/?$/i.test(u)?'https://t.me/jbhbhg58':u})()}};
    return json(res,200,{ok:true,...cfg});
  }
  if(p==='/api/admin/welcome-settings' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const settings=readJSON('settings.json',{});let remote=null;try{remote=await firebaseGetJson('config/welcomePopup',5000)}catch(_){}
    const localWelcome=settings.welcomePopup&&typeof settings.welcomePopup==='object'?settings.welcomePopup:{};const remoteWelcome=remote&&typeof remote==='object'?remote:{};const welcome=(Date.parse(remoteWelcome.updatedAt||'')||0)>=(Date.parse(localWelcome.updatedAt||'')||0)?{...localWelcome,...remoteWelcome}:{...remoteWelcome,...localWelcome};const tg=telegramConfig();
    return json(res,200,{ok:true,welcome:{enabled:welcome.enabled!==false,showEveryEntry:welcome.showEveryEntry!==false,splashEnabled:welcome.splashEnabled!==false,title:welcome.title||'مرحباً بكم في صدى العراق!',subtitle:welcome.subtitle||'مرحباً بك، يسعدنا حضورك. نحن إلى جانبك في كل وقت.',tutorialTitle:welcome.tutorialTitle||'شرح التطبيق',tutorialSubtitle:welcome.tutorialSubtitle||'شاهد شرح الاستخدام بالتفصيل',tutorialUrl:welcome.tutorialUrl||settings.tutorialUrl||settings.youtubeUrl||'https://youtu.be/vVZv3xv8LnU?si=cvSbqCAgwSB1VLJE',whatsappTitle:welcome.whatsappTitle||'دعم الواتساب',whatsappSubtitle:welcome.whatsappSubtitle||'تحدث معنا على واتساب',whatsappUrl:welcome.whatsappUrl||settings.waUrl||'https://wa.me/9647762267959',telegramTitle:welcome.telegramTitle||'قناة التليجرام',telegramSubtitle:welcome.telegramSubtitle||'تابع آخر الأخبار والتحديثات',telegramUrl:(()=>{const u=String(welcome.telegramUrl||'https://t.me/jbhbhg58');return /^https:\/\/t\.me\/(?:hddjh55|jgkhfcvn)\/?$/i.test(u)?'https://t.me/jbhbhg58':u})()},channels:{activationChat:tg.activationChat||'',overdueChat:tg.overdueChat||'',activationEnvLocked:tg.activationEnvLocked,overdueEnvLocked:tg.overdueEnvLocked},telegram:{enabled:tg.enabled,tokenSet:!!tg.token}});
  }
  if(p==='/api/admin/welcome-settings' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req);const w=b.welcome&&typeof b.welcome==='object'?b.welcome:{};const channels=b.channels&&typeof b.channels==='object'?b.channels:{};const wantsChannelUpdate=Object.prototype.hasOwnProperty.call(b,'channels')||Object.prototype.hasOwnProperty.call(b,'telegramEnabled');
    const safeText=(x,max,def='')=>String(x??def).trim().slice(0,max);
    const safeUrl=(x)=>{try{const u=new URL(String(x||'').trim());return u.protocol==='https:'?u.toString():''}catch(_){return ''}};
    const old=readJSON('settings.json',{});const welcome={enabled:w.enabled!==false,showEveryEntry:w.showEveryEntry!==false,splashEnabled:w.splashEnabled!==false,title:safeText(w.title,100,'مرحباً بكم في صدى العراق!'),subtitle:safeText(w.subtitle,240,'مرحباً بك، يسعدنا حضورك. نحن إلى جانبك في كل وقت.'),tutorialTitle:safeText(w.tutorialTitle,60,'شرح التطبيق'),tutorialSubtitle:safeText(w.tutorialSubtitle,100,'شاهد شرح الاستخدام بالتفصيل'),tutorialUrl:safeUrl(w.tutorialUrl)||'https://youtu.be/vVZv3xv8LnU?si=cvSbqCAgwSB1VLJE',whatsappTitle:safeText(w.whatsappTitle,60,'دعم الواتساب'),whatsappSubtitle:safeText(w.whatsappSubtitle,100,'تحدث معنا على واتساب'),whatsappUrl:safeUrl(w.whatsappUrl),telegramTitle:safeText(w.telegramTitle,60,'قناة التليجرام'),telegramSubtitle:safeText(w.telegramSubtitle,100,'تابع آخر الأخبار والتحديثات'),telegramUrl:safeUrl(w.telegramUrl)||'https://t.me/jbhbhg58',updatedAt:nowISO()};
    const tg={...(old.telegram||{})};if(b.telegramEnabled!==undefined)tg.enabled=b.telegramEnabled===true;const validateChat=(x)=>{const v=normalizeTelegramChatTarget(x);return !v||validTelegramChatTarget(v)};
    if(channels.activationChat!==undefined&&!telegramConfig().activationEnvLocked){if(!validateChat(channels.activationChat))return json(res,422,{ok:false,error:'اسم قناة التفعيلات غير صالح'});tg.activationChat=normalizeTelegramChatTarget(channels.activationChat);tg.chat=tg.activationChat||tg.chat||'';}
    if(channels.overdueChat!==undefined&&!telegramConfig().overdueEnvLocked){if(!validateChat(channels.overdueChat))return json(res,422,{ok:false,error:'اسم قناة الطلبات المتأخرة غير صالح'});tg.overdueChat=normalizeTelegramChatTarget(channels.overdueChat);}
    old.welcomePopup=welcome;old.telegram=tg;writeJSON('settings.json',old);
    let firebaseWelcome=false,firebaseChannels=false,errors=[];
    try{await firebaseWriteJson('config/welcomePopup',welcome,7000);firebaseWelcome=true}catch(e){errors.push('welcome: '+String(e.message||e).slice(0,120))}
    if(wantsChannelUpdate){try{const liveTelegram=telegramConfig();const channelData={activationChat:tg.activationChat||liveTelegram.activationChat||'',overdueChat:tg.overdueChat||liveTelegram.overdueChat||'',adminChat:tg.adminChat||liveTelegram.adminChat||'',enabled:tg.enabled!==false,updatedAt:nowISO()};await firebaseWriteJson('config/telegramChannels',channelData,7000);TELEGRAM_CHANNELS_REMOTE=channelData;firebaseChannels=true}catch(e){errors.push('channels: '+String(e.message||e).slice(0,120))}}
    // Welcome settings are independently durable. A channel-write failure must not make
    // a successfully persisted welcome/tutorial save look as though it failed.
    const durable=firebaseWelcome||DATA_IS_EXTERNAL;
    if(!durable)return json(res,503,{ok:false,error:'لم يكتمل الحفظ الدائم لإعدادات الترحيب. تم حفظ نسخة محلية مؤقتة فقط، لكن Firebase رفض الحفظ ولا يوجد Railway Volume مؤكد. افحص صلاحيات كتابة Firebase ثم أعد الحفظ.',welcome,channels:{activationChat:tg.activationChat||telegramConfig().activationChat||'',overdueChat:tg.overdueChat||telegramConfig().overdueChat||''},persisted:false,firebaseWelcome,firebaseChannels:wantsChannelUpdate?firebaseChannels:null,errors});
    const warning=!firebaseWelcome?'تم الحفظ في مساحة دائمة على الخادم، لكن Firebase لم يؤكد حفظ إعدادات الترحيب.':(wantsChannelUpdate&&!firebaseChannels?'تم حفظ إعدادات الترحيب، لكن لم تكتمل مزامنة إعدادات القنوات.':'');
    return json(res,200,{ok:true,welcome,channels:{activationChat:tg.activationChat||telegramConfig().activationChat||'',overdueChat:tg.overdueChat||telegramConfig().overdueChat||''},persisted:true,firebaseWelcome,firebaseChannels:wantsChannelUpdate?firebaseChannels:null,warning,errors});
  }
  if(p==='/api/admin/refunds' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const q=String(urlObj.searchParams.get('q')||'').trim().toLowerCase();let firebaseAvailable=true,warning='';let peopleRoot={},remoteOrderRoot={};
    try{peopleRoot=await firebaseGetJson('users',12000)||{};}catch(e){firebaseAvailable=false;warning='تعذر قراءة مستخدمي Firebase: '+String(e.message||e).slice(0,120)}
    try{remoteOrderRoot=await firebaseGetJson('orders',12000)||{};}catch(e){firebaseAvailable=false;warning=(warning?warning+' · ':'')+'تعذر قراءة الطلبات من Firebase: '+String(e.message||e).slice(0,120)}
    const profileByUser=new Map(),profileByEmail=new Map();
    for(const [key,u] of collectionEntries(peopleRoot)){if(!u||typeof u!=='object'||Array.isArray(u))continue;const username=String(u.username||u.userName||u.user||u.handle||decodeFirebaseSafeKey(key)||key).trim(),email=String(firebaseRecordEmail(u)||'').trim().toLowerCase();if(username)profileByUser.set(username.toLowerCase(),{...u,username,email});if(email)profileByEmail.set(email,{...u,username,email});}
    for(const [key,u] of Object.entries(readJSON('users.json',{users:{}}).users||{})){if(!u||typeof u!=='object')continue;const username=String(u.username||u.userName||u.user||key).trim(),email=String(firebaseRecordEmail(u)||'').trim().toLowerCase();if(username&&!profileByUser.has(username.toLowerCase()))profileByUser.set(username.toLowerCase(),{...u,username,email});if(email&&!profileByEmail.has(email))profileByEmail.set(email,{...u,username,email});}
    const orderMap=new Map(),orderKey=o=>String(o.id||o.siteOrderId||o.orderId||o.order_id||o.providerOrderId||o.smmpartyOrderId||o.publicOrderNo||'')+'|'+String(o.user||o.username||'').toLowerCase();
    for(const o of readJSON('orders.json',[])){if(o&&typeof o==='object'&&!o.event)orderMap.set(orderKey(o),o)}
    for(const [key,o] of collectionEntries(remoteOrderRoot)){if(o&&typeof o==='object'&&!Array.isArray(o)&&!o.event){const id=orderKey(o);orderMap.set(id,{...(orderMap.get(id)||{}),...o,_firebaseKey:key})}}
    const orderRows=[...orderMap.values()],allEvents=new Map();const pushEvent=(ev,username,email='')=>{if(!ev||typeof ev!=='object')return;const id=String(ev.id||[username,ev.orderId,ev.providerOrderId,ev.createdAt,ev.amountIQD].join('|'));const prof=profileByUser.get(String(username||ev.user||'').toLowerCase())||profileByEmail.get(String(email||'').toLowerCase())||{};allEvents.set(id,{...(allEvents.get(id)||{}),...ev,id,user:String(ev.user||username||prof.username||''),email:String(email||ev.email||prof.email||'')})};
    for(const ev of readJSON('refunds.json',[]))pushEvent(ev,String(ev?.user||''),String(ev?.email||''));
    for(const [key,u] of collectionEntries(peopleRoot)){if(!u||typeof u!=='object'||Array.isArray(u))continue;const uname=String(u.username||u.userName||u.user||u.handle||decodeFirebaseSafeKey(key)||key).trim(),email=String(firebaseRecordEmail(u)||'').trim().toLowerCase(),maps=u.sadaRefunds&&typeof u.sadaRefunds==='object'?u.sadaRefunds:{};for(const [refundKey,entry] of Object.entries(maps)){if(!entry||typeof entry!=='object')continue;const events=Array.isArray(entry.events)&&entry.events.length?entry.events:[{...entry,id:entry.id||refundKey,orderId:entry.orderId||entry.siteOrderId,amountIQD:entry.totalIQD||entry.amountIQD,amountUSD:entry.amountUSD,status:entry.status,createdAt:entry.updatedAt||entry.createdAt}];for(const ev of events)pushEvent(ev,uname,email)}}
    const enriched=[...allEvents.values()].map(ev=>{const user=String(ev.user||''),order=orderRows.find(o=>String(o.user||o.username||'').toLowerCase()===user.toLowerCase()&&((ev.orderId&&[o.id,o.siteOrderId,o.orderId,o.publicOrderNo].some(x=>String(x||'')===String(ev.orderId)))||(ev.providerOrderId&&String(o.providerOrderId||o.smmpartyOrderId||'')===String(ev.providerOrderId))))||{},profile=profileByUser.get(user.toLowerCase())||{};const rawChargeIQD=order.totalIQD??order.total??(Number(order.chargeUsd||0)*FIXED_RATE);const chargeIQD=Number(rawChargeIQD||0);return {...ev,username:user,email:String(ev.email||profile.email||order.email||''),name:String(profile.fullName||profile.name||order.userName||user),publicOrderNo:String(order.publicOrderNo||(/^[0-9]+$/.test(String(ev.orderId||''))?ev.orderId:'')||''),siteOrderId:String(order.id||order.siteOrderId||ev.orderId||''),providerOrderId:String(ev.providerOrderId||order.providerOrderId||order.smmpartyOrderId||''),serviceName:String(ev.serviceName||order.serviceName||order.name||'خدمة'),link:String(order.link||''),quantity:Number(ev.quantity??order.quantity??order.qty??0),originalChargeIQD:chargeIQD,originalChargeUSD:Number((chargeIQD/FIXED_RATE).toFixed(6)),amountIQD:Math.max(0,Number(ev.amountIQD||0)),amountUSD:Number((Number(ev.amountIQD||0)/FIXED_RATE).toFixed(6))}}).sort((a,b)=>(Date.parse(b.createdAt||0)||0)-(Date.parse(a.createdAt||0)||0));
    const stats={count:enriched.length,totalRefundIQD:enriched.reduce((n,r)=>n+Math.max(0,Number(r.amountIQD||0)),0),totalRefundUSD:0,users:new Set(enriched.map(r=>String(r.user||'').toLowerCase()).filter(Boolean)).size};stats.totalRefundUSD=Number((stats.totalRefundIQD/FIXED_RATE).toFixed(6));
    const filtered=enriched.filter(r=>!q||[r.user,r.username,r.name,r.email,r.orderId,r.siteOrderId,r.publicOrderNo,r.providerOrderId,r.serviceName,r.status].join(' ').toLowerCase().includes(q));
    const byUser=new Map();for(const r of enriched){const k=String(r.user||'غير معروف');const v=byUser.get(k)||{username:k,email:r.email||'',count:0,totalRefundIQD:0,totalRefundUSD:0};v.count++;v.totalRefundIQD+=Number(r.amountIQD||0);v.totalRefundUSD=Number((v.totalRefundIQD/FIXED_RATE).toFixed(6));if(!v.email&&r.email)v.email=r.email;byUser.set(k,v)}
    return json(res,200,{ok:true,stats,users:[...byUser.values()].sort((a,b)=>b.totalRefundIQD-a.totalRefundIQD),items:filtered.slice(0,1000),total:filtered.length,firebaseAvailable,warning:warning||(!firebaseAvailable?'تم عرض السجلات المتاحة فقط؛ قد تكون إحصائيات الاسترداد غير مكتملة.':'')});
  }
  if(p==='/api/user/refunds' && req.method==='GET'){
    const username=userFromSession(req);if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول لعرض عمليات الاسترداد'});
    try{
      const user=await firebaseUserByUsername(username);if(!user)return json(res,200,{ok:true,user:username,balanceIQD:0,balanceUSD:0,refunds:[],warning:'لم يتم العثور على سجل رصيد المستخدم في Firebase.'});
      const map=user.sadaRefunds&&typeof user.sadaRefunds==='object'?user.sadaRefunds:{};const rows=[];for(const [refundKey,entry] of Object.entries(map)){if(!entry||typeof entry!=='object')continue;const events=Array.isArray(entry.events)&&entry.events.length?entry.events:[{...entry,id:entry.id||refundKey,orderId:entry.orderId,amountIQD:entry.totalIQD||entry.amountIQD,amountUSD:entry.amountUSD,status:entry.status,createdAt:entry.updatedAt||entry.createdAt}];for(const ev of events)rows.push({...ev,user:username});}
      const global=readJSON('refunds.json',[]);for(const r of global.filter(x=>String(x.user||'').toLowerCase()===username.toLowerCase())){if(!rows.some(y=>y.id&&y.id===r.id))rows.push(r)}
      let orderRows=readJSON('orders.json',[]).filter(o=>o&&typeof o==='object'&&!o.event);try{const remote=await firebaseGetJson('orders',8000);for(const [key,o] of collectionEntries(remote)){if(!o||typeof o!=='object'||o.event)continue;const idx=orderRows.findIndex(x=>String(x.user||x.username||'').toLowerCase()===String(o.user||o.username||'').toLowerCase()&&String(x.id||x.siteOrderId||'')===String(o.id||o.siteOrderId||''));if(idx>=0)orderRows[idx]={...orderRows[idx],...o};else orderRows.push({...o,_firebaseKey:key});}}catch(_){}
      const profileEmail=String(firebaseRecordEmail(user)||'');for(let i=0;i<rows.length;i++){const r=rows[i],o=orderRows.find(x=>String(x.user||x.username||'').toLowerCase()===username.toLowerCase()&&((r.orderId&&[x.id,x.siteOrderId,x.publicOrderNo,x.orderId].some(v=>String(v||'')===String(r.orderId)))||(r.providerOrderId&&String(x.providerOrderId||x.smmpartyOrderId||'')===String(r.providerOrderId))))||{};const rawCharged=o.totalIQD??o.total??(Number(o.chargeUsd||0)*FIXED_RATE);const charged=Number(rawCharged||0);rows[i]={...r,email:profileEmail,publicOrderNo:String(o.publicOrderNo||(/^[0-9]+$/.test(String(r.orderId||''))?r.orderId:'')||''),siteOrderId:String(o.id||o.siteOrderId||r.orderId||''),providerOrderId:String(r.providerOrderId||o.providerOrderId||o.smmpartyOrderId||''),serviceName:String(r.serviceName||o.serviceName||o.name||'خدمة'),link:String(o.link||''),quantity:Number(r.quantity??o.quantity??o.qty??0),originalChargeIQD:charged,originalChargeUSD:Number((charged/FIXED_RATE).toFixed(6)),amountIQD:Math.max(0,Number(r.amountIQD||0)),amountUSD:Number((Number(r.amountIQD||0)/FIXED_RATE).toFixed(6))};}
      rows.sort((a,b)=>(Date.parse(b.createdAt||'')||0)-(Date.parse(a.createdAt||'')||0));const total=rows.reduce((sum,r)=>sum+Math.max(0,Number(r.amountIQD||0)),0);const balanceIQD=Number(user.balance||0);
      return json(res,200,{ok:true,user:username,email:profileEmail,balanceIQD,balanceUSD:Number((balanceIQD/FIXED_RATE).toFixed(6)),totalRefundIQD:total,totalRefundUSD:Number((total/FIXED_RATE).toFixed(6)),refunds:rows.slice(0,500)});
    }catch(e){return json(res,502,{ok:false,error:'تعذر قراءة سجل الاسترداد من قاعدة البيانات: '+String(e.message||e).slice(0,150)});}
  }
  if(p==='/api/admin/order-audit/balances' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const q=String(urlObj.searchParams.get('q')||'').trim().toLowerCase();const sort=String(urlObj.searchParams.get('sort')||'balance');const page=Math.max(1,parseInt(urlObj.searchParams.get('page')||'1',10)||1);const limit=Math.max(10,Math.min(100,parseInt(urlObj.searchParams.get('limit')||'50',10)||50));
    let remote=null;let remoteOk=false;try{remote=await firebaseGetJson('users',12000);if(remote!==null&&remote!==undefined&&(typeof remote!=='object'))throw new Error('شكل بيانات users غير متوقع');remoteOk=true}catch(e){if(!DATA_IS_EXTERNAL)return json(res,502,{ok:false,error:'تعذر قراءة أرصدة Firebase بأمان؛ لم نعرض أرقاماً محلية على أنها الأرصدة الحقيقية.',details:String(e.message||e).slice(0,140)})}
    const local=readJSON('users.json',{users:{}}).users||{};const all=new Map();for(const [k,v] of Object.entries(local)){if(v&&typeof v==='object')all.set(k,{...v,username:String(v.username||k),_firebaseKey:'',_source:'local'})}for(const [k,v] of collectionEntries(remote)){if(v&&typeof v==='object'&&!Array.isArray(v)){const username=String(v.username||v.userName||decodeFirebaseSafeKey(k)||k);all.set(username,{...(all.get(username)||{}),...v,username,_firebaseKey:String(k),_source:'firebase'})}}
    const orderCounts=new Map();let ordersAvailable=true;try{const orderRoot=await firebaseGetJson('orders',10000),orderRows=new Map();for(const o of readJSON('orders.json',[])){if(o&&typeof o==='object'&&!o.event)orderRows.set(String(o.id||o.siteOrderId||o.providerOrderId||o.createdAt||'')+'|'+String(o.user||o.username||'').toLowerCase(),o)}for(const [key,o] of collectionEntries(orderRoot)){if(o&&typeof o==='object'&&!o.event)orderRows.set(String(o.id||o.siteOrderId||o.providerOrderId||o.createdAt||key)+'|'+String(o.user||o.username||'').toLowerCase(),o)}for(const o of orderRows.values()){const u=String(o.user||o.username||'').trim().toLowerCase();if(u)orderCounts.set(u,(orderCounts.get(u)||0)+1)}}catch(_){ordersAvailable=false}
    const rows=[...all.values()].map(u=>({username:String(u.username||u.u||''),name:String(u.fullName||u.name||u.username||''),email:String(firebaseRecordEmail(u)||''),balanceIQD:Number(u.balance||0),balanceUSD:Number((Number(u.balance||0)/FIXED_RATE).toFixed(6)),orderCount:ordersAvailable?(orderCounts.get(String(u.username||u.u||'').trim().toLowerCase())||0):null,role:String(u.role||'user'),discountPct:Number(u.discountPct??u.discount??0),banned:isSadaAdminBannedAccount(u),status:String(u.status||u.accountStatus||''),updatedAt:u.updatedAt||u.joined||null,firebaseKey:String(u._firebaseKey||'')})).filter(u=>u.username&&(!q||[u.username,u.name,u.email].join(' ').toLowerCase().includes(q))).sort((a,b)=>sort==='orders'?((Number(b.orderCount)||0)-(Number(a.orderCount)||0)||b.balanceIQD-a.balanceIQD):sort==='balance_asc'?(a.balanceIQD-b.balanceIQD||a.username.localeCompare(b.username,'ar')):(b.balanceIQD-a.balanceIQD||a.username.localeCompare(b.username,'ar')));
    const stats={totalUsers:all.size,withBalance:rows.filter(x=>x.balanceIQD>0).length,totalBalanceIQD:[...all.values()].reduce((sum,u)=>sum+Number(u.balance||0),0),totalBalanceUSD:0};stats.totalBalanceUSD=Number((stats.totalBalanceIQD/FIXED_RATE).toFixed(6));
    return json(res,200,{ok:true,stats,items:rows.slice((page-1)*limit,page*limit),page,limit,total:rows.length,totalPages:Math.max(1,Math.ceil(rows.length/limit)),source:remoteOk?'firebase':'local-only',warning:(remoteOk?'': 'تنبيه: مصدر Firebase غير متاح؛ بيانات العرض محلية وقد لا تعكس الرصيد الحي.')+(!ordersAvailable?' · تعذر قراءة الطلبات؛ أعداد الطلبات غير متاحة.':'')});
  }
  if(p==='/api/admin/order-audit/balances/adjust' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req);const username=String(b.username||'').trim(),email=normalizeEmail(b.email),firebaseKey=String(b.firebaseKey||'').trim(),type=String(b.type||''),reason=String(b.reason||'').trim(),amount=Number(b.amountUsd);
    if(!username||(email&&!validEmail(email))||!['charge','deduct','clear'].includes(type)||reason.length<4||reason.length>500)return json(res,422,{ok:false,error:'حدد اسم المستخدم (والبريد إذا كان متاحاً) ونوع العملية وسبباً واضحاً من 4 إلى 500 حرف'});
    if(type!=='clear'&&(!Number.isFinite(amount)||amount<=0||amount>1000000))return json(res,422,{ok:false,error:'أدخل مبلغاً بالدولار أكبر من صفر'});
    try{const out=await adjustAdminUserBalance(username,type,amount,reason,session(req)?.username||ADMIN_USER,firebaseKey,email);if(out.error){const status=out.error==='user-not-found'?404:out.error==='insufficient-balance'?409:422;return json(res,status,{ok:false,error:out.error==='user-not-found'?walletLookupFailureMessage(out.lookup):out.error==='email-required'?'البريد الإلكتروني الصحيح مطلوب لتحديد الحساب':out.error==='email-mismatch'?'البريد الإلكتروني لا يطابق سجل Firebase؛ لم يتم تغيير الرصيد.':'رصيد المستخدم أقل من مبلغ الخصم أو رصيد الحساب غير صالح',diagnostic:out.lookup||undefined});}return json(res,200,out)}catch(e){return json(res,502,{ok:false,error:'تعذر تعديل الرصيد في Firebase: '+String(e.message||e).slice(0,180)});}
  }
  if(p==='/api/firebase/custom-token'&&req.method==='GET'){
    const s=session(req);if(!s||!['user','admin'].includes(String(s.role||'')))return json(res,401,{ok:false,error:'يجب تسجيل الدخول أولاً.'});
    if(!FIREBASE_DATABASE_URL)return json(res,503,{ok:false,error:'رابط Firebase المضمّن غير مضبوط في هذا الإصدار.'});
    try{return json(res,200,{ok:true,token:createFirebaseCustomToken(String(s.username),String(s.role))});}
    catch(e){return json(res,503,{ok:false,error:String(e.message||e).slice(0,220)});}
  }
  if(p==='/api/admin/firebase/verify'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    if(!FIREBASE_DATABASE_URL)return json(res,503,{ok:false,error:'رابط قاعدة Firebase المضمّن غير مضبوط. '});
    const id='health_'+Date.now().toString(36)+'_'+crypto.randomBytes(4).toString('hex');
    const testPath='_system/healthChecks/'+id;const probe={id,app:APP_NAME,createdAt:nowISO(),purpose:'connectivity-smoke-test'};
    try{
      const auth=await firebaseAuthContext();
      const [users,orders,providers]=await Promise.all([firebaseGetJson('users',15000),firebaseGetJson('orders',15000),firebaseGetJson('config/smmProviders',8000)]);const services=readJSON('services.json',{});
      await firebaseWriteJson(testPath,probe,10000);const check=await firebaseGetJson(testPath,10000);
      if(!check||check.id!==id)throw new Error('كتابة Firebase نجحت ظاهرياً لكن قراءة التحقق فشلت.');
      await firebaseDeleteJson(testPath,10000);const deleted=await firebaseGetJson(testPath,8000);if(deleted!==null)throw new Error('تعذر حذف سجل الاختبار المؤقت من Firebase.');
      return json(res,200,{ok:true,connected:true,readVerified:true,writeVerified:true,deleteVerified:true,databaseDriver:'rest-oauth',authMode:auth.headers?.Authorization?'service-account-oauth':(auth.queryAuth?'database-secret':'test-only-unauthenticated'),counts:{users:users&&typeof users==='object'?Object.keys(users).length:0,orders:orders&&typeof orders==='object'?Object.keys(orders).length:0,services:services&&typeof services==='object'?Object.keys(services).length:0,providers:providers&&typeof providers==='object'?Object.keys(providers).length:0},checkedAt:nowISO()});
    }catch(e){try{await firebaseDeleteJson(testPath,5000)}catch(_){}return json(res,503,{ok:false,connected:false,error:String(e.message||e).slice(0,240),checkedAt:nowISO()});}
  }
  if(p==='/api/admin/firebase/import-catalog'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    if(!FIREBASE_DATABASE_URL)return json(res,503,{ok:false,error:'رابط قاعدة Firebase المضمّن غير مضبوط.'});
    const b=await bodyJSON(req,10*1024*1024),catalog=b&&b.catalog;
    if(!catalog||typeof catalog!=='object'||Array.isArray(catalog))return json(res,422,{ok:false,error:'ملف JSON لا يحتوي بنية قاعدة بيانات صالحة.'});
    const paths=[
      ['services','services'],['providerServices','providerServices'],['categoryMeta','categoryMeta'],['apiServices','apiServices'],
      ['config/smmProviders','config/smmProviders'],['config/smmProviderSecrets','config/smmProviderSecrets'],['config/smmDeletedProviders','config/smmDeletedProviders'],['config/smmActive','config/smmActive'],['config/paymentMethods','config/paymentMethods']
    ];
    const report=[];
    try{
      for(const [targetPath,sourcePath] of paths){
        const source=getObjectPath(catalog,sourcePath);if(source===undefined||source===null)continue;
        const tx=await firebaseTransaction(targetPath,current=>{const merged=mergeMissingCatalog(current,source);return merged.added>0?{write:true,value:merged.value,result:{added:merged.added}}:{write:false,result:{added:0}};},8,25000);
        const added=Number(tx.result?.added||0);
        if(added>0){const verify=await firebaseGetJson(targetPath,20000);if(!catalogContains(verify,tx.value))throw new Error('تعذر تأكيد استيراد العقدة '+targetPath);}
        report.push({path:targetPath,added});
      }
      // Upgrade the pre-split `config/smm` provider format without copying that secret node as-is.
      const legacySmm=getObjectPath(catalog,'config/smm');
      if(legacySmm&&typeof legacySmm==='object'&&usableProviderKey(legacySmm.key)&&String(legacySmm.url||'').trim()){
        const legacyId=normalizeProviderId(legacySmm.id||legacySmm.providerId||'legacy-provider')||'legacy-provider';
        const k=firebaseSafeKey(legacyId),metaPath='config/smmProviders/'+k,secretPath='config/smmProviderSecrets/'+k;
        let meta=await firebaseGetJson(metaPath,8000),secret=await firebaseGetJson(secretPath,8000),added=0;
        if(!meta){const m={id:legacyId,name:String(legacySmm.name||legacyId),url:String(legacySmm.url),hasKey:true,updatedAt:nowISO()};await firebaseWriteJson(metaPath,m,8000);meta=await firebaseGetJson(metaPath,8000);if(!meta||meta.id!==legacyId)throw new Error('تعذر التحقق من ترحيل مزود config/smm');added++;}
        if(!secret||!usableProviderKey(secret.key)){const sec={id:legacyId,name:String(legacySmm.name||legacyId),url:String(legacySmm.url),key:String(legacySmm.key)};await firebaseWriteJson(secretPath,sec,8000);secret=await firebaseGetJson(secretPath,8000);if(!secret||!usableProviderKey(secret.key))throw new Error('تعذر التحقق من ترحيل مفتاح config/smm');added++;}
        const active=await firebaseGetJson('config/smmActive',5000);if(!active)await firebaseWriteJson('config/smmActive',legacyId,5000);
        report.push({path:'config/smm→'+metaPath+' + '+secretPath,added});
      }
      await Promise.allSettled([hydrateProviderRuntimeFromFirebase(),hydrateApiServicesFromFirebase()]);
      return json(res,200,{ok:true,imported:true,paths:report,totalAdded:report.reduce((n,x)=>n+x.added,0),excluded:['users','orders','payments','transactions','balanceLedger','userNotifications'],message:'تم دمج خدمات ومزودين فقط؛ لم تُستورد الحسابات أو الطلبات أو المعاملات، ولم تُستبدل البيانات الموجودة في القاعدة الجديدة.'});
    }catch(e){return json(res,503,{ok:false,error:'توقف استيراد الكتالوج قبل تأكيد جميع الكتابات: '+String(e.message||e).slice(0,220),partial:report});}
  }
  if(p==='/api/admin/site-links'&&req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const cfg=readJSON('settings.json',{});let channel=String(cfg.telegramChannelUrl||'').trim();
    try{const remote=await firebaseGetJson('config/telegramChannelUrl',2200);if(typeof remote==='string'&&remote.trim())channel=remote.trim();else if(remote&&typeof remote.url==='string')channel=remote.url.trim();}catch(_){}
    if(!isValidTelegramChannelUrl(channel)||['https://t.me/jgkhfcvn','https://t.me/hddjh55'].includes(channel.replace(/\/$/,'')))channel='https://t.me/jbhbhg58';
    return json(res,200,{ok:true,telegramChannelUrl:channel,storage:'firebase-with-local-fallback'});
  }
  if(p==='/api/admin/site-links'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req);const channel=normalizeTelegramChannelUrl(b.telegramChannelUrl||b.url||'');
    if(!channel)return json(res,422,{ok:false,error:'رابط قناة Telegram غير صالح. استخدم رابط HTTPS مثل https://t.me/channelname'});
    try{
      await firebaseWriteJson('config/telegramChannelUrl',channel,7000);
      const saved=await firebaseGetJson('config/telegramChannelUrl',7000);
      const savedUrl=typeof saved==='string'?saved:String(saved?.url||'');
      if(savedUrl!==channel)throw new Error('تعذر التحقق من الرابط بعد حفظه في Firebase');
      const cfg=readJSON('settings.json',{});cfg.telegramChannelUrl=channel;writeJSON('settings.json',cfg);
      return json(res,200,{ok:true,telegramChannelUrl:channel,persisted:true,message:'تم حفظ رابط قناة التليجرام والتحقق منه.'});
    }catch(e){
      if(DATA_IS_EXTERNAL){const cfg=readJSON('settings.json',{});cfg.telegramChannelUrl=channel;writeJSON('settings.json',cfg);return json(res,200,{ok:true,telegramChannelUrl:channel,persisted:true,warning:'تم الحفظ في التخزين الدائم للخادم لكن تعذرت مزامنة Firebase.'});}
      return json(res,503,{ok:false,error:'تعذر حفظ الرابط بشكل دائم في Firebase؛ لم نؤكد الحفظ. تحقق من اتصال قاعدة البيانات ثم أعد المحاولة.',details:String(e.message||e).slice(0,120)});
    }
  }
  if(p==='/api/config'){ const cfg=readJSON('settings.json',{}); const waUrl=normalizeWhatsAppUrl(cfg.waUrl||cfg.waNum||'https://wa.me/9647762267959'); let telegramChannelUrl=String(cfg.telegramChannelUrl||'').trim();try{const remote=await firebaseGetJson('config/telegramChannelUrl',1800);if(typeof remote==='string'&&remote.trim())telegramChannelUrl=remote.trim();else if(remote&&typeof remote.url==='string')telegramChannelUrl=remote.url.trim();}catch(_){}if(!isValidTelegramChannelUrl(telegramChannelUrl)||['https://t.me/jgkhfcvn','https://t.me/hddjh55'].includes(telegramChannelUrl.replace(/\/$/,'')))telegramChannelUrl='https://t.me/jbhbhg58'; return json(res,200,{appName:APP_NAME,version:APP_VERSION,buildId:BUILD_ID,firebase:firebaseWebConfig(),firebaseVapidKey:String(process.env.FIREBASE_WEB_PUSH_VAPID_KEY||'').trim(),maintenance:(()=>{const m=readJSON('settings.json',{}).maintenance||{};return {enabled:m.enabled===true,title:String(m.title||'التطبيق متوقف مؤقتاً'),message:String(m.message||''),reason:String(m.reason||''),imageUrl:String(m.imageUrl||'')}})(),currency:'USD',exchangeRate:FIXED_RATE,fixedRecharge:'5000 IQD = 4 USD',rateTable:[1000,2000,3000,4000,5000,6000,7000,8000,9000,10000].map(i=>({iqd:i,usd:i/FIXED_RATE})),supportWhatsappUrl:waUrl,supportWhatsappNumber:normalizeWhatsAppNumber(waUrl),telegramChannelUrl}); }
  if(p==='/api/auth/google-config'&&req.method==='GET'){return json(res,200,{ok:true,enabled:!!String(process.env.GOOGLE_CLIENT_ID||'').trim(),clientId:String(process.env.GOOGLE_CLIENT_ID||'').trim()});}
  if(p==='/api/auth/captcha'&&req.method==='GET'){const wait=rateLimit(req,'captcha');if(wait)return json(res,429,{ok:false,error:'طلبات تحقق كثيرة؛ أعد المحاولة بعد قليل.'},{'Retry-After':String(wait)});return json(res,200,{ok:true,...issueMathCaptcha(req)});}
  if(p==='/api/auth/google'&&req.method==='POST'){
    if(!requestHasSameOrigin(req))return json(res,403,{ok:false,error:'رفض تسجيل الدخول بسبب اختلاف مصدر الطلب؛ أعد فتح الموقع الرسمي.'});
    const wait=rateLimit(req,'auth');if(wait)return json(res,429,{ok:false,error:'محاولات كثيرة، أعد المحاولة بعد '+wait+' ثانية'},{'Retry-After':String(wait)});
    const b=await bodyJSON(req);const cap=consumeMathCaptcha(req,b);if(cap)return json(res,422,{ok:false,error:cap,captchaFailed:true});
    if(!String(b.credential||''))return json(res,422,{ok:false,error:'رمز Google مفقود.'});
    try{const out=await googleAuthLogin(String(b.credential));let authUser=out.user||{};let remoteAuthUser=null;try{remoteAuthUser=await findRemoteUserByUsername(out.username)}catch(e){return json(res,503,{ok:false,error:'تعذر التحقق من حالة الحساب في قاعدة البيانات؛ لم يتم تسجيل الدخول.'})}if(isSadaAdminBannedAccount(authUser)||isSadaAdminBannedAccount(remoteAuthUser?.user)||SADA_ADMIN_BANNED_USERNAMES.has(String(out.username||'').trim().toLowerCase()))return json(res,403,{ok:false,code:'account_banned',error:'تم حظر حسابك من تسجيل الدخول. يرجى التواصل مع الإدارة.'});const role='user';const lastLoginAt=recordSuccessfulUserLogin(out.username);const sessionToken=setSession(res,{role,username:out.username});const safe={...cleanGoogleUser(out.user),lastLoginAt};return json(res,200,{ok:true,role,username:out.username,user:safe,sessionToken,authProvider:'google',firebaseSaved:out.firebaseSaved});}
    catch(e){const code=Number(e.statusCode)||(/invalid|token|audience|expired|signature/i.test(String(e.message||''))?401:502);return json(res,code,{ok:false,error:code===502?'تعذر الاتصال بخدمة التحقق من Google؛ حاول مرة أخرى.':String(e.message||'فشل التحقق من Google')});}
  }
  if((p==='/api/auth/register/resend'||p==='/api/auth/register/verify') && req.method==='POST'){
    return json(res,410,{ok:false,verificationRequired:false,error:'تم إلغاء التحقق من البريد عند التسجيل؛ أعد إرسال نموذج التسجيل لإنشاء الحساب مباشرة.'});
  }
  if(p==='/api/auth' && req.method==='POST'){
    const wait=rateLimit(req,'auth'); if(wait) return json(res,429,{ok:false,error:'محاولات كثيرة، أعد المحاولة بعد '+wait+' ثانية'},{'Retry-After':String(wait)});
    const b=await bodyJSON(req);const captchaError=consumeMathCaptcha(req,b);if(captchaError)return json(res,422,{ok:false,error:captchaError,captchaFailed:true});
    const u=String(b.username||'').trim(),pw=String(b.password||'');
    if(String(b.action||'')==='register'){
      const name=String(b.name||'').trim().replace(/\s+/g,' ');
      if(!/^[a-zA-Z0-9]{5,32}$/.test(u)) return json(res,422,{ok:false,error:'اسم المستخدم يجب أن يكون 5 أحرف أو أرقام إنجليزية على الأقل، من دون مسافات.'});
      if(name.length<3||name.length>80||!/\p{Script=Arabic}/u.test(name))return json(res,422,{ok:false,error:'اكتب اسمك الكامل باللغة العربية.'});
      if(pw.length<8) return json(res,422,{ok:false,error:'كلمة المرور يجب أن تكون 8 أحرف على الأقل'});
      const email=normalizeEmail(b.email);if(!validEmail(email))return json(res,422,{ok:false,error:'أدخل بريدك الإلكتروني الصحيح.'});
      if(u.toLowerCase()===ADMIN_USER.toLowerCase()) return json(res,409,{ok:false,error:'اسم المستخدم محجوز'});
      const store=readJSON('users.json',{users:{}});if(Object.keys(store.users||{}).some(k=>k.toLowerCase()===u.toLowerCase()))return json(res,409,{ok:false,error:'اسم المستخدم موجود مسبقاً'});
      let remoteCheck;try{remoteCheck=await findRemoteUserByUsername(u);}catch(e){
        const detail=String(e&&e.message||e||'unknown').slice(0,220);
        console.error('[AUTH_REGISTER_FIREBASE_USERNAME_CHECK_FAILED]',JSON.stringify({code:e?.code||'',statusCode:e?.statusCode||0,message:detail,credentialCode:firebaseServiceAccountStatus().code,hasServiceAccount:firebaseServiceAccountConfigured(),databaseHost:(()=>{try{return new URL(FIREBASE_DATABASE_URL).host}catch(_){return 'invalid-url'}})()}));
        let publicError='تعذّر التحقق من الحسابات القديمة في Firebase؛ لم يُنشأ الحساب. أعد المحاولة بعد إصلاح اتصال قاعدة البيانات.';
        if(/يلزم إعداد سر FIREBASE_SERVICE_ACCOUNT_JSON/.test(detail)) publicError='اعتماد Firebase غير مضبوط على الخادم. لم يُنشأ الحساب.';
        else if(/FIREBASE_SERVICE_ACCOUNT_JSON لا يحتوي JSON صالحاً|FIREBASE_SERVICE_ACCOUNT_BASE64 لا يحتوي JSON صالحاً|بيانات حساب خدمة Firebase|صيغة المفتاح الخاص|المفتاح الخاص في حساب خدمة Firebase|حساب الخدمة لا يخص مشروع/.test(detail)) publicError='اعتماد Firebase موجود لكنه غير صالح أو لا يخص المشروع المحدد. لم يُنشأ الحساب.';
        else if(/Firebase HTTP 401|Firebase HTTP 403|permission_denied|Permission denied/i.test(detail)) publicError='رفض Firebase قراءة الحسابات بسبب المصادقة أو الصلاحيات (401/403). لم يُنشأ الحساب؛ راجع اعتماد الخادم وصلاحيات قاعدة البيانات.';
        else if(/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|AbortError|fetch failed|network/i.test(detail)) publicError='تعذّر الوصول إلى خادم Firebase بسبب اتصال الشبكة أو DNS. لم يُنشأ الحساب.';
        return json(res,503,{ok:false,error:publicError,code:'firebase_username_check_failed'});
      }
      if(remoteCheck)return json(res,409,{ok:false,error:'اسم المستخدم موجود مسبقاً في قاعدة الحسابات الحالية'});
      let emailAccount;try{emailAccount=await findAccountByEmail(email);}catch(e){
        const detail=String(e&&e.message||e||'unknown').slice(0,220);
        console.error('[AUTH_REGISTER_FIREBASE_EMAIL_CHECK_FAILED]',JSON.stringify({code:e?.code||'',statusCode:e?.statusCode||0,message:detail,credentialCode:firebaseServiceAccountStatus().code,hasServiceAccount:firebaseServiceAccountConfigured()}));
        let publicError='تعذّر التحقق من البريد في Firebase؛ لم يُنشأ الحساب.';
        if(/يلزم إعداد سر FIREBASE_SERVICE_ACCOUNT_JSON/.test(detail)) publicError='اعتماد Firebase غير مضبوط على الخادم. لم يُنشأ الحساب.';
        else if(/FIREBASE_SERVICE_ACCOUNT_JSON لا يحتوي JSON صالحاً|FIREBASE_SERVICE_ACCOUNT_BASE64 لا يحتوي JSON صالحاً|بيانات حساب خدمة Firebase|صيغة المفتاح الخاص|المفتاح الخاص في حساب خدمة Firebase|حساب الخدمة لا يخص مشروع/.test(detail)) publicError='اعتماد Firebase موجود لكنه غير صالح أو لا يخص المشروع المحدد. لم يُنشأ الحساب.';
        else if(/Firebase HTTP 401|Firebase HTTP 403|permission_denied|Permission denied/i.test(detail)) publicError='رفض Firebase قراءة الحسابات بسبب المصادقة أو الصلاحيات (401/403). لم يُنشأ الحساب.';
        else if(/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|AbortError|fetch failed|network/i.test(detail)) publicError='تعذّر الوصول إلى Firebase بسبب اتصال الشبكة أو DNS. لم يُنشأ الحساب.';
        return json(res,503,{ok:false,error:publicError,code:'firebase_email_check_failed'});
      }
      if(emailAccount)return json(res,409,{ok:false,error:'هذا البريد مرتبط بحساب موجود بالفعل. سجّل الدخول باستخدامه أو باسم المستخدم.'});
      // Email confirmation was intentionally removed from registration. Keep the
      // address as user-supplied data; never claim it was verified without proof.
      const now=nowISO(),passwordHash=hashPassword(pw);
      const user={username:u,name,email,emailVerified:false,emailVerificationRequired:false,passwordHash,balance:0,level:'مبتدئ',telegram:'',phone:'',joined:now,lastLoginAt:now,totalSpent:0,totalOrders:0,role:'user'};
      const userPath='users/'+firebaseSafeKey(u);
      let created;
      try{
        created=await firebaseTransaction(userPath,current=>{
          if(current&&typeof current==='object'&&!Array.isArray(current))return {write:false,result:{error:'username-exists'}};
          return {write:true,value:user,result:{created:true}};
        },12000,8);
      }catch(e){
        const detail=String(e&&e.message||e||'unknown').slice(0,220);
        console.error('[AUTH_REGISTER_FIREBASE_WRITE_FAILED]',JSON.stringify({message:detail,credentialCode:firebaseServiceAccountStatus().code,hasServiceAccount:firebaseServiceAccountConfigured()}));
        return json(res,503,{ok:false,error:'تعذر حفظ الحساب في Firebase. لم يكتمل التسجيل؛ أعد المحاولة بعد إصلاح اتصال قاعدة البيانات.'});
      }
      if(created?.result?.error==='username-exists')return json(res,409,{ok:false,error:'اسم المستخدم موجود مسبقاً في قاعدة الحسابات الحالية'});
      if(!created?.value||String(created.value.username||'').toLowerCase()!==u.toLowerCase())return json(res,503,{ok:false,error:'لم يؤكد Firebase حفظ الحساب؛ لم يتم تسجيل الدخول. أعد المحاولة بعد التحقق من قاعدة البيانات.'});
      const storeAfter=readJSON('users.json',{users:{}});storeAfter.users=storeAfter.users&&typeof storeAfter.users==='object'?storeAfter.users:{};storeAfter.users[u]=user;writeJSON('users.json',storeAfter);
      const sessionToken=setSession(res,{role:'user',username:u}),clean={...user};delete clean.password;delete clean.passwordHash;
      return json(res,200,{ok:true,role:'user',username:u,user:clean,sessionToken,emailVerificationRequired:false,message:'تم إنشاء الحساب وحفظه بنجاح؛ لا يلزم رمز تحقق للبريد عند التسجيل.'});
    }
    const submittedEmail=String(u||'').trim().toLowerCase();
    const bundledOwnerEmail=String(BUNDLED_ADMIN_AUTH.email||'').trim().toLowerCase();
    const isBundledOwner=!!bundledOwnerEmail&&submittedEmail===bundledOwnerEmail;
    if(submittedEmail===String(ADMIN_USER||'').trim().toLowerCase()||isBundledOwner){
      if(!adminPasswordConfigured())return json(res,503,{ok:false,code:'admin_password_not_configured',error:'تسجيل دخول الإدارة غير مهيأ على الخادم. أضف بيانات الإدارة في Railway أو استخدم حزمة الإدارة التي تحتوي حساب المالك.'});
      const settings=readJSON('settings.json',{});
      // The owner's bundled account stays usable even if Railway has an older ADMIN_EMAIL/ADMIN_PASSWORD.
      // A deliberate password reset (adminPasswordOverride) takes precedence and disables the bundled password.
      const bundledOwnerValid=isBundledOwner&&settings.adminPasswordOverride!==true&&String(BUNDLED_ADMIN_AUTH.passwordHash||'').startsWith('scrypt$')&&verifyPassword(pw,BUNDLED_ADMIN_AUTH.passwordHash);
      const configuredAdminValid=submittedEmail===String(ADMIN_USER||'').trim().toLowerCase()&&adminPasswordValid(pw);
      if(!bundledOwnerValid&&!configuredAdminValid)return json(res,401,{ok:false,code:'invalid_admin_credentials',error:'بيانات دخول الإدارة غير صحيحة. تحقق من البريد وكلمة المرور أو إعدادات الإدارة.'});
      const adminIdentity=isBundledOwner?BUNDLED_ADMIN_AUTH.email:ADMIN_USER;
      const sessionToken=setSession(res,{role:'admin',username:adminIdentity});return json(res,200,{ok:true,role:'admin',username:adminIdentity,sessionToken});
    }
    const store=readJSON('users.json',{users:{}});let actualUsername=u;let user=store.users?.[u]||null;
    if(!user){const found=Object.entries(store.users||{}).find(([key,val])=>key.toLowerCase()===u.toLowerCase()||String(val?.username||'').toLowerCase()===u.toLowerCase());if(found){actualUsername=found[0];user=found[1];}}
    let remoteRecord=null,remoteLookupFailed=false;
    if(!user){try{remoteRecord=await findRemoteUserByUsername(u);if(remoteRecord){actualUsername=remoteRecord.username||u;user=remoteRecord.user;}}catch(e){remoteLookupFailed=true;console.warn('Legacy Firebase login lookup failed:',String(e.message||e).slice(0,120));}}
    if(!user&&validEmail(u)){
      try{const foundByEmail=await findAccountByEmail(u);if(foundByEmail&&foundByEmail.source!=='admin'){actualUsername=String(foundByEmail.username||foundByEmail.user?.username||u);user=foundByEmail.user;remoteRecord={username:actualUsername,user,firebasePath:foundByEmail.firebasePath||('users/'+firebaseSafeKey(actualUsername))};}}
      catch(e){remoteLookupFailed=true;console.warn('Email login lookup failed:',String(e.message||e).slice(0,120));}
    }
    if(user&&String(user.passwordHash||user.password||user.passHash||user.pass||'').length>0&&verifyPassword(pw,user.passwordHash||user.password||user.passHash||user.pass||'')){
      if(isSadaAdminBannedAccount(user)||SADA_ADMIN_BANNED_USERNAMES.has(String(actualUsername||u).trim().toLowerCase()))return json(res,403,{ok:false,code:'account_banned',error:'تم حظر حسابك من تسجيل الدخول. يرجى التواصل مع الإدارة.'});
      // Mirror a remote-only legacy account locally without replacing its financial/order fields.
      if(!store.users[actualUsername]||!String(user.passwordHash||'').startsWith('scrypt$')){const upgraded={...(store.users[actualUsername]||user),...user,username:actualUsername};if(!String(user.passwordHash||'').startsWith('scrypt$'))upgraded.passwordHash=hashPassword(pw);delete upgraded.password;delete upgraded.pass;delete upgraded.passHash;store.users[actualUsername]=upgraded;writeJSON('users.json',store);
        if(remoteRecord&&remoteRecord.firebasePath&&!String(user.passwordHash||'').startsWith('scrypt$')){try{await firebasePatchJson(remoteRecord.firebasePath,{passwordHash:upgraded.passwordHash,password:null,pass:null,passHash:null,passwordUpdatedAt:nowISO()},5000);}catch(e){console.warn('Legacy password hash remote migration skipped:',String(e.message||e).slice(0,100));}}
      }
      const lastLoginAt=recordSuccessfulUserLogin(actualUsername);
      const localUser={...(readJSON('users.json',{users:{}}).users?.[actualUsername]||user),lastLoginAt};
      const sessionToken=setSession(res,{role:localUser.role==='admin'?'admin':'user',username:actualUsername});const clean={...localUser};delete clean.password;delete clean.passwordHash;delete clean.pass;delete clean.passHash;
      return json(res,200,{ok:true,role:localUser.role==='admin'?'admin':'user',username:actualUsername,user:clean,sessionToken,legacyAccountRecovered:!Boolean(store.users?.[u])});
    }
    if(remoteLookupFailed)return json(res,503,{ok:false,error:'تعذر الاتصال بقاعدة الحسابات للتحقق من حسابك القديم. حسابك لم يُحذف؛ حاول مرة أخرى بعد قليل.'});
    if(user&&!String(user.passwordHash||user.password||user.passHash||user.pass||''))return json(res,409,{ok:false,error:'تم العثور على سجل حسابك القديم، لكن سجل كلمة المرور غير متوفر لهذا الحساب. لا تنشئ حساباً مكرراً؛ استخدم استعادة كلمة المرور إذا كان البريد موثقاً أو تواصل مع الدعم.'});
    return json(res,401,{ok:false,error:'بيانات الدخول غير صحيحة'});
  }
  if(p==='/api/auth/forgot-password' && req.method==='POST'){
    const wait=rateLimit(req,'email');if(wait)return json(res,429,{ok:false,error:'طلبات الاستعادة كثيرة؛ أعد المحاولة بعد '+wait+' ثانية'},{'Retry-After':String(wait)});
    const b=await bodyJSON(req),email=normalizeEmail(b.email);if(!validEmail(email))return json(res,422,{ok:false,error:'أدخل عنوان بريد إلكتروني صحيحاً.'});
    let account=null;try{account=await findAccountByEmail(email);}catch(e){return json(res,503,{ok:false,error:'تعذر فحص قاعدة الحسابات الآن. لم نغيّر أي حساب؛ أعد المحاولة بعد قليل.'});}
    // Same public response for existing and unknown emails to reduce account enumeration.
    if(!account)return json(res,200,{ok:true,message:'إذا كان البريد مرتبطاً بحساب، فستصلك رسالة استعادة.'});
    if(account.source==='admin'&&(process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD_HASH))return json(res,503,{ok:false,error:'كلمة مرور الإدارة مضبوطة من متغيرات الاستضافة؛ حدّث ADMIN_PASSWORD أو ADMIN_PASSWORD_HASH من Railway.'});
    try{await beginEmailChallenge(email,'reset',account.username,'استعادة كلمة المرور');return json(res,200,{ok:true,message:'إذا كان البريد مرتبطاً بحساب، فستصلك رسالة استعادة.'});}
    catch(e){return json(res,Number(e.statusCode)||502,{ok:false,error:String(e.message||'تعذر إرسال رسالة الاستعادة').slice(0,260)});}
  }
  if(p==='/api/auth/reset-password' && req.method==='POST'){
    const wait=rateLimit(req,'email');if(wait)return json(res,429,{ok:false,error:'محاولات كثيرة؛ أعد المحاولة بعد '+wait+' ثانية'},{'Retry-After':String(wait)});
    const b=await bodyJSON(req),email=normalizeEmail(b.email),code=String(b.code||''),newPassword=String(b.newPassword||'');if(!validEmail(email)||!/^[0-9]{6}$/.test(code))return json(res,422,{ok:false,error:'أدخل البريد ورمز التحقق المكوّن من 6 أرقام.'});if(newPassword.length<8)return json(res,422,{ok:false,error:'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل.'});
    const challengeStore=readJSON('email_challenges.json',{}),challenge=challengeStore[emailChallengeKey(email,'reset')];if(!challenge||!challenge.username)return json(res,422,{ok:false,error:'أرسل رمز استعادة جديداً أولاً.'});
    if(challenge.username===ADMIN_USER){if(process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD_HASH)return json(res,409,{ok:false,error:'كلمة مرور الإدارة تُدار من Railway Variables؛ لم يتغير شيء.'});const verified=consumeEmailChallenge(email,'reset',code,challenge.username);if(!verified.ok)return json(res,422,{ok:false,error:verified.error});const cfg=readJSON('settings.json',{});cfg.adminPasswordHash=hashPassword(newPassword);cfg.adminPasswordOverride=true;cfg.adminPasswordUpdatedAt=nowISO();writeJSON('settings.json',cfg);return json(res,200,{ok:true,message:'تم تغيير كلمة مرور الإدارة. سجّل الدخول بكلمة المرور الجديدة.'});}
    const usersStore=readJSON('users.json',{users:{}});let localKey=Object.keys(usersStore.users||{}).find(k=>k===challenge.username)||Object.keys(usersStore.users||{}).find(k=>k.toLowerCase()===String(challenge.username).toLowerCase());let user=localKey?usersStore.users[localKey]:null;let resetFirebasePath=localKey?'users/'+firebaseSafeKey(localKey):'';let remoteRecord=null;
    if(!user){try{remoteRecord=await findRemoteUserByUsername(challenge.username);if(remoteRecord){localKey=remoteRecord.username||challenge.username;resetFirebasePath=remoteRecord.firebasePath||('users/'+firebaseSafeKey(localKey));user={...remoteRecord.user,username:localKey};usersStore.users[localKey]=user;}}catch(e){return json(res,503,{ok:false,error:'تعذر تحميل سجل الحساب القديم من قاعدة البيانات؛ لم تتغير كلمة المرور. أعد إرسال رمز جديد لاحقاً.'});}}
    if(!user||normalizeEmail(user.email||user.mail||user.emailAddress)!==email)return json(res,409,{ok:false,error:'تعذر مطابقة البريد مع حسابك؛ لم تتغير كلمة المرور.'});
    const verified=consumeEmailChallenge(email,'reset',code,challenge.username);if(!verified.ok)return json(res,422,{ok:false,error:verified.error});
    if(!remoteRecord){try{remoteRecord=await findRemoteUserByUsername(localKey);}catch(e){return json(res,503,{ok:false,error:'تعذر التأكد من قاعدة الحسابات؛ لم تتغير كلمة المرور. أرسل رمزاً جديداً بعد عودة الاتصال.'});}}
    if(!remoteRecord&&!DATA_IS_EXTERNAL)return json(res,503,{ok:false,error:'لا يوجد تخزين دائم مؤكد لتغيير كلمة المرور بأمان. اربط Railway Volume أو أصلح Firebase ثم أرسل رمزاً جديداً.'});
    const newHash=hashPassword(newPassword),updatedAt=nowISO();
    if(remoteRecord){try{await firebasePatchJson(remoteRecord.firebasePath||resetFirebasePath||('users/'+firebaseSafeKey(localKey)),{passwordHash:newHash,password:null,pass:null,passHash:null,passwordUpdatedAt:updatedAt},7000);}catch(e){return json(res,502,{ok:false,error:'تعذر حفظ كلمة المرور الجديدة في قاعدة الحسابات؛ لم نغيّر النسخة المحلية حتى لا تتعارض الحسابات. أرسل رمزاً جديداً وأعد المحاولة.'});}}
    user.passwordHash=newHash;delete user.password;delete user.pass;delete user.passHash;user.passwordUpdatedAt=updatedAt;usersStore.users[localKey]=user;writeJSON('users.json',usersStore);
    return json(res,200,{ok:true,message:'تم تغيير كلمة المرور بنجاح.',remoteSynced:!!remoteRecord,storageMode:DATA_IS_EXTERNAL?'persistent-volume':'check-persistence'});
  }
  if(p==='/api/account/email/request' && req.method==='POST'){
    if(!requestHasSameOrigin(req))return json(res,403,{ok:false,error:'رفض الطلب بسبب اختلاف مصدر الصفحة؛ أعد فتح الموقع الرسمي.'});const s=session(req);if(!s||s.role!=='user')return json(res,401,{ok:false,error:'سجّل الدخول أولاً.'});const wait=rateLimit(req,'email');if(wait)return json(res,429,{ok:false,error:'طلبات البريد كثيرة؛ أعد المحاولة بعد '+wait+' ثانية'},{'Retry-After':String(wait)});
    const b=await bodyJSON(req),email=normalizeEmail(b.email);if(!validEmail(email))return json(res,422,{ok:false,error:'أدخل البريد الجديد بصورة صحيحة.'});let account;try{account=await findAccountByEmail(email);}catch(e){return json(res,503,{ok:false,error:'تعذر فحص البريد في قاعدة البيانات.'});}if(account&&account.username.toLowerCase()!==String(s.username).toLowerCase())return json(res,409,{ok:false,error:'البريد مستخدم في حساب آخر.'});
    try{await beginEmailChallenge(email,'change-email',s.username,'تأكيد البريد الجديد');return json(res,200,{ok:true,message:'تم إرسال رمز حقيقي إلى البريد الجديد.'});}catch(e){return json(res,Number(e.statusCode)||502,{ok:false,error:String(e.message||'تعذر إرسال رمز البريد').slice(0,260)});}
  }
  if(p==='/api/account/email/confirm' && req.method==='POST'){
    if(!requestHasSameOrigin(req))return json(res,403,{ok:false,error:'رفض الطلب بسبب اختلاف مصدر الصفحة؛ أعد فتح الموقع الرسمي.'});const s=session(req);if(!s||s.role!=='user')return json(res,401,{ok:false,error:'سجّل الدخول أولاً.'});const b=await bodyJSON(req),email=normalizeEmail(b.email),code=String(b.code||'');if(!validEmail(email))return json(res,422,{ok:false,error:'البريد الجديد غير صالح.'});const check=consumeEmailChallenge(email,'change-email',code,s.username);if(!check.ok)return json(res,422,{ok:false,error:check.error});
    let collision=null;try{collision=await findAccountByEmail(email);}catch(e){return json(res,503,{ok:false,error:'تعذر التأكد من أن البريد غير مستخدم لأن قاعدة البيانات غير متاحة؛ لم يتغير البريد.'});}if(collision&&String(collision.username).toLowerCase()!==String(s.username).toLowerCase())return json(res,409,{ok:false,error:'البريد أصبح مرتبطاً بحساب آخر.'});
    const store=readJSON('users.json',{users:{}});let key=Object.keys(store.users||{}).find(k=>k===s.username)||Object.keys(store.users||{}).find(k=>k.toLowerCase()===String(s.username).toLowerCase());let user=key?store.users[key]:null;let remoteRecord=null;
    if(!user){try{remoteRecord=await findRemoteUserByUsername(s.username);if(remoteRecord){key=remoteRecord.username||s.username;user={...remoteRecord.user,username:key};}}catch(e){return json(res,503,{ok:false,error:'تعذر تحميل الحساب القديم من قاعدة البيانات؛ لم يتغير البريد.'});}}
    else {try{remoteRecord=await findRemoteUserByUsername(key);}catch(e){return json(res,503,{ok:false,error:'تعذر التأكد من مزامنة الحساب مع قاعدة البيانات؛ لم يتغير البريد.'});}}
    if(!user)return json(res,404,{ok:false,error:'الحساب غير موجود في مخزن الحسابات الحالي؛ لم يتغير البريد.'});
    const updatedAt=nowISO();if(remoteRecord){try{await firebasePatchJson(remoteRecord.firebasePath||('users/'+firebaseSafeKey(key)),{email,emailVerified:true,emailVerifiedAt:updatedAt,updatedAt},7000);}catch(e){return json(res,502,{ok:false,error:'تعذر حفظ البريد الجديد في قاعدة الحسابات؛ لم نغيّر نسخة الحساب المحلية. أرسل رمزاً جديداً وأعد المحاولة.'});}}else if(!DATA_IS_EXTERNAL)return json(res,503,{ok:false,error:'لا يوجد تخزين دائم مؤكد لتغيير البريد بأمان. اربط Railway Volume أو أصلح Firebase ثم أرسل رمزاً جديداً.'});
    user.email=email;user.emailVerified=true;user.emailVerifiedAt=updatedAt;user.updatedAt=updatedAt;store.users[key]=user;writeJSON('users.json',store);
    return json(res,200,{ok:true,email,emailVerified:true,remoteSynced:!!remoteRecord,storageMode:DATA_IS_EXTERNAL?'persistent-volume':'check-persistence'});
  }
  if(p==='/api/session' && req.method==='GET'){
    const token=sid(req); const s=session(req);
    if(!s)return json(res,200,{ok:false,authenticated:false});
    // Re-issue a fresh signed token/header so the browser can keep using a header even
    // when a Railway proxy/browser drops HttpOnly cookie state.
    const fresh=setSession(res,{role:s.role,username:s.username,sessionId:String(s.sessionId||token)});
    if(s.role==='admin')return json(res,200,{ok:true,authenticated:true,role:'admin',username:s.username,sessionToken:fresh});
    const store=readJSON('users.json',{users:{}}); const u=store.users?.[s.username]||null;
    const clean=u?{...u}:{}; delete clean.password; delete clean.passwordHash;
    return json(res,200,{ok:true,authenticated:true,role:'user',username:s.username,user:Object.keys(clean).length?clean:null,sessionToken:fresh,localUserRecord:!!u});
  }
  if(p==='/api/settings' && req.method==='GET'){ const cfg=readJSON('settings.json',{}); const waUrl=normalizeWhatsAppUrl(cfg.waUrl||cfg.waNum||'https://wa.me/9647762267959'); return json(res,200,{ok:true,settings:{waUrl,waNum:normalizeWhatsAppNumber(waUrl)}}); }
  if(p==='/api/settings' && req.method==='POST'){ if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'}); const b=await bodyJSON(req); const cfg=readJSON('settings.json',{}); if(b.waUrl!==undefined) cfg.waUrl=normalizeWhatsAppUrl(b.waUrl); else if(b.waNum!==undefined) cfg.waUrl=normalizeWhatsAppUrl(b.waNum); cfg.waNum=normalizeWhatsAppNumber(cfg.waUrl); writeJSON('settings.json',cfg); return json(res,200,{ok:true,settings:{waUrl:cfg.waUrl,waNum:cfg.waNum}}); }
  if(p==='/api/mastercard' && req.method==='GET'){
    const cfg=readJSON('settings.json',{}); const mc=cfg.mastercard||{};
    return json(res,200,{ok:true,mastercard:{enabled:mc.enabled!==false,number:'3494089927',image:'',updatedAt:mc.updatedAt||null}});
  }
  if(p==='/api/mastercard' && req.method==='POST'){
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req); const cfg=readJSON('settings.json',{}); const old=cfg.mastercard||{};
    const image='';
    cfg.mastercard={enabled:b.enabled!==undefined?!!b.enabled:(old.enabled!==false),number:'3494089927',image,updatedAt:new Date().toISOString()}; writeJSON('settings.json',cfg);
    return json(res,200,{ok:true,mastercard:cfg.mastercard});
  }
  if(p==='/api/provider/diagnostics' && req.method==='POST'){
    const wait=rateLimit(req,'provider'); if(wait)return json(res,429,{ok:false,error:'طلبات فحص المزود كثيرة، أعد المحاولة لاحقاً'},{'Retry-After':String(wait)});
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req); const prov=await resolveProviderDiagnosticsInput(b);
    if(!/^https?:\/\//i.test(prov.url)||!prov.key)return json(res,422,{ok:false,error:'رابط API أو مفتاح API غير صالح. إذا كان المزود محفوظاً، أعد تحميل قائمة المزودين ثم أعد الاختبار.'});
    const out={connection:{ok:false},balance:{ok:false},services:{ok:false}};
    try{
      const bd=await providerRequest(prov,{action:'balance'}); const balance=normalizeProviderBalance(bd);
      if(balance===null) throw new Error('API لم يرجع رصيداً رقمياً');
      out.connection={ok:true}; out.balance={ok:true,balance,currency:normalizeProviderCurrency(bd),raw:bd};
    }catch(e){ out.balance={ok:false,error:e.name==='AbortError'?'انتهت مهلة جلب الرصيد':e.message}; }
    try{
      const sd=await providerRequest(prov,{action:'services'}); const list=normalizeProviderServices(sd);
      if(!list.length) throw new Error('المزود لم يرجع أي خدمات');
      out.services={ok:true,count:list.length}; out.connection={ok:true};
    }catch(e){ out.services={ok:false,error:e.name==='AbortError'?'انتهت مهلة جلب الخدمات':e.message}; }
    if(!out.connection.ok) out.connection={ok:false,error:out.balance.error||out.services.error||'فشل الاتصال بالمزود'};
    return json(res,200,{ok:out.connection.ok&&out.balance.ok&&out.services.ok,diagnostics:out});
  }
  if(p==='/api/admin/support-notify' && req.method==='POST'){
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const wait=rateLimit(req,'api'); if(wait)return json(res,429,{ok:false,error:'طلبات الإشعارات كثيرة، أعد المحاولة لاحقاً'},{'Retry-After':String(wait)});
    const b=await bodyJSON(req);const username=String(b.username||'').trim().slice(0,150);const message=String(b.message||'').trim().slice(0,1200);const chatMessageId=String(b.chatMessageId||'').trim().slice(0,180);
    if(!username||!message||!chatMessageId)return json(res,422,{ok:false,error:'اسم المستخدم والرسالة ومعرف الرسالة مطلوبة'});
    const id='SUP'+sha256(username+'|'+chatMessageId).slice(0,24);
    const notification=createUserNotification(username,{id,type:'support_reply',title:'رد جديد من الدعم الفني',message:message.slice(0,380),meta:{chatMessageId}});
    return json(res,200,{ok:true,notificationId:notification?.id||id});
  }
  if(p==='/api/user/push-token'&&req.method==='POST'){
    const current=session(req);if(!current||!['user','admin'].includes(String(current.role||'')))return json(res,401,{ok:false,error:'سجّل الدخول لتفعيل إشعارات الهاتف.'});
    const b=await bodyJSON(req),token=String(b.token||'').trim();if(token.length<80||token.length>8192)return json(res,422,{ok:false,error:'رمز إشعارات الهاتف غير صالح.'});
    const all=readJSON('push_tokens.json',{});const username=String(current.username||'').trim();if(!username)return json(res,401,{ok:false,error:'تعذر تحديد الحساب الحالي.'});
    const id=sha256(token);all[username]=all[username]&&typeof all[username]==='object'?all[username]:{};all[username][id]={token,updatedAt:nowISO(),platform:String(b.platform||'web').slice(0,30),userAgent:String(req.headers['user-agent']||'').slice(0,180)};writeJSON('push_tokens.json',all);
    return json(res,200,{ok:true,saved:true,message:'تم تسجيل هذا الجهاز لاستقبال الإشعارات. يمكن لهذا الجهاز استقبالها بعد منح إذن المتصفح.'});
  }
  if(p==='/api/admin/notifications/push'&&req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req,4*1024*1024),title=String(b.title||'').trim().slice(0,120),message=String(b.message||'').trim().slice(0,1200),link=String(b.url||'').trim();
    if(!title||!message)return json(res,422,{ok:false,error:'عنوان الإشعار ونصه مطلوبان.'});
    if(link&&(!/^https:\/\//i.test(link)||link.length>1500))return json(res,422,{ok:false,error:'رابط الإشعار يجب أن يكون HTTPS صالحاً.'});
    const registry=readJSON('push_tokens.json',{}),entries=[];for(const [username,map] of Object.entries(registry||{})){if(!map||typeof map!=='object')continue;for(const [hash,row] of Object.entries(map)){const token=String(row?.token||'').trim();if(token)entries.push({username,hash,token});}}
    const unique=[...new Map(entries.map(x=>[x.token,x])).values()];if(!unique.length)return json(res,409,{ok:false,error:'لا توجد أجهزة سجلت موافقتها على إشعارات الهاتف بعد. على المستخدمين تفعيلها من صفحة الإشعارات أولاً.'});
    if(!firebaseServiceAccountConfigured())return json(res,503,{ok:false,error:'اعتماد Firebase Admin غير مضبوط وصالح؛ لم تُرسل أي إشعارات.'});
    let imageUrl='';const dataUrl=String(b.imageData||'');
    if(dataUrl){const match=dataUrl.match(/^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i);if(!match)return json(res,422,{ok:false,error:'صيغة الصورة غير مدعومة. استخدم PNG أو JPG أو WebP.'});const bytes=Buffer.from(match[2],'base64');if(!bytes.length||bytes.length>1400*1024)return json(res,413,{ok:false,error:'حجم الصورة يجب أن يكون أقل من 1.4 ميغابايت بعد الضغط.'});const ext=match[1].toLowerCase().replace('jpeg','jpg');const dir=path.join(DATA,'push-media');fs.mkdirSync(dir,{recursive:true});const file='push-'+crypto.randomUUID().replace(/-/g,'')+'.'+ext;fs.writeFileSync(path.join(dir,file),bytes,{flag:'wx'});imageUrl=publicBaseUrl(req)+'/media/push/'+file;}
    const base=publicBaseUrl(req);let messaging;try{messaging=firebaseAdminMessaging()}catch(e){return json(res,503,{ok:false,error:String(e.message||e).slice(0,180)});}
    const report={successCount:0,failureCount:0,invalidTokens:0,errors:[]};const now=nowISO();
    for(let i=0;i<unique.length;i+=500){const chunk=unique.slice(i,i+500);try{const result=await messaging.sendEachForMulticast({tokens:chunk.map(x=>x.token),notification:{title,body:message,...(imageUrl?{imageUrl}:{})},data:{url:link||base,title,body:message},webpush:{fcmOptions:{link:link||base},notification:{title,body:message,icon:'/sadairaq-logo.jpg',...(imageUrl?{image:imageUrl}:{})}}});report.successCount+=result.successCount;report.failureCount+=result.failureCount;result.responses.forEach((r,j)=>{if(r.success)return;const code=String(r.error?.code||'');if(/registration-token-not-registered|invalid-registration-token/.test(code)){const item=chunk[j];if(registry[item.username]){delete registry[item.username][item.hash];report.invalidTokens++;}}if(report.errors.length<8)report.errors.push(code||String(r.error?.message||'FCM error').slice(0,100));});}catch(e){report.failureCount+=chunk.length;if(report.errors.length<8)report.errors.push(String(e.message||e).slice(0,120));}}
    writeJSON('push_tokens.json',registry);appendJsonLedger('push_notifications.json',{id:'PUSH_'+crypto.randomUUID().replace(/-/g,''),title,message,url:link,imageUrl,admin:String(session(req)?.username||ADMIN_USER),sentAt:now,successCount:report.successCount,failureCount:report.failureCount});
    return json(res,report.successCount?200:502,{ok:report.successCount>0,title,targetDevices:unique.length,...report,storageMode:DATA_IS_EXTERNAL?'persistent-volume':'release-local',warning:!DATA_IS_EXTERNAL?'تأكد من ربط Railway Volume حتى تُحفظ صور الإشعارات ورموز الأجهزة بعد إعادة النشر.':'',message:report.successCount?'تم تسليم الإشعار إلى خدمة Firebase للأجهزة المسجلة. هذا لا يضمن عرض كل جهاز إذا كان إذن النظام معطلاً.':'لم تؤكد Firebase تسليم الإشعار لأي جهاز؛ راجع أخطاء الإرسال.'});
  }
  if(p==='/api/admin/notifications' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'}); return json(res,200,{ok:true,notifications:readNotifications().map(sanitizeNotification)});
  }
  if(p==='/api/admin/notifications' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'}); const b=await bodyJSON(req); const title=String(b.title||'').trim(), message=String(b.message||'').trim(), url=String(b.url||'').trim();
    if(!title||!message)return json(res,422,{ok:false,error:'العنوان والنص مطلوبان'});
    const requestedType=String(b.type||'').trim();const type=['broadcast','required','temporary_page'].includes(requestedType)?requestedType:(b.required?'required':'broadcast');
    const rawDelay=Number(b.delaySeconds===undefined?5:b.delaySeconds);if(type==='temporary_page'&&(!Number.isInteger(rawDelay)||rawDelay<1||rawDelay>600))return json(res,422,{ok:false,error:'مدة الإشعار المؤقت يجب أن تكون بين ثانية و600 ثانية'});
    const all=readNotifications(); const n=sanitizeNotification({id:notifId(),title:title.slice(0,160),message:message.slice(0,3000),url:url.slice(0,1000),type,delaySeconds:type==='temporary_page'?rawDelay:undefined,required:type==='required'||(requestedType===''&&!!b.required),active:b.active!==false,createdAt:new Date().toISOString()}); all.unshift(n); writeNotifications(all.slice(0,500)); return json(res,200,{ok:true,notification:n});
  }
  if(p==='/api/admin/notifications' && req.method==='PATCH'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'}); const b=await bodyJSON(req); const all=readNotifications(); const i=all.findIndex(x=>String(x.id)===String(b.id)); if(i<0)return json(res,404,{ok:false,error:'الإشعار غير موجود'}); if(b.action==='delete')all.splice(i,1); else {all[i]={...sanitizeNotification(all[i]),...(b.active!==undefined?{active:!!b.active}:{}),...(b.required!==undefined?{required:!!b.required}:{}),updatedAt:new Date().toISOString()};} writeNotifications(all); return json(res,200,{ok:true});
  }
  if(p==='/api/notifications' && req.method==='GET'){
    const s=session(req); if(!s||s.role!=='user')return json(res,401,{ok:false,error:'يجب تسجيل الدخول'});
    const all=await listUserNotifications(s.username);const includeRead=urlObj.searchParams.get('all')==='1';const items=includeRead?all:all.filter(n=>!n.read);return json(res,200,{ok:true,notifications:items,unreadCount:all.filter(n=>!n.read).length,checkedAt:nowISO()});
  }
  if(p==='/api/notifications/seen' && req.method==='POST'){
    const s=session(req); if(!s||s.role!=='user')return json(res,401,{ok:false,error:'يجب تسجيل الدخول'}); const b=await bodyJSON(req); const id=String(b.id||''); if(!id)return json(res,422,{ok:false,error:'معرف الإشعار مطلوب'}); const seen=readNotificationSeen(); seen[s.username]=seen[s.username]||{}; seen[s.username][id]=nowISO(); writeNotificationSeen(seen);let firebaseSeenSaved=false;try{await firebaseWriteJson('userNotificationSeen/'+firebaseSafeKey(s.username)+'/'+id,seen[s.username][id],5000);firebaseSeenSaved=true;}catch(_){}const all=readJSON('user_notifications.json',{});const rows=Array.isArray(all[s.username])?all[s.username]:[];let found=false;for(let i=0;i<rows.length;i++)if(String(rows[i].id)===id){rows[i]={...rows[i],read:true,readAt:nowISO()};found=true;}if(found){all[s.username]=rows;writeJSON('user_notifications.json',all);firebasePatchJson('userNotifications/'+firebaseSafeKey(s.username)+'/'+id,{read:true,readAt:nowISO()},4000).catch(()=>{});} return json(res,200,{ok:true,firebaseSeenSaved,storageMode:DATA_IS_EXTERNAL?'persistent-volume':'release-local'});
  }
  if(p==='/api/user/orders' && req.method==='GET'){
    const s=session(req);if(!s||!['user','admin'].includes(s.role))return json(res,401,{ok:false,error:'يجب تسجيل الدخول'});
    const username=String(s.username||''),merged=new Map(),firebaseKeyById=new Map();
    const add=(o,key='',source='')=>{if(!o||typeof o!=='object'||o.event||String(o.user||o.username||o.userName||'')!==username)return;const id=String(o.id||o.siteOrderId||o.localId||o.orderId||o.order_id||key||'');if(!id)return;const old=merged.get(id)||{};merged.set(id,{...old,...o,id:String(o.id||old.id||id),user:username,_k:String(o._k||o.firebaseKey||key||old._k||''),source:source||old.source||'local'});if(source==='firebase')firebaseKeyById.set(id,String(key||''));};
    for(const o of readJSON('orders.json',[]))add(o,o.id,'hosting-file');
    let firebaseAvailable=false,warning='';try{const remote=await firebaseGetQueryJson('orders',{orderBy:JSON.stringify('user'),equalTo:JSON.stringify(username)},8000);firebaseAvailable=true;for(const [key,o] of collectionEntries(remote))add(o,key,'firebase');}catch(e){warning='تعذر قراءة طلبات هذا المستخدم من Firebase؛ تم عرض طلبات الخادم المحفوظة. '+String(e.message||e).slice(0,100);}
    const mergedRows=[...merged.values()];
    // Existing REQ_* IDs stay as internal tracking IDs, while older records receive a permanent public number starting at 3000.
    const needsNumber=mergedRows.filter(o=>{if(o.legacyHistory)return false;const p=String(o.publicOrderNo||'').trim(),id=String(o.id||'').trim();const validPublic=/^\d{1,9}$/.test(p)&&Number(p)>=3000;const numericId=/^\d{1,9}$/.test(id)&&Number(id)>=3000;return !validPublic&&!numericId;}).sort((a,b)=>(Date.parse(a.createdAt||0)||0)-(Date.parse(b.createdAt||0)||0));
    if(firebaseAvailable&&needsNumber.length){
      const localRows=readJSON('orders.json',[]);let localChanged=false;
      for(const order of needsNumber){
        try{
          const number=await nextPublicOrderNumber();
          const remoteKey=firebaseKeyById.get(String(order.id||''));
          // Update only the existing Firebase child. If the order is local-only, persist and verify the whole order, never create a number-only ghost node.
          if(remoteKey)await firebaseWriteJson('orders/'+remoteKey+'/publicOrderNo',number,6000);
          else await persistOrderToFirebase({...order,publicOrderNo:number});
          order.publicOrderNo=number;
          for(let i=0;i<localRows.length;i++){const row=localRows[i];if(row&&!row.event&&String(row.id||row.localId||'')===String(order.id)&&String(row.user||row.username||'')===username){localRows[i]={...row,publicOrderNo:number};localChanged=true;}}
        }catch(e){warning=(warning?warning+' ':'')+'تعذر ترقيم بعض الطلبات القديمة تلقائياً؛ '+String(e.message||e).slice(0,90);}
      }
      if(localChanged)writeJSON('orders.json',localRows);
    }
    const orders=mergedRows.sort((a,b)=>(Date.parse(b.createdAt||0)||0)-(Date.parse(a.createdAt||0)||0)).slice(0,500);
    return json(res,200,{ok:true,orders,source:firebaseAvailable?'hosting-file+firebase':'hosting-file',warning:warning||undefined});
  }
  if(p==='/api/user/summary' && req.method==='GET'){
    const s=session(req);if(!s||!['user','admin'].includes(s.role))return json(res,401,{ok:false,error:'يجب تسجيل الدخول'});
    const uname=String(s.username||'');const usernameNorm=uname.trim().toLowerCase();
    const ownerOf=o=>String(o?.user||o?.username||o?.userName||o?.customerUsername||o?.customer_username||'').trim().toLowerCase();
    const localOrders=readJSON('orders.json',[]).filter(x=>x&&!x.event&&ownerOf(x)===usernameNorm);
    const orderMap=new Map();
    const summaryStatus=o=>{const raw=String(o?.status||o?.providerStatus||o?.provider_status||o?.smmStatus||o?.state||'pending').trim().toLowerCase();return ({'complete':'completed','success':'completed','successful':'completed','done':'completed','finished':'completed','in_progress':'processing','in progress':'processing','waiting':'pending','canceled':'cancelled'}[raw]||raw);};
    const addSummaryOrder=(o,sourceKey='')=>{const id=String(o.id||o.siteOrderId||o.localId||o.orderId||o.order_id||o.providerOrderId||o.smmpartyOrderId||sourceKey||o.createdAt||'');if(!id)return;const key=usernameNorm+'|'+id;const prior=orderMap.get(key)||{};const usdRaw=o.chargeUsd??o.chargeUSD??o.totalUsd??o.priceUsd??o.amountUsd??o.amountUSD;const usd=Number(usdRaw);const iqRaw=o.totalIQD??o.chargeIqd??o.chargeIQD??o.amountIQD??o.total;const iq=Number(iqRaw);const amountUsd=Number.isFinite(usd)&&usd>=0?usd:(Number.isFinite(prior.amountUsd)?prior.amountUsd:undefined);const totalIQD=Number.isFinite(iq)&&iq>0?iq:(Number.isFinite(amountUsd)&&amountUsd>=0?Number((amountUsd*FIXED_RATE).toFixed(4)):Number(prior.totalIQD||0));const status=summaryStatus(o);const previous=String(prior.status||'pending');const mergedStatus=prior.status&&previous==='completed'?previous:status;orderMap.set(key,{...prior,...o,id,user:uname,totalIQD,amountUsd,status:mergedStatus,createdAt:String(o.createdAt||o.created_date||prior.createdAt||''),legacyHistory:!!(o.legacyHistory||prior.legacyHistory)});};
    for(const o of localOrders)addSummaryOrder(o);
    let ordersSource='hosting-file';let ordersReadWarning='';
    try{const fbOrders=await firebaseGetQueryJson('orders',{orderBy:JSON.stringify('user'),equalTo:JSON.stringify(uname)},6500);if(fbOrders&&typeof fbOrders==='object'){for(const [key,o] of collectionEntries(fbOrders)){if(!o||typeof o!=='object'||o.event||ownerOf(o)!==usernameNorm)continue;addSummaryOrder(o,key);}ordersSource='hosting-file+firebase';}}catch(e){ordersReadWarning='تعذر قراءة بعض الطلبات من Firebase؛ الإحصائيات قد لا تتضمن السجلات البعيدة.';console.warn('user summary remote orders unavailable:',String(e.message||e).slice(0,100))}
    const orders=[...orderMap.values()];const spentIQD=orders.reduce((a,o)=>a+Math.max(0,Number(o.totalIQD||((Number(o.amountUsd)||0)*FIXED_RATE))||0),0);
    const refs=readJSON('refunds.json',[]).filter(x=>String(x.user||'')===uname);let refundedIQD=refs.reduce((a,r)=>a+Math.max(0,Number(r.amountIQD||0)),0);let remoteUser=null;try{const foundUser=await findRemoteUserByUsername(uname);remoteUser=foundUser?.user||null}catch(_){}if(remoteUser?.sadaRefunds&&typeof remoteUser.sadaRefunds==='object'){const remoteRefunded=Object.values(remoteUser.sadaRefunds).reduce((a,r)=>a+Math.max(0,Number(r?.totalIQD||0)),0);refundedIQD=Math.max(refundedIQD,remoteRefunded)}
    const er=readJSON('earn_requests.json',[]).filter(x=>String(x.user||'')===uname&&x.status==='approved');const rewardsUSD=Math.max(Number(remoteUser?.sadaEarnTotalUSD||0),er.reduce((a,r)=>a+Math.max(0,Number(r.rewardUSD||0)),0));const localProfile=readJSON('users.json',{users:{}}).users?.[uname]||{};const localBalance=localProfile.balance;const balanceIQD=Number(remoteUser?.balance??localBalance??s.balance??0);const email=String(remoteUser?.email||remoteUser?.mail||localProfile.email||'');const verifiedRaw=remoteUser?.emailVerified??localProfile.emailVerified;const emailVerified=verifiedRaw===true||String(verifiedRaw||'').toLowerCase()==='true';const requiredRaw=remoteUser?.emailVerificationRequired??localProfile.emailVerificationRequired;const emailVerificationRequired=requiredRaw!==false;const profile={username:uname,name:String(remoteUser?.name||remoteUser?.fullName||localProfile.name||localProfile.fullName||uname),email,emailVerified,emailVerificationRequired,phone:String(remoteUser?.phone||localProfile.phone||''),joined:String(remoteUser?.joined||remoteUser?.createdAt||localProfile.joined||localProfile.createdAt||''),createdAt:String(remoteUser?.createdAt||localProfile.createdAt||localProfile.joined||''),lastLoginAt:String(remoteUser?.lastLoginAt||localProfile.lastLoginAt||''),level:String(remoteUser?.level||localProfile.level||'مبتدئ')};
    const completedStates=new Set(['completed','complete','success','successful','done','finished']);const activeStates=new Set(['pending','processing','in_progress','in progress','queued','awaiting']);const completedOrders=orders.filter(o=>completedStates.has(String(o.status||'').toLowerCase())).length;const activeOrders=orders.filter(o=>activeStates.has(String(o.status||'').toLowerCase())).length;const lastOrderAt=orders.map(o=>o.createdAt).filter(Boolean).sort((a,b)=>(Date.parse(b)||0)-(Date.parse(a)||0))[0]||'';
    return json(res,200,{ok:true,profile,orders:orders.length,completedOrders,activeOrders,lastOrderAt,spentIQD:Number(spentIQD.toFixed(4)),refundedIQD:Number(refundedIQD.toFixed(4)),rewardsUSD:Number(rewardsUSD.toFixed(6)),balanceIQD,currency:'IQD',ordersSource,warning:ordersReadWarning||undefined,checkedAt:nowISO()});
  }
  if(p==='/api/earn/requests' && req.method==='GET'){
    const s=session(req);if(!s||s.role!=='user')return json(res,401,{ok:false,error:'يجب تسجيل الدخول'});const rows=readJSON('earn_requests.json',[]).filter(x=>String(x.user||'')===String(s.username));let remote=[];try{const v=await firebaseGetJson('earnRequestsByUser/'+firebaseSafeKey(s.username),4000);if(v&&typeof v==='object')remote=(Array.isArray(v)?v:Object.values(v)).filter(x=>x&&typeof x==='object')}catch(_){}const m=new Map();for(const r of [...remote,...rows])if(r.id)m.set(String(r.id),{...m.get(String(r.id)),...r});return json(res,200,{ok:true,requests:[...m.values()].sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0)).slice(0,100),maxRewardUSD:50});
  }
  if(p==='/api/earn/requests' && req.method==='POST'){
    const wait=rateLimit(req,'auth');if(wait)return json(res,429,{ok:false,error:'طلبات كثيرة، حاول لاحقاً'},{'Retry-After':String(wait)});const s=session(req);if(!s||s.role!=='user')return json(res,401,{ok:false,error:'يجب تسجيل الدخول'});const b=await bodyJSON(req);const platform=String(b.platform||'').toLowerCase();const link=String(b.videoUrl||b.link||'').trim();const followers=Number(b.followers),views=Number(b.views),notes=String(b.notes||'').trim().slice(0,500);let u;try{u=new URL(link)}catch(_){return json(res,422,{ok:false,error:'رابط الفيديو غير صالح'})}const domains={tiktok:['tiktok.com'],youtube:['youtube.com','youtu.be'],instagram:['instagram.com'],facebook:['facebook.com','fb.watch']};if(u.protocol!=='https:'||!(domains[platform]||[]).some(d=>u.hostname===d||u.hostname.endsWith('.'+d)))return json(res,422,{ok:false,error:'اختر المنصة الصحيحة وأدخل رابط فيديو HTTPS مطابقاً لها'});if(!Number.isInteger(followers)||followers<100)return json(res,422,{ok:false,error:'يجب أن يكون لديك 100 مشترك/متابع على الأقل'});if(!Number.isInteger(views)||views<100||views>10000)return json(res,422,{ok:false,error:'عدد المشاهدات المقبول من 100 إلى 10,000'});const rewardUSD=views<500?1.5:views<2000?2:5;const localRows=readJSON('earn_requests.json',[]);if(localRows.some(x=>String(x.user||'')===String(s.username)&&x.status==='pending_review'&&String(x.videoUrl||'')===link))return json(res,409,{ok:false,error:'هذا الفيديو لديه طلب مراجعة قيد الانتظار'});let total=localRows.filter(x=>String(x.user||'')===String(s.username)&&['pending_review','approved'].includes(x.status)).reduce((a,x)=>a+Number(x.rewardUSD||0),0);try{const rem=await firebaseGetJson('earnRequestsByUser/'+firebaseSafeKey(s.username),3000);if(rem&&typeof rem==='object')total=Math.max(total,Object.values(rem).filter(x=>x&&['pending_review','approved'].includes(x.status)).reduce((a,x)=>a+Number(x.rewardUSD||0),0))}catch(_){}if(total+rewardUSD>50)return json(res,422,{ok:false,error:'تجاوزت حد المكافآت المتاحة 50 دولاراً لهذا الحساب'});const id='ER'+Date.now().toString(36).toUpperCase()+crypto.randomBytes(3).toString('hex').toUpperCase();const row={id,user:String(s.username),videoUrl:u.toString(),platform,followers,views,notes,rewardUSD,status:'pending_review',createdAt:nowISO(),updatedAt:nowISO()};localRows.unshift(row);writeJSON('earn_requests.json',localRows.slice(0,10000));let remoteSaved=false,remoteError='';try{await firebaseWriteJson('earnRequests/'+id,row,5000);const urow={...row};delete urow.user;await firebaseWriteJson('earnRequestsByUser/'+firebaseSafeKey(s.username)+'/'+id,urow,5000);remoteSaved=true}catch(e){remoteError=String(e.message||e).slice(0,120)}if(!remoteSaved&&!DATA_IS_EXTERNAL){const arr=readJSON('earn_requests.json',[]).filter(x=>x.id!==id);writeJSON('earn_requests.json',arr);return json(res,503,{ok:false,error:'تعذر حفظ طلب المكافأة في قاعدة بيانات دائمة. أعد المحاولة بعد فحص Firebase أو مساحة التخزين.'})}createUserNotification(s.username,{type:'earn_request',status:'pending_review',title:'تم استلام طلب رصيد مجاني',message:'تم تسجيل طلب مكافأتك بقيمة '+rewardUSD.toFixed(2)+' دولار وهو بانتظار مراجعة الإدارة.'});return json(res,201,{ok:true,request:row,persistedRemotely:remoteSaved,warning:remoteSaved?'':'تم حفظ الطلب في التخزين المحلي الدائم لكن تعذر مزامنته مع Firebase.'});
  }
  if(p==='/api/admin/earn-requests' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const page=Math.max(1,Number(urlObj.searchParams.get('page')||1)),limit=Math.min(100,Math.max(10,Number(urlObj.searchParams.get('limit')||30))),q=String(urlObj.searchParams.get('q')||'').trim().toLowerCase();let rows=readJSON('earn_requests.json',[]);try{const v=await firebaseGetJson('earnRequests',5000);if(v&&typeof v==='object'){const m=new Map(rows.map(x=>[String(x.id),x]));for(const x of Object.values(v))if(x&&typeof x==='object'&&x.id)m.set(String(x.id),{...m.get(String(x.id)),...x});rows=[...m.values()]}}catch(_){}rows=rows.filter(x=>!q||[x.id,x.user,x.videoUrl,x.platform,x.status].some(v=>String(v||'').toLowerCase().includes(q))).sort((a,b)=>(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0));return json(res,200,{ok:true,total:rows.length,page,limit,requests:rows.slice((page-1)*limit,page*limit)});
  }
  if(p==='/api/admin/earn-requests/decision' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});const b=await bodyJSON(req),id=String(b.id||''),action=String(b.action||''),reason=String(b.reason||'').trim().slice(0,400);if(!id||!['approve','reject'].includes(action))return json(res,422,{ok:false,error:'بيانات القرار غير مكتملة'});let rows=readJSON('earn_requests.json',[]),row=rows.find(x=>String(x.id)===id);if(!row){try{row=await firebaseGetJson('earnRequests/'+id,4000)}catch(_){}}if(!row||!row.user)return json(res,404,{ok:false,error:'طلب المكافأة غير موجود'});if(row.status==='approved')return json(res,200,{ok:true,alreadyProcessed:true,request:row});if(row.status==='rejected')return json(res,409,{ok:false,error:'تم رفض هذا الطلب سابقاً'});if(action==='reject'){row={...row,status:'rejected',reviewedAt:nowISO(),reviewedBy:session(req)?.username||'admin',reviewReason:reason};}else{const reward=Math.max(0,Number(row.rewardUSD||0));if(reward<=0||reward>50)return json(res,422,{ok:false,error:'قيمة المكافأة غير صالحة'});let tx;try{tx=await firebaseTransaction('users/'+firebaseSafeKey(row.user),current=>{if(!current||typeof current!=='object')return {write:false,result:{error:'user-record-not-found'}};const credits=current.sadaEarnCredits&&typeof current.sadaEarnCredits==='object'?{...current.sadaEarnCredits}:{};if(credits[id])return {write:false,result:{already:true,balanceIQD:Number(current.balance||0)}};const lifetime=Number(current.sadaEarnTotalUSD||0);if(lifetime+reward>50.000001)return {write:false,result:{error:'تجاوز حد المكافآت 50 دولاراً'}};const before=Number(current.balance||0),amountIQD=Number((reward*FIXED_RATE).toFixed(4)),after=Number((before+amountIQD).toFixed(4)),at=nowISO();credits[id]={requestId:id,rewardUSD:reward,amountIQD,createdAt:at};current.sadaEarnCredits=credits;current.sadaEarnTotalUSD=Number((lifetime+reward).toFixed(6));current.balance=after;current.updatedAt=at;return {write:true,value:current,result:{credited:true,balanceBeforeIQD:before,balanceIQD:after,amountIQD,rewardUSD:reward}}},10000);if(tx.result?.error)return json(res,409,{ok:false,error:tx.result.error});}catch(e){return json(res,503,{ok:false,error:'تعذر تحديث رصيد المستخدم في قاعدة البيانات: '+String(e.message||e).slice(0,140)})}row={...row,status:'approved',reviewedAt:nowISO(),reviewedBy:session(req)?.username||'admin',reviewReason:reason};if(tx.result?.credited){appendJsonLedger('balance_ledger.json',{user:row.user,type:'earn_reward',amountUSD:reward,amountIQD:tx.result.amountIQD,after:tx.result.balanceIQD,reason:'مكافأة رصيد مجاني بعد مراجعة الإدارة',admin:session(req)?.username||'admin',reference:id,createdAt:nowISO()});}else if(!tx.result?.already)return json(res,503,{ok:false,error:'لم يتم تأكيد عملية رصيد المكافأة.'});}
    const idx=rows.findIndex(x=>String(x.id)===id);if(idx>=0)rows[idx]=row;else rows.unshift(row);writeJSON('earn_requests.json',rows.slice(0,10000));try{await firebaseWriteJson('earnRequests/'+id,row,5000);const ur={...row};delete ur.user;await firebaseWriteJson('earnRequestsByUser/'+firebaseSafeKey(row.user)+'/'+id,ur,5000)}catch(e){if(!DATA_IS_EXTERNAL)return json(res,503,{ok:false,error:'تم تحديث السجل المحلي لكن تعذر تثبيته في Firebase؛ تحقق من قاعدة البيانات.'})}createUserNotification(row.user,{type:'earn_decision',status:row.status,title:row.status==='approved'?'تمت الموافقة على مكافأتك':'تمت مراجعة طلب المكافأة',message:row.status==='approved'?'تم اعتماد مكافأتك وإضافة '+Number(row.rewardUSD||0).toFixed(2)+' دولار إلى رصيدك.':'تم رفض طلب المكافأة. '+reason});return json(res,200,{ok:true,request:row});
  }

  if(p==='/api/provider/balance' && req.method==='GET'){
    const wait=rateLimit(req,'provider'); if(wait)return json(res,429,{ok:false,error:'طلبات الرصيد كثيرة، أعد المحاولة لاحقاً'},{'Retry-After':String(wait)});
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح — جلسة الإدارة غير صالحة'});
    const requested=String(urlObj.searchParams.get('provider')||''); await ensureProviderRuntime(requested);
    const {prov,pid}=getProviderById(requested,{allowSingleFallback:true}); if(!prov?.url||!prov?.key)return json(res,404,{ok:false,error:'المزود غير موجود أو بيانات URL/Key غير مكتملة'});
    try{const d=await providerRequest(prov,{action:'balance'}); const balance=normalizeProviderBalance(d); if(balance===null)return json(res,502,{ok:false,error:'المزود لم يرجع قيمة رصيد صالحة'}); return json(res,200,{ok:true,providerId:pid,providerName:prov.name||pid,balance,currency:normalizeProviderCurrency(d),checkedAt:new Date().toISOString()});}
    catch(e){return json(res,502,{ok:false,error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':e.message});}
  }
  if(p==='/api/provider/test' && req.method==='POST'){
    const wait=rateLimit(req,'provider'); if(wait)return json(res,429,{ok:false,error:'طلبات اختبار المزود كثيرة، أعد المحاولة لاحقاً'},{'Retry-After':String(wait)});
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req); const prov=await resolveProviderDiagnosticsInput(b);
    if(!/^https?:\/\//i.test(prov.url)||!prov.key) return json(res,422,{ok:false,error:'رابط API أو مفتاح API غير صالح. إذا كان المزود محفوظاً، أعد تحميل قائمة المزودين ثم أعد الاختبار.'});
    const out={connection:{ok:false},balance:{ok:false},services:{ok:false}};
    try{ const d=await providerRequest(prov,{action:'balance'}); const balance=normalizeProviderBalance(d); if(balance===null) throw new Error('API لم يرجع رصيداً رقمياً'); out.connection={ok:true}; out.balance={ok:true,balance,currency:normalizeProviderCurrency(d)}; }
    catch(e){ out.balance={ok:false,error:e.name==='AbortError'?'انتهت مهلة جلب الرصيد':e.message}; }
    try{ const d=await providerRequest(prov,{action:'services'}); const list=normalizeProviderServices(d); out.services={ok:Array.isArray(list)&&list.length>0,count:Array.isArray(list)?list.length:0,error:Array.isArray(list)&&list.length?'':'لم يرجع خدمات'}; if(out.services.ok && !out.connection.ok) out.connection={ok:true}; }
    catch(e){ out.services={ok:false,error:e.name==='AbortError'?'انتهت مهلة جلب الخدمات':e.message}; }
    if(!out.connection.ok) out.connection={ok:false,error:out.balance.error||out.services.error||'فشل الاتصال بالمزود'};
    return json(res,200,{ok:out.connection.ok&&out.balance.ok&&out.services.ok,providerName:prov.name,diagnostics:out,checkedAt:new Date().toISOString()});
  }
  if(p==='/api/order/create' && req.method==='POST'){
    const wait=rateLimit(req,'order'); if(wait)return json(res,429,{ok:false,error:'طلبات كثيرة، أعد المحاولة بعد قليل'},{'Retry-After':String(wait)});
    const orderSession=session(req);
    const username=userFromSession(req); if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول من جديد'});
    const isAdminSession=orderSession?.role==='admin';
    const b=await bodyJSON(req); const providerId=String(b.providerId||'').trim();
    const customShopResult=await handleCustomShopOrder(req,b,username,orderSession);if(customShopResult)return json(res,customShopResult.status,customShopResult.body,customShopResult.headers||{});
    const manualResult=await handleManualSupportOrder(req,res,b,username,orderSession);if(manualResult)return json(res,manualResult.status,manualResult.body,manualResult.headers||{});
    // The website/catalog identifier is distinct from the provider's service number.
    // Old clients send serviceId=provider ID + firebaseServiceKey=site ID; new clients send both explicit fields.
    const legacyServiceId=String(b.serviceId||'').trim();
    const requestedSiteServiceId=String(b.siteServiceId||b.catalogServiceId||'').trim();
    const requestedProviderServiceId=String(b.providerServiceId||b.smmpartyId||(!requestedSiteServiceId?legacyServiceId:'')).trim();
    const firebaseServiceKey=String(b.firebaseServiceKey||requestedSiteServiceId||'').trim();
    const serviceLookupId=String(requestedProviderServiceId||legacyServiceId||requestedSiteServiceId).trim();
    const link=String(b.link||'').trim(); const quantity=Number(b.quantity); const localId=String(b.localId||'').trim();
    if(!providerId||!serviceLookupId||!link||!Number.isInteger(quantity)||quantity<=0)return json(res,422,{ok:false,error:'بيانات الطلب غير مكتملة',stage:'validate'});
    if(!/^https?:\/\//i.test(link))return json(res,422,{ok:false,error:'الرابط غير صالح',stage:'validate'});
    await ensureLocalServiceCatalogSeeded();ensureNumericSiteServiceIds();
    const existing=readJSON('orders.json',[]).find(x=>String(x.user||'')===username&&String(x.localId||'')===localId&&localId&&String(x.providerOrderId||''));
    if(existing){const existingSiteId=String(existing.id||existing.localId||localId||'');let savedToFirebase=true;try{await persistOrderToFirebase(existing)}catch(_){savedToFirebase=false}if(!savedToFirebase)return json(res,503,{ok:false,uncertain:true,error:'عُثر على الطلب السابق محلياً لكن لم أستطع تأكيد حفظه في Firebase. لم يُرسل طلب جديد.'});if(existing.billingMode!=='admin-test'){try{await finalizeProviderOrderAccounting(username,localId,Number(existing.total??Number(existing.chargeUsd||0)*FIXED_RATE),existing.createdAt)}catch(e){console.warn('idempotent order accounting reconciliation:',String(e.message||e).slice(0,100));}}const providerTrackingToken=issueProviderOrderTrackingToken({username,providerId:String(existing.providerId||providerId),providerOrderId:String(existing.providerOrderId),siteOrderId:existingSiteId});return json(res,200,{ok:true,idempotent:true,siteOrderId:existingSiteId,publicOrderNo:String(existing.publicOrderNo||''),siteServiceId:String(existing.siteServiceId||existing.serviceId||''),serviceId:String(existing.siteServiceId||existing.serviceId||''),providerServiceId:String(existing.providerServiceId||existing.smmpartyId||''),providerId:String(existing.providerId||providerId),providerName:String(existing.providerName||''),providerOrderId:String(existing.providerOrderId),providerTrackingToken,providerRaw:existing.providerRaw||null,createdAt:existing.createdAt||new Date().toISOString()});}
    const svc=await guardServicePrice(await authoritativeWebsiteService(providerId,requestedProviderServiceId||legacyServiceId||requestedSiteServiceId,firebaseServiceKey));
    if(!svc)return json(res,409,{ok:false,error:'لم أستطع التحقق من الخدمة وربطها بالمزوّد. أعد فحص معرّف الموقع وربط خدمة المزود من لوحة الإدارة؛ لم يُخصم أي رصيد ولم يُرسل طلب.',stage:'service_lookup',siteServiceId:requestedSiteServiceId||firebaseServiceKey||null,providerServiceId:requestedProviderServiceId||legacyServiceId||null});
    if(svc.providerAvailable===false||String(svc.availabilityStatus||'').toLowerCase()==='unavailable')return json(res,409,{ok:false,error:'هذه الخدمة غير متاحة حالياً لدى المزود أو لم يُتحقق من سعرها الحي. أُوقف الطلب ولن يُخصم أي رصيد.',stage:'provider_service_unavailable',siteServiceId:String(svc.siteServiceId||''),providerServiceId:String(svc.providerServiceId||'')});
    const siteServiceId=String(svc.siteServiceId||requestedSiteServiceId||svc.fbKey||firebaseServiceKey||(!requestedProviderServiceId?legacyServiceId:'')).trim();
    const providerServiceId=String(svc.providerServiceId||requestedProviderServiceId||legacyServiceId||'').trim();
    if(!siteServiceId)return json(res,409,{ok:false,error:'الخدمة لا تملك معرّفاً داخلياً ثابتاً في كتالوج صدى العراق؛ لم يُخصم أي رصيد ولم يُرسل طلب.',stage:'site_service_id'});
    if(!providerServiceId)return json(res,409,{ok:false,error:'الخدمة لا تملك معرّف مزوّد محفوظاً؛ لم يُخصم أي رصيد ولم يُرسل طلب.',stage:'provider_service_id',siteServiceId});
    const mn=Math.max(1,Number(svc.min||100)),mx=Math.max(mn,Number(svc.max||10000)); if(quantity<mn||quantity>mx)return json(res,422,{ok:false,error:'الكمية خارج حدود الخدمة',stage:'validate',siteServiceId,providerServiceId,min:mn,max:mx});
    const rawServiceRate=svc.sellingUsd??svc.rateUsd??svc.rate;
    if(rawServiceRate===undefined||rawServiceRate===null||rawServiceRate===''||!Number.isFinite(Number(rawServiceRate))||Number(rawServiceRate)<0)
      return json(res,409,{ok:false,error:'سعر البيع لهذه الخدمة غير مضبوط في كتالوج الاستضافة؛ لم يُخصم أي رصيد ولم يُرسل طلب للمزوّد.',stage:'service_price'});
    const serviceRate=Number(rawServiceRate); const localUser=readJSON('users.json',{users:{}}).users?.[username]||{};
    let verifiedUser=null,walletUserPath='';
    if(!isAdminSession){try{verifiedUser=await findRemoteUserByUsername(username);walletUserPath=String(verifiedUser?.firebasePath||'');}catch(e){return json(res,503,{ok:false,error:'تعذر التحقق من مسار رصيد المستخدم في Firebase: '+String(e.message||e).slice(0,130),stage:'wallet_lookup'});}if(!verifiedUser?.user||!walletUserPath)return json(res,503,{ok:false,error:'سجل المستخدم غير موجود في مسار Firebase المتوقع؛ لم يتم خصم الرصيد أو إرسال الطلب.',stage:'wallet_lookup'});}
    const userDiscount=Math.max(0,Math.min(100,Number(verifiedUser?.user?.discountPct??verifiedUser?.user?.discount??localUser.discountPct??orderSession?.discountPct??0)||0));
    const chargeUsd=Number((Math.max(0,quantity/1000*serviceRate*(1-userDiscount/100))).toFixed(6));
    const isAdminFreeService=svc.adminFreeService===true;
    const providerRateUsd=catalogRate(svc);
    if((providerRateUsd===null||!Number.isFinite(providerRateUsd)||providerRateUsd<0)&&!isAdminFreeService)return json(res,409,{ok:false,error:'لا توجد تكلفة موثوقة حديثة للمزود؛ أوقفنا الطلب حتى لا يُباع بخسارة. حدّث كتالوج الأسعار من لوحة الإدارة.',stage:'provider_cost_unverified'});
    const effectiveProviderRateUsd=providerRateUsd===null?0:providerRateUsd;
    const providerCostUsd=Number((effectiveProviderRateUsd*quantity/1000).toFixed(6));
    const requiredMarkupPct=Math.max(0,Math.min(1000,Number.isFinite(Number(svc.markupPct))?Number(svc.markupPct):100));const minimumChargeUsd=Number((providerCostUsd*(1+requiredMarkupPct/100)).toFixed(6));
    if(!isAdminFreeService&&chargeUsd+0.000001<minimumChargeUsd)return json(res,422,{ok:false,error:'سعر البيع بعد الخصم لا يحقق زيادة '+requiredMarkupPct+'% على تكلفة المزود. أوقفنا الطلب لحماية هامش الربح المطلوب؛ خفّض الخصم أو ارفع سعر الخدمة.',stage:'sale_below_provider_cost',providerCostUsd,chargeUsd,minimumChargeUsd,requiredMarkupPct,markupPct:providerCostUsd>0?Number((((chargeUsd/providerCostUsd)-1)*100).toFixed(2)):null});
    const grossProfitUsd=Number((chargeUsd-providerCostUsd).toFixed(6));
    const actualMarkupPct=providerCostUsd>0?Number((grossProfitUsd/providerCostUsd*100).toFixed(2)):null;
    const profitMarginPct=chargeUsd>0?Number((grossProfitUsd/chargeUsd*100).toFixed(2)):null;
    const chargeIqd=Number((chargeUsd*FIXED_RATE).toFixed(4));
    await ensureProviderRuntime(providerId); const {prov}=getProviderById(providerId); if(!prov)return json(res,404,{ok:false,error:'المزود المرتبط بالخدمة غير موجود',stage:'provider_lookup'});
    const result=await withApiUserLock(username,async()=>{
      // Admin-created free offers have their own per-account limit; ordinary/free supplier services are untouched.
      let freeUsageClaim=null;
      if(isAdminFreeService&&!isAdminSession){
        if(!localId||localId.length>100)return {freeRequestDuplicate:true,error:'رقم تتبع الطلب مطلوب للخدمة المجانية.'};
        const claim=await reserveAdminFreeServiceUsage(username,String(svc.adminFreeServiceKey||svc.fbKey||siteServiceId),Number(svc.perAccountLimit||2),localId,walletUserPath);
        if(!claim.ok)return claim.duplicate?{freeRequestDuplicate:true,error:claim.error}:claim.limit?{freeLimitReached:true,error:claim.error,limit:claim.limit,nextAllowedAt:claim.nextAllowedAt}:{freeUsageUnavailable:true,error:claim.error||'تعذر حفظ حد الاستخدام المجاني'};
        freeUsageClaim=claim;
      }
      // The server, not the browser, is authoritative for provider-order wallet reservations.
      const reservationId=sha256(String(localId||'')+'|'+username).slice(0,40);
      let reserved=false,before=0,after=0;
      async function markReservation(state){
        if(isAdminSession||chargeIqd<=0)return;
        try{await firebaseTransaction(walletUserPath||('users/'+firebaseSafeKey(username)),current=>{
          if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-record-not-found'}};
          const map=current.sadaOrderReservations&&typeof current.sadaOrderReservations==='object'?{...current.sadaOrderReservations}:{};
          if(!map[reservationId])return {write:false,result:{missing:true}};
          if(state==='complete'){const seen=current.sadaOrderAccounting&&typeof current.sadaOrderAccounting==='object'?{...current.sadaOrderAccounting}:{};if(!seen[reservationId]){const charge=Math.max(0,Number(map[reservationId]?.amountIQD||chargeIqd)||0);current.totalSpent=Number((Math.max(0,Number(current.totalSpent)||0)+charge).toFixed(4));current.totalOrders=Math.max(0,Math.floor(Number(current.totalOrders)||0))+1;seen[reservationId]={localId,amountIQD:charge,createdAt:map[reservationId]?.createdAt||nowISO(),countedAt:nowISO()};const ordered=Object.entries(seen).sort((a,b)=>(Date.parse(a[1]?.countedAt||0)||0)-(Date.parse(b[1]?.countedAt||0)||0));while(ordered.length>1500){const [oldKey]=ordered.shift();delete seen[oldKey];}}delete map[reservationId];current.sadaOrderAccounting=seen;current.sadaOrderReservations=map;current.updatedAt=nowISO();return {write:true,value:current,result:{completed:true,totalSpent:current.totalSpent,totalOrders:current.totalOrders}};}
          if(state==='release'){
            const amount=Math.max(0,Number(map[reservationId].amountIQD||chargeIqd));
            current.balance=Number((Number(current.balance||0)+amount).toFixed(4));delete map[reservationId];
            current.sadaOrderReservations=map;current.updatedAt=nowISO();
            return {write:true,value:current,result:{released:true,amountIQD:amount,balanceIQD:current.balance}};
          }
          map[reservationId]={...map[reservationId],state,updatedAt:nowISO()};current.sadaOrderReservations=map;current.updatedAt=nowISO();
          return {write:true,value:current,result:{marked:true}};
        },10000,8)}catch(e){console.warn('order reservation reconciliation:',String(e.message||e).slice(0,140))}
      }
      if(chargeIqd>0 && !isAdminSession){
        if(!localId||localId.length>100)return {walletUnavailable:true,error:'رقم تتبع الطلب مطلوب لإجراء حجز آمن'};
        let tx;try{tx=await firebaseTransaction(walletUserPath||('users/'+firebaseSafeKey(username)),current=>{
          if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-record-not-found'}};
          const map=current.sadaOrderReservations&&typeof current.sadaOrderReservations==='object'?{...current.sadaOrderReservations}:{};
          if(map[reservationId])return {write:false,result:{duplicateReservation:true,state:String(map[reservationId].state||'reserved')}};
          const bal=Number(current.balance||0);if(!Number.isFinite(bal)||bal<chargeIqd)return {write:false,result:{insufficient:true,balanceIQD:Math.max(0,Number.isFinite(bal)?bal:0)}};
          before=bal;after=Number((bal-chargeIqd).toFixed(4));current.balance=after;
          map[reservationId]={localId,amountIQD:chargeIqd,state:'reserved',createdAt:nowISO(),providerId,siteServiceId,providerServiceId};current.sadaOrderReservations=map;current.updatedAt=nowISO();
          return {write:true,value:current,result:{reserved:true,beforeIQD:before,afterIQD:after}};
        },10000,8)}catch(e){return {walletUnavailable:true,error:'تعذر حجز الرصيد بأمان في قاعدة البيانات: '+String(e.message||e).slice(0,100)}}
        if(tx.result?.error)return {walletUnavailable:true,error:'لم يتم العثور على سجل رصيد موثوق للمستخدم في Firebase'};
        if(tx.result?.insufficient)return {insufficient:true,balanceUsd:Number((Number(tx.result.balanceIQD||0)/FIXED_RATE).toFixed(6))};
        if(tx.result?.duplicateReservation)return {duplicateReservation:true,state:tx.result.state};
        reserved=!!tx.result?.reserved;before=Number(tx.result?.beforeIQD||0);after=Number(tx.result?.afterIQD||0);
        if(!reserved)return {walletUnavailable:true,error:'تعذر تأكيد حجز الرصيد؛ لم يتم إرسال الطلب إلى المزود'};
        appendJsonLedger('balance_ledger.json',{user:username,type:'order_reservation',amountUSD:Number((chargeIqd/FIXED_RATE).toFixed(6)),amountIQD:chargeIqd,beforeIQD:before,afterIQD:after,reason:'حجز رصيد قبل إرسال الطلب إلى المزود',admin:'system',reference:localId,createdAt:nowISO()});
      }
      try{
        const d=await providerRequest(prov,{action:'add',service:providerServiceId,link,quantity});
        const providerOrderId=normalizeProviderOrderId(d);
        if(!providerOrderId){if(freeUsageClaim)await finalizeAdminFreeServiceUsage(username,String(svc.adminFreeServiceKey||svc.fbKey||siteServiceId),localId,'uncertain',walletUserPath);await markReservation('uncertain');appendJsonLedger('provider_failures.json',{stage:'provider_response',uncertain:true,user:username,providerId,siteServiceId,providerServiceId,localId,link,quantity,error:'المزود لم يرجع رقم طلب واضح',providerResponse:safeProviderResponse(d),createdAt:nowISO()});return {error:'المزود لم يرجع رقم طلب واضح بعد عملية الإرسال؛ تم تعليق الحجز لحين المراجعة لتجنب تكرار الطلب',uncertain:true};}
        const createdAt=nowISO(); const siteOrderId=String(localId||('EXT_'+Date.now()));const publicOrderNo=await nextPublicOrderNumber(siteOrderId);
        const providerTrackingToken=issueProviderOrderTrackingToken({username,providerId,providerOrderId,siteOrderId});
        const platformFields=canonicalServicePlatform(svc);
        const nonPlatformImage=value=>{const x=String(value||'').trim();return x&&!/\/platform-icons\//i.test(x)&&!/^(?:instagram|tiktok|facebook|youtube|telegram|twitter|snapchat|whatsapp|linkedin|other)\.svg$/i.test(x)&&x!==platformFields.image?x:''};
        const groups=Array.isArray(svc.groups)?svc.groups:(Array.isArray(svc.categories)?svc.categories:[svc.category].filter(Boolean));
        const categoryRoot=readJSON('category_meta.json',{});let categoryMeta={};
        for(const group of groups){const match=Object.entries(categoryRoot&&typeof categoryRoot==='object'?categoryRoot:{}).find(([key,v])=>String(v?.name||'')===String(group)||String(key)===String(group));if(match){categoryMeta=match[1]||{};if(nonPlatformImage(categoryMeta.image))break;}}
        const orderServiceImage=nonPlatformImage(svc.serviceImage)||nonPlatformImage(svc.customImage)||nonPlatformImage(svc.imageUrl)||nonPlatformImage(svc.image);
        const orderCategoryImage=nonPlatformImage(categoryMeta.image)||nonPlatformImage(svc.customCategoryImage)||nonPlatformImage(svc.categoryImage)||nonPlatformImage(svc.sectionImage)||nonPlatformImage(svc.groupImage);
        const orderImage=orderServiceImage||orderCategoryImage||platformFields.image;
        const memberProfile=verifiedUser?.user||localUser||{};const ord={id:siteOrderId,localId:siteOrderId,publicOrderNo,user:username,userName:String(memberProfile.fullName||memberProfile.displayName||memberProfile.name||memberProfile.userName||memberProfile.username||username),memberId:String(memberProfile.id||memberProfile.userId||memberProfile.user_id||memberProfile.uid||memberProfile.firebaseUid||memberProfile.authUid||username),orderSource:'app',origin:'app',providerId,providerName:prov.name||providerId,providerOrderId,serviceId:siteServiceId,siteServiceId,providerServiceId,serviceName:String(svc.name||'خدمة'),serviceApp:platformFields.serviceApp,image:orderImage,serviceImage:orderServiceImage||orderImage,categoryImage:orderCategoryImage||'',platformIcon:platformFields.platformIcon,category:String(groups[0]||svc.category||''),link,quantity,unitSellingUsd:serviceRate,discountPct:userDiscount,chargeUsd,sellingPriceUsd:chargeUsd,providerRateUsd,providerCostUsd,providerCostIQD:Number((providerCostUsd*FIXED_RATE).toFixed(4)),grossProfitUsd,grossProfitIQD:Number((grossProfitUsd*FIXED_RATE).toFixed(4)),markupPct:Number.isFinite(Number(svc.markupPct))?Number(svc.markupPct):100,actualMarkupPct,profitMarginPct,total:chargeIqd,status:'pending',billingMode:isAdminSession?'admin-test':'user',free:!!svc.free||chargeUsd<=0,serviceKind:isAdminFreeService?'admin_funded_free':'provider_catalog',adminFreeService:!!isAdminFreeService,adminFreeServiceKey:isAdminFreeService?String(svc.adminFreeServiceKey||svc.fbKey||''):'',providerRaw:safeProviderResponse(d),createdAt}; appendJsonLedger('orders.json',ord);
        try{await persistOrderToFirebase(ord);}catch(saveError){if(freeUsageClaim)await finalizeAdminFreeServiceUsage(username,String(svc.adminFreeServiceKey||svc.fbKey||siteServiceId),localId,'uncertain',walletUserPath);await markReservation('uncertain');appendJsonLedger('provider_failures.json',{stage:'firebase_order_persist',uncertain:true,user:username,providerId,siteServiceId,providerServiceId,localId,providerOrderId,error:String(saveError.message||saveError).slice(0,180),createdAt:nowISO()});return {error:'أنشأ المزود الطلب، لكن تعذر تأكيد حفظه في Firebase. لا تعِد إرسال طلب جديد؛ رقم طلب المزود: '+providerOrderId,uncertain:true};}
        await markReservation('complete');
        if(isAdminFreeService&&!isAdminSession){try{await finalizeProviderOrderAccounting(username,localId,0,createdAt)}catch(e){console.warn('admin-funded free order accounting:',String(e.message||e).slice(0,100));}}
        if(freeUsageClaim)await finalizeAdminFreeServiceUsage(username,String(svc.adminFreeServiceKey||svc.fbKey||siteServiceId),localId,'accepted',walletUserPath);
        return {ok:true,order:ord,providerTrackingToken};
      }catch(e){
        const rejected=!!e.providerRejected; const authFail=providerAuthErrorText(e.message);
        if(freeUsageClaim)await finalizeAdminFreeServiceUsage(username,String(svc.adminFreeServiceKey||svc.fbKey||siteServiceId),localId,rejected?'rejected':'uncertain',walletUserPath);
        if(reserved&&rejected){
          try{const refundTx=await firebaseTransaction(walletUserPath||('users/'+firebaseSafeKey(username)),current=>{if(!current||typeof current!=='object'||Array.isArray(current))return {write:false,result:{error:'user-record-not-found'}};const map=current.sadaOrderReservations&&typeof current.sadaOrderReservations==='object'?{...current.sadaOrderReservations}:{};const rec=map[reservationId];if(!rec)return {write:false,result:{alreadyReleased:true}};const amount=Math.max(0,Number(rec.amountIQD||chargeIqd)),bal=Number(current.balance||0);current.balance=Number((bal+amount).toFixed(4));delete map[reservationId];current.sadaOrderReservations=map;current.updatedAt=nowISO();return {write:true,value:current,result:{released:true,beforeIQD:bal,afterIQD:current.balance,amountIQD:amount}}},10000,8);if(refundTx.result?.released)appendJsonLedger('balance_ledger.json',{user:username,type:'refund',amountUSD:Number((Number(refundTx.result.amountIQD||chargeIqd)/FIXED_RATE).toFixed(6)),amountIQD:Number(refundTx.result.amountIQD||chargeIqd),beforeIQD:refundTx.result.beforeIQD,afterIQD:refundTx.result.afterIQD,reason:'استرداد حجز بعد رفض المزود للطلب بشكل مؤكد',admin:'system-provider-rejection',reference:localId,createdAt:nowISO()});}catch(refundError){console.error('Failed to release rejected provider reservation:',String(refundError.message||refundError).slice(0,160))}
        }else if(reserved){await markReservation('uncertain')}
        appendJsonLedger('provider_failures.json',{stage:'website_provider_add',uncertain:!rejected,authFailure:authFail,user:username,providerId,siteServiceId,providerServiceId,localId,link,quantity,providerHttpStatus:Number(e.httpStatus||0)||null,providerErrorCode:String(e.providerErrorCode||'').slice(0,60),providerDiagnostic:String(e.providerDiagnostic||'').slice(0,180),error:String(e.message||e).slice(0,240),createdAt:nowISO()}); return {error:authFail?'مفتاح API للمزود مرفوض أو منتهي':String(e.message||e),uncertain:!rejected,authFailure:authFail,stage:'provider_add',providerHttpStatus:Number(e.httpStatus||0)||null,providerErrorCode:String(e.providerErrorCode||'').slice(0,60),providerDiagnostic:String(e.providerDiagnostic||'').slice(0,180)};
      }
    });
    if(result?.freeLimitReached)return json(res,429,{ok:false,error:result.error||'وصلت إلى الحد المشترك لجميع الخدمات المجانية: طلبان لكل حساب خلال 24 ساعة.',stage:'free_service_limit',limit:result.limit,nextAllowedAt:result.nextAllowedAt||null});
    if(result?.freeUsageUnavailable)return json(res,503,{ok:false,error:result.error||'تعذر تأكيد حد الخدمة المجانية في Firebase؛ لم يُرسل طلب للمزود.',stage:'free_service_usage'});
    if(result?.freeRequestDuplicate)return json(res,409,{ok:false,error:result.error||'يوجد طلب مجاني سابق قيد التحقق؛ لم يتم إرسال طلب مكرر.',stage:'free_service_duplicate',uncertain:true});
    if(result?.insufficient)return json(res,402,{ok:false,error:'رصيد المستخدم غير كافٍ',balanceUsd:result.balanceUsd});
    if(result?.walletUnavailable)return json(res,503,{ok:false,error:result.error||'تعذر حجز الرصيد بأمان؛ لم يتم إرسال الطلب'});
    if(result?.duplicateReservation)return json(res,409,{ok:false,error:'يوجد حجز سابق لهذا الطلب قيد التحقق؛ لم نرسل طلباً مكرراً.',uncertain:true,state:result.state});
    if(result?.error)return json(res,502,{ok:false,error:result.error,stage:result.stage||'provider_add',providerHttpStatus:result.providerHttpStatus||null,providerErrorCode:result.providerErrorCode||'',providerDiagnostic:result.providerDiagnostic||'',uncertain:!!result.uncertain,authFailure:!!result.authFailure,siteServiceId,providerServiceId});
    if(result?.ok){const siteId=String(result.order.id||localId||'');createUserNotification(username,{type:'order_created',orderId:siteId,status:'pending',title:'تم استلام طلبك #'+siteId,message:'تم استلام طلب '+siteId+' لخدمة '+String(result.order.serviceName||'خدمة')+'، وسيتم تحديث حالته هنا.',meta:{serviceName:String(result.order.serviceName||'خدمة'),quantity:Number(result.order.quantity||0),providerName:String(result.order.providerName||''),providerOrderId:String(result.order.providerOrderId||'')}});notifyTelegramNewOrder(result.order,{source:'backend'}).catch(()=>{});return json(res,200,{ok:true,siteOrderId:siteId,publicOrderNo:String(result.order.publicOrderNo||''),siteServiceId:String(result.order.siteServiceId||siteServiceId),serviceId:String(result.order.siteServiceId||siteServiceId),providerServiceId:String(result.order.providerServiceId||providerServiceId),providerId,providerName:prov.name||providerId,providerOrderId:String(result.order.providerOrderId),providerTrackingToken:String(result.providerTrackingToken||''),providerRaw:result.order.providerRaw,providerBalanceBefore:null,chargeUsd,totalIQD:chargeIqd,discountPct:userDiscount,createdAt:result.order.createdAt});}
    return json(res,500,{ok:false,error:'تعذر إنشاء الطلب'});
  }

  if(p==='/api/order/status' && req.method==='POST'){
    const wait=rateLimit(req,'order'); if(wait)return json(res,429,{ok:false,error:'طلبات كثيرة، أعد المحاولة بعد قليل'},{'Retry-After':String(wait)});
    const username=userFromSession(req); if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول من جديد'});
    const b=await bodyJSON(req); const providerIdInput=String(b.providerId||'').trim(); const providerOrderIdInput=String(b.providerOrderId||'').trim(); const siteOrderId=String(b.siteOrderId||b.orderId||'').trim();
    if(!providerIdInput||!providerOrderIdInput)return json(res,422,{ok:false,error:'بيانات التحقق ناقصة'});
    const rows=readJSON('orders.json',[]);
    const ownedBySite=siteOrderId?rows.find(x=>String(x.user||'')===username&&String(x.providerId||'')===providerIdInput&&[String(x.id||''),String(x.localId||'')].includes(siteOrderId)&&String(x.providerOrderId||'')):null;
    const ownedByProvider=rows.find(x=>String(x.user||'')===username&&String(x.providerId||'')===providerIdInput&&String(x.providerOrderId||'')===providerOrderIdInput);
    const ticket=verifyProviderOrderTrackingToken(b.providerTrackingToken,{username,providerId:providerIdInput,providerOrderId:providerOrderIdInput,siteOrderId});
    const ledgerOrder=ownedBySite||ownedByProvider;
    if(!ticket&&!ledgerOrder)return json(res,403,{ok:false,error:'تعذر إثبات ملكية الطلب من سجل الخادم. حدّث الصفحة أو أرسل رقم طلب الموقع للدعم إذا كان الطلب قديماً.'});
    const providerId=String(ticket?.providerId||ledgerOrder?.providerId||providerIdInput);
    const providerOrderId=String(ticket?.providerOrderId||ledgerOrder?.providerOrderId||providerOrderIdInput);
    const effectiveSiteOrderId=String(ticket?.siteOrderId||ledgerOrder?.id||ledgerOrder?.localId||siteOrderId||'');
    await ensureProviderRuntime(providerId); const {prov}=getProviderById(providerId); if(!prov)return json(res,404,{ok:false,error:'المزود المرتبط بالطلب غير موجود'});
    try{
      const d=await providerRequest(prov,{action:'status',order:providerOrderId});
      const normalized=normalizeProviderStatus(d.status||''); const checkedAt=nowISO();
      const idx=rows.findIndex(x=>String(x.user||'')===username&&String(x.providerId||'')===providerId&&String(x.providerOrderId||'')===providerOrderId);
      let resolvedSiteOrderId=effectiveSiteOrderId;
      if(idx>=0){const ord=rows[idx];const oldStatus=normalizeProviderStatus(ord.status||'pending');resolvedSiteOrderId=String(ord.id||effectiveSiteOrderId);ord.providerStatus=String(d.status||'');if(normalized!=='unknown')ord.status=normalized;ord.remains=d.remains;ord.startCount=d.start_count??d.startCount;ord.providerCharge=d.charge;ord.providerCurrency=d.currency||'USD';ord.lastCheckedAt=checkedAt;ord.providerRaw=safeProviderResponse(d);rows[idx]=ord;writeJSON('orders.json',rows);if(['cancelled','partial'].includes(normalized))await applyVerifiedOrderRefund(ord,d,normalized);if(oldStatus!==normalizeProviderStatus(ord.status||oldStatus))notifyOrderStatusChange(ord,oldStatus,normalizeProviderStatus(ord.status||oldStatus)).catch(()=>{});}
      return json(res,200,{ok:true,siteOrderId:resolvedSiteOrderId,providerId,providerOrderId,status:String(d.status||''),normalizedStatus:normalized,remains:d.remains,startCount:d.start_count??d.startCount,charge:d.charge,currency:d.currency||'USD',raw:d,checkedAt});
    }catch(e){return json(res,502,{ok:false,error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':e.message});}
  }
  if(p==='/api/order/cancel' && req.method==='POST'){
    const wait=rateLimit(req,'order');if(wait)return json(res,429,{ok:false,error:'طلبات كثيرة، أعد المحاولة بعد قليل'},{'Retry-After':String(wait)});
    const username=userFromSession(req);if(!username)return json(res,401,{ok:false,error:'يجب تسجيل الدخول من جديد'});
    const b=await bodyJSON(req);const providerId=String(b.providerId||'').trim();const providerOrderId=String(b.providerOrderId||'').trim();if(!providerId||!providerOrderId)return json(res,422,{ok:false,error:'بيانات الإلغاء ناقصة'});
    if(!ownedProviderOrder(username,providerId,providerOrderId))return json(res,403,{ok:false,error:'هذا الطلب لا يتبع حسابك'});
    await ensureProviderRuntime(providerId);const {prov}=getProviderById(providerId);if(!prov)return json(res,404,{ok:false,error:'المزود غير موجود'});
    try{
      const cancelResp=await providerRequest(prov,{action:'cancel',orders:providerOrderId});
      if(!providerActionSucceeded('cancel',cancelResp,providerOrderId))return json(res,502,{ok:false,error:'المزود لم يؤكد طلب الإلغاء؛ لم يتغير الرصيد.',providerRaw:safeProviderResponse(cancelResp)});
      const rows=readJSON('orders.json',[]);const idx=rows.findIndex(x=>!x.event&&String(x.user||'')===username&&String(x.providerId||'')===providerId&&String(x.providerOrderId||'')===providerOrderId);if(idx<0)return json(res,403,{ok:false,error:'لا يوجد سجل طلب موثوق لهذا المستخدم في خادم الموقع؛ لم نغير الحالة أو الرصيد.'});
      const ord=rows[idx];let statusResp=null,norm='unknown';try{statusResp=await providerRequest(prov,{action:'status',order:providerOrderId});norm=normalizeProviderStatus(statusResp?.status??statusResp?.data?.status??'');}catch(_){}
      if(!['cancelled','partial'].includes(norm)){
        const event={event:'cancel-request',user:username,providerId,providerOrderId,status:'cancel_requested',providerRaw:safeProviderResponse(cancelResp),createdAt:nowISO()};appendJsonLedger('orders.json',event);
        return json(res,202,{ok:true,pending:true,providerOrderId,status:ord.status||'pending',message:'المزود قبل طلب الإلغاء لكن لم يؤكد الحالة النهائية بعد؛ لم يُضف أي رصيد إلى المحفظة.',providerStatus:statusResp?.status||''});
      }
      const old=normalizeProviderStatus(ord.status||'pending');ord.providerStatus=String(statusResp.status||'');ord.status=norm;ord.providerRaw=safeProviderResponse(statusResp);ord.remains=statusResp.remains??ord.remains;ord.lastCheckedAt=nowISO();ord.cancelledAt=norm==='cancelled'?nowISO():ord.cancelledAt;rows[idx]=ord;writeJSON('orders.json',rows);
      const refund=await applyVerifiedOrderRefund(ord,statusResp,norm);notifyOrderStatusChange(ord,old,norm).catch(()=>{});
      return json(res,200,{ok:true,providerOrderId,status:norm,providerStatus:ord.providerStatus,refund,updatedAt:ord.lastCheckedAt,message:refund?.credited?'تم تأكيد الحالة وإرجاع المبلغ المستحق إلى المحفظة.':refund?.state==='pending'?'تم تحديث الحالة، لكن تعذر تأكيد مبلغ الاسترداد أو حفظه؛ لم يُضاف الرصيد.':'تم تأكيد الحالة، ولا يوجد مبلغ إضافي مستحق للاسترداد.'});
    }catch(e){return json(res,502,{ok:false,error:e.name==='AbortError'?'انتهت مهلة الاتصال بالمزود':String(e.message||e)});}
  }
  if(p==='/api/logout'){
    const id=sid(req),activeSession=session(req);let asiacellSession='none',protectedTransfer=false;
    if(activeSession&&id){
      const key=sha256(String(activeSession.sessionId||id));
      try{
        const current=await loadAsiacellSession(key);
        if(current&&isAsiacellSafetyCritical(current)){
          protectedTransfer=true;
          const indexed=await writeAsiacellPendingPointer(activeSession.username,key,current);
          asiacellSession=indexed?'preserved_for_safety':'preserved_pointer_warning';
        }else if(current){asiacellSession=await deleteAsiacellSession(key)?'reset':'reset_pending';}
        else asiacellSession='reset';
      }catch(e){asiacellSession='reset_pending';}
    }
    if(id) sessions.delete(id);res.setHeader('Set-Cookie',`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);return json(res,200,{ok:true,asiacellSession,protectedTransfer});
  }

  if(p==='/api/admin/order-user-info' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const username=String(urlObj.searchParams.get('username')||'').trim();if(!username)return json(res,422,{ok:false,error:'اسم المستخدم مطلوب'});
    let user=null,userSource='not-found',firebaseUserPath='';
    for(const pathName of ['users/'+firebaseSafeKey(username),'users/'+username]){try{const candidate=await firebaseGetJson(pathName,5000);if(candidate&&typeof candidate==='object'&&!Array.isArray(candidate)){user=candidate;userSource='firebase';firebaseUserPath=pathName;break;}}catch(_) {}}
    if(!user){try{const people=await firebaseGetQueryJson('users',{orderBy:'\"username\"',equalTo:JSON.stringify(username),limitToLast:5},6000);const match=collectionEntries(people).find(([,u])=>u&&typeof u==='object'&&String(u.username||u.userName||u.user||'').toLowerCase()===username.toLowerCase());if(match){user=match[1];userSource='firebase-indexed';firebaseUserPath='users/'+match[0];}}catch(_) {}}
    const localUsers=readJSON('users.json',{users:{}}).users||{};if(!user){const match=Object.entries(localUsers).find(([k,u])=>k.toLowerCase()===username.toLowerCase()||String(u?.username||u?.userName||u?.user||'').toLowerCase()===username.toLowerCase());if(match){user=match[1];userSource='server-cache';}}
    // Count this user's orders using Firebase's existing indexed user field, not the complete orders root.
    let remoteOrders=null,ordersError='';try{remoteOrders=await firebaseGetQueryJson('orders',{orderBy:'\"user\"',equalTo:JSON.stringify(username)},10000);}catch(e){ordersError=String(e.message||e).slice(0,160);}
    const localOrders=readJSON('orders.json',[]),orderIds=new Set();
    for(const [key,o] of collectionEntries(remoteOrders)){if(!o||typeof o!=='object')continue;if(String(o.user||o.username||'').toLowerCase()!==username.toLowerCase())continue;orderIds.add(String(o.id||o.siteOrderId||o.orderId||key));}
    if(Array.isArray(localOrders))for(const o of localOrders){if(!o||typeof o!=='object'||String(o.user||o.username||'').toLowerCase()!==username.toLowerCase())continue;orderIds.add(String(o.id||o.siteOrderId||o.orderId||''));}
    const actualCount=orderIds.size,counter=Number(user?.totalOrders??user?.ordersCount??user?.orderCount??0)||0;
    const profile={username:String(user?.username||user?.userName||user?.user||username),name:String(user?.name||user?.fullName||user?.displayName||user?.realName||''),email:String(firebaseRecordEmail(user||{})||''),phone:String(user?.phone||user?.phoneNumber||user?.mobile||''),balance:Number(user?.balance??user?.balanceIQD??0)||0,role:String(user?.role||'user'),discountPct:Number(user?.discountPct??user?.discount??0)||0,customDiscount:user?.customDiscount??null,totalSpent:Number(user?.totalSpent??user?.totalSpentIQD??0)||0,totalOrders:Math.max(actualCount,counter),ordersCountFromQuery:actualCount,totalOrdersCounter:counter,joined:String(user?.joined||user?.createdAt||user?.registeredAt||''),lastLoginAt:String(user?.lastLoginAt||user?.lastLogin||''),isDisabled:user?.isDisabled===true||user?.disabled===true,freePoints:Number(user?.freePoints??user?.free_points??0)||0,source:userSource};
    return json(res,200,{ok:true,user:profile,ordersCountAccurate:!ordersError,ordersCountWarning:ordersError||undefined,ordersCountSource:ordersError?'user-counter-and-server-ledger':'indexed-user-orders',firebaseUserPath:firebaseUserPath||undefined});
  }
  if(p==='/api/admin/orders' && req.method==='GET'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const rawQ=String(urlObj.searchParams.get('q')||'').trim(),q=rawQ.toLowerCase();
    const st=String(urlObj.searchParams.get('status')||'').trim().toLowerCase();
    const merged=new Map();const keyOf=o=>String(o?.legacyHistory?'legacy:'+o.legacyImportKey:(o?.id||o?.siteOrderId||o?.orderId||o?.order_id||o?.providerOrderId||o?.smmpartyOrderId||o?.createdAt||''))+'|'+String(o?.user||o?.username||'');
    const add=(o,key,source)=>{if(!o||typeof o!=='object'||Array.isArray(o)||o.event)return;const id=keyOf(o),prior=merged.get(id)||{};merged.set(id,{...prior,...o,source:o.legacyHistory?'legacy':source||prior.source||'firebase',_k:String(key||o._k||''),readOnly:!!o.legacyHistory});};
    const localOrders=readJSON('orders.json',[]);for(const o of Array.isArray(localOrders)?localOrders:[])add(o,String(o.id||''),'server');
    let firebaseAvailable=true,firebaseWarning='',searchMode='recent';
    try{
      if(!rawQ){
        const recent=await firebaseGetQueryJson('orders',{orderBy:'\"$key\"',limitToLast:500},12000);for(const [k,o] of collectionEntries(recent))add(o,k,'firebase');searchMode='recent-500';
      }else{
        const hits=[];const qLooksNumeric=/^\d{1,16}$/.test(rawQ);
        if(qLooksNumeric){try{const direct=await firebaseGetJson('orders/'+firebaseSafeKey(rawQ),4500);if(direct&&typeof direct==='object'&&String(direct.id||direct.siteOrderId||direct.publicOrderNo||'')===rawQ)hits.push([firebaseSafeKey(rawQ),direct]);}catch(_){}try{const byId=await firebaseGetQueryJson('orders',{orderBy:'\"id\"',equalTo:JSON.stringify(rawQ),limitToLast:100},7000);hits.push(...collectionEntries(byId));}catch(_){}try{const byIdNum=await firebaseGetQueryJson('orders',{orderBy:'\"id\"',equalTo:String(Number(rawQ)),limitToLast:100},7000);hits.push(...collectionEntries(byIdNum));}catch(_){}searchMode='indexed-order-number';}
        else{
          try{const byUser=await firebaseGetQueryJson('orders',{orderBy:'\"user\"',equalTo:JSON.stringify(rawQ),limitToLast:500},9000);hits.push(...collectionEntries(byUser));}catch(e){firebaseWarning=String(e.message||e).slice(0,140);}searchMode='indexed-username';
        }
        for(const [k,o] of hits)add(o,k,'firebase');
        // If indexed search did not match (e.g. free-text service/link search), only inspect the latest bounded window.
        if(!hits.length){const recent=await firebaseGetQueryJson('orders',{orderBy:'\"$key\"',limitToLast:500},10000);for(const [k,o] of collectionEntries(recent))add(o,k,'firebase');searchMode=qLooksNumeric?'order-number-not-found-in-index':'recent-500-fallback';}
      }
    }catch(e){firebaseAvailable=false;firebaseWarning=String(e.message||e).slice(0,160);}
    // This list endpoint deliberately does not load the whole users node; email/profile fields are loaded per-user on demand.
    const rows=[...merged.values()].map(o=>({...o,email:String(o.email||o.userEmail||o.memberEmail||'')})).filter(o=>{const hay=[o.id,o.publicOrderNo,o.publicOrderNumber,o.siteOrderId,o.user,o.username,o.userName,o.name,o.email,o.link,o.serviceName,o.providerOrderId,o.legacyOrderId,o.legacyOrderNumber].map(v=>String(v||'').toLowerCase()).join(' ');const rawStatus=String(o.providerStatus||o.smmStatus||o.status||'pending').trim().toLowerCase().replace(/[\s_-]+/g,' ');const norm=(rawStatus==='in progress'||rawStatus==='inprogress')?'in progress':normalizeProviderStatus(rawStatus);const wanted=(st==='in progress'||st==='in_progress')?'in progress':normalizeProviderStatus(st);return (!q||hay.includes(q))&&(!st||st==='all'||norm===wanted);}).sort((a,b)=>(Date.parse(b.createdAt||0)||0)-(Date.parse(a.createdAt||0)||0)).slice(0,500);
    return json(res,200,{ok:true,orders:rows,firebaseAvailable,warning:firebaseWarning||undefined,searchMode,limit:500,readOnlyLegacyCount:rows.filter(x=>x.legacyHistory).length});
  }
  if(p==='/api/admin/order-status' && req.method==='POST'){
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req); const siteId=String(b.orderId||'').trim();
    if(!siteId) return json(res,422,{ok:false,error:'رقم طلب الموقع مطلوب'});
    const rows=readJSON('orders.json',[]); const idx=rows.findIndex(o=>String(o.id||'')===siteId);
    if(idx<0) return json(res,404,{ok:false,error:'طلب الموقع غير موجود'});
    const order=rows[idx]; if(!order.providerId||!order.providerOrderId) return json(res,409,{ok:false,error:'هذا الطلب لا يملك طلباً مرتبطاً بالمزود'});
    await ensureProviderRuntime(order.providerId); const {prov}=getProviderById(order.providerId); if(!prov)return json(res,404,{ok:false,error:'المزود غير موجود'});
    try{
      const d=await providerRequest(prov,{action:'status',order:String(order.providerOrderId)});
      const oldStatus=normalizeProviderStatus(order.status||'pending'); const newStatus=normalizeProviderStatus(d.status||order.status||'pending');
      order.providerStatus=String(d.status||''); order.status=newStatus==='unknown'?(order.status||'pending'):newStatus;
      order.remains=d.remains; order.startCount=d.start_count??d.startCount; order.lastCheckedAt=nowISO(); order.providerRaw=safeProviderResponse(d);
      rows[idx]=order; writeJSON('orders.json',rows); if(['cancelled','partial'].includes(order.status))await applyVerifiedOrderRefund(order,d,order.status); notifyOrderStatusChange(order,oldStatus,order.status).catch(()=>{});
      return json(res,200,{ok:true,siteOrderId:siteId,providerOrderId:String(order.providerOrderId),status:order.status,providerStatus:order.providerStatus,remains:order.remains,startCount:order.startCount,checkedAt:order.lastCheckedAt});
    }catch(e){
      appendJsonLedger('provider_failures.json',{stage:'admin_order_status',siteOrderId:siteId,providerId:order.providerId,providerOrderId:order.providerOrderId,error:String(e.message||e),createdAt:nowISO()});
      return json(res,502,{ok:false,error:String(e.message||e)});
    }
  }

  if(p==='/api/admin/data-summary' && req.method==='GET'){
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const users=readJSON('users.json',{users:{}})?.users||{};
    const orders=readJSON('orders.json',[]); const payments=readJSON('payments.json',[]);
    return json(res,200,{ok:true,counts:{users:Object.keys(users).length,orders:Array.isArray(orders)?orders.length:0,payments:Array.isArray(payments)?payments.length:0}});
  }
  if(p==='/api/admin/cleanup' && req.method==='POST'){
    if(!isAdmin(req))return json(res,403,{ok:false,error:'غير مصرح'});
    const body=await bodyJSON(req,64*1024);
    if(body.confirmation!=='CLEAN_ALL_APP_DATA')return json(res,422,{ok:false,error:'يلزم تأكيد تنظيف قاعدة الموقع.'});
    const now=new Date().toISOString(),version=String(Date.now());
    const email=String(ADMIN_USER||'').trim().toLowerCase();
    const isAdminRecord=(key,row)=>{
      if(!row||typeof row!=='object'||Array.isArray(row))return false;
      const role=String(row.role||row.userRole||'').trim().toLowerCase();
      const identities=[row.username,row.userName,row.user,row.email,key].map(value=>String(value||'').trim().toLowerCase()).filter(Boolean);
      return role==='admin'||role==='owner'||row.isAdmin===true||!!email&&identities.includes(email);
    };
    let remoteUsers={},localUserStore=readJSON('users.json',{users:{}}),localUsers=localUserStore?.users&&typeof localUserStore.users==='object'&&!Array.isArray(localUserStore.users)?localUserStore.users:{};
    try{
      const remote=await firebaseGetJson('users',12000);
      for(const [key,row] of Object.entries(remote&&typeof remote==='object'&&!Array.isArray(remote)?remote:{}))if(isAdminRecord(key,row))remoteUsers[key]=row;
    }catch(e){return json(res,503,{ok:false,persisted:false,error:'تعذر قراءة حسابات Firebase؛ لم يبدأ التنظيف. '+String(e.message||e).slice(0,150)});}
    const remoteDeletes=[
      'orders','payments','chats','notifications','services','categoryMeta','providerServices',
      'asiacellTransfers','balanceLedger','discountLedger','userNotifications','userNotificationSeen',
      'earnRequests','earnRequestsByUser','apiRefills','apiKeys','apiKeyBlocks'
    ];
    const patch={};
    patch.users=Object.keys(remoteUsers).length?remoteUsers:null;
    for(const node of remoteDeletes)patch[node]=null;
    // Preserve all site/payment/provider settings while resetting only the order sequence and catalog state.
    patch['settings/orderCounter']=2999;
    patch['settings/catalogOrder']={categories:[],services:{}};
    patch['config/orderAuditState']=null;
    patch['settings/svcsVersion']=version;
    try{
      await persistFirebaseCatalogPatch(patch,{verify:true,atomic:true,timeoutMs:60000});
    }catch(e){
      return json(res,503,{ok:false,persisted:false,error:'رفض Firebase أو لم يؤكد التنظيف؛ لم تُصفّر ملفات الاستضافة. '+String(e.message||e).slice(0,180)});
    }
    try{
      const keptLocalUsers={};for(const [key,row] of Object.entries(localUsers))if(isAdminRecord(key,row))keptLocalUsers[key]=row;
      writeJSON('users.json',{...localUserStore,users:keptLocalUsers});
      writeJSON('orders.json',[]);writeJSON('payments.json',[]);writeJSON('chats.json',{});
      writeJSON('notifications.json',[]);writeJSON('telegram_notifications.json',[]);
      writeJSON('notification_seen.json',{});writeJSON('user_notifications.json',{});
      writeJSON('earn_requests.json',[]);writeJSON('api_refills.json',[]);writeJSON('api_keys.json',{});
      writeJSON('balance_ledger.json',[]);writeJSON('discount_ledger.json',[]);writeJSON('refunds.json',[]);
      writeJSON('google_accounts.json',{});writeJSON('email_challenges.json',{});writeJSON('free_service_usage.json',{});
      writeJSON('services.json',{});writeJSON('category_meta.json',{});writeJSON('provider_services.json',{});writeJSON('api_services.json',[]);
      const localSettings=readJSON('settings.json',{});writeJSON('settings.json',{...localSettings,orderCounter:2999,resetAt:now});
      writeJSON('catalog_settings.json',{catalogOrder:{categories:[],services:{}},catalogUpdatedAt:now,lastFullCleanupAt:now,firebaseSvcsVersion:version,firebaseCatalogLastVerifiedAt:now,firebaseCatalogLastVerifiedCounts:{services:0,sections:0}});
      writeJSON('stats_state.json',{resetAt:now});writeJSON('order_audit_state.json',{alerts:{},resetAt:now});
      SITE_SERVICE_IDS_DIRTY=true;ensureNumericSiteServiceIds();
      markCatalogSeeded();CATALOG_FIREBASE_READY=true;
      // Invalidate non-admin sessions on this instance without disturbing the current administrator.
      for(const [sessionId,sessionValue] of sessions)if(String(sessionValue?.role||'')!=='admin')sessions.delete(sessionId);
    }catch(e){
      return json(res,503,{ok:false,persisted:true,hostCacheCleared:false,error:'تم تنظيف Firebase والتحقق منه، لكن تعذر تنظيف بعض ملفات الاستضافة: '+String(e.message||e).slice(0,150)});
    }
    return json(res,200,{ok:true,verified:true,persisted:true,hostCacheCleared:true,preservedAdminAccounts:Object.keys(remoteUsers).length,deletedNodes:remoteDeletes,remainingOrders:0,remainingPayments:0,remainingServices:0,remainingSections:0,nextOrderNumber:3000,settingsPreserved:true,message:'تم تنظيف بيانات المستخدمين والطلبات والشحنات والمحادثات والإشعارات والكتالوج وسجلاتها. حُفظ حساب الإدارة وإعدادات الموقع والمزودين وطرق الدفع؛ الرقم التالي للطلب 3000.'});
  }

  if(p==='/api/admin/reset' && req.method==='POST'){
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const now=new Date().toISOString();
    writeJSON('users.json',{users:{}});
    writeJSON('orders.json',[]);
    writeJSON('payments.json',[]);
    writeJSON('settings.json',{...readJSON('settings.json',{}),orderCounter:0,resetAt:now});
    writeJSON('providers.json',readJSON('providers.json',{activeProvider:'',providers:{}}));
    return json(res,200,{ok:true,message:'تم تنظيف بيانات Railway والبدء من جديد'});
  }
  if(p==='/api/admin/user-balance' && req.method==='POST'){
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح'});
    const b=await bodyJSON(req); const username=String(b.username||'').trim(); const balance=Number(b.balance);
    if(!username||!Number.isFinite(balance)||balance<0)return json(res,422,{ok:false,error:'بيانات رصيد المستخدم غير صالحة'});
    const store=readJSON('users.json',{users:{}}); const user=store.users?.[username];
    if(!user)return json(res,404,{ok:false,error:'المستخدم غير موجود في قاعدة Railway'});
    user.balance=Number(balance); user.updatedAt=new Date().toISOString(); writeJSON('users.json',store);
    return json(res,200,{ok:true,username,balance:user.balance,updatedAt:user.updatedAt});
  }
  if(p==='/api/provider/secret' && req.method==='GET') {
    if(!isAdmin(req)) return json(res,403,{ok:false,error:'غير مصرح — جلسة الإدارة غير صالحة'});
    const id=String(urlObj.searchParams.get('provider')||'');
    await ensureProviderRuntime(id);
    const {pid,prov}=getProviderById(id,{allowSingleFallback:true});
    if(!prov?.key) return json(res,404,{ok:false,error:'المزود غير موجود أو مفتاحه غير محفوظ'});
    return json(res,200,{ok:true,providerId:pid,key:String(prov.key)});
  }
  if(p.startsWith('/api/providers/') && req.method==='DELETE'){
    if(!isAdmin(req)) return json(res,403,{error:'غير مصرح'});
    const pid=decodeURIComponent(p.slice('/api/providers/'.length)).trim();
    if(!pid) return json(res,400,{error:'معرف المزود مفقود'});
    const store=providerStore();
    const existed=!!store.providers[pid];
    const out={...(store.providers||{})};
    delete out[pid];
    const deletedIds=new Set(store.deletedProviderIds||[]);
    deletedIds.add(pid); // permanent tombstone: an update/restart must not resurrect this provider
    let active=String(store.activeProvider||'');
    if(active===pid) active=Object.keys(out)[0]||'';
    writeJSON('providers.runtime.json',{activeProvider:active,providers:out,deletedProviderIds:[...deletedIds],updatedAt:new Date().toISOString()});
    // Persist deletion independently of the code release and remove any Firebase copy.
    let firebaseSynced=true;
    try{
      await firebaseDeleteJson('config/smmProviders/'+firebaseSafeKey(pid));
      await firebaseDeleteJson('config/smmProviderSecrets/'+firebaseSafeKey(pid));
      await firebaseWriteJson('config/smmDeletedProviders/'+firebaseSafeKey(pid),true);
      const activeRemote=String(active||''); if(activeRemote) await firebaseWriteJson('config/smmActive',activeRemote);
    }catch(e){ firebaseSynced=false; console.warn('provider delete Firebase sync failed:',e?.message||e); }
    return json(res,200,{ok:true,deleted:pid,alreadyDeleted:!existed,activeProvider:active,count:Object.keys(out).length,firebaseSynced});
  }
  if(p==='/api/providers'){
    if(req.method!=='GET'&&req.method!=='POST') return json(res,405,{error:'Method not allowed'});
    if(!isAdmin(req)) return json(res,403,{error:'غير مصرح — جلسة الإدارة غير صالحة'});
    let store=providerStore();
    if(req.method==='GET'){
      // Hydrate remote metadata/secrets on each explicit list request, without clearing local data if Firebase is offline.
      await hydrateProviderRuntimeFromFirebase().catch(()=>{});
      store=providerStore();
      const safe={};
      for(const [id,v] of Object.entries(store.providers||{})) if(v?.url) safe[id]={id,name:v.name||id,url:v.url||'',hasKey:!!v.key};
      return json(res,200,{activeProvider:store.activeProvider||'',providers:safe,storageMode:DATA_IS_EXTERNAL?'external-directory':'release-local'});
    }
    const b=await bodyJSON(req); const list=Array.isArray(b.providers)?b.providers:[];
    await ensureProviderRuntime(''); store=providerStore();
    const incoming={};
    for(const item of list){
      if(!item||typeof item!=='object') continue;
      const rawId=String(item.id||item.providerId||'').trim(); const id=normalizeProviderId(rawId);
      if(!id) continue;
      let oldId=providerIdInStore(store,rawId)||providerIdInStore(store,id);
      let prev=oldId?store.providers[oldId]:{};
      const name=String(item.name||prev?.name||id).trim();
      let apiUrl=String(item.url||item.apiUrl||prev?.url||'').trim();
      // A list loaded from the admin UI intentionally contains hasKey, not the secret.
      // If a legacy/provider ID was renamed, preserve its saved secret only when exactly
      // one existing provider has the same normalized API URL.
      if(!oldId && apiUrl){
        let normalizedIncoming='';
        try{normalizedIncoming=normalizeProviderApiUrl(apiUrl).replace(/\/$/,'').toLowerCase();}catch(_){}
        if(normalizedIncoming){
          const matches=Object.entries(store.providers||{}).filter(([,v])=>{
            if(!v?.key||!v?.url)return false;
            try{return normalizeProviderApiUrl(v.url).replace(/\/$/,'').toLowerCase()===normalizedIncoming;}catch(_){return false;}
          });
          if(matches.length===1){oldId=matches[0][0];prev=matches[0][1]||{};}
        }
      }
      let key=usableProviderKey(item.key)||usableProviderKey(item.apiKey)||usableProviderKey(prev?.key)||usableProviderKey(store.envProvider?.id===id?store.envProvider.key:'');
      try{apiUrl=normalizeProviderApiUrl(apiUrl)}catch(_){ }
      const blockedDeleted=[...(store.deletedProviderIds||[])].some(x=>normalizeProviderId(x)===id);
      // A tombstoned provider may return only after an explicit Add/Save operation.
      const explicitRestore=b.restoreDeleted===true;
      if(blockedDeleted&&!explicitRestore) continue;
      if(name && /^https?:\/\//i.test(apiUrl) && key){
        incoming[id]={...(prev||{}),...item,id,name,url:apiUrl,key,source:'admin'};
      }
    }
    const confirmedReplace=b.mode==='replace'&&b.confirmReplace===true;
    const out=confirmedReplace?incoming:{...(store.providers||{}),...incoming};
    const unsavedRequested=list.filter(item=>{
      if(!item||typeof item!=='object')return false;
      const rawId=String(item.id||item.providerId||'').trim();const nid=normalizeProviderId(rawId);if(!nid)return false;
      const storedId=providerIdInStore({providers:out},rawId)||providerIdInStore({providers:out},nid);const prov=storedId?out[storedId]:out[nid];
      // If a provider is present in the admin form but neither its saved copy nor the request carries a usable key/URL,
      // don't silently return success: the next release would correctly have nothing to restore.
      return !(String(prov?.url||item.url||item.apiUrl||'').trim() && (usableProviderKey(prov?.key)||usableProviderKey(item.key)||usableProviderKey(item.apiKey)));
    });
    if(unsavedRequested.length){return json(res,409,{ok:false,error:'تعذر تثبيت بيانات بعض المزودين لأن مفتاح API أو الرابط غير محفوظ. أعد فتح المزود، أدخل المفتاح الصحيح، واحفظه حتى يتأكد التخزين الدائم.',unsaved:unsavedRequested.map(x=>String(x.name||x.id||x.providerId||'مزود'))});}
    const deletedIds=new Set(store.deletedProviderIds||[]);
    for(const id of Object.keys(incoming)) for(const oldId of [...deletedIds]) if(normalizeProviderId(oldId)===normalizeProviderId(id)) deletedIds.delete(oldId);
    let activeCandidate=String(b.activeProvider!==undefined?b.activeProvider:(store.activeProvider||''));
    let active=providerIdInStore({providers:out},activeCandidate);
    if(!active) active=Object.keys(out).find(id=>out[id]?.url&&out[id]?.key)||'';
    writeJSON('providers.runtime.json',{activeProvider:active,providers:out,deletedProviderIds:[...deletedIds],updatedAt:nowISO()});
    let firebaseSynced=true;
    try{
      for(const [id,v] of Object.entries(incoming)){
        const k=firebaseSafeKey(id);
        await firebaseDeleteJson('config/smmDeletedProviders/'+k);
        await firebaseWriteJson('config/smmProviders/'+k,{id,name:v.name,url:v.url,hasKey:true});
        await firebaseWriteJson('config/smmProviderSecrets/'+k,{id,key:v.key,name:v.name,url:v.url});
      }
      await firebaseWriteJson('config/smmActive',active);
    }catch(e){firebaseSynced=false;console.warn('provider save Firebase sync failed:',e?.message||e);}
    if(!firebaseSynced)return json(res,503,{ok:false,count:Object.keys(out).length,activeProvider:active,firebaseSynced:false,persistent:false,needsClientPersistence:true,error:'تم تحديث نسخة تشغيل مؤقتة فقط، لكن Firebase لم تؤكد حفظ بيانات المزودين. لا تعتبر العملية ناجحة؛ افحص إعدادات Firebase ثم أعد الحفظ.',received:list.length,saved:Object.keys(incoming).length});
    return json(res,200,{ok:true,count:Object.keys(out).length,activeProvider:active,firebaseSynced:true,persistent:true,storageMode:'firebase',needsClientPersistence:false,warning:'',received:list.length,saved:Object.keys(incoming).length});
  }
  if(p==='/api/smm') return apiSmm(req,res,urlObj);
  if(p==='/api/asiacell' && req.method==='POST') return apiAsiacell(req,res);
  if(p==='/api/health') {
    let uiVersion='', uiBuildId='', versionFile='', buildFile='';
    try { const html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8'); uiVersion=String(html.match(/<meta\s+name=["']sada-version["']\s+content=["']([^"']+)["']/i)?.[1]||''); uiBuildId=String(html.match(/<meta\s+name=["']sada-build-id["']\s+content=["']([^"']+)["']/i)?.[1]||''); } catch(_) {}
    try { versionFile=fs.readFileSync(path.join(ROOT,'version.txt'),'utf8').trim(); } catch(_) {}
    try { buildFile=fs.readFileSync(path.join(ROOT,'BUILD_ID.txt'),'utf8').trim(); } catch(_) {}
    const deploymentConsistent=uiVersion===APP_VERSION && uiBuildId===BUILD_ID && versionFile===APP_VERSION && buildFile===BUILD_ID;
    const dbInfo=firebaseDatabaseDiagnosticInfo();
    const health={ok:true,app:APP_NAME,version:APP_VERSION,buildId:BUILD_ID,uiVersion,uiBuildId,versionFile,buildFile,deploymentConsistent,dataStorageMode:DATA_IS_EXTERNAL?'external-directory':'release-local',firebaseUrlConfigured:!!FIREBASE_DATABASE_URL,firebaseDatabaseSource:FIREBASE_DATABASE_URL_SOURCE,firebaseServerAuthConfigured:firebaseAuthAvailable(),firebaseDatabaseDriver:firebaseAdminEnabled()?'admin-sdk':'rest-oauth',priceGuard:PRICE_GUARD_ENABLED,securityPatch:'1.6.88',providerCount:Object.keys(providerStore().providers||{}).length,time:new Date().toISOString(),node:process.version};
    // Keep operational configuration details private; only an authenticated admin can inspect them.
    if(isAdmin(req)){const credentialStatus=firebaseServiceAccountStatus();health.firebaseDatabase={host:dbInfo.host,source:dbInfo.source,databaseProjectHint:dbInfo.databaseProjectHint,serviceAccountProjectId:dbInfo.serviceAccountProjectId||null,configuredWebProjectId:dbInfo.configuredWebProjectId||null,serviceAccountProjectMatch:dbInfo.serviceAccountProjectMatch};health.securityConfig={sessionSecretConfigured:!!String(process.env.SESSION_SECRET||'').trim(),dedicatedEncryptionKeyConfigured:!!String(process.env.SADA_ENCRYPTION_KEY||'').trim(),stableEncryptionAvailable:telegramEncryptionReady(),firebaseConfigured:!!FIREBASE_DATABASE_URL,firebaseServiceAccountConfigured:credentialStatus.ok,firebaseCredentialStatus:{ok:credentialStatus.ok,code:credentialStatus.code,source:credentialStatus.source,message:credentialStatus.message},firebaseDatabaseSecretConfigured:!!String(process.env.FIREBASE_DATABASE_SECRET||'').trim(),firebaseAuthAvailable:firebaseAuthAvailable(),emailServiceConfigured:!!(String(process.env.RESEND_API_KEY||'').trim()&&String(process.env.RESEND_FROM_EMAIL||process.env.EMAIL_FROM||'').trim()),telegramTokenFromEnvironment:!!String(process.env.TELEGRAM_BOT_TOKEN||'').trim(),adminPasswordFromEnvironment:!!(String(process.env.ADMIN_PASSWORD||'').trim()||String(process.env.ADMIN_PASSWORD_HASH||'').trim()),adminPasswordConfigured:adminPasswordConfigured()};}
    return json(res,200,health);
  }
  return json(res,404,{error:'API endpoint not found'});
}

const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8'};
const STATIC_CACHE=new Map();
const STATIC_TEXT_EXTS=new Set(['.html','.js','.css','.svg','.json','.txt','.xml']);
function staticRecord(file,st,ext,callback){
  const key=file, cached=STATIC_CACHE.get(key);
  if(cached&&cached.mtimeMs===st.mtimeMs&&cached.size===st.size)return callback(null,cached);
  fs.readFile(file,(err,raw)=>{
    if(err)return callback(err);
    const etag='"'+crypto.createHash('sha1').update(raw).digest('hex')+'"';
    const record={mtimeMs:st.mtimeMs,size:st.size,etag,lastModified:st.mtime.toUTCString(),raw,br:null,gzip:null};
    if(STATIC_TEXT_EXTS.has(ext)&&raw.length>=512){
      try{record.br=zlib.brotliCompressSync(raw,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:4}})}catch(_){}
      try{record.gzip=zlib.gzipSync(raw,{level:6})}catch(_){}
    }
    STATIC_CACHE.set(key,record);
    // Keep the cache bounded for long-lived instances.
    while(STATIC_CACHE.size>80)STATIC_CACHE.delete(STATIC_CACHE.keys().next().value);
    callback(null,record);
  });
}
function serveStatic(req,res,urlObj){
  let p;try{p=decodeURIComponent(urlObj.pathname)}catch(_){return json(res,400,{error:'Invalid path'})} if(p==='/'||p==='') p='/index.html';
  if((p==='/'||p==='/index.html')&&urlObj.searchParams.get('admin')!=='1'&&session(req)?.role!=='admin'){
    const m=readJSON('settings.json',{}).maintenance||{};
    if(m.enabled===true){const escapeHtml=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const title=escapeHtml(m.title||'التطبيق متوقف مؤقتاً'),message=escapeHtml(m.message||'نعتذر عن الإزعاج، التطبيق تحت الصيانة المؤقتة.'),reason=escapeHtml(m.reason||''),image=String(m.imageUrl||'');const imageHtml=/^\/media\/maintenance\/[a-z0-9-]+\.(?:jpg|jpeg|png|webp)$/i.test(image)?'<img alt="" style="max-width:min(88vw,420px);max-height:34vh;object-fit:contain;border-radius:18px;margin:0 auto 20px" src="'+image+'">':'';const html='<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+title+'</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(ellipse at top,#171d43,#070918 70%);color:#f4f3ff;font-family:system-ui,sans-serif;padding:22px;box-sizing:border-box;text-align:center"><main style="max-width:560px;width:100%;padding:28px;border:1px solid #38336c;border-radius:24px;background:#10152ee8;box-sizing:border-box">'+imageHtml+'<div style="font-size:42px;margin-bottom:10px">🛠️</div><h1 style="font-size:clamp(23px,5vw,32px)">'+title+'</h1><p style="font-size:16px;line-height:2">'+message+'</p>'+(reason?'<p style="font-size:13px;line-height:1.8;color:#aaa9c9">السبب: '+reason+'</p>':'')+'<p style="font-size:11px;color:#8b8caf;margin-top:22px">سنعود للعمل بعد انتهاء الصيانة. شكراً لصبركم.</p><a href="/?admin=1" style="display:inline-block;margin-top:9px;color:#aaa0ff;font-size:11px;text-decoration:none">دخول الإدارة</a></main></body></html>';res.statusCode=200;res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Length',String(Buffer.byteLength(html)));return req.method==='HEAD'?res.end():res.end(html);}
  }
  const mediaMatch=p.match(/^\/media\/(push|maintenance|custom-shop)\/([a-z0-9-]+\.(?:jpg|jpeg|png|webp))$/i);
  if(mediaMatch){const mediaType=mediaMatch[1].toLowerCase(),folder=mediaType==='push'?'push-media':mediaType==='maintenance'?'maintenance-media':'custom-shop-media',file=mediaMatch[2],full=path.join(DATA,folder,file);return fs.readFile(full,(err,buf)=>{if(err)return json(res,404,{error:'Not found'});res.statusCode=200;res.setHeader('Content-Type',mediaTypeForImage(path.extname(file)));res.setHeader('Cache-Control','public, max-age=3600');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Length',String(buf.length));return req.method==='HEAD'?res.end():res.end(buf);});}
  const bundled=bundledAssetRecord(p);
  if(bundled){res.statusCode=200;res.setHeader('Content-Type',bundled.contentType);res.setHeader('Cache-Control','public, max-age=300, must-revalidate');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Length',String(bundled.buffer.length));res.setHeader('ETag','"'+crypto.createHash('sha1').update(bundled.buffer).digest('hex')+'"');return req.method==='HEAD'?res.end():res.end(bundled.buffer);}
  const baseName=path.posix.basename(p).toLowerCase();
  const blockedFiles=new Set(['server.js','package.json','package-lock.json','bundled-assets.json','config.json','admin-auth.json','authproviders.json','login.json','noauth.json','cookies.txt','firebase-service-account.json']);
  if(blockedFiles.has(baseName) || /^\/(?:data|tests|node_modules)(?:\/|$)/i.test(p) || /(?:^|\/)\.(?:env|git|npmrc)/i.test(p) || /(?:^|\/)(?:start_here|readme|release-smoke|api-runtime-smoke|asiacell-runtime-smoke|full-flow-audit)[^/]*$/i.test(p) || /(?:^|\/)(?:database\.rules\.json|railway\.json|nixpacks\.toml|dockerfile)$/i.test(p)) return json(res,403,{error:'Forbidden'});
  const file=path.resolve(ROOT,'.'+p);
  const relative=path.relative(ROOT,file);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)) return json(res,403,{error:'Forbidden'});
  fs.stat(file,(err,st)=>{
    if(err||!st.isFile()) return json(res,404,{error:'Not found'});
    const ext=path.extname(file).toLowerCase();
    staticRecord(file,st,ext,(readErr,record)=>{
      if(readErr)return json(res,404,{error:'Not found'});
      res.setHeader('Content-Type',MIME[ext]||'application/octet-stream');res.setHeader('Last-Modified',record.lastModified);res.setHeader('Vary','Accept-Encoding');
      // HTML revalidates on every visit so deployments appear immediately; assets can be reused briefly.
      res.setHeader('Cache-Control',ext==='.html'?'no-cache, must-revalidate, max-age=0':'public, max-age=300, must-revalidate');if(ext==='.html'){res.setHeader('Pragma','no-cache');res.setHeader('Expires','0');}
      let body=record.raw,encoding='';const ae=String(req.headers['accept-encoding']||'');
      if(record.br&&/(?:^|,\s*)br(?:\s*;q=(?!0(?:\.0*)?)[0-9.]+)?(?:,|$)/i.test(ae)){body=record.br;encoding='br';}
      else if(record.gzip&&/(?:^|,\s*)gzip(?:\s*;q=(?!0(?:\.0*)?)[0-9.]+)?(?:,|$)/i.test(ae)){body=record.gzip;encoding='gzip';}
      // Use representation-specific ETags for compressed vs. uncompressed bodies.
      const etagKey=encoding||'raw';record.etags=record.etags||{raw:record.etag};
      if(!record.etags[etagKey])record.etags[etagKey]='"'+crypto.createHash('sha1').update(body).digest('hex')+'"';
      const selectedEtag=record.etags[etagKey];res.setHeader('ETag',selectedEtag);
      const inm=String(req.headers['if-none-match']||'');const ims=String(req.headers['if-modified-since']||'');
      if(inm&&(inm.split(',').map(x=>x.trim()).includes(selectedEtag)||inm.trim()==='*')){res.statusCode=304;return res.end();}
      if(!inm&&ims&&Number.isFinite(Date.parse(ims))&&Math.floor(st.mtimeMs/1000)<=Math.floor(Date.parse(ims)/1000)){res.statusCode=304;return res.end();}
      if(encoding)res.setHeader('Content-Encoding',encoding);
      res.statusCode=200;res.setHeader('Content-Length',String(body.length));
      if(req.method==='HEAD')return res.end();
      res.end(body);
    });
  });
}

async function hydrateProviderRuntimeFromFirebase(){
  // Provider metadata and credentials were split into two Firebase paths by newer UI builds.
  // Merge both paths; never discard the local runtime store when Firebase is temporarily offline.
  const settled=await Promise.allSettled([
    firebaseGetJson('config/smmProviders',7000),
    firebaseGetJson('config/smmProviderSecrets',7000),
    firebaseGetJson('config/smmDeletedProviders',7000),
    firebaseGetJson('config/smmActive',7000)
  ]);
  const take=i=>settled[i]?.status==='fulfilled'?settled[i].value:null;
  const remote=take(0), secrets=take(1), deleted=take(2), remoteActive=take(3);
  const old=readJSON('providers.runtime.json',{activeProvider:'',providers:{},deletedProviderIds:[]});
  const legacy=readJSON('providers.json',{activeProvider:'',providers:{},deletedProviderIds:[]});
  const deletedSet=new Set([
    ...(Array.isArray(old?.deletedProviderIds)?old.deletedProviderIds:[]).map(String),
    ...(Array.isArray(legacy?.deletedProviderIds)?legacy.deletedProviderIds:[]).map(String),
    ...((deleted&&typeof deleted==='object')?Object.entries(deleted).filter(([,v])=>v===true).map(([k])=>String(k)):[])
  ]);
  const providers={...(old?.providers&&typeof old.providers==='object'?old.providers:{})};
  if(legacy?.providers&&typeof legacy.providers==='object') for(const [id,v] of Object.entries(legacy.providers)) providers[id]=providers[id]?{...v,...providers[id]}:v;
  const ids=new Set([
    ...Object.keys(remote&&typeof remote==='object'&&!Array.isArray(remote)?remote:{}),
    ...Object.keys(secrets&&typeof secrets==='object'&&!Array.isArray(secrets)?secrets:{})
  ]);
  for(const firebaseKey of ids){
    const meta=(remote&&typeof remote[firebaseKey]==='object'&&remote[firebaseKey])||{};
    const secret=(secrets&&typeof secrets[firebaseKey]==='object'&&secrets[firebaseKey])||{};
    const id=String(secret.id||meta.id||firebaseKey).trim();
    const normId=normalizeProviderId(id);
    const blocked=[...deletedSet].some(x=>String(x)===id || normalizeProviderId(x)===normId);
    if(!id||blocked)continue;
    const prevKey=providerIdInStore({providers},id);
    const prev=prevKey?providers[prevKey]:{};
    const urlRaw=String(secret.url||meta.url||prev.url||'').trim();
    const key=usableProviderKey(secret.key)||usableProviderKey(meta.key)||usableProviderKey(prev.key);
    if(!urlRaw||!key)continue;
    let url=urlRaw; try{url=normalizeProviderApiUrl(urlRaw)}catch(_){}
    providers[id]={...prev,...meta,...secret,id,name:String(meta.name||secret.name||prev.name||id),url,key};
    if(prevKey && prevKey!==id) delete providers[prevKey];
  }
  for(const id of deletedSet){ for(const existing of Object.keys(providers)){if(String(existing)===String(id)||normalizeProviderId(existing)===normalizeProviderId(id))delete providers[existing];} }
  const env=envProvider(); if(env&&!deletedSet.has(String(env.id)))providers[env.id]={...(providers[env.id]||{}),...env};
  const activeFromRemote=typeof remoteActive==='string'?remoteActive:String(remoteActive?.id||remoteActive?.activeProvider||'');
  const active=providers[activeFromRemote]?activeFromRemote:(providers[old?.activeProvider]?String(old.activeProvider):(Object.keys(providers)[0]||''));
  writeJSON('providers.runtime.json',{activeProvider:active,providers,deletedProviderIds:[...deletedSet],updatedAt:nowISO()});
  // Safe one-way backfill: if the newly selected database lacks a provider record,
  // preserve the local Railway-volume provider metadata/secret without overwriting an existing remote entry.
  if(FIREBASE_DATABASE_URL&&firebaseAuthAvailable()){
    const remoteMeta=remote&&typeof remote==='object'?remote:{};
    const remoteSecrets=secrets&&typeof secrets==='object'?secrets:{};
    for(const [id,prov] of Object.entries(providers)){
      if(!prov||typeof prov!=='object'||deletedSet.has(String(id)))continue;
      const k=firebaseSafeKey(id),metaExists=!!remoteMeta[k]||Object.values(remoteMeta).some(v=>String(v?.id||'')===String(id));
      const secretExists=!!remoteSecrets[k]||Object.values(remoteSecrets).some(v=>String(v?.id||'')===String(id));
      try{
        if(!metaExists){await firebaseWriteJson('config/smmProviders/'+k,{id,name:String(prov.name||id),url:String(prov.url||''),hasKey:!!usableProviderKey(prov.key),updatedAt:nowISO()},6000);const m=await firebaseGetJson('config/smmProviders/'+k,5000);if(!m||String(m.id||'')!==String(id))throw new Error('لم يتم التحقق من بيانات المزود');}
        if(!secretExists&&usableProviderKey(prov.key)){await firebaseWriteJson('config/smmProviderSecrets/'+k,{id,name:String(prov.name||id),url:String(prov.url||''),key:String(prov.key)},6000);const sec=await firebaseGetJson('config/smmProviderSecrets/'+k,5000);if(!sec||!usableProviderKey(sec.key))throw new Error('لم يتم التحقق من مفتاح المزود');}
      }catch(e){console.warn('Local provider backfill not confirmed for '+String(id)+': '+String(e.message||e).slice(0,100));}
    }
    if(active&&!activeFromRemote){try{await firebaseWriteJson('config/smmActive',active,5000)}catch(_){}}
  }
  return true;
}
async function ensureProviderRuntime(id=''){
  let store=providerStore();
  const wanted=String(id||store.activeProvider||'');
  const found=getProviderById(wanted).prov;
  if(found?.url&&found?.key)return store;
  await hydrateProviderRuntimeFromFirebase();
  store=providerStore();
  return store;
}

function readBundledLegacySeedArchive(){
  const archivePath=path.join(ROOT,LEGACY_SEED_ARCHIVE_RELATIVE);
  if(fs.existsSync(archivePath))return {zipBytes:fs.readFileSync(archivePath),sourceFile:'database/SadaIraq_Database_Export.zip',encrypted:false};
  const encryptedPath=path.join(ROOT,LEGACY_SEED_ENCRYPTED_FILE);
  if(fs.existsSync(encryptedPath)){
    const keyText=String(process.env.SADA_LEGACY_SEED_KEY||'').trim();
    if(!keyText)throw Object.assign(new Error('النسخة القديمة مشفرة وتحتاج SADA_LEGACY_SEED_KEY.'),{code:'SEED_KEY_MISSING'});
    let key;try{key=Buffer.from(keyText,'base64url')}catch(_){key=Buffer.alloc(0)}
    if(key.length!==32)throw new Error('SADA_LEGACY_SEED_KEY غير صالحة.');
    const box=fs.readFileSync(encryptedPath);if(box.length<36||box.subarray(0,8).toString('ascii')!=='SADAENC1')throw new Error('تنسيق النسخة المشفرة غير صالح.');
    const iv=box.subarray(8,20),tag=box.subarray(20,36),body=box.subarray(36);
    try{const d=crypto.createDecipheriv('aes-256-gcm',key,iv);d.setAuthTag(tag);return {zipBytes:Buffer.concat([d.update(body),d.final()]),sourceFile:'base44-legacy-seed.enc',encrypted:true};}
    catch(_){throw new Error('تعذر فك قاعدة البيانات المشفرة. تحقق من المفتاح.');}
  }
  throw new Error('ملف قاعدة البيانات المضمّن غير موجود داخل حزمة المشروع.');
}
function parseBundledLegacyArchive(){
  const loaded=readBundledLegacySeedArchive(),entries=readZipArchive(loaded.zipBytes);
  const dbKey=Object.keys(entries).find(k=>k==='sadairaq.db'||k.endsWith('/sadairaq.db'));
  if(!dbKey||entries[dbKey].subarray(0,16).toString('binary')!=='SQLite format 3\u0000')throw new Error('ملف SQLite مفقود أو غير سليم داخل قاعدة البيانات المضمّنة.');
  const users=parseLegacyJsonEntry(entries,'sadairaq-users.json'),orders=parseLegacyJsonEntry(entries,'sadairaq-orders.json'),transactions=parseLegacyJsonEntry(entries,'sadairaq-transactions.json');
  const userIds=assertUniqueIds(users,'المستخدمين'),orderIds=assertUniqueIds(orders,'الطلبات'),transactionIds=assertUniqueIds(transactions,'المعاملات');
  const linkedOrders=orders.filter(o=>userIds.has(String(o?.user_id||''))).length;
  if(users.length!==822||orders.length!==2840||transactions.length!==1129||linkedOrders!==orders.length||new Set(userIds).size!==users.length||new Set(orderIds).size!==orders.length||new Set(transactionIds).size!==transactions.length)throw new Error('فشل التحقق من أعداد قاعدة البيانات أو علاقات المستخدمين والطلبات؛ لم يتم دمج شيء.');
  return {...loaded,entries,users,orders,transactions,counts:{users:users.length,orders:orders.length,transactions:transactions.length}};
}
async function prepareBundledLegacyStage(){
  const existing=await readLegacyStage();if(existing)return existing;
  const loaded=parseBundledLegacyArchive();
  const stage={version:1,uploadedAt:nowISO(),sourceFile:loaded.sourceFile,sourceZipBytes:loaded.zipBytes.length,seedSourceId:LEGACY_SEED_ID,users:loaded.users.map(legacyUserPrivateRow),orders:loaded.orders.map(legacyOrderPrivateRow),transactions:loaded.transactions.map(legacyTransactionPrivateRow),transactionCount:loaded.transactions.length,counts:loaded.counts};
  writeJSON(LEGACY_STAGE_FILE,stage);return stage;
}
let LEGACY_SEED_BOOTSTRAP_RUNNING=false;
async function runBundledLegacySeedBootstrap(){
  if(LEGACY_SEED_BOOTSTRAP_RUNNING)return;LEGACY_SEED_BOOTSTRAP_RUNNING=true;
  const updateStatus=v=>{try{writeJSON(LEGACY_SEED_STATUS_FILE,{...v,checkedAt:nowISO(),seedId:LEGACY_SEED_ID,seedArchivePresent:fs.existsSync(path.join(ROOT,LEGACY_SEED_ARCHIVE_RELATIVE)),encryptedLegacySeedPresent:fs.existsSync(path.join(ROOT,LEGACY_SEED_ENCRYPTED_FILE))})}catch(_){}};
  try{
    const archivePath=path.join(ROOT,LEGACY_SEED_ARCHIVE_RELATIVE),encryptedPath=path.join(ROOT,LEGACY_SEED_ENCRYPTED_FILE);
    if(!fs.existsSync(archivePath)&&!fs.existsSync(encryptedPath)){updateStatus({status:'not-included',error:'ملف قاعدة البيانات غير موجود داخل هذا الإصدار.'});return;}
    if(!fs.existsSync(archivePath)&&!String(process.env.SADA_LEGACY_SEED_KEY||'').trim()){updateStatus({status:'waiting-for-key',error:'النسخة المشفرة القديمة تحتاج SADA_LEGACY_SEED_KEY. ارفع إصدار قاعدة البيانات الجديدة لتعمل دون مفتاح منفصل.',needsVariable:'SADA_LEGACY_SEED_KEY'});return;}
    let state=null,remoteUsersIndex=null,remoteTx=null,remoteOrders=null,remoteUsers=null;
    try{[state,remoteUsersIndex,remoteTx,remoteOrders,remoteUsers]=await Promise.all([firebaseGetJson(LEGACY_IMPORT_STATE_REMOTE_PATH,7000),firebaseGetJson(LEGACY_USERS_REMOTE_PATH,7000),firebaseGetJson(LEGACY_TRANSACTIONS_REMOTE_PATH,7000),firebaseGetJson('orders',18000),firebaseGetJson('users',18000)])}
    catch(e){updateStatus({status:'firebase-unavailable',error:String(e.message||e).slice(0,160)});return;}
    let loaded;
    try{loaded=parseBundledLegacyArchive();}
    catch(e){updateStatus({status:'seed-read-error',error:String(e.message||e).slice(0,200)});return;}
    const {users,orders,transactions}=loaded;
    const completedUsers=Number(remoteUsersIndex?.count||Object.keys(remoteUsersIndex?.users||{}).length||0);
    let transactionsSaved=Number(remoteTx?.count||Object.keys(remoteTx?.transactions||{}).length||0)===transactions.length;
    if(!transactionsSaved){try{const tx=await persistLegacyTransactionsRemote(transactions,LEGACY_SEED_ID);writeJSON(LEGACY_TRANSACTIONS_PRIVATE_FILE,transactions.map(legacyTransactionPrivateRow));transactionsSaved=tx.count===transactions.length;}catch(e){updateStatus({status:'transactions-pending',error:String(e.message||e).slice(0,160)});return;}}
    const persistedLegacyOrderIds=new Set(collectionEntries(remoteOrders).map(([,o])=>o&&o.legacyHistory&&o.legacyImportKey!==undefined?String(o.legacyImportKey):'').filter(Boolean));
    const everyOrderPersisted=orders.every(o=>persistedLegacyOrderIds.has(String(o.id)));
    const liveDirectory=normalizeCurrentUsers(remoteUsers||{});
    const mappedLiveUsers=mapLegacyUsersToCurrent(users,liveDirectory);
    const allUsersHaveAccounts=mappedLiveUsers.matchedIds.size===users.length;
    const countsMatch=Number(state?.counts?.users||0)===users.length&&Number(state?.counts?.orders||0)===orders.length&&completedUsers>=users.length&&everyOrderPersisted&&allUsersHaveAccounts;
    if(countsMatch){
      const revised={...state,legacyTransactionsSaved:transactionsSaved,legacyTransactionsRemoteCount:transactions.length,bundledSeedId:LEGACY_SEED_ID,accountProfilesVerified:true};
      await firebaseWriteJson(LEGACY_IMPORT_STATE_REMOTE_PATH,revised,10000).catch(()=>{});writeJSON(LEGACY_IMPORT_STATE_FILE,revised);
      updateStatus({status:transactionsSaved?'already-imported':'transactions-pending',counts:loaded.counts,legacyUsersRemoteCount:completedUsers,actualUserProfiles:liveDirectory.users.length,transactionsSaved,source:'existing-firebase-snapshot'});return;
    }
    const stage=await prepareBundledLegacyStage();
    const result=await applyLegacyStage(stage,{bundledSeed:true});
    updateStatus({status:result.allDone?'completed':'partial',counts:result.report.counts,accountProfilesCreated:result.report.accountProfilesCreated,report:result.report,warning:result.warning,transactionsSaved:result.report.legacyTransactionsSaved});
    console.log('Manual legacy import completed:',JSON.stringify({status:result.allDone?'completed':'partial',counts:result.report.counts,accountProfilesCreated:result.report.accountProfilesCreated,matchedUsers:result.report.matchedUsers,unmatchedUsers:result.report.unmatchedUsers,ordersWritten:result.report.ordersWritten,transactionsSaved:result.report.legacyTransactionsSaved}));
  }catch(e){updateStatus({status:'error',error:String(e.message||e).slice(0,200)});console.warn('Base44 database bootstrap failed:',String(e.message||e).slice(0,180));}
  finally{LEGACY_SEED_BOOTSTRAP_RUNNING=false;}
}

ensureData();
purgeCatalogServiceSnapshots(); // Also purge snapshots copied from legacy release-local DATA by ensureData().
ensureTelegramDefaults();
// Startup must never move, hide, or delete service rows/categories. Imports require an explicit admin action.
startGlobalPriceSyncScheduler();
let ADMIN_DASHBOARD_CACHE={at:0,value:null,promise:null};
let ADMIN_USERS_COUNT_CACHE={at:0,value:null};
let ADMIN_PAYMENTS_CACHE={at:0,value:null,promise:null,limit:0};
const server=http.createServer(async (req,res)=>{
  try{
    res._forwardedProto=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim();
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','SAMEORIGIN');
    res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    if(res._forwardedProto==='https') res.setHeader('Strict-Transport-Security','max-age=15552000; includeSubDomains');
    const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    res._acceptEncoding=String(req.headers['accept-encoding']||'');
    // Never compress authentication/session or Telegram secret-management responses.
    res._allowJsonCompression=!(/^\/api\/auth(?:\/|$)/i.test(u.pathname)||/^\/api\/admin\/telegram(?:\/|$)/i.test(u.pathname));
    if(u.pathname.startsWith('/api/')) return routeAPI(req,res,u);
    return serveStatic(req,res,u);
  }catch(e){
    const st=Number(e?.statusCode)||500;
    const requestPath=String(req.url||'').split('?')[0];
    if(st>=500 && /^\/api\/(?:order\/create|v1\/order)$/.test(requestPath)){
      const requestId=crypto.randomBytes(6).toString('hex');
      console.error('[Sada order exception '+requestId+'] '+requestPath+' '+String(e?.stack||e?.message||e).slice(0,1800));
      return json(res,st,{ok:false,error:'تعذر إنشاء الطلب بسبب خطأ داخلي في الخادم. لم يتم تأكيد نجاح الطلب؛ إذا وصل ردّ غير مؤكد فلا تعِد الإرسال قبل فحص «طلباتي».',stage:'server_exception',requestId,uncertain:true});
    }
    return json(res,st,{error:st===500?'Server error':e.message});
  }
});
server.listen(PORT,'0.0.0.0',()=>{
  console.log(`${APP_NAME} v${APP_VERSION} build ${BUILD_ID} running on port ${PORT}`);
  // Prepare the shared Firebase catalog after the listener is live. Routes share this in-flight
  // promise, so a user's first catalog page doesn't trigger an extra cold set of Firebase reads.
  setTimeout(()=>{ensureLocalServiceCatalogSeeded().then(async result=>{console.log('Firebase catalog ready:',JSON.stringify({services:result.count,source:result.source}));try{const free=await ensureAdminFreeServicesDurable({refresh:true});console.log('Firebase admin-funded free services ready:',Object.keys(adminFreeServiceObject(free)).length)}catch(error){console.warn('Admin-funded free services hydration deferred:',String(error.message||error).slice(0,180))}}).catch(error=>console.warn('Firebase catalog warm-up deferred:',String(error.message||error).slice(0,180)));},250);
  if(!adminPasswordConfigured()) console.warn('SECURITY WARNING: Admin login is not configured. Set ADMIN_PASSWORD/ADMIN_PASSWORD_HASH or restore a valid bundled admin hash.');
  if(!process.env.SESSION_SECRET){if(SESSION_SECRET_SOURCE==='firebase-service-credential')console.warn('SECURITY NOTICE: SESSION_SECRET is not set; using a stable, purpose-separated key derived from the server-only Firebase service credential. Set SESSION_SECRET explicitly for independent key rotation.');else console.warn('SECURITY WARNING: configure a long random SESSION_SECRET for stable, multi-instance signed sessions.');}
  if(!process.env.SADA_ENCRYPTION_KEY && !telegramEncryptionReady()) console.warn('SECURITY WARNING: could not create a stable encryption key; set a strong fixed SESSION_SECRET or attach persistent Railway storage.');
  // Bind HTTP before any remote Firebase hydration so saved sessions respond immediately.
  Promise.allSettled([hydrateProviderRuntimeFromFirebase(),hydrateTelegramChannelsFromFirebase(),hydrateApiServicesFromFirebase()]).then(()=>{
    // The bundled Base44 dump was removed from this release. Only the explicitly configured Firebase is used.
    setTimeout(()=>{runOrderAuditMonitor().catch(()=>{});runTelegramNewOrdersMonitor().catch(()=>{});runRefundReconciliationMonitor().catch(()=>{});},3000).unref();
    setInterval(()=>{runOrderAuditMonitor().catch(()=>{});runTelegramNewOrdersMonitor().catch(()=>{});runRefundReconciliationMonitor().catch(()=>{});},60*1000).unref();
  });
});
