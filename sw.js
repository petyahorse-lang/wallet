/* Офлайн для GitHub Pages.
   Кешируются только свои файлы. Библиотека Supabase и сама база живут в
   сети: без неё приложение открывается и работает на локальных данных,
   а записи уходят в очередь и досылаются при появлении связи. */
const CACHE = "wallet-byn-v7";
const CORE = ["./", "./index.html", "./engine.js", "./config.js", "./ai.js",
              "./vendor/supabase.js",
              "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  /* Своя страница: сначала сеть, чтобы обновления приезжали сами,
     при отсутствии сети отдаём из кеша. */
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req).then(r => r || caches.match("./index.html")))
  );
});
