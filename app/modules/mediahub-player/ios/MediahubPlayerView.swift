import AVFoundation
import AVKit
import AetherEngine
import Combine
import ExpoModulesCore
import MediaPlayer
import UIKit

/// Backing layer IS an AVPlayerLayer: PiP on the native route runs on this second layer bound to the
/// engine's AVPlayer (same player, decode happens once), like Sodalite's PlayerPiPController.
final class PiPSourceView: UIView {
  override class var layerClass: AnyClass { AVPlayerLayer.self }
  var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

// One AetherEngine per player view. JS owns the controls; this view owns the picture, the
// subtitle overlay (the engine hands cues to the host on its FFmpeg routes), Picture in Picture,
// Now Playing / lock-screen controls and the event stream.
final class MediahubPlayerView: ExpoView {
  let onPhase = EventDispatcher()
  let onProgress = EventDispatcher()
  let onTracks = EventDispatcher()
  let onInfo = EventDispatcher()
  let onEnded = EventDispatcher()
  let onError = EventDispatcher()
  let onPiP = EventDispatcher()
  let onStartup = EventDispatcher()
  private var loadStartedAt = Date()

  /// The one view allowed to play: starting a source in another view stops this one (a small window
  /// left running by a closed screen, or a restored window reopening the player, must not play twice).
  nonisolated(unsafe) static weak var playing: MediahubPlayerView?
  /// Keeps a player alive while its PiP window is open after the React screen unmounted it.
  nonisolated(unsafe) static var pipKeeper: MediahubPlayerView?
  /// Called by the module to tell JS that the user tapped "restore" on a detached PiP window.
  nonisolated(unsafe) static var onDetachedRestore: ((_ itemId: String, _ position: Double) -> Void)?

  var subtitleScale: CGFloat = 1 {
    didSet { renderSubtitles(at: lastSourceTime, force: true) }
  }
  var autoPiP = true {
    didSet { pip?.canStartPictureInPictureAutomaticallyFromInline = autoPiP }
  }
  var itemId = ""
  var nowPlaying: NowPlayingRecord? {
    didSet { applyNowPlaying() }
  }

  private let surface = AetherPlayerView()
  private let pipSource = PiPSourceView()
  private let subtitleLabel = UILabel()
  private let subtitleImage = UIImageView()
  private var engine: AetherEngine?
  private var bag = Set<AnyCancellable>()
  private var loadTask: Task<Void, Never>?
  private var currentURI: String?
  private var paused = false
  private var rate: Float = 1
  private var loaded = false
  private var endedSent = false
  private var cues: [SubtitleCue] = []
  private var shownCueId: Int?
  private var lastSourceTime: Double = 0
  private var pip: AVPictureInPictureController?
  private var pipSoftware: SoftwarePiPSource?
  private var pipPossible: NSKeyValueObservation?
  private var commandsBound: MPRemoteCommandCenter?
  private var artwork: MPMediaItemArtwork?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .black
    clipsToBounds = true
    for v in [surface, pipSource] as [UIView] {
      v.frame = bounds
      v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      addSubview(v)
    }
    pipSource.isUserInteractionEnabled = false
    pipSource.playerLayer.videoGravity = .resizeAspect

    subtitleLabel.numberOfLines = 0
    subtitleLabel.textAlignment = .center
    subtitleLabel.isHidden = true
    addSubview(subtitleLabel)
    subtitleImage.contentMode = .scaleToFill
    subtitleImage.isHidden = true
    addSubview(subtitleImage)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    renderSubtitles(at: lastSourceTime, force: true)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window == nil else { return }
    if pip?.isPictureInPictureActive == true {
      // The screen closed while the small window plays on: keep the engine alive until it closes.
      MediahubPlayerView.pipKeeper = self
    } else {
      stopPlayback()
    }
  }

  // MARK: - Props

