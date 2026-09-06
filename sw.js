/* Still: offline cache.
   Bump the version below whenever you upload a new index.html, so phones fetch the new one. */
var CACHE = 'still-v19';
var SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-512-maskable.png', './apple-touch-icon.png'];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
/* Serve the app's own files from cache first, so it opens instantly and offline, and
   refresh the copy in the background.

   Only this app's files. Anything on another host — the sync Worker above all — is left
   alone entirely: a cached reply would be one person's private record sitting in a store
   shared by everyone who uses this device, and it would be served to whoever asked next. */
self.addEventListener('fetch', function(e){
  if(e.request.method !== 'GET') return;
  var url;
  try{ url = new URL(e.request.url); }catch(err){ return; }
  if(url.origin !== self.location.origin) return;          // never touch the API
  if(e.request.headers.get('Authorization')) return;        // nor anything carrying a session

  e.respondWith(caches.open(CACHE).then(function(c){
    return c.match(e.request, { ignoreSearch: true }).then(function(hit){
      var net = fetch(e.request).then(function(res){
        if(res && res.ok && res.type === 'basic') c.put(e.request, res.clone());
        return res;
      }).catch(function(){ return hit; });
      return hit || net;
    });
  }));
});
