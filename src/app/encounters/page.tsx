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
    <main className="page" data-testid="encounters-page">
      <header className="page-header">
        <h1>Encounters</h1>
        <p>Ready encounters open claim preflight. Proposals do not submit until Allow once.</p>
      </header>
      <EncountersTable rows={rows} />
      {focus && (
        <section className="stack" data-testid="encounter-preflight">
          <h2>Claim preflight — {focus.episode.patientName}</h2>
          <ClaimWorkbench
            episode={focus.episode}
            preflight={focus.preflight}
            events={focus.events}
            agentMode={model.config.agentMode}
          />
        </section>
      )}
    </main>
  );
}