  func setSource(_ source: PlayerSourceRecord?) {
    guard let source, !source.uri.isEmpty, let url = URL(string: source.uri) else {
      stopPlayback()
      return
    }
    if source.uri == currentURI { return }
    if let other = MediahubPlayerView.playing, other !== self {
      other.stopPlayback()
    }
    MediahubPlayerView.playing = self
    currentURI = source.uri
    guard let engine = ensureEngine() else { return }
    loadTask?.cancel()
    loaded = false
    endedSent = false
    cues = []
    renderSubtitles(at: 0, force: true)

    var options = LoadOptions(httpHeaders: source.headers)
    options.preferredAudioLanguages = source.audioLanguages
    options.preferredSubtitleLanguages = source.subtitleLanguages
    options.autoplay = !paused
    options.externalSubtitles = source.externalSubtitles.compactMap { sub in
      guard let u = URL(string: sub.uri) else { return nil }
      return ExternalSubtitleTrack(url: u, name: sub.name.isEmpty ? nil : sub.name,
                                   language: sub.language.isEmpty ? nil : sub.language,
                                   httpHeaders: source.headers.merging(sub.headers) { _, b in b })
    }
    // Startup tuning for remote sources (115 CDN via ge2o): a smaller probe budget ends
    // find_stream_info sooner on MKVs with sparse PGS / cover-art streams; progressive delivery lets
    // AVPlayer start on a segment's first fragment instead of the whole ~4 s segment.
    if source.probeBytes > 0 { options.probesize = Int64(source.probeBytes) }
    if source.analyzeMs > 0 { options.maxAnalyzeDuration = Int64(source.analyzeMs * 1000) }
    options.progressiveSegmentDelivery = source.progressive
    loadStartedAt = Date()
    let start = source.startPosition > 1 ? source.startPosition : nil
    loadTask = Task { @MainActor [weak self] in
      do {
        try await engine.load(url: url, startPosition: start, options: options)
        guard let self, !Task.isCancelled else { return }
        self.loaded = true
        if self.rate != 1 { engine.setRate(self.rate) }
        if self.paused { engine.pause() } else { engine.play() }
        self.applyNowPlaying()
      } catch {
        guard let self, !Task.isCancelled else { return }
        self.onError(["message": String(describing: error)])
      }
    }
  }

  func setPaused(_ value: Bool) {
    paused = value
    guard loaded, let engine else { return }
    if value { engine.pause() } else { engine.play() }
  }

  func setRate(_ value: Float) {
    rate = value
    guard loaded, let engine else { return }
    engine.setRate(value)
  }

  // MARK: - Commands

  func seek(_ seconds: Double) {
    guard let engine else { return }
    endedSent = false
    Task { @MainActor in await engine.seek(to: seconds) }
  }

  func selectAudio(_ id: Int) {
    engine?.selectAudioTrack(index: id)
  }

  func selectSubtitle(_ id: Int) {
    guard let engine else { return }
    if id < 0 {
      engine.clearSubtitle()
      cues = []
      renderSubtitles(at: lastSourceTime, force: true)
    } else {
      engine.selectSubtitleTrack(index: id)
    }
  }

  /// Registers a subtitle file found next to the video and selects it. Returns the new track id.
  func addSubtitle(_ sub: ExternalSubtitleRecord) -> Int {
    guard let engine, let url = URL(string: sub.uri) else { return -1 }
    let track = engine.addExternalSubtitleTrack(ExternalSubtitleTrack(
      url: url, name: sub.name.isEmpty ? nil : sub.name, language: sub.language.isEmpty ? nil : sub.language,
      httpHeaders: sub.headers.isEmpty ? nil : sub.headers))
    engine.selectSubtitleTrack(index: track.id)
    return track.id
  }

  func startPiP() {
    guard let pip else {
      onPiP(["active": false, "error": "这个视频暂时不能小窗播放"])
      return
    }
    if pip.isPictureInPictureActive { pip.stopPictureInPicture() } else { pip.startPictureInPicture() }
  }

  func stopPlayback() {
    loadTask?.cancel()
    loadTask = nil
    currentURI = nil
    loaded = false
    pip?.stopPictureInPicture()
    engine?.stop()
    if MediahubPlayerView.pipKeeper === self { MediahubPlayerView.pipKeeper = nil }
    if MediahubPlayerView.playing === self { MediahubPlayerView.playing = nil }
  }

