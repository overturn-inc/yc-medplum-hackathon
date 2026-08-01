"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";

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

  function resetDemo() {
    startTransition(async () => {
      await fetch("/api/demo/reset", { method: "POST" });
      router.refresh();
    });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Primary">
        <div className="brand">
          <strong>Harborview PMS</strong>
          <span>Agent-native billing workspace</span>
        </div>
        <ul className="nav-list">
          {NAV.map((item) => (
            <li key={item.label}>
              {item.enabled ? (
                <Link
                  href={item.href}
                  aria-current={pathname.startsWith(item.href) ? "page" : undefined}
                >
                  {item.label}
                </Link>
              ) : (
                <span className="disabled" aria-disabled="true" title="Later scope">
                  {item.label}
                </span>
              )}
            </li>
          ))}
        </ul>
      </aside>
      <div className="content">
        <header className="topbar">
          <div className="badges" aria-label="Demo mode">
            <span className="badge" data-testid="badge-synthetic">
              Synthetic data
            </span>
            <span className="badge" data-testid="badge-healthcare">
              Healthcare: {healthcareMode}
            </span>
            <span className="badge" data-testid="badge-agent">
              Agent: {agentMode}
            </span>
            <span className="badge warn">No live payer writes</span>
          </div>
          <button
            type="button"
            className="btn"
            onClick={resetDemo}
            disabled={pending}
            data-testid="reset-demo"
          >
            {pending ? "Resetting…" : "Reset demo"}
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
