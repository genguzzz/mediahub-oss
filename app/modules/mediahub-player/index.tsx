// JS side of the MediahubPlayer native module (AetherEngine view + device helpers) and the AirPlay
// button. Everything is optional so OTA code running on an older binary (or web) can check
// `playerAvailable` / `nativeCaps()` and fall back instead of crashing.
import { forwardRef, type Ref } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { requireNativeView } from "expo";
import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";

export interface ExternalSub { uri: string; name?: string; language?: string; headers?: Record<string, string> }

export interface PlayerSource {
  uri: string;
  headers?: Record<string, string>;
  startPosition?: number;
  externalSubtitles?: ExternalSub[];
  audioLanguages?: string[];
  subtitleLanguages?: string[];
  probeBytes?: number;       // runtime 4: demux probe budget (AetherEngine default 50 MB)
  analyzeMs?: number;        // runtime 4: max analyze duration (default 60 s)
  progressive?: boolean;     // runtime 4: serve loopback segments while they are written
}

export interface PlayerTrack { id: number; name: string; codec: string; language: string; channels: number; isDefault: boolean; isForced: boolean; isAtmos: boolean; isExternal: boolean }
export type Phase = "idle" | "loading" | "playing" | "paused" | "seeking" | "buffering" | "stalled" | "ended" | "error";
export interface PlayerInfo { videoFormat: string; videoDecoder: string; audioDecoder: string; codec: string; container: string; route?: string }

export interface PlayerViewProps extends ViewProps {
  source: PlayerSource | null;
  paused?: boolean;
  rate?: number;
  subtitleScale?: number;
  autoPiP?: boolean;                  // runtime 3+
  itemId?: string;                    // runtime 3+, for restoring a detached PiP window
  nowPlaying?: { title: string; subtitle?: string; artwork?: string } | null; // runtime 3+
  onPhase?: (e: NativeSyntheticEvent<{ phase: Phase; message?: string; reconnecting?: boolean }>) => void;
  onProgress?: (e: NativeSyntheticEvent<{ position: number; duration: number; buffered: number }>) => void;
  onTracks?: (e: NativeSyntheticEvent<{ audio: PlayerTrack[]; subtitles: PlayerTrack[]; activeAudio: number; activeSubtitle: number }>) => void;
  onInfo?: (e: NativeSyntheticEvent<PlayerInfo>) => void;
  onEnded?: () => void;
  onError?: (e: NativeSyntheticEvent<{ message: string }>) => void;
  onPiP?: (e: NativeSyntheticEvent<{ active: boolean; possible?: boolean; error?: string }>) => void; // runtime 3+
  onStartup?: (e: NativeSyntheticEvent<{ step: string; ms: number }>) => void; // runtime 4+
}

export interface PlayerHandle {
  seek(seconds: number): Promise<void>;
  selectAudio(id: number): Promise<void>;
  selectSubtitle(id: number): Promise<void>;
  addSubtitle?(sub: ExternalSub): Promise<number>; // runtime 3+
  togglePiP?(): Promise<void>;                     // runtime 3+
  stop(): Promise<void>;
}

export interface NativeCaps {
  module: number; pip: boolean; airplay: boolean; addSubtitle: boolean; brightness: boolean; volume: boolean; nowPlaying: boolean;
  hdr: boolean; hdr10: boolean; dolbyVision: boolean; hlg: boolean; engine: string;
  prewarm?: boolean; startupEvents?: boolean; // runtime 4+
}

interface NativeModule {
  capabilities?(): Promise<NativeCaps>;
  getBrightness?(): Promise<number>;
  setBrightness?(v: number): Promise<void>;
  getVolume?(): Promise<number>;
  setVolume?(v: number): Promise<void>;
  prewarm?(uri: string, headers: Record<string, string>): Promise<{ bytes: number; declined: string }>;
  addListener?(event: "onPiPRestore", fn: (e: { itemId: string; position: number }) => void): EventSubscription;
  addListener?(event: "onEngineLog", fn: (e: { line: string }) => void): EventSubscription;
}

const mod = requireOptionalNativeModule<NativeModule>("MediahubPlayer");
export const playerAvailable = mod !== null;
const airplayAvailable = requireOptionalNativeModule("MediahubAirPlay") !== null;

let caps: Promise<NativeCaps | null> | null = null;
// Runtime 2 binaries have no capabilities(): report the basics they do have.
export function nativeCaps(): Promise<NativeCaps | null> {
  caps ??= mod?.capabilities ? mod.capabilities().catch(() => null) : Promise.resolve(mod ? ({ module: 2 } as NativeCaps) : null);
  return caps;
}

export const device = {
  getBrightness: () => mod?.getBrightness?.() ?? Promise.resolve(null),
  setBrightness: (v: number) => mod?.setBrightness?.(v) ?? Promise.resolve(),
  getVolume: () => mod?.getVolume?.() ?? Promise.resolve(null),
  setVolume: (v: number) => mod?.setVolume?.(v) ?? Promise.resolve(),
  // Runtime 4: fetch a source's first 8 MB ahead of playback; null on older binaries.
  prewarm: (uri: string, headers: Record<string, string> = {}) => mod?.prewarm?.(uri, headers).catch(() => null) ?? Promise.resolve(null),
  onPiPRestore: (fn: (e: { itemId: string; position: number }) => void) => mod?.addListener?.("onPiPRestore", fn) ?? null,
  // Runtime 4: AetherEngine startup/network diagnostics (open timings, first data, stalls…), URLs cut to host.
  onEngineLog: (fn: (e: { line: string }) => void) => mod?.addListener?.("onEngineLog", fn) ?? null,
};

const Native = playerAvailable ? requireNativeView<PlayerViewProps & { ref?: Ref<PlayerHandle> }>("MediahubPlayer") : null;

export const PlayerView = forwardRef<PlayerHandle, PlayerViewProps>(function PlayerView(props, ref) {
  if (!Native) return null;
  return <Native {...props} ref={ref} />;
});

const NativeAirPlay = airplayAvailable ? requireNativeView<ViewProps & { tint?: string }>("MediahubAirPlay") : null;

// System AirPlay picker; renders nothing on binaries without it.
export function AirPlayButton(props: ViewProps & { tint?: string }) {
  if (!NativeAirPlay) return null;
  return <NativeAirPlay {...props} />;
}