  // MARK: - Engine

  private func ensureEngine() -> AetherEngine? {
    if let engine { return engine }
    do {
      let e = try AetherEngine()
      e.videoGravity = .resizeAspect
      e.backgroundPlaybackEnabled = true
      // Lock screen / Control Center transport for both routes (read when a host is created).
      e.ownsVideoNowPlayingSession = true
      e.ownsSoftwareNowPlaying = true
      e.remoteSkipInterval = 15
      e.bind(view: surface)
      engine = e
      observe(e)
      return e
    } catch {
      onError(["message": "播放器初始化失败：\(error)"])
      return nil
    }
  }

  private func observe(_ e: AetherEngine) {
    e.$playbackPhase
      .removeDuplicates()
      .receive(on: DispatchQueue.main)
      .sink { [weak self] phase in self?.emitPhase(phase) }
      .store(in: &bag)

    // Each startup checkpoint with ms since this load began, so JS can log where the time went.
    e.$startupProgress
      .compactMap { $0 }
      .removeDuplicates()
      .receive(on: DispatchQueue.main)
      .sink { [weak self] p in
        guard let self else { return }
        self.onStartup(["step": String(describing: p.checkpoint), "ms": Int(Date().timeIntervalSince(self.loadStartedAt) * 1000)])
      }
      .store(in: &bag)

    e.$state
      .receive(on: DispatchQueue.main)
      .sink { [weak self] state in
        guard let self else { return }
        switch state {
        case .ended where !self.endedSent:
          self.endedSent = true
          self.onEnded()
        case .error(let message):
          self.onError(["message": message])
        default:
          break
        }
      }
      .store(in: &bag)

    e.clock.$currentTime
      .throttle(for: .milliseconds(250), scheduler: DispatchQueue.main, latest: true)
      .sink { [weak self, weak e] t in
        guard let self, let e else { return }
        self.onProgress(["position": t, "duration": e.duration, "buffered": e.clock.bufferedPosition])
      }
      .store(in: &bag)

    e.clock.$sourceTime
      .receive(on: DispatchQueue.main)
      .sink { [weak self] t in self?.renderSubtitles(at: t, force: false) }
      .store(in: &bag)

    e.$subtitleCues
      .receive(on: DispatchQueue.main)
      .sink { [weak self] list in
        guard let self else { return }
        self.cues = list
        self.renderSubtitles(at: self.lastSourceTime, force: true)
      }
      .store(in: &bag)

    Publishers.CombineLatest4(e.$audioTracks, e.$subtitleTracks, e.$activeAudioTrackIndex, e.$activeSubtitleTrackIndex)
      .debounce(for: .milliseconds(150), scheduler: DispatchQueue.main)
      .sink { [weak self] audio, subs, activeAudio, activeSub in
        self?.onTracks([
          "audio": audio.map(Self.track),
          "subtitles": subs.map(Self.track),
          "activeAudio": activeAudio ?? -1,
          "activeSubtitle": activeSub ?? -1,
        ])
      }
      .store(in: &bag)

    Publishers.CombineLatest3(e.$videoFormat, e.$activeVideoDecoder, e.$activeAudioDecoder)
      .debounce(for: .milliseconds(300), scheduler: DispatchQueue.main)
      .sink { [weak self, weak e] format, vdec, adec in
        self?.onInfo([
          "videoFormat": Self.formatName(format),
          "videoDecoder": vdec ?? "",
          "audioDecoder": adec ?? "",
          "codec": e?.sourceVideoCodecName ?? "",
          "container": e?.sourceContainerFormat ?? "",
          "route": e.map { String(describing: $0.videoRoute) } ?? "",
        ])
      }
      .store(in: &bag)

    // PiP follows whichever pipeline serves the session.
    e.$currentAVPlayer
      .receive(on: DispatchQueue.main)
      .sink { [weak self] player in
        self?.bindPiP(player: player)
        self?.bindRemoteCommands()
      }
      .store(in: &bag)
    e.$softwarePiPSource
      .receive(on: DispatchQueue.main)
      .sink { [weak self] source in self?.bindPiP(software: source) }
      .store(in: &bag)
  }

