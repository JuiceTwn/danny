/**
 * What "alive" means for Danny: the process answers AND the reminder scheduler is still ticking.
 * A scheduler that silently stops is the worst failure here: nothing looks broken and reminders just never come.
 * The scheduler calls tick() after every successful pass, including passes where nothing was due.
 */
export class Health {
  private lastTick = Date.now(); // grace period: the first tick can take a moment after boot

  constructor(readonly expectScheduler: boolean, private staleMs = 120_000) {}

  tick() {
    this.lastTick = Date.now();
  }

  schedulerOk(now = Date.now()) {
    return !this.expectScheduler || now - this.lastTick < this.staleMs;
  }
}
