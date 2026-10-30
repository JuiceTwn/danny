export class GithubError extends Error {
  constructor(message: string, readonly kind: "reconnect" | "failed" = "failed") {
    super(message);
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function gh<T>(token: string, path: string, fetchFn: typeof fetch): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(`https://api.github.com${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "Danny", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GithubError("Couldn't reach GitHub.");
  }
  if (res.status === 401) throw new GithubError("GitHub rejected the saved token. Reconnect GitHub in Settings.", "reconnect");
  if (res.status === 403 || res.status === 429) throw new GithubError("GitHub is rate limiting or refused that. Try again in a few minutes.");
  if (!res.ok) throw new GithubError("GitHub had a problem with that request.");
  return (await res.json()) as T;
}

/** The login the token belongs to. Throws if the token doesn't work. */
export async function whoAmI(token: string, fetchFn: typeof fetch = fetch) {
  const me = await gh<{ login?: string }>(token, "/user", fetchFn);
  if (!me.login) throw new GithubError("GitHub didn't say who that token belongs to.");
  return me.login;
}

export type GhItem = { repo: string; number: number; title: string; url: string; updated: string };
type SearchResult = { items?: { number: number; title: string; html_url: string; updated_at: string; repository_url: string }[] };

const search = async (token: string, q: string, fetchFn: typeof fetch): Promise<GhItem[]> => {
  const r = await gh<SearchResult>(token, `/search/issues?${new URLSearchParams({ q, sort: "updated", order: "desc", per_page: "8" })}`, fetchFn);
  return (r.items ?? []).map((i) => ({ repo: i.repository_url.split("/").slice(-2).join("/"), number: i.number, title: clip(i.title.replace(/\s+/g, " "), 100), url: i.html_url, updated: i.updated_at.slice(0, 10) }));
};

/** What is waiting on this person: reviews asked of them, issues assigned to them, and their own open pull requests. */
export async function waitingOnYou(token: string, fetchFn: typeof fetch = fetch) {
  const [reviews, assigned, mine] = await Promise.all([
    search(token, "is:open is:pr review-requested:@me archived:false", fetchFn),
    search(token, "is:open is:issue assignee:@me archived:false", fetchFn),
    search(token, "is:open is:pr author:@me archived:false", fetchFn),
  ]);
  return { reviews, assigned, mine };
}

export const itemLine = (i: GhItem) => `${i.repo}#${i.number} ${i.title} (updated ${i.updated})`;

export function summarize(w: Awaited<ReturnType<typeof waitingOnYou>>) {
  const part = (label: string, items: GhItem[]) => (items.length ? `${label}:\n${items.map((i) => `- ${itemLine(i)}`).join("\n")}` : "");
  return [part("Reviews waiting on you", w.reviews), part("Issues assigned to you", w.assigned), part("Your open pull requests", w.mine)].filter(Boolean).join("\n") || "Nothing waiting on you.";
}
