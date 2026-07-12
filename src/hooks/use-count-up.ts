"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

const DURATION_MS = 650;

// Ease-out cubic: fast off the mark, settles gently on the final value.
const ease = (t: number) => 1 - Math.pow(1 - t, 3);

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

const subscribe = (onChange: () => void) => {
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

const getSnapshot = () => window.matchMedia(reducedMotionQuery).matches;

// On the server, assume reduced motion so the markup ships the final value.
const getServerSnapshot = () => true;

/**
 * Animates from 0 up to `target` on mount, and from the previous value on any
 * subsequent change.
 *
 * Returns `target` unanimated when the user prefers reduced motion — the CSS
 * `prefers-reduced-motion` guard in globals.css can't reach a JS-driven
 * counter, so it's re-checked here.
 */
export function useCountUp(target: number): number {
  const reduced = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  // Seeded at 0, not `target`: seeding with the final value paints the finished
  // number for one frame before the first rAF tick knocks it back to the start.
  const [value, setValue] = useState(0);

  // Where the next run counts from. Tracks the displayed value throughout the
  // animation, so a target that changes mid-flight resumes from what's on
  // screen rather than snapping back to the previous run's origin.
  const fromRef = useRef(0);

  // Counting up to zero has nothing to show, and a non-finite target can't be
  // interpolated — both render as-is.
  const animate = !reduced && Number.isFinite(target) && target !== 0;

  useEffect(() => {
    if (!animate) {
      fromRef.current = Number.isFinite(target) ? target : 0;
      return;
    }

    const from = fromRef.current;
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min((now - start) / DURATION_MS, 1);
      const next = Math.round(from + (target - from) * ease(t));
      fromRef.current = next;
      setValue(next);

      if (t < 1) {
        frame = requestAnimationFrame(tick);
      }
    });

    return () => cancelAnimationFrame(frame);
  }, [animate, target]);

  return animate ? value : target;
}
