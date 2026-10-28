import AVKit
import ExpoModulesCore

// System AirPlay picker (AVRoutePickerView); the player's AVPlayer allows external playback,
// so picking a TV or speaker routes the picture/audio there.
final class MediahubAirPlayView: ExpoView {
  private let picker = AVRoutePickerView()

  var tint: UIColor = .white {
    didSet { picker.tintColor = tint }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    picker.tintColor = tint
    picker.activeTintColor = UIColor(red: 0.91, green: 0.69, blue: 0.29, alpha: 1)
    picker.prioritizesVideoDevices = true
    picker.frame = bounds
    picker.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(picker)
  }
}

public class MediahubAirPlayModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MediahubAirPlay")
    View(MediahubAirPlayView.self) {
      Prop("tint") { (view: MediahubAirPlayView, color: UIColor) in
        view.tint = color
      }
    }
  }
}
