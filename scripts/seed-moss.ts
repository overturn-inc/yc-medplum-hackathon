import { MossClient } from "@moss-dev/moss";
import { DEFAULT_DEMO_CLOCK } from "@/domain/clock";
import { createSeedEpisodes } from "@/domain/fixtures";
import { buildMossDocuments } from "@/adapters/retrieval/moss-documents";

const projectId = process.env.MOSS_PROJECT_ID;
const projectKey = process.env.MOSS_PROJECT_KEY;
const indexName = process.env.MOSS_INDEX_NAME || "overturn-claims-demo-v1";

if (!projectId || !projectKey) {
  throw new Error("MOSS_PROJECT_ID and MOSS_PROJECT_KEY are required");
}

const documents = buildMossDocuments(createSeedEpisodes(DEFAULT_DEMO_CLOCK));
const client = new MossClient(projectId, projectKey);

try {
  const indexes = await client.listIndexes();
  const existing = indexes.find((index) => index.name === indexName);
  if (existing) {
    await client.addDocs(indexName, documents, { upsert: true });
  } else {
    await client.createIndex(indexName, documents, { modelId: "moss-minilm" });
  }

  const updated = await client.getIndex(indexName);
  console.log(
    JSON.stringify({
      ok: true,
      indexName,
      operation: existing ? "upserted" : "created",
      documentCount: updated.docCount,
      syntheticOnly: true,
    }),
  );
} finally {
  await client.close();
}
