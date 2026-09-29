'use client';

import { useEffect, useState } from 'react';

/** `refined` is the product surface. `classic` is the raw projection the stream
 *  arrives as — kept so the payload behind a row is always one click away while
 *  developing, and never shipped. */
export type ActivityStyle = 'refined' | 'classic';

export const ACTIVITY_STYLE_STORAGE_KEY = 'vibe-coding-platform-activity-style';

export const SHOW_ACTIVITY_STYLE_TOGGLE = process.env.NODE_ENV === 'development';

function isActivityStyle(value: unknown): value is ActivityStyle {
  return value === 'refined' || value === 'classic';
}

export function useActivityStyle() {
  const [style, setStyle] = useState<ActivityStyle>('refined');

  // Read after mount rather than during render: the server has no storage, and
  // seeding from it would hand the client a different first paint.
  useEffect(() => {
    if (!SHOW_ACTIVITY_STYLE_TOGGLE) return;
    const stored = window.localStorage.getItem(ACTIVITY_STYLE_STORAGE_KEY);
    if (isActivityStyle(stored)) setStyle(stored);
  }, []);

  useEffect(() => {
    if (!SHOW_ACTIVITY_STYLE_TOGGLE) return;
    window.localStorage.setItem(ACTIVITY_STYLE_STORAGE_KEY, style);
  }, [style]);

  // Production has one style, so nothing downstream has to ask which build it
  // is running in.
  return {
    style: SHOW_ACTIVITY_STYLE_TOGGLE ? style : ('refined' as ActivityStyle),
    setStyle,
  };
}
