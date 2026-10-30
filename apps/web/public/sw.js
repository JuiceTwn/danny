// App shell cache only. API calls (/v1/*) are never cached: they carry private data.
const CACHE = "danny-shell-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/v1/")) return;

  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/", copy));
          return res;
        })
        .catch(() => caches.match("/").then((r) => r || new Response("Offline", { status: 503 }))),
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        }),
    ),
  );
});

// Reminders. The server sends { title, body, taskId }. Done and Snooze work from the notification itself.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { /* plain text push */ }
  e.waitUntil(
    self.registration.showNotification(d.title || "Danny", {
      body: d.body || "",
      tag: d.taskId || "danny",
      renotify: true,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { taskId: d.taskId || null },
      actions: d.taskId ? [{ action: "done", title: "Done" }, { action: "snooze", title: "Snooze" }] : [],
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const { taskId } = e.notification.data || {};
  const post = (path, body) => fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  if (taskId && e.action === "done") return e.waitUntil(post(`/v1/tasks/${taskId}/done`).catch(() => {}));
  if (taskId && e.action === "snooze") return e.waitUntil(post(`/v1/tasks/${taskId}/snooze`, { minutes: 10 }).catch(() => {}));
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((all) => {
      const open = all.find((c) => "focus" in c);
      return open ? open.focus() : self.clients.openWindow("/#/tasks");
    }),
  );
});
