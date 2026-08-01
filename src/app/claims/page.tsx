import { ClaimsTable } from "@/components/Tables";
import { getDemoViewModel } from "@/server/demo";
import { isNeedsAttention } from "@/domain/projector";

export const dynamic = "force-dynamic";

export default async function ClaimsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const model = await getDemoViewModel();
  if (!model.ok) return null;
  const { filter = "all" } = await searchParams;

  const rows = model.episodes
    .filter((episode) => episode.fixtureKey !== "encounter-a" || episode.claimId)
    .concat(model.episodes.filter((e) => e.fixtureKey === "encounter-a"))
    .filter((episode, index, arr) => arr.findIndex((e) => e.id === episode.id) === index)
    .map((episode) => {
      const filterKeys = [
        !episode.submissionReceiptId && episode.claimId ? "draft" : "",
        episode.submissionReceiptId ? "submitted" : "",
        episode.transportState === "clearinghouse_rejected" ? "rejected" : "",
        episode.adjudicationState === "accepted_for_processing" ? "accepted" : "",
        episode.pmsState.toLowerCase().includes("processing") ||
        episode.adjudicationState === "pending"
          ? "processing"
          : "",
        episode.adjudicationState === "info_requested" ? "pended" : "",
        episode.adjudicationState === "denied" ? "denied" : "",
        episode.verifiedPaid || episode.adjudicationState === "paid" ? "paid" : "",
        episode.overlays.includes("source_discrepancy") ? "source_discrepancy" : "",
        episode.overlays.includes("approval_required") ? "approval_required" : "",
        episode.overlays.includes("follow_up_due") ? "follow_up_due" : "",
        isNeedsAttention(episode) ? "needs_attention" : "",
        episode.primaryBucket,
      ]
        .filter(Boolean)
        .join(",");
      return { ...episode, filterKeys };
    });

  return (
    <main className="page" data-testid="claims-page">
      <header className="page-header">
        <h1>Claims</h1>
        <p>Multi-source lifecycle queue. Open a row for evidence-rich workbench.</p>
      </header>
      <ClaimsTable rows={rows} initialFilter={filter} />
    </main>
  );
}
