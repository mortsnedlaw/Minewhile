export class SlidingWindowRateLimiter {
  private timestamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("windowMs must be positive");
  }

  allow(now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length && this.timestamps[0] <= cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.limit) return false;
    this.timestamps.push(now);
    return true;
  }
}
