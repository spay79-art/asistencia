// Service worker: guarda los archivos de la app para que abra sin señal y cargue al instante.
// Las llamadas al servidor (Apps Script) nunca se guardan: van siempre a la red (la cola de marcas vive en app.js).
// Al publicar una versión nueva de la app, sube el número de VERSION para que los teléfonos la tomen.
var VERSION = 'asistencia-v3';
var ARCHIVOS = [
  './', 'index.html', 'app.js', 'config.js', 'estilos.css', 'manifest.webmanifest',
  'iconos/icono-180.png', 'iconos/icono-192.png', 'iconos/icono-512.png', 'iconos/icono-mascara-512.png',
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(ARCHIVOS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (claves) {
    return Promise.all(claves.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

// Archivos de la app: primero la red (para tomar cambios), y si no hay señal, lo guardado.
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(fetch(e.request).then(function (r) {
    var copia = r.clone();
    caches.open(VERSION).then(function (c) { c.put(e.request, copia); });
    return r;
  }).catch(function () {
    return caches.match(e.request, { ignoreSearch: true }).then(function (r) { return r || caches.match('index.html'); });
  }));
});
