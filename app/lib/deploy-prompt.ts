/**
 * When the composer should offer a production deploy.
 *
 * The topbar no longer has a persistent publish button. A short prompt appears
 * above the input after a finished project turn — not while the agent is busy,
 * not after a successful deploy of that same turn, and not after a pure Q&A.
 */

export type DeployOfferKind = 'first' | 'again' | 'retry';

export type DeployOfferActivity = {
  kind?: string;
  status?: string;
  name?: string;
  url?: string;
};

export type DeployOfferMessage = {
  id?: string;
  role: string;
  status?: string;
  activities?: DeployOfferActivity[];
};

export function isPublishProjectToolName(name = '') {
  return name.includes('publish_project');
}

export function lastFinishedAssistant<T extends DeployOfferMessage>(messages: readonly T[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item.role === 'assistant' && item.status && item.status !== 'running') {
      return item;
    }
  }
  return undefined;
}

function activitiesOf(message?: DeployOfferMessage) {
  return message?.activities ?? [];
}

function hasSuccessfulPublish(activities: readonly DeployOfferActivity[]) {
  return activities.some((activity) => (
    activity.kind === 'publish'
    && activity.status === 'completed'
    && Boolean(activity.url)
  ));
}

function hasFailedPublish(activities: readonly DeployOfferActivity[]) {
  return activities.some((activity) => (
    activity.kind === 'publish'
    && (activity.status === 'failed' || (activity.status === 'completed' && !activity.url))
  )) || activities.some((activity) => (
    activity.kind === 'tool'
    && isPublishProjectToolName(activity.name)
    && activity.status === 'failed'
  ));
}

function usedPublishTool(activities: readonly DeployOfferActivity[]) {
  return activities.some((activity) => (
    activity.kind === 'tool' && isPublishProjectToolName(activity.name)
  ));
}

function touchedProject(activities: readonly DeployOfferActivity[]) {
  return activities.some((activity) => (
    activity.kind === 'tool' && !isPublishProjectToolName(activity.name)
  ));
}

export function resolveDeployOffer(
  messages: readonly DeployOfferMessage[],
  options: { canDownload: boolean; loading: boolean },
): DeployOfferKind | null {
  if (options.loading || !options.canDownload) return null;

  const last = lastFinishedAssistant(messages);
  if (!last || last.status !== 'done') return null;

  const lastActivities = activitiesOf(last);
  if (hasSuccessfulPublish(lastActivities)) return null;
  if (hasFailedPublish(lastActivities)) return 'retry';
  if (usedPublishTool(lastActivities)) return null;

  const everPublished = messages.some((message) => hasSuccessfulPublish(activitiesOf(message)));
  if (touchedProject(lastActivities)) return everPublished ? 'again' : 'first';

  const anyTools = messages.some((message) => (
    activitiesOf(message).some((activity) => activity.kind === 'tool')
  ));
  if (!everPublished && !anyTools) return 'first';
  return null;
}
