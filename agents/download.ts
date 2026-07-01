import { runProjectDownloadPipeline } from './_pipelines';

export async function onRequest(context: any) {
  return runProjectDownloadPipeline(context);
}
