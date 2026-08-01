import { notFound } from "next/navigation";
import Link from "next/link";
import { ClaimWorkbench } from "@/components/ClaimWorkbench";
import { getEpisodeView } from "@/server/demo";
import { storeFromCookies } from "@/server/request-store";

export const dynamic = "force-dynamic";

export default async function ClaimDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const store = await storeFromCookies();
  const view = await getEpisodeView(id, store);
  if (!view) notFound();

  return (
    <main className="page claim-detail-page" data-testid="claim-detail-page">
      <div className="breadcrumb-row">
        <Link href="/claims" prefetch={false} className="btn btn-quiet">← Claims</Link>
        <span className="mono">/claims/{id}</span>
      </div>
      <ClaimWorkbench
        episode={view.episode}
        preflight={view.preflight}
        events={view.events}
        agentMode={view.config.agentMode}
        stediConfigured={view.config.stediConfigured}
      />
    </main>
  );
}
