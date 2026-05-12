package expo.modules.nvrvideoview

import android.content.Context
import android.graphics.Color
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class NvrVideoView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onFeed by EventDispatcher()

  private val label = TextView(context).apply {
    setTextColor(Color.WHITE)
    gravity = Gravity.CENTER
    text = "NvrVideoView (dummy)\nwaiting for feed()…"
  }

  init {
    setBackgroundColor(Color.parseColor("#3a32a8"))
    addView(
      label,
      FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
      ),
    )
  }

  fun setBackgroundHex(hex: String) {
    val normalized = if (hex.startsWith("#")) hex else "#$hex"
    try {
      setBackgroundColor(Color.parseColor(normalized))
    } catch (_: IllegalArgumentException) {
      // ignore bad input, keep previous color
    }
  }

  fun feed(data: ByteArray, isKeyframe: Boolean, pts: Double) {
    label.post {
      label.text = "feed(${data.size} bytes, key=$isKeyframe, pts=${pts.toLong()})"
    }
    onFeed(
      mapOf(
        "bytes" to data.size,
        "isKeyframe" to isKeyframe,
        "pts" to pts,
      ),
    )
  }

  fun flush() {
    label.post { label.text = "flushed" }
  }
}
