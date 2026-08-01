import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import { getDemoViewModel } from "@/server/demo";
import { storeFromCookies } from "@/server/request-store";
import "./globals.css";

export const metadata: Metadata = {
  title: "Harborview PMS — Agent-native demo",
  description: "Synthetic local-first agent-native practice management demo",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const store = await storeFromCookies();
  const model = await getDemoViewModel(store);
  const healthcareMode = model.config.healthcareMode;
  const agentMode = model.config.agentMode;

  return (
    <html lang="en">
      <body>
        <AppShell healthcareMode={healthcareMode} agentMode={agentMode}>
          {!model.ok ? (
            <main className="page">
              <div className="panel" role="alert" data-testid="connected-error">
                <h1>Connected mode unavailable</h1>
                <p>{model.error}</p>
                {"recovery" in model && model.recovery ? (
                  <p className="muted" data-testid="store-recovery">
                    Recovery: {model.recovery}
                  </p>
                ) : null}
                <p className="muted">
                  Healthcare: {healthcareMode} · Agent: {agentMode}. Local/synthetic
                  fallback was not used.
                </p>
              </div>
            </main>
          ) : (
            <>
              {model.agentStatus && !model.agentStatus.available ? (
                <div
                  className="panel"
                  role="alert"
                  data-testid="agent-degraded"
                  style={{ margin: "1rem 1.5rem 0" }}
                >
                  <strong>Agent boundary degraded</strong>
                  <p>{model.agentStatus.error}</p>
                  <p className="muted">
                    Deterministic synthetic proposals are hidden in BFF mode. No
                    silent fallback.
                  </p>
                </div>
              ) : null}
              {children}
            </>
          )}
        </AppShell>
      </body>
    </html>
  );
}
