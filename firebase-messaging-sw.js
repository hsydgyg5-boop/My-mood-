/* Sada Iraq Web Push worker. Public Firebase web configuration is fetched from /api/config. */
importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js');
importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js');
self.addEventListener('install',event=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
let bootPromise=null;
function bootFirebase(){
  if(bootPromise)return bootPromise;
  bootPromise=fetch('/api/config',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('config unavailable');return r.json()}).then(cfg=>{
    if(!cfg||!cfg.firebase||!cfg.firebase.apiKey||!cfg.firebase.projectId)throw new Error('Firebase web config missing');
    if(!firebase.apps.length)firebase.initializeApp(cfg.firebase);
    const messaging=firebase.messaging();
    // A single native push listener below owns display/click handling. Keep the
    // Firebase SDK's background callback silent to prevent duplicate notifications.
    if(messaging&&typeof messaging.setBackgroundMessageHandler==='function')messaging.setBackgroundMessageHandler(()=>Promise.resolve());
    return true;
  }).catch(err=>{bootPromise=null;throw err});
  return bootPromise;
}
self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    try{await bootFirebase();}catch(_){}
    let payload={};try{payload=event.data?event.data.json():{}}catch(_){try{payload={notification:{body:event.data.text()}}}catch(__){}}
    const n=payload.notification||{},d=payload.data||{};
    const title=String(n.title||d.title||'صدى العراق');
    const body=String(n.body||d.body||'لديك إشعار جديد');
    const url=String(d.url||'/');
    await self.registration.showNotification(title,{body,icon:'/sadairaq-logo.jpg',image:n.image||d.image||undefined,data:{url}});
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  const raw=String(event.notification.data&&event.notification.data.url||'/');let target='/';
  try{const u=new URL(raw,self.location.origin);if(u.origin===self.location.origin)target=u.href;}catch(_){}
  event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(clients=>{
    for(const client of clients){if('focus' in client){client.navigate(target);return client.focus()}}
    if(self.clients.openWindow)return self.clients.openWindow(target);
  }));
});
