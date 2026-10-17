import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { SLOW_OPENING_MS } from "@/lib/opening";

/** How long the splash takes to fade into the app. */
export const SPLASH_FADE_MS = 200;

// Several screens show the splash in turn while the app opens, starting with
// the page's own; they share one clock, from when the page opened, so the
// slow-opening notice does not restart at every step. The clock starts over
// once no splash is left on screen.
let openingSince: number | undefined = Date.now() - performance.now();
let splashesShown = 0;

function useSlowOpening(): boolean {
  const [since] = useState(() => {
    openingSince ??= Date.now();
    return openingSince;
  });
  useEffect(() => {
    splashesShown += 1;
    return () => {
      splashesShown -= 1;
      // The next step's splash mounts in the same commit, before this runs.
      setTimeout(() => {
        if (!splashesShown) openingSince = undefined;
      });
    };
  }, []);
  const [slow, setSlow] = useState(() => Date.now() - since >= SLOW_OPENING_MS);
  useEffect(() => {
    if (slow) return;
    const timer = setTimeout(() => setSlow(true), Math.max(0, since + SLOW_OPENING_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [since, slow]);
  return slow;
}

/**
 * The opening screen: the logo alone on the app's background. It matches the
 * markup in index.html, so the page before the app loads hands over to it
 * without a visible change.
 */
export function SplashScreen({ leaving = false }: { leaving?: boolean }) {
  const slow = useSlowOpening();
  return (
    <div
      role="status"
      aria-label="Opening Wisp"
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center bg-background text-foreground transition-opacity ease-out motion-reduce:transition-none",
        leaving && "pointer-events-none opacity-0",
      )}
      style={{ transitionDuration: `${SPLASH_FADE_MS}ms` }}
    >
      <img src={`${import.meta.env.BASE_URL}apple-touch-icon.png`} alt="" width={64} height={64} draggable={false} />
      {slow && !leaving ? (
        <div className="absolute top-[calc(50%+56px)] right-4 left-4 flex flex-col items-center gap-2 text-center">
          <p className="m-0 text-sm text-dim">Taking longer than usual…</p>
          <Button type="button" size="sm" variant="ghost" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Keeps the splash over the app until it is ready, then fades it out. Returns
 * null once the splash is gone.
 */
export function SplashOverlay({ ready }: { ready: boolean }) {
  const [gone, setGone] = useState(ready);
  useEffect(() => {
    if (!ready || gone) return;
    const timer = setTimeout(() => setGone(true), SPLASH_FADE_MS);
    return () => clearTimeout(timer);
  }, [ready, gone]);
  return gone ? null : <SplashScreen leaving={ready} />;
}
