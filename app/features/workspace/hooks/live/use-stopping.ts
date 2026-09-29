'use client';

import { useRef, useState } from 'react';

export function useStoppingState() {
  const [stopping, setStopping] = useState(false);
  const stopInFlightRef = useRef(false);

  function resetStopping() {
    stopInFlightRef.current = false;
    setStopping(false);
  }

  return {
    stopping,
    setStopping,
    stopInFlightRef,
    resetStopping,
  };
}
