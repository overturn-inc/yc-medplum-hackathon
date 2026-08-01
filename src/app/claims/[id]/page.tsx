import { notFound } from "next/navigation";
import { ClaimWorkbench } from "@/components/ClaimWorkbench";
import { getEpisodeView } from "@/server/demo";

export const dynamic = "force-dynamic";

export default async function ClaimDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const view = await getEpisodeView(id);
  if (!view) notFound();

  return (
    <main className="page" data-testid="claim-detail-page">
      <header className="page-header">
        <h1>Claim workbench</h1>
        <p>
          Source observations stay immutable. Agent proposals require one-time approval
          before any synthetic write.
        </p>
      </header>
      <ClaimWorkbench
        episode={view.episode}
        preflight={view.preflight}
        events={view.events}
      />
    </main>
  );
}
