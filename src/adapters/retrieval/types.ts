export interface RetrievalQuery {
  episodeId: string;
  query: string;
  topK?: number;
}

export interface RetrievedDocument {
  id: string;
  title: string;
  reference: string;
  documentType: string;
  excerpt: string;
  score: number;
}

export interface RetrievalResult {
  provider: "moss";
  indexName: string;
  execution: "cloud-semantic-search" | "local-in-memory" | "aws-local-sidecar";
  latencyMs: number;
  mossSearchMs: number | null;
  synthetic: true;
  documents: RetrievedDocument[];
}

export interface RetrievalAdapter {
  readonly provider: "moss";
  query(input: RetrievalQuery): Promise<RetrievalResult>;
}
