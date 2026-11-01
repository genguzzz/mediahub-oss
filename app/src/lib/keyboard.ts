// One rule for the whole app: a touch that starts anywhere but the focused text field (a tap elsewhere, or
// the start of a scroll / swipe) hides the keyboard. Wired once at the root view (onTouchStart, which never
// takes the touch away from what was pressed); touch events bubble through the React tree, so sheets,
// modals and form-sheet screens are covered too.
import { findNodeHandle, Keyboard, TextInput, type GestureResponderEvent } from "react-native";

export function dismissKeyboardOnOutsideTouch(e: GestureResponderEvent) {
  const focused = TextInput.State.currentlyFocusedInput();
  if (!focused) return;
  const tag = findNodeHandle(focused as Parameters<typeof findNodeHandle>[0]);
  if (tag != null && e.nativeEvent.target === tag) return; // touching the field being typed in
  Keyboard.dismiss();
}
