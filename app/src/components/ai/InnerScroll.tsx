// A scroll box inside the AI chat list (a step's request / result, an expanded thought). iOS gave the
// pan to the outer list every time, so while a finger is down in the box the chat list stops scrolling
// (ai.tsx provides the lock) and the box gets the drag; lifting the finger hands it back.
import { createContext, useContext, type ReactNode } from "react";
import { ScrollView, type StyleProp, type ViewStyle } from "react-native";

export const ScrollLock = createContext<(locked: boolean) => void>(() => {});

export function InnerScroll({ maxHeight, style, contentStyle, children }: { maxHeight: number; style?: StyleProp<ViewStyle>; contentStyle?: StyleProp<ViewStyle>; children: ReactNode }) {
  const lock = useContext(ScrollLock);
  const release = () => lock(false);
  return (
    <ScrollView
      nestedScrollEnabled
      style={[{ maxHeight }, style]}
      contentContainerStyle={contentStyle}
      onTouchStart={() => lock(true)}
      onTouchEnd={release}
      onTouchCancel={release}
      onScrollEndDrag={release}
      onMomentumScrollEnd={release}
    >
      {children}
    </ScrollView>
  );
}
