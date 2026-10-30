import webpush from "web-push";

export type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } };
export type PushPayload = { title: string; body: string; taskId?: string };

export interface PushSender {
  /** Public VAPID key the browser needs to subscribe. Null when push is not configured. */
  readonly publicKey: string | null;
  /** "gone" means the browser dropped the subscription and it should be deleted. */
  send(sub: PushSub, payload: PushPayload): Promise<"ok" | "gone" | "failed">;
}

export class NoPush implements PushSender {
  readonly publicKey = null;
  async send(): Promise<"failed"> {
    return "failed";
  }
}

export class WebPushSender implements PushSender {
  constructor(readonly publicKey: string, private privateKey: string, private subject: string) {}
  async send(sub: PushSub, payload: PushPayload) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), {
        vapidDetails: { subject: this.subject, publicKey: this.publicKey, privateKey: this.privateKey },
        TTL: 60 * 60,
        urgency: "high",
        timeout: 10_000,
      });
      return "ok" as const;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      return code === 404 || code === 410 ? ("gone" as const) : ("failed" as const);
    }
  }
}

// The server posts to whatever address a subscription carries, so only real push services are accepted.
// Without this, a signed-in user could point the server at an internal address.
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

export function isAllowedPushEndpoint(raw: string) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}
