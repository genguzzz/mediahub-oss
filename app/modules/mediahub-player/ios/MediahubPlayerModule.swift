import AVFoundation
import AVKit
import AetherEngine
import ExpoModulesCore
import MediaPlayer
import UIKit

struct ExternalSubtitleRecord: Record {
  @Field var uri: String = ""
  @Field var name: String = ""
  @Field var language: String = ""
  @Field var headers: [String: String] = [:]
}

struct PlayerSourceRecord: Record {
  @Field var uri: String = ""
  @Field var headers: [String: String] = [:]
  @Field var startPosition: Double = 0
  @Field var externalSubtitles: [ExternalSubtitleRecord] = []
  @Field var audioLanguages: [String] = []
  @Field var subtitleLanguages: [String] = []
  // Runtime 4: startup tuning. 0 / false keep AetherEngine's defaults (50 MB, 60 s, whole segments).
  @Field var probeBytes: Double = 0
  @Field var analyzeMs: Double = 0
  @Field var progressive: Bool = false
}

struct NowPlayingRecord: Record {
  @Field var title: String = ""
  @Field var subtitle: String = ""
  @Field var artwork: String = ""
}

// System volume has no public setter; the slider inside an off-screen MPVolumeView is the
// sanctioned way (no HUD while it's in the hierarchy).
@MainActor
enum VolumeControl {
  private static var view: MPVolumeView?

  private static func slider() -> UISlider? {
    if view == nil {
      let v = MPVolumeView(frame: CGRect(x: -2000, y: -2000, width: 10, height: 10))
      v.alpha = 0.01
      let window = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first
      window?.addSubview(v)
      view = v
    }
    return view?.subviews.compactMap { $0 as? UISlider }.first
  }

  static func get() -> Float { AVAudioSession.sharedInstance().outputVolume }

  static func set(_ value: Float) {
    let s = slider()
    // The slider attaches its target lazily; set on the next runloop turn.
    Task { @MainActor in s?.setValue(max(0, min(1, value)), animated: false) }
  }
}

