// Drawer open state, separate from Drawer.tsx so ui.tsx can open it without an import cycle.
import { useSyncExternalStore } from "react";
import { track } from "@/lib/track";

let open = false;
const listeners = new Set<() => void>();
function setOpen(v: boolean) {
  open = v;
  listeners.forEach((l) => l());
}
export const openDrawer = () => {
  track("drawer_open");
  setOpen(true);
};
export const closeDrawer = () => setOpen(false);
export const useDrawerOpen = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => open);
