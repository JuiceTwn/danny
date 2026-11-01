export type Route = "chat" | "tasks" | "waiting" | "apps" | "memory" | "settings" | "owner";
const ROUTES: Route[] = ["chat", "tasks", "waiting", "apps", "memory", "settings", "owner"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// #/apps opens the list; #/apps/<id> opens one app.
const parse = (): { route: Route; id: string } => {
  const [name = "", id = ""] = location.hash.replace(/^#\//, "").split("/");
  const route = ROUTES.includes(name as Route) ? (name as Route) : "chat";
  return { route, id: route === "apps" && UUID.test(id) ? id : "" };
};

class Router {
  current = $state<Route>(parse().route);
  /** The id after #/apps/, or "" */
  appId = $state(parse().id);
}
export const router = new Router();
addEventListener("hashchange", () => {
  const p = parse();
  router.current = p.route;
  router.appId = p.id;
});
export const go = (r: Route) => (location.hash = `#/${r}`);
export const openApp = (id: string) => (location.hash = `#/apps/${id}`);

export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
export const fmtDay = (iso: string) => {
  const d = new Date(iso), t = new Date();
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, t)) return "Today";
  const y = new Date(t); y.setDate(t.getDate() - 1);
  if (same(d, y)) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
};
export const usd = (n: number) => `$${n.toFixed(2)}`;
/** "3 h 20 min", "45 min": how long until the allowance resets. */
export const resetsIn = (iso: string, now = Date.now()) => {
  const mins = Math.max(1, Math.ceil((Date.parse(iso) - now) / 60_000));
  return mins >= 60 ? `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ""}` : `${mins} min`;
};
export const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  return `${fmtDay(iso)} ${fmtTime(iso)}${d.getTime() < Date.now() ? " (past)" : ""}`;
};