  // MARK: - Picture in Picture

  private func makeController(_ pip: AVPictureInPictureController) {
    pip.delegate = self
    pip.canStartPictureInPictureAutomaticallyFromInline = autoPiP
    self.pip = pip
    pipPossible = pip.observe(\.isPictureInPicturePossible, options: [.new, .initial]) { [weak self] p, _ in
      let possible = p.isPictureInPicturePossible
      let active = p.isPictureInPictureActive
      Task { @MainActor in self?.onPiP(["active": active, "possible": possible]) }
    }
  }

  private func dropController() {
    pipPossible?.invalidate()
    pipPossible = nil
    pip = nil
  }

  private func bindPiP(player: AVPlayer?) {
    guard AVPictureInPictureController.isPictureInPictureSupported() else { return }
    if pipSoftware != nil, player == nil { return }
    guard let player else {
      // A reload publishes a nil gap before the fresh player; keep an open window across it.
      if pip?.isPictureInPictureActive != true {
        pipSource.playerLayer.player = nil
        dropController()
      }
      return
    }
    pipSource.playerLayer.player = player
    guard pip == nil, let c = AVPictureInPictureController(playerLayer: pipSource.playerLayer) else { return }
    makeController(c)
  }

  private func bindPiP(software source: SoftwarePiPSource?) {
    guard AVPictureInPictureController.isPictureInPictureSupported() else { return }
    guard let source else {
      guard pipSoftware != nil else { return }
      pipSoftware = nil
      if pip?.isPictureInPictureActive != true { dropController() }
      return
    }
    pipSoftware = source
    let content = AVPictureInPictureController.ContentSource(sampleBufferDisplayLayer: source.layer, playbackDelegate: self)
    if let existing = pip {
      if existing.isPictureInPictureActive { existing.contentSource = content }
      return
    }
    makeController(AVPictureInPictureController(contentSource: content))
  }

  /// While the small window plays, the inline view shows nothing (JS draws a placeholder). On the
  /// native route PiP runs on `pipSource`, which iOS blanks by itself, but the engine's own layer on
  /// `surface` shows the same AVPlayer and kept rendering; on the software route the window uses the
  /// engine's display layer itself, so only the subtitle overlay is hidden there.
  private func setInlineHidden(_ hidden: Bool) {
    if pipSoftware == nil { surface.isHidden = hidden }
    if hidden {
      subtitleLabel.isHidden = true
      subtitleImage.isHidden = true
    } else {
      renderSubtitles(at: lastSourceTime, force: true)
    }
  }

  // MARK: - Now Playing

  private func applyNowPlaying() {
    guard let engine, let np = nowPlaying else { return }
    var info: [String: Any] = [MPMediaItemPropertyTitle: np.title]
    if !np.subtitle.isEmpty { info[MPMediaItemPropertyArtist] = np.subtitle }
    if let artwork { info[MPMediaItemPropertyArtwork] = artwork }
    engine.setVideoNowPlayingInfo(info)
    if artwork == nil, let u = URL(string: np.artwork), !np.artwork.isEmpty {
      URLSession.shared.dataTask(with: u) { [weak self] data, _, _ in
        guard let data, let image = UIImage(data: data) else { return }
        Task { @MainActor in
          guard let self else { return }
          self.artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
          self.applyNowPlaying()
        }
      }.resume()
    }
  }

