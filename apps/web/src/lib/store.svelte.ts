import { api, setOnUnauthorized, type Approval, type Me, type Settings } from "./api";

class AppState {
  me = $state<Me | null>(null);
  loaded = $state(false);
  settings = $state<Settings | null>(null);
  pending = $state(0);
  online = $state(true);
  canInstall = $state(false);
  installed = $state(false);
}
export const app = new AppState();

let deferredInstall: (Event & { prompt: () => Promise<void> }) | null = null;

export function setup() {
  setOnUnauthorized(() => {
    app.me = null;
    app.settings = null;
  });
  app.online = navigator.onLine;
  addEventListener("online", () => (app.online = true));
  addEventListener("offline", () => (app.online = false));
  app.installed = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e as typeof deferredInstall;
    app.canInstall = true;
  });
  addEventListener("appinstalled", () => {
    app.installed = true;
    app.canInstall = false;
  });
  setInterval(() => app.me && refresh(), 60_000);
}

export async function installApp() {
  await deferredInstall?.prompt();
  deferredInstall = null;
  app.canInstall = false;
}

export async function boot() {
  try {
    app.me = await api<Me>("GET", "/v1/me");
    await refresh();
  } catch {
    app.me = null;
  }
  app.loaded = true;
}

export async function refresh() {
  try {
    const [settings, pending] = await Promise.all([
      api<Settings>("GET", "/v1/settings"),
      api<{ items: Approval[] }>("GET", "/v1/approvals?status=pending"),
    ]);
    app.settings = settings;
    app.pending = pending.items.length;
  } catch {
    /* status strip just keeps its last values */
  }
}

export async function signOut() {
  await api("POST", "/v1/auth/logout").catch(() => {});
  app.me = null;
  app.settings = null;
  app.pending = 0;
}
