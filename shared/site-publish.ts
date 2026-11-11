/** The sentence the publish button sends. The host publishes it; the model does not. */
export const SITE_PUBLISH_REQUEST = {
  zh: '把当前站点发布上线',
  en: 'Publish this site',
} as const;

export function isSitePublishRequest(message: string) {
  const trimmed = message.trim();
  return trimmed === SITE_PUBLISH_REQUEST.zh || trimmed === SITE_PUBLISH_REQUEST.en;
}

/**
 * The activity row the host publish pipeline writes. The timeline reads it back
 * as "Deploy project", so a finished publish does not ask to publish again.
 */
export const SITE_PUBLISH_ACTIVITY_COMMAND = 'publish site';
