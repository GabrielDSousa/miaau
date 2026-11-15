/**
 * Superfície pública da camada de I/O do coletor.
 * O Worker não importa nada daqui — ele só lê o D1.
 */

export { createFetcher, miaauUserAgent, HttpError, type Fetcher, type FetchResult } from "./http.ts";
export { Store, parseSize, verifyPriority, verifyReason, type PollState, type StoreStats, type VerifyJob } from "./store.ts";
export { toIngestItem, type BuildItemOptions } from "./item.ts";
export { createRemote, remoteBase, RemoteError, type Remote, type RemoteOptions } from "./remote.ts";
export { runCycle, type CycleOptions, type CycleResult } from "./cycle.ts";
export {
  ingestRss,
  pollOnce,
  verifyBatch,
  verifyOne,
  type IngestResult,
  type PollResult,
  type VerifyResult,
} from "./pipeline.ts";
