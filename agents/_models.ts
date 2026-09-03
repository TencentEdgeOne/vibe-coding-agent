import {
  DEFAULT_MODEL,
  EXTRA_MODELS_ENV_KEY,
  buildModelCatalog,
  resolveSelectedModel,
  type ModelOption,
} from '../shared/models.ts';

function envValue(context: any, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The model this deployment runs when the composer has not chosen one. Kept as
 * the single reader of the model env chain so the picker's default and the
 * agent's fallback can never drift apart.
 */
export function resolveConfiguredModel(context: any) {
  return envValue(context, 'AI_GATEWAY_MODEL')
    || envValue(context, 'ANTHROPIC_MODEL')
    || envValue(context, 'DEEPSEEK_MODEL')
    || DEFAULT_MODEL;
}

/** The menu the composer's picker shows for this deployment. */
export function resolveModelCatalog(context: any): ModelOption[] {
  return buildModelCatalog({
    configuredModel: resolveConfiguredModel(context),
    extraModels: envValue(context, EXTRA_MODELS_ENV_KEY),
  });
}

/**
 * A request's model choice, dropped unless this deployment offers it. Callers
 * read '' as "no choice" and fall back to the configured model, so a client that
 * sends an arbitrary string cannot pick what the gateway bills for.
 */
export function resolveRequestedModel(context: any, requested: unknown) {
  return resolveSelectedModel(resolveModelCatalog(context), requested);
}
