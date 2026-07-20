import { runProjectResumePipeline } from './_pipelines';

export async function onRequest(context: any) {
  return runProjectResumePipeline(context);
}
