import { MossClient } from "@moss-dev/moss";

const projectId = process.env.MOSS_PROJECT_ID;
const projectKey = process.env.MOSS_PROJECT_KEY;
const indexName = process.env.MOSS_INDEX_NAME;

if (!projectId || !projectKey || !indexName) {
  throw new Error("MOSS_PROJECT_ID, MOSS_PROJECT_KEY, and MOSS_INDEX_NAME are required");
}

const client = new MossClient(projectId, projectKey);
try {
  const loadStartedAt = performance.now();
  await client.loadIndex(indexName);
  const queryStartedAt = performance.now();
  const result = await client.query(
    indexName,
    "Synthetic claim CLM-C-3003 was denied for authorization. What evidence supports reprocessing?",
    {
      topK: 5,
      filter: { field: "episodeId", condition: { $eq: "episode-claim-c" } },
    },
  );

  if (result.docs.length < 2) {
    throw new Error("Moss did not return enough Claim C evidence");
  }
  if (!result.docs.some((doc) => doc.metadata?.sourceReference?.includes("doc-auth-claim-c"))) {
    throw new Error("Moss did not retrieve the Claim C authorization evidence");
  }
  if (result.docs.some((doc) => doc.metadata?.episodeId !== "episode-claim-c")) {
    throw new Error("Moss returned a document outside the requested episode scope");
  }

  console.log(
    JSON.stringify({
      ok: true,
      provider: "moss",
      execution: "local-in-memory",
      indexName,
      loadMs: Math.round(queryStartedAt - loadStartedAt),
      queryMs: Math.round((performance.now() - queryStartedAt) * 10) / 10,
      documents: result.docs.map((doc) => ({
        id: doc.id,
        reference: doc.metadata?.sourceReference,
        score: Number(doc.score.toFixed(4)),
      })),
      syntheticOnly: true,
    }),
  );
} finally {
  await client.close();
}
