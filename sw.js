var CACHE = 'mnemosyne-shell-v21';
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
      return cache.addAll(SHELL.map(function (url) {
        return new Request(url, { cache: 'reload' });
      }));
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

function scopeBase() {
  return new URL('./', self.registration.scope).pathname;
}

function shellPath(pathname) {
  var base = scopeBase();
  if (pathname === base || pathname === base + 'index.html') return true;
  var files = ['styles.css', 'app.js', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png'];
  for (var i = 0; i < files.length; i++) {
    if (pathname === base + files[i]) return true;
  }
  return false;
}

function freshShell(pathname) {
  var base = scopeBase();
  if (pathname === base || pathname === base + 'index.html') return true;
  return pathname === base + 'app.js'
    || pathname === base + 'styles.css'
    || pathname === base + 'manifest.json';
}

function cacheFallback(request) {
  return caches.open(CACHE).then(function (cache) {
    return cache.match(request, { ignoreSearch: true }).then(function (cached) {
      if (cached) return cached;
      if (request.mode === 'navigate') return cache.match('./index.html');
      return null;
    });
  });
}

function networkFirst(request) {
  var network;
  try {
    network = request.mode === 'navigate'
      ? fetch(request, { cache: 'reload' })
      : fetch(new Request(request.url, { cache: 'reload', credentials: 'same-origin' }));
  } catch (err) {
    network = fetch(request);
  }
  return network.then(function (response) {
    if (response && response.ok) {
      var copy = response.clone();
      caches.open(CACHE).then(function (cache) {
        cache.put(request, copy);
      });
    }
    return response;
  }).catch(function () {
    return cacheFallback(request).then(function (cached) {
      return cached || Response.error();
    });
  });
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
  if (request.mode === 'navigate' || freshShell(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }
  event.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(request, { ignoreSearch: true }).then(function (cached) {
        return cached || fetch(request);
      });
    })
  );
});
