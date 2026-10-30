import { api } from "./api";

export type PushState = "unsupported" | "unconfigured" | "denied" | "off" | "on";

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const key64 = (b64: string) => {
  const raw = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export async function pushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  const { publicKey } = await api<{ publicKey: string | null }>("GET", "/v1/push/key");
  if (!publicKey) return "unconfigured";
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) && Notification.permission === "granted" ? "on" : "off";
}

export async function enablePush() {
  const { publicKey } = await api<{ publicKey: string | null }>("GET", "/v1/push/key");
  if (!publicKey) throw new Error("not configured");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("denied");
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key64(publicKey) }));
  await api("POST", "/v1/push/subscribe", sub.toJSON());
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await api("POST", "/v1/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}
