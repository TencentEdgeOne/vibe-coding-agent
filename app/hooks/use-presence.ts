'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Keeps the last visible value mounted long enough for its exit animation to
// finish. The element reports animationend so CSS remains the timing source.
export function usePresence<T>(value: T | null | undefined) {
  const latestValueRef = useRef<T | null>(value ?? null);
  if (value != null) latestValueRef.current = value;

  const visible = value != null;
  const [mounted, setMounted] = useState(visible);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setExiting(false);
      return;
    }
    if (!mounted) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setMounted(false);
      setExiting(false);
      return;
    }
    setExiting(true);
  }, [mounted, visible]);

  const finishExit = useCallback(() => {
    if (visible) return;
    setMounted(false);
    setExiting(false);
  }, [visible]);

  return {
    mounted,
    value: mounted ? latestValueRef.current : null,
    exiting,
    finishExit,
  };
}
