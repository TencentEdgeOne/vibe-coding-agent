import { resolveConfiguredModel, resolveModelCatalog } from '../shared/models.ts';

/**
 * The composer's model menu. Served rather than bundled into the client because
 * the list depends on this deployment's environment, which the browser cannot
 * read — and because the server validates against the same list, a menu built
 * anywhere else could offer a model this instance would reject.
 *
 * An edge function, not an agent route: the answer does not depend on a
 * conversation, so the home screen can fetch it before one exists.
 */
export function onRequestGet(context: any) {
  return new Response(JSON.stringify({
    ok: true,
    models: resolveModelCatalog(context),
    defaultModel: resolveConfiguredModel(context),
  }), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
