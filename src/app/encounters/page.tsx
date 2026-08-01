import { ClaimWorkbench } from "@/components/ClaimWorkbench";
import { EncountersTable } from "@/components/Tables";
import { getDemoViewModel, getEpisodeView } from "@/server/demo";
import { storeFromCookies } from "@/server/request-store";

export const dynamic = "force-dynamic";

export default async function EncountersPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>;
}) {
  const store = await storeFromCookies();
  const model = await getDemoViewModel(store);
  if (!model.ok) return null;
  const params = await searchParams;
  const focusId = params.focus ?? "episode-encounter-a";
  const focus = await getEpisodeView(focusId, store);

  const rows = model.episodes.map((episode) => {
    const filterKeys = [
      episode.chargeState === "ready" && !episode.claimId ? "ready_to_bill" : "",
      episode.chargeState === "coding_blocked" || !episode.coverageActive
        ? "missing_information"
        : "",
      episode.claimId ? "claim_created" : "",
    ]
      .filter(Boolean)
      .join(",");
    return { ...episode, filterKeys };
  });

  return (
    <main className="page encounters-page" data-testid="encounters-page">
      <header className="page-header">
        <div>
          <h1>Encounters</h1>
          <p>
            Completed visits and billing readiness. Creating a proposal is not
            submission; nothing leaves this workspace until Allow once.
          </p>
        </div>
      </header>
      <section className="encounter-workspace">
        <EncountersTable rows={rows} />
        {focus && (
          <section className="encounter-detail" data-testid="encounter-preflight">
            <div className="detail-kicker">Claim preflight</div>
            <ClaimWorkbench
              episode={focus.episode}
              preflight={focus.preflight}
              events={focus.events}
              agentMode={model.config.agentMode}
              stediConfigured={model.config.stediConfigured}
              compactHeader
            />
          </section>
        )}
      </section>
    </main>
  );
}
