import { runTranscriptPipeline } from './pipelines/_transcript';

/** Download the conversation as the same JSONL the UI export button produces. */
export async function onRequestGet(context: any) {
  return runTranscriptPipeline(context);
}
