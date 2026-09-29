import { SITE_PUBLISH_REQUEST } from '../../shared/site-publish.ts';
import type { HomeExample, HomeFeature } from './types.ts';

type Copy = {
  brandTag: string;
  deployLabel: string;
  home: {
    subtitle: string;
    examples: readonly HomeExample[];
    features: readonly HomeFeature[];
  };
  workspace: {
    toolActions: { 'Deploy project': string };
    deployRequest: string;
    deployNeedsProject: string;
    deployNeedsIdle: string;
    deployOffer: string;
    deployOfferAgain: string;
    deployOfferAction: string;
  };
};

const zh = {
  brandTag: '通用版',
  deployLabel: '发布站点',
  home: {
    subtitle: '用一句话生成静态站点，在沙箱里预览，再发布到 EdgeOne。',
    examples: [
      { label: '做一个简洁好用的 Todolist', prompt: '做一个简洁好用的 Todolist' },
      { label: '为产品设计师创建一个作品集网站', prompt: '为产品设计师创建一个作品集网站' },
      { label: '做一个带统计和主题切换的番茄钟', prompt: '做一个带统计和主题切换的番茄钟' },
    ],
    features: [],
  },
  workspace: {
    toolActions: { 'Deploy project': '发布站点' },
    deployRequest: SITE_PUBLISH_REQUEST.zh,
    deployNeedsProject: '生成站点后即可发布',
    deployNeedsIdle: '当前任务结束后即可发布',
    deployOffer: '要把当前站点发布上线吗？',
    deployOfferAgain: '站点有更新，要重新发布吗？',
    deployOfferAction: '发布',
  },
} satisfies Copy;

const en = {
  brandTag: 'Universal',
  deployLabel: 'Publish site',
  home: {
    subtitle: 'Describe a static site, preview it in the sandbox, then publish it.',
    examples: [
      { label: 'Build a SaaS dashboard for an analytics startup', prompt: 'Build a SaaS dashboard for an analytics startup' },
      { label: 'Create a portfolio site for a product designer', prompt: 'Create a portfolio site for a product designer' },
      { label: 'Make a Pomodoro timer with stats and themes', prompt: 'Make a Pomodoro timer with stats and themes' },
    ],
    features: [],
  },
  workspace: {
    toolActions: { 'Deploy project': 'Publish site' },
    deployRequest: SITE_PUBLISH_REQUEST.en,
    deployNeedsProject: 'Publish becomes available once a site is generated',
    deployNeedsIdle: 'Publish becomes available once the current task finishes',
    deployOffer: 'Publish this site?',
    deployOfferAgain: 'The site has updates. Publish again?',
    deployOfferAction: 'Publish',
  },
} satisfies Copy;

export function applySiteCopy<T extends Copy>(locale: 'zh' | 'en', copy: T): T {
  const site = locale === 'zh' ? zh : en;
  return {
    ...copy,
    brandTag: site.brandTag,
    deployLabel: site.deployLabel,
    home: {
      ...copy.home,
      subtitle: site.home.subtitle,
      examples: site.home.examples,
      features: site.home.features,
    },
    workspace: {
      ...copy.workspace,
      ...site.workspace,
      toolActions: {
        ...copy.workspace.toolActions,
        ...site.workspace.toolActions,
      },
    },
  };
}