  private func bindRemoteCommands() {
    guard let engine, let center = engine.videoNowPlayingSession?.remoteCommandCenter, center !== commandsBound else { return }
    commandsBound = center
    // Remote commands arrive on the main thread; hop explicitly so the MainActor engine API is legal.
    center.playCommand.addTarget { [weak engine] _ in
      Task { @MainActor in engine?.play() }
      return .success
    }
    center.pauseCommand.addTarget { [weak engine] _ in
      Task { @MainActor in engine?.pause() }
      return .success
    }
    center.togglePlayPauseCommand.addTarget { [weak engine] _ in
      Task { @MainActor in engine?.togglePlayPause() }
      return .success
    }
    center.skipForwardCommand.preferredIntervals = [15]
    center.skipForwardCommand.addTarget { [weak engine] _ in
      Task { @MainActor in
        guard let engine else { return }
        await engine.seek(to: engine.clock.currentTime + 15)
      }
      return .success
    }
    center.skipBackwardCommand.preferredIntervals = [15]
    center.skipBackwardCommand.addTarget { [weak engine] _ in
      Task { @MainActor in
        guard let engine else { return }
        await engine.seek(to: max(0, engine.clock.currentTime - 15))
      }
      return .success
    }
    center.changePlaybackPositionCommand.addTarget { [weak engine] event in
      guard let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      let t = e.positionTime
      Task { @MainActor in await engine?.seek(to: t) }
      return .success
    }
    applyNowPlaying()
  }

  // MARK: - Events

  private func emitPhase(_ phase: PlaybackPhase) {
    var payload: [String: Any] = [:]
    switch phase {
    case .idle: payload["phase"] = "idle"
    case .loading: payload["phase"] = "loading"
    case .playing: payload["phase"] = "playing"
    case .paused: payload["phase"] = "paused"
    case .seeking: payload["phase"] = "seeking"
    case .rebuffering: payload["phase"] = "buffering"
    case .stalled(let reconnecting):
      payload["phase"] = "stalled"
      payload["reconnecting"] = reconnecting
    case .ended: payload["phase"] = "ended"
    case .error(let message):
      payload["phase"] = "error"
      payload["message"] = message
    }
    onPhase(payload)
  }

  private static func track(_ t: TrackInfo) -> [String: Any] {
    [
      "id": t.id, "name": t.name, "codec": t.codec, "language": t.language ?? "",
      "channels": t.channels, "isDefault": t.isDefault, "isForced": t.isForced,
      "isAtmos": t.isAtmos, "isExternal": t.isExternal,
    ]
  }

  private static func formatName(_ f: VideoFormat) -> String {
    switch f {
    case .sdr: return "SDR"
    case .hdr10: return "HDR10"
    case .hdr10Plus: return "HDR10+"
    case .dolbyVision: return "Dolby Vision"
    case .hlg: return "HLG"
    }
  }

  // MARK: - Subtitles

  private func renderSubtitles(at time: Double, force: Bool) {
    lastSourceTime = time
    if engine?.pictureInPictureActive == true {
      subtitleLabel.isHidden = true
      subtitleImage.isHidden = true
      return
    }
    let cue = cues.last { $0.startTime <= time && time < $0.endTime }
    if !force && cue?.id == shownCueId { return }
    shownCueId = cue?.id
    guard let cue else {
      subtitleLabel.isHidden = true
      subtitleImage.isHidden = true
      return
    }
    switch cue.body {
    case .image(let image):
      subtitleLabel.isHidden = true
      showImage(image)
    default:
      subtitleImage.isHidden = true
      showText(cue.text ?? "")
    }
  }

