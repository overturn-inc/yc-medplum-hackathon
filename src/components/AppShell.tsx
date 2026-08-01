"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, useSyncExternalStore, useTransition } from "react";

const subscribeToHydration = () => () => {};

const NAV = [
  { href: "/dashboard", label: "Overview", enabled: true },
  { href: "/encounters", label: "Encounters", enabled: true },
  { href: "/claims", label: "Claims", enabled: true },
  { href: "#", label: "Work Queue", enabled: false },
  { href: "#", label: "Payments", enabled: false },
  { href: "#", label: "Agent Activity", enabled: false },
  { href: "#", label: "Approvals", enabled: false },
  { href: "#", label: "Reports", enabled: false },
  { href: "#", label: "Integrations", enabled: false },
] as const;

export function AppShell({
  children,
  healthcareMode,
  agentMode,
}: {
  children: React.ReactNode;
  healthcareMode: string;
  agentMode: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [navigationOpen, setNavigationOpen] = useState(false);
  // Server-rendered controls are visible before React attaches their event
  // handlers. Keep them non-interactive for that brief window so a fast click
  // cannot be silently dropped. useSyncExternalStore provides a hydration-safe
  // server snapshot without an effect-driven state update.
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );

  function resetDemo() {
    startTransition(async () => {
      await fetch("/api/demo/reset", { method: "POST" });
      router.refresh();
    });
  }

  return (
    <div
      className="app-shell"
      data-hydrated={hydrated ? "true" : "false"}
      aria-busy={hydrated ? undefined : "true"}
    >
      <aside
        className={`sidebar ${navigationOpen ? "sidebar-open" : ""}`}
        aria-label="Primary"
      >
        <div className="sidebar-scroll" data-testid="sidebar-scroll">
          <div className="brand">
            <strong>Overturn</strong>
            <span>Agent-native billing workspace</span>
          </div>
          <div className="nav-section-label">Workspace</div>
          <ul className="nav-list">
            {NAV.slice(0, 3).map((item) => (
              <li key={item.label}>
                <Link
                  href={item.href}
                  prefetch={false}
                  aria-current={pathname.startsWith(item.href) ? "page" : undefined}
                  onClick={() => setNavigationOpen(false)}
                >
                  <span aria-hidden className="nav-marker" />
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="nav-section-label nav-section-spaced">Not in this demo</div>
          <ul className="nav-list">
            {NAV.slice(3).map((item) => (
              <li key={item.label}>
                <span className="disabled" aria-disabled="true" title="Coming soon">
                  {item.label}
                  <small>Soon</small>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div className="sidebar-session" data-testid="sidebar-session">
          <span aria-hidden className="status-dot" /> Demo session · synthetic
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <button
            type="button"
            className="nav-toggle"
            aria-label="Toggle navigation"
            aria-expanded={navigationOpen}
            onClick={() => setNavigationOpen((value) => !value)}
          >
            Menu
          </button>
          <div className="badges" aria-label="Demo mode">
            <span className="badge" data-testid="badge-synthetic">
              <span aria-hidden className="badge-dot" /> Synthetic data
            </span>
            <span className="badge" data-testid="badge-healthcare">
              <span aria-hidden className="badge-dot badge-dot-blue" /> Healthcare: {healthcareMode}
            </span>
            <span className="badge" data-testid="badge-agent">
              <span aria-hidden className="badge-dot badge-dot-neutral" /> Agent: {agentMode}
            </span>
            <span className="badge warn">
              <span aria-hidden className="badge-dot badge-dot-warn" /> No live payer writes
            </span>
          </div>
          <div className="reset-wrap">
            <button
              type="button"
              className="btn btn-quiet"
              onClick={resetDemo}
              disabled={pending}
              data-testid="reset-demo"
              title="Reset only this synthetic browser session"
            >
              {pending ? "Resetting…" : "Reset demo"}
            </button>
            <span className="sr-only">Resets only this synthetic session.</span>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
