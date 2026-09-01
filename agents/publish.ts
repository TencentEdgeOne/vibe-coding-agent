import { runProjectPublishPipeline } from './_pipelines';

export async function onRequestPost(context: any) {
  try {
    return await runProjectPublishPipeline(context);
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to publish the project.',
    }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