  private func showText(_ text: String) {
    let clean = text.replacingOccurrences(of: "\\N", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    if clean.isEmpty {
      subtitleLabel.isHidden = true
      return
    }
    let size = max(15, min(bounds.width, bounds.height) * 0.055) * subtitleScale
    let shadow = NSShadow()
    shadow.shadowColor = UIColor.black.withAlphaComponent(0.9)
    shadow.shadowBlurRadius = 3
    shadow.shadowOffset = CGSize(width: 0, height: 1)
    subtitleLabel.attributedText = NSAttributedString(string: clean, attributes: [
      .font: UIFont.systemFont(ofSize: size, weight: .semibold),
      .foregroundColor: UIColor.white,
      .strokeColor: UIColor.black,
      .strokeWidth: -2.5,
      .shadow: shadow,
    ])
    let maxWidth = bounds.width * 0.9
    let fit = subtitleLabel.sizeThatFits(CGSize(width: maxWidth, height: .greatestFiniteMagnitude))
    let bottomInset = max(safeAreaInsets.bottom, 12) + bounds.height * 0.04
    subtitleLabel.frame = CGRect(x: (bounds.width - fit.width) / 2, y: bounds.height - bottomInset - fit.height,
                                 width: fit.width, height: fit.height)
    subtitleLabel.isHidden = false
  }

  // Bitmap cues (PGS / DVB / VobSub) are positioned on the video canvas; map that canvas onto
  // the aspect-fit video rect inside this view.
  private func showImage(_ image: SubtitleImage) {
    let canvas = image.canvasSize.width > 0 ? image.canvasSize : CGSize(width: 1920, height: 1080)
    let scale = min(bounds.width / canvas.width, bounds.height / canvas.height)
    let video = CGRect(x: (bounds.width - canvas.width * scale) / 2, y: (bounds.height - canvas.height * scale) / 2,
                       width: canvas.width * scale, height: canvas.height * scale)
    let p = image.position
    subtitleImage.image = UIImage(cgImage: image.cgImage)
    subtitleImage.frame = CGRect(x: video.minX + p.minX * scale, y: video.minY + p.minY * scale,
                                 width: p.width * scale * subtitleScale, height: p.height * scale * subtitleScale)
    subtitleImage.isHidden = false
  }
}

extension MediahubPlayerView: @preconcurrency AVPictureInPictureControllerDelegate {
  func pictureInPictureControllerWillStartPictureInPicture(_ c: AVPictureInPictureController) {
    engine?.pictureInPictureActive = true
    setInlineHidden(true)
  }

  func pictureInPictureControllerDidStartPictureInPicture(_ c: AVPictureInPictureController) {
    onPiP(["active": true, "possible": true])
  }

  func pictureInPictureController(_ c: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error) {
    engine?.pictureInPictureActive = false
    setInlineHidden(false)
    onPiP(["active": false, "error": error.localizedDescription])
  }

  func pictureInPictureController(_ c: AVPictureInPictureController,
                                  restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
    if window == nil {
      // The player screen is gone: let JS reopen it at this position, then end this session.
      MediahubPlayerView.onDetachedRestore?(itemId, engine?.clock.currentTime ?? 0)
    }
    completionHandler(true)
  }

  func pictureInPictureControllerWillStopPictureInPicture(_ c: AVPictureInPictureController) {
    // Bring the inline picture back before the window animates home, so it lands on a live frame.
    setInlineHidden(false)
  }

  func pictureInPictureControllerDidStopPictureInPicture(_ c: AVPictureInPictureController) {
    engine?.pictureInPictureActive = false
    setInlineHidden(false)
    onPiP(["active": false, "possible": c.isPictureInPicturePossible])
    if window == nil { stopPlayback() }
  }
}

extension MediahubPlayerView: @preconcurrency AVPictureInPictureSampleBufferPlaybackDelegate {
  func pictureInPictureController(_ c: AVPictureInPictureController, setPlaying playing: Bool) {
    pipSoftware?.setPlaying(playing)
  }

  func pictureInPictureControllerTimeRangeForPlayback(_ c: AVPictureInPictureController) -> CMTimeRange {
    pipSoftware?.timeRange() ?? CMTimeRange(start: .negativeInfinity, duration: .positiveInfinity)
  }

  func pictureInPictureControllerIsPlaybackPaused(_ c: AVPictureInPictureController) -> Bool {
    pipSoftware?.isPaused ?? true
  }

  func pictureInPictureController(_ c: AVPictureInPictureController, didTransitionToRenderSize newRenderSize: CMVideoDimensions) {}

  func pictureInPictureController(_ c: AVPictureInPictureController, skipByInterval skipInterval: CMTime, completion completionHandler: @escaping () -> Void) {
    pipSoftware?.skip(by: skipInterval.seconds)
    completionHandler()
  }
}