public class MediahubPlayerModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MediahubPlayer")

    // A PiP window outlived its player screen and the user tapped "restore": JS reopens the player.
    Events("onPiPRestore", "onEngineLog")

    OnCreate {
      // Runtime 4: forward AetherEngine's startup / network diagnostics (open timings, first data,
      // redirect caching, stalls, prewarm) to JS so playback speed can be tracked per play. Only
      // matching lines, URLs cut to their host (115 links carry tokens), at most 40 per second.
      let lock = NSLock()
      var windowStart = Date()
      var sent = 0
      let wanted = ["[Demuxer] open timings", "[SourceOpen]", "first data after", "Cached resolved URL",
                    "Dropped resolved URL", "stall", "[SourcePrewarm]", "reconnect", "protocol"]
      EngineLog.handler = { [weak self] line in
        guard let self, wanted.contains(where: { line.contains($0) }) else { return }
        // The handler runs on whatever thread logged; the rate counter is shared.
        lock.lock()
        let now = Date()
        if now.timeIntervalSince(windowStart) > 1 { windowStart = now; sent = 0 }
        sent += 1
        let over = sent > 40
        lock.unlock()
        guard !over else { return }
        let clean = line.replacingOccurrences(of: #"https?://([^/\s:]+)[^\s]*"#, with: "$1", options: .regularExpression)
        self.sendEvent("onEngineLog", ["line": String(clean.prefix(400))])
      }
      MediahubPlayerView.onDetachedRestore = { [weak self] itemId, position in
        self?.sendEvent("onPiPRestore", ["itemId": itemId, "position": position])
      }
    }

    // What this binary and device can do; JS checks it before offering a feature (OTA code may run on older binaries).
    // These closures run on the main queue (runOnQueue(.main)); assumeIsolated makes that explicit
    // for the main-actor APIs they call.
    AsyncFunction("capabilities") { () -> [String: Any] in
      let d = MainActor.assumeIsolated { AetherEngine.displayCapabilities }
      return [
        "module": 5,
        "ssdp": true,
        "prewarm": true,
        "startupEvents": true,
        "engineLog": true,
        "pip": AVPictureInPictureController.isPictureInPictureSupported(),
        "airplay": true,
        "addSubtitle": true,
        "brightness": true,
        "volume": true,
        "nowPlaying": true,
        "hdr": d.supportsHDR,
        "hdr10": d.supportsHDR10,
        "dolbyVision": d.supportsDolbyVision,
        "hlg": d.supportsHLG,
        "engine": AetherEngine.version,
      ]
    }.runOnQueue(.main)

    // Runtime 4: fetch a source's opening bytes before the player opens it (AetherEngine #551); the
    // next load() of the exact same URL takes them. Returns what was kept, or why nothing was.
    AsyncFunction("prewarm") { (uri: String, headers: [String: String]) async -> [String: Any] in
      guard let url = URL(string: uri) else { return ["bytes": 0, "declined": "bad url"] }
      let r = await AetherEngine.prewarm(url: url, httpHeaders: headers)
      return ["bytes": r.retainedBytes, "declined": r.declined ?? ""]
    }

    // Runtime 5: find DLNA renderers (TVs) on the Wi-Fi for casting.
    AsyncFunction("ssdpScan") { (timeoutMs: Int) async -> [[String: String]] in
      await Task.detached { Ssdp.scan(timeoutMs: timeoutMs) }.value
    }

    AsyncFunction("getBrightness") { () -> Double in
      Double(UIScreen.main.brightness)
    }.runOnQueue(.main)

    AsyncFunction("setBrightness") { (value: Double) in
      UIScreen.main.brightness = CGFloat(max(0, min(1, value)))
    }.runOnQueue(.main)

    AsyncFunction("getVolume") { () -> Double in
      Double(MainActor.assumeIsolated { VolumeControl.get() })
    }.runOnQueue(.main)

    AsyncFunction("setVolume") { (value: Double) in
      MainActor.assumeIsolated { VolumeControl.set(Float(value)) }
    }.runOnQueue(.main)

    View(MediahubPlayerView.self) {
      Events("onPhase", "onProgress", "onTracks", "onInfo", "onEnded", "onError", "onPiP", "onStartup")

      Prop("source") { (view: MediahubPlayerView, source: PlayerSourceRecord?) in
        view.setSource(source)
      }
      Prop("paused") { (view: MediahubPlayerView, paused: Bool) in
        view.setPaused(paused)
      }
      Prop("rate") { (view: MediahubPlayerView, rate: Double) in
        view.setRate(Float(rate))
      }
      Prop("subtitleScale") { (view: MediahubPlayerView, scale: Double) in
        view.subtitleScale = CGFloat(scale)
      }
      Prop("autoPiP") { (view: MediahubPlayerView, on: Bool) in
        view.autoPiP = on
      }
      Prop("itemId") { (view: MediahubPlayerView, id: String) in
        view.itemId = id
      }
      Prop("nowPlaying") { (view: MediahubPlayerView, np: NowPlayingRecord?) in
        view.nowPlaying = np
      }

      AsyncFunction("seek") { (view: MediahubPlayerView, seconds: Double) in
        view.seek(seconds)
      }
      AsyncFunction("selectAudio") { (view: MediahubPlayerView, id: Int) in
        view.selectAudio(id)
      }
      // id < 0 turns subtitles off.
      AsyncFunction("selectSubtitle") { (view: MediahubPlayerView, id: Int) in
        view.selectSubtitle(id)
      }
      AsyncFunction("addSubtitle") { (view: MediahubPlayerView, sub: ExternalSubtitleRecord) -> Int in
        view.addSubtitle(sub)
      }
      AsyncFunction("togglePiP") { (view: MediahubPlayerView) in
        view.startPiP()
      }
      AsyncFunction("stop") { (view: MediahubPlayerView) in
        view.stopPlayback()
      }
    }
  }
}
