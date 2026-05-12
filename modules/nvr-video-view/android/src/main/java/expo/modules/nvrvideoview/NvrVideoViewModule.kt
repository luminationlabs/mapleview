package expo.modules.nvrvideoview

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class NvrVideoViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NvrVideoView")

    Function("getVersion") {
      "0.0.1-dummy"
    }

    Events("onFeed")

    View(NvrVideoView::class) {
      Prop("backgroundHex") { view: NvrVideoView, hex: String ->
        view.setBackgroundHex(hex)
      }

      AsyncFunction("feed") { view: NvrVideoView, data: ByteArray, isKeyframe: Boolean, pts: Double ->
        view.feed(data, isKeyframe, pts)
      }

      AsyncFunction("flush") { view: NvrVideoView ->
        view.flush()
      }
    }
  }
}
