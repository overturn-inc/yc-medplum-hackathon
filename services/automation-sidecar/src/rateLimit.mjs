/** Minimal fixed-window rate limiter used to cap voice_session job creation. */
export class RateLimiter {
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = [];
  }

  allow(now = Date.now()) {
    const windowStart = now - this.windowMs;
    this.hits = this.hits.filter((timestamp) => timestamp > windowStart);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}
