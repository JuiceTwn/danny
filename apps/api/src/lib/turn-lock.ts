/**
 * One turn at a time per workspace, whether it came from typing or from a call. This also keeps parallel requests from
 * running past the spend cap. In memory, so it holds for a single server process.
 */
export class TurnLock {
  private busy = new Map<string, symbol>();

  /** Returns a release function, or null if a turn is already running. Releasing twice, or releasing someone else's turn, does nothing. */
  tryAcquire(workspaceId: string): (() => void) | null {
    if (this.busy.has(workspaceId)) return null;
    const mine = Symbol();
    this.busy.set(workspaceId, mine);
    return () => {
      if (this.busy.get(workspaceId) === mine) this.busy.delete(workspaceId);
    };
  }
}
