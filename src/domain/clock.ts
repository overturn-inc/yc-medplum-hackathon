/** Deterministic demo clock. */

let frozenNow: string | null = null;

export const DEFAULT_DEMO_CLOCK = "2026-07-15T15:00:00.000Z";

export function getDemoClock(): string {
  return frozenNow ?? DEFAULT_DEMO_CLOCK;
}

export function setDemoClock(iso: string): void {
  frozenNow = iso;
}

export function resetDemoClock(): void {
  frozenNow = null;
}

export function withDemoClock<T>(iso: string, fn: () => T): T {
  const previous = frozenNow;
  frozenNow = iso;
  try {
    return fn();
  } finally {
    frozenNow = previous;
  }
}

export function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

export function isAfter(a: string, b: string): boolean {
  return new Date(a).getTime() > new Date(b).getTime();
}

export function daysBetween(earlier: string, later: string): number {
  const ms = new Date(later).getTime() - new Date(earlier).getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}
