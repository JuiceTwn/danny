import { access, constants, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Talking to the server without SSH. The app never runs anything: it drops an empty file named for the action in a folder, and a root-owned script on
 * the server (deploy/ops.sh, started by a systemd path unit) does the work and writes the results to a folder the app can only read.
 * See docs/DEPLOY.md. The names below are the whole list; the script ignores anything else.
 */
export const ACTIONS = ["check", "backup", "update", "doctor", "logs", "fix", "restart"] as const;
export type OpsAction = (typeof ACTIONS)[number];

const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export class Ops {
  readonly requests: string;
  readonly status: string;
  constructor(opsDir: string) {
    this.requests = join(opsDir, "requests");
    this.status = join(opsDir, "status");
  }

  private async json<T>(name: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(join(this.status, name), "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  /** A text file the server script wrote (the doctor's report, the recent log lines), or null. Capped, and with control characters removed. */
  async text(name: string, max = 12_000): Promise<string | null> {
    try {
      // eslint-disable-next-line no-control-regex
      return (await readFile(join(this.status, name), "utf8")).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, max);
    } catch {
      return null;
    }
  }

  async view() {
    const writable = await access(this.requests, constants.W_OK).then(() => true, () => false);
    const readable = await access(join(this.status, "repo.json"), constants.R_OK).then(() => true, () => false);
    const last = await this.json<Record<string, unknown> | null>("last.json", null);
    const repo = await this.json<Record<string, unknown>>("repo.json", {});
    const backups = await this.json<unknown[]>("backups.json", []);
    const pending = writable ? (await readdir(this.requests).catch(() => [])).filter((f) => (ACTIONS as readonly string[]).includes(f)) : [];
    const started = typeof last?.startedAt === "string" ? Date.parse(last.startedAt) : NaN;
    // A request that never finished (the server rebooted mid-update) should not lock the buttons forever.
    const running = last?.state === "running" && Number.isFinite(started) && Date.now() - started < 45 * 60_000;
    return {
      available: writable && readable,
      busy: running || pending.length > 0,
      pending,
      last: last && { action: s(last.action, 20), state: s(last.state, 20), startedAt: s(last.startedAt, 40), finishedAt: s(last.finishedAt, 40), summary: s(last.summary, 4000) },
      version: s(repo.version, 40),
      branch: s(repo.branch, 80),
      behind: n(repo.behind),
      changes: Array.isArray(repo.changes) ? repo.changes.slice(0, 10).map((c) => s(c, 140) ?? "") : [],
      checkedAt: s(repo.checkedAt, 40),
      backups: (Array.isArray(backups) ? backups : []).slice(0, 5).map((b: any) => ({ name: s(b?.name, 80), bytes: n(b?.bytes), at: s(b?.at, 40) })),
    };
  }

  /** Ask for one action. "busy" when something is already running or this exact request is already waiting; "not_set_up" before danny ops-install. */
  async request(action: OpsAction): Promise<"ok" | "not_set_up" | "busy"> {
    const v = await this.view();
    if (!v.available) return "not_set_up";
    if (v.busy) return "busy";
    try {
      await writeFile(join(this.requests, action), "", { flag: "wx" });
    } catch {
      return "busy";
    }
    return "ok";
  }
}

export type OpsView = Awaited<ReturnType<Ops["view"]>>;
