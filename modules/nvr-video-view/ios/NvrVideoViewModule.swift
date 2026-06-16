import ExpoModulesCore

public class NvrVideoViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NvrVideoView")

    // Module-level function — proves module plumbing works.
    Function("getVersion") {
      return "0.0.1-dummy"
    }

    View(NvrVideoView.self) {
      // Events emitted by the view. Declared inside View() — view event
      // names are collected from the View definition only; a module-level
      // Events() call does not register them as view props.
      //   onError     — fires when the decoder hits a recoverable or fatal
      //                 failure. See NvrVideoView.swift `emitError` for
      //                 codes. De-duplicated so a persistent failure
      //                 doesn't flood the bridge.
      //   onVideoSize — fires when the stream's presentation dimensions
      //                 become known or change (SPS parsed on a keyframe).
      //                 Drives the JS pinch-zoom pan clamp.
      // onFeed (the per-frame EventDispatcher in NvrVideoView.swift) is
      // deliberately NOT declared: declaring a view event installs a live
      // dispatch handler at view creation, so every feed() would convert
      // its payload and hop to the JS thread even with no JS listener —
      // per frame, per grid tile. Undeclared, the dispatcher's handler
      // stays nil and the call is a free no-op. Declare it only when
      // something on the JS side actually consumes it.
      Events("onError", "onVideoSize")

      // Simple prop — drives the view's background color.
      Prop("backgroundHex") { (view: NvrVideoView, hex: String) in
        view.setBackgroundHex(hex)
      }

      // Ref-callable method taking binary data. This is the exact shape
      // the real view will use to receive NAL units.
      AsyncFunction("feed") { (view: NvrVideoView, data: Data, isKeyframe: Bool, pts: Double) in
        view.feed(data: data, isKeyframe: isKeyframe, pts: pts)
      }

      // `targetPts` arms the seek-target gate so pending pre-scrub feeds
      // that execute after flush() runs are dropped instead of re-populating
      // the layer. 0 = no gate (used by non-scrub flushes like mode-upgrade
      // resync).
      AsyncFunction("flush") { (view: NvrVideoView, targetPts: Double) in
        view.flush(targetPts: targetPts)
      }

      AsyncFunction("setSpeed") { (view: NvrVideoView, speed: Double) in
        view.setSpeed(speed)
      }

      // Arm the keyframe gate so non-IDR samples are dropped until the
      // next keyframe. Used by useCamera on re-attach to cover the case
      // where the detach-grace sink-no-op consumed the most recent IDR
      // and the next sink delivery would otherwise be a stale-reference
      // P-frame (green frame).
      AsyncFunction("markPotentialGap") { (view: NvrVideoView) in
        view.markPotentialGap()
      }
    }
  }
}
