// This domain used to serve the Danny app, which installed a service worker here. The app now lives on its own
// subdomain, so anyone who visited before would keep seeing the old cached app instead of this page. This file
// replaces that worker, clears its cache and unregisters itself.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) await caches.delete(k);
    await self.registration.unregister();
    for (const c of await self.clients.matchAll({ type: "window" })) c.navigate(c.url);
  })());
});
