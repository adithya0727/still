/* Still: offline cache.
   Bump the version below whenever you upload a new index.html, so phones fetch the new one. */
var CACHE = 'still-v3';
var SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-512-maskable.png', './apple-touch-icon.png'];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
/* Serve from cache first so the app opens instantly and offline; refresh the copy in the background. */
self.addEventListener('fetch', function(e){
  if(e.request.method !== 'GET') return;
  e.respondWith(caches.open(CACHE).then(function(c){
    return c.match(e.request, { ignoreSearch: true }).then(function(hit){
      var net = fetch(e.request).then(function(res){
        if(res && (res.ok || res.type === 'opaque')) c.put(e.request, res.clone());
        return res;
      }).catch(function(){ return hit; });
      return hit || net;
    });
  }));
});
