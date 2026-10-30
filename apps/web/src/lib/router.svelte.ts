export type Route = "chat" | "waiting" | "memory" | "settings" | "owner";
const ROUTES: Route[] = ["chat", "waiting", "memory", "settings", "owner"];

const parse = (): Route => {
  const r = location.hash.replace(/^#\//, "") as Route;
  return ROUTES.includes(r) ? r : "chat";
};

class Router {
  current = $state<Route>(parse());
}
export const router = new Router();
addEventListener("hashchange", () => (router.current = parse()));
export const go = (r: Route) => (location.hash = `#/${r}`);

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
