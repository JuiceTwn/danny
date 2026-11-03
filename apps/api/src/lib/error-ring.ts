/**
 * The last few things that went wrong since the server started, kept in memory so the owner can ask "/errors" from the app instead of reading logs
 * over SSH. Only what the server already logs: the place, a short message and a time. Nothing a user wrote.
 */
export type ErrorEntry = { at: number; where: string; message: string };

const MAX = 100;
const ring: ErrorEntry[] = [];

export function recordError(where: string, message: string, at = Date.now()) {
  ring.push({ at, where: where.slice(0, 80), message: message.replace(/\s+/g, " ").slice(0, 300) });
  if (ring.length > MAX) ring.shift();
}

/** Newest first. */
export const recentErrors = (n = 10, since = 0) => ring.filter((e) => e.at >= since).slice(-n).reverse();
export const countErrors = (since: number) => ring.filter((e) => e.at >= since).length;
export const clearErrors = () => {
  ring.length = 0;
};
