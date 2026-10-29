var CACHE = 'mnemosyne-shell-v10';
var SHELL = [
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE; }).map(function (key) {
          return caches.delete(key);
        })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function shellPath(pathname) {
  var base = new URL('./', self.registration.scope).pathname;
  if (pathname === base || pathname === base + 'index.html') return true;
  var files = ['styles.css', 'app.js', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png'];
  for (var i = 0; i < files.length; i++) {
    if (pathname === base + files[i]) return true;
  }
  return false;
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;
  var url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (!shellPath(url.pathname)) return;
  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(request, { ignoreSearch: true }).then(function (cached) {
        if (cached) return cached;
        if (request.mode === 'navigate') {
          return cache.match('./index.html').then(function (index) {
            return index || fetch(request);
          });
        }
        return fetch(request);
      });
    })
  );
});
