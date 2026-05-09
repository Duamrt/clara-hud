// Clara HUD — Service Worker
// Cache-first pra assets estáticos. Atualiza em network change.
const CACHE_VERSION = "clara-hud-v1.9.0";
const PRECACHE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

// Install: pré-cacheia tudo
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Permite que a página force ativação imediata da nova versão
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// Activate: limpa caches antigos
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first com fallback à rede
self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Só GET (POST/PUT etc passam direto)
  if (req.method !== "GET") return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((resp) => {
        // Cacheia respostas OK do mesmo domínio
        if (resp.ok && new URL(req.url).origin === self.location.origin) {
          const clone = resp.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
        }
        return resp;
      }).catch(() => caches.match("./index.html"));
    })
  );
});
