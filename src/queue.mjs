// Server-side alert queue. Alerts play one at a time so every overlay instance
// stays in sync; higher priority jumps ahead, and repeated identical alerts
// from the same user are merged instead of flooding the screen.

export class AlertQueue {
  constructor({ maxSize = 100, onPlay = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.items = [];
    this.maxSize = maxSize;
    this.onPlay = onPlay;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.current = null;
    this.timer = null;
    this.paused = false;
  }

  push(alert) {
    const item = { priority: 0, duration: 5, mergeKey: '', count: 1, ...alert, queuedAt: Date.now() };
    if (item.mergeKey) {
      const twin = this.items.find((x) => x.mergeKey === item.mergeKey);
      if (twin) {
        twin.count += item.count;
        twin.text = item.text;
        return twin;
      }
    }
    // Stable insert by priority (desc).
    let i = this.items.findIndex((x) => x.priority < item.priority);
    if (i === -1) i = this.items.length;
    this.items.splice(i, 0, item);
    if (this.items.length > this.maxSize) this.items.pop(); // drop the least important
    this.pump();
    return item;
  }

  pump() {
    if (this.current || this.paused || !this.items.length) return;
    this.current = this.items.shift();
    this.onPlay(this.current);
    this.timer = this.setTimer(() => this.finish(), Math.max(0.5, this.current.duration) * 1000);
  }

  finish() {
    this.current = null;
    this.timer = null;
    this.pump();
  }

  skip() {
    if (this.timer) this.clearTimer(this.timer);
    this.finish();
  }

  clear() {
    this.items = [];
  }

  setPaused(paused) {
    this.paused = paused;
    if (!paused) this.pump();
  }

  snapshot() {
    return { current: this.current, pending: this.items.length, paused: this.paused };
  }
}
