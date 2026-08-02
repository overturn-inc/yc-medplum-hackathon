/** Runs a synthetic voice job through the same authenticated sidecar contract
 * used by the app and proves that both Deepgram STT and TTS ran in live mode. */
export {};

const sidecarUrl = process.env.AUTOMATION_SIDECAR_URL;
const sidecarApiKey = process.env.AUTOMATION_SIDECAR_API_KEY;

if (!sidecarUrl || !sidecarApiKey) {
  console.log(
    JSON.stringify({
      deepgram: {
        live: false,
        reason:
          "AUTOMATION_SIDECAR_URL and/or AUTOMATION_SIDECAR_API_KEY are not set in this app's " +
          "environment. ToolJobService falls back to the in-process mock automation sidecar for " +
          "voice_session jobs; no live Deepgram call is possible without a configured sidecar.",
      },
    }),
  );
  process.exit(1);
}

const base = sidecarUrl.replace(/\/$/, "");
const headers = {
  Authorization: `Bearer ${sidecarApiKey}`,
  "Content-Type": "application/json",
};
const created = await fetch(`${base}/v1/jobs`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    action: "voice_session",
    idempotencyKey: `deepgram-live-${crypto.randomUUID()}`,
    episodeId: "episode-encounter-a",
    sessionRevision: 1,
    episodeRevision: 1,
  }),
});
if (!created.ok) throw new Error(`Voice job create failed: ${created.status}`);
let job = ((await created.json()) as { job: Record<string, unknown> }).job;
const deadline = Date.now() + 60_000;
while (!new Set(["completed", "failed_safe", "cancelled"]).has(String(job.state))) {
  if (Date.now() >= deadline) throw new Error("Voice job timed out");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const polled = await fetch(`${base}/v1/jobs/${String(job.id)}`, { headers });
  if (!polled.ok) throw new Error(`Voice job poll failed: ${polled.status}`);
  job = ((await polled.json()) as { job: Record<string, unknown> }).job;
}
const result = job.result as {
  transcript?: string;
  providers?: { stt?: { mode?: string }; tts?: { mode?: string } };
};
if (
  job.state !== "completed" ||
  !result.transcript ||
  result.providers?.stt?.mode !== "live" ||
  result.providers?.tts?.mode !== "live"
) {
  throw new Error("Voice job did not prove live Deepgram STT and TTS");
}
console.log(JSON.stringify({ deepgram: { live: true, transcriptLength: result.transcript.length } }));
