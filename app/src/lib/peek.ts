// Which poster card is open in the long-press sheet (rendered once by PosterSheetHost).
import { useSyncExternalStore } from "react";
import type { CardData } from "@/components/media";

let current: CardData | null = null;
const listeners = new Set<() => void>();

export function openPeek(c: CardData | null) {
  current = c;
  listeners.forEach((l) => l());
}

export function usePeek(): CardData | null {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => current);
}
