export type Locale = 'zh' | 'en';

/** An explicit choice made from the language switch. */
export const LANGUAGE_STORAGE_KEY = 'vibe-coding-platform-language';

export type HomeFeatureIcon = 'skills' | 'functions';

// One capability the generated project gets out of the platform, described by
// what comes back from the prompt rather than by what the platform offers. The
// distinction is the whole point of these cards: a capability list belongs on a
// product site, but the question being asked here is what the run produces.
//
// The two are ordered, and `home-stage.tsx` numbers them in array order.
export type HomeFeature = {
  readonly icon: HomeFeatureIcon;
  readonly title: string;
  readonly desc: string;
};

// A landing-page example chip. Both fields hold the same sentence: the chip and
// the typewriter placeholder show it, and clicking it sends it unchanged. So it
// has to work as both — short enough to read on one line, complete enough to
// build from. A label that summarised a longer prompt once sent a user a
// six-page specification they had not read, so a test holds the two equal.
export type HomeExample = {
  readonly label: string;
  readonly prompt: string;
};
