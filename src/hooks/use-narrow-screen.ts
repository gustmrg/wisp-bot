import { useSyncExternalStore } from "react";
const QUERY = "(max-width: 620px)";
function subscribe(listener: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
function snapshot() {
  return window.matchMedia(QUERY).matches;
}
export function useNarrowScreen() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
