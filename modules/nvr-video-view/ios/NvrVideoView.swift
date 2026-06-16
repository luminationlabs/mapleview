import ExpoModulesCore
import UIKit
import AVFoundation
import CoreMedia
import VideoToolbox

final class NvrVideoView: ExpoView {
  let onFeed = EventDispatcher()

  // MARK: – Error reporting
  //
  // onError fires when the decoder hits a recoverable or unrecoverable
  // failure. JS can react (show a "decoder failure — retry" overlay,
  // log to a tracker, etc.). De-duplicated by code so a persistent
  // failure doesn't flood the bridge — same code is suppressed until a
  // successful feed clears the latch (or a different code fires).
  //
  // Codes:
  //   "timebase_init"     — CMTimebase creation failed at init. Fatal.
  //   "layer_failed"      — AVSampleBufferDisplayLayer entered .failed.
  //                         feed() auto-clears formatDescription and
  //                         re-anchors on the next keyframe.
  //   "format_description"— CMVideoFormatDescriptionCreateFromH264/HEVC
  //                         ParameterSets failed. Next keyframe retries.
  //   "sample_buffer"     — CMBlockBuffer / CMSampleBufferCreateReady
  //                         failed. Likely memory pressure.
  let onError = EventDispatcher()
  private var lastErrorCode: String?

  // MARK: – Video size reporting
  //
  // onVideoSize fires when the stream's presentation dimensions become
  // known or change (SPS/VPS parsed into a new format description on a
  // keyframe). JS uses this to clamp pinch-zoom panning against the real
  // displayed image box — stream aspect ratios vary (sub-streams are
  // often 4:3), so the JS side must not assume 16:9. Presentation
  // dimensions are pixel-aspect-ratio and clean-aperture corrected,
  // matching what `.resizeAspect` actually displays. De-duplicated by
  // value: extractParameterSets rebuilds the format description on every
  // keyframe, but the size only crosses the bridge when it changes.
  let onVideoSize = EventDispatcher()
  private var lastReportedVideoSize: CGSize?

  private func reportVideoSize(_ fmt: CMFormatDescription) {
    let size = CMVideoFormatDescriptionGetPresentationDimensions(
      fmt,
      usePixelAspectRatio: true,
      useCleanAperture: true
    )
    guard size.width > 0, size.height > 0, size != lastReportedVideoSize else { return }
    lastReportedVideoSize = size
    onVideoSize([
      "width": Double(size.width),
      "height": Double(size.height),
    ])
  }

  private func emitError(_ code: String, _ message: String) {
    if lastErrorCode == code { return }
    lastErrorCode = code
    print("[NvrVideoView] error \(code): \(message)")
    onError([
      "code": code,
      "message": message,
    ])
  }

  // MARK: – Display layer

  private let displayLayer = AVSampleBufferDisplayLayer()

  /// Timebase controlling when the display layer shows each sample. We anchor
  /// it to the first frame's PTS (in the sample PTS timescale) and run at
  /// rate 1.0, so the layer paces frames by PTS instead of rendering the
  /// whole flow-control burst at once (`displayImmediately`).
  private var controlTimebase: CMTimebase?

  /// Sample PTS timescale. The JS side passes PTS as 100-ns FILETIME ticks,
  /// so a timescale of 10,000,000 means CMTime.value = pts directly.
  private let ptsTimescale: CMTimeScale = 10_000_000

  /// If true, the next delivered frame will re-anchor the timebase. Set on
  /// construction, on flush(), and whenever a PTS discontinuity is detected
  /// (seek, new task, stream restart).
  private var needsTimebaseAnchor = true

  /// Re-anchor threshold — if an incoming frame's PTS is this far from the
  /// current timebase time, treat it as a discontinuity and rebase. Keyframe-
  /// only mode at 8x advances the timebase ~40s of video per 5s wall, so this
  /// window has to be wide enough to tolerate a few seconds of network stall
  /// without spuriously rebasing to a stale frame.
  private let timebaseDiscontinuitySeconds: Double = 30.0

  // MARK: – Decoder state

  /// Current format description built from SPS/PPS (H.264) or VPS/SPS/PPS (H.265).
  private var formatDescription: CMFormatDescription?

  /// True when we detected H.265 (HEVC) NAL types; false for H.264.
  private var isHEVC = false

  /// PTS of the previous frame, used to compute per-sample duration. Without
  /// an explicit duration the layer may not pace correctly under concurrent
  /// load — it defaults to rendering immediately in burst scenarios.
  private var previousPts: Double = 0

  /// When true, non-keyframe samples are dropped until the next IDR resets
  /// the decoder's reference chain. Set after any delivery gap so we never
  /// show a green frame from a stale reference.
  private var needsKeyframeAfterGap = false

  // MARK: – Seek-target gate
  //
  // Set by flush(targetPts); pre-scrub samples in flight with PTS far
  // before target are dropped in feed(). 0 = no gate. Margin tolerates
  // the server's pre-target IDR rewind (up to ~GOP seconds).
  private var seekTargetPts: Double = 0
  private let seekTargetPtsMargin: Double = 50_000_000  // 5s in 100ns ticks

  // MARK: – Init

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .black

    displayLayer.videoGravity = .resizeAspect          // letterbox
    displayLayer.preventsDisplaySleepDuringVideoPlayback = true
    layer.addSublayer(displayLayer)

    // Attach a timebase so the display layer paces samples by their PTS.
    var tb: CMTimebase?
    let status = CMTimebaseCreateWithSourceClock(
      allocator: kCFAllocatorDefault,
      sourceClock: CMClockGetHostTimeClock(),
      timebaseOut: &tb
    )
    if status == noErr, let tb = tb {
      CMTimebaseSetRate(tb, rate: 0)
      displayLayer.controlTimebase = tb
      controlTimebase = tb
    } else {
      emitError("timebase_init", "CMTimebaseCreateWithSourceClock failed (status=\(status))")
    }
  }

  deinit {
    // Release queued samples + last-rendered image so the layer doesn't
    // retain GPU resources after the view is gone.
    displayLayer.flushAndRemoveImage()
  }

  // Threading note: feed/flush/setSpeed are reached from JS via
  // ExpoModulesCore's AsyncFunction, which serialises calls onto the
  // module's runtime queue. So the mutable fields below
  // (formatDescription, seekTargetPts, needsTimebaseAnchor,
  // previousPts, controlTimebase) don't need explicit locks — every
  // public entry point already runs on a single queue.

  override func layoutSubviews() {
    super.layoutSubviews()
    // Keep the display layer sized to the view.
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    displayLayer.frame = bounds
    CATransaction.commit()
  }

  // MARK: – Public API (called from NvrVideoViewModule)

  func setBackgroundHex(_ hex: String) {
    backgroundColor = UIColor(hex: hex) ?? .black
  }

  /// Receive one frame of Annex-B NAL data.
  func feed(data: Data, isKeyframe: Bool, pts: Double) {
    // Drop stale pre-scrub samples that arrived after the new flush.
    if seekTargetPts > 0 {
      if pts < seekTargetPts - seekTargetPtsMargin {
        return
      }
      seekTargetPts = 0
    }

    // After a delivery gap the decoder's reference chain is broken —
    // drop until the next IDR to avoid a green frame. We do NOT
    // re-anchor the timebase on gaps (visible "jumps"); late samples
    // get DisplayImmediately via the >500ms threshold below instead.
    if needsKeyframeAfterGap {
      if !isKeyframe { return }
      needsKeyframeAfterGap = false
    }

    // Recover from a failed layer.
    if displayLayer.status == .failed {
      let err = displayLayer.error
      emitError(
        "layer_failed",
        "AVSampleBufferDisplayLayer .failed (isKey=\(isKeyframe) hasFmt=\(formatDescription != nil)): \(err?.localizedDescription ?? "no error")"
      )
      displayLayer.flush()
      formatDescription = nil
      needsTimebaseAnchor = true
    }

    // Anchor or re-anchor on first frame / discontinuity. Without rebase
    // a post-seek PTS far from current timebase time would cause the
    // layer to hold frames forever (or discard them as too late).
    if let tb = controlTimebase {
      if !needsTimebaseAnchor {
        let now = CMTimebaseGetTime(tb)
        let nowSec = CMTimeGetSeconds(now)
        let ptsSec = pts / Double(ptsTimescale)
        if !nowSec.isFinite || abs(ptsSec - nowSec) > timebaseDiscontinuitySeconds {
          needsTimebaseAnchor = true
        }
      }
      if needsTimebaseAnchor {
        let anchor = CMTime(value: CMTimeValue(pts), timescale: ptsTimescale)
        CMTimebaseSetTime(tb, time: anchor)
        CMTimebaseSetRate(tb, rate: currentSpeed)
        needsTimebaseAnchor = false
      }
    }

    let nals = splitAnnexBNALUnits(data)
    guard !nals.isEmpty else { return }

    // --- Identify codec & extract parameter sets when keyframe ---
    if isKeyframe {
      extractParameterSets(from: nals)
    }

    // Can't decode anything without a format description.
    guard let fmt = formatDescription else { return }

    // --- Build a single AVCC/HVCC block from VCL NAL units ---
    // We include all NAL units that are NOT parameter sets (VCL + SEI etc.).
    let vclNALs = nals.filter { !isParameterSetNAL($0) }
    guard !vclNALs.isEmpty else { return }

    let avccData = annexBToLengthPrefixed(vclNALs)

    // Frame duration from PTS delta — gives the display layer explicit
    // timing so it holds each frame for the right interval. Adapts to
    // any fps and to keyframe-only mode (~5s between keyframes at 8x →
    // 0.625s wall per keyframe). Clamp upper bound at 10s to reject
    // seek / discontinuity outliers.
    let frameDuration: CMTime
    if previousPts > 0 && pts > previousPts {
      let deltaTicks = pts - previousPts
      let deltaSeconds = deltaTicks / Double(ptsTimescale)
      if deltaSeconds > 0.001 && deltaSeconds < 10.0 {
        frameDuration = CMTime(value: CMTimeValue(deltaTicks), timescale: ptsTimescale)
      } else {
        frameDuration = CMTime.invalid
      }
    } else {
      frameDuration = CMTime.invalid
    }
    previousPts = pts

    guard let sampleBuffer = createSampleBuffer(
      from: avccData, formatDescription: fmt, pts: pts, duration: frameDuration
    ) else { return }

    // Force DisplayImmediately only for significantly-late samples
    // (>500ms). 1× bursts land <100ms behind and shouldn't be forced;
    // high-speed playback exceeds the threshold and needs it.
    if let tb = controlTimebase {
      let now = CMTimebaseGetTime(tb)
      let samplePTS = CMTime(value: CMTimeValue(pts), timescale: ptsTimescale)
      let lag = CMTimeSubtract(now, samplePTS)
      let lagSeconds = CMTimeGetSeconds(lag)
      if lagSeconds > 0.5 {
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(
          sampleBuffer, createIfNecessary: true
        ) as? [NSMutableDictionary], let dict = attachments.first {
          dict[kCMSampleAttachmentKey_DisplayImmediately] = true
        }
      }
    }

    displayLayer.enqueue(sampleBuffer)

    // Check if the enqueue caused a layer failure (green frame source).
    if displayLayer.status == .failed {
      let err = displayLayer.error
      emitError(
        "layer_failed",
        "AVSampleBufferDisplayLayer .failed on enqueue (isKey=\(isKeyframe) hasFmt=\(formatDescription != nil)): \(err?.localizedDescription ?? "no error")"
      )
    } else {
      // Reached end of feed cleanly — clear the dedup latch so the next
      // failure (different or same code) fires fresh.
      lastErrorCode = nil
    }

    // Notify JS side.
    onFeed([
      "bytes": data.count,
      "isKeyframe": isKeyframe,
      "pts": pts,
    ])
  }

  /// Flush the display layer and reset decoder state so the next keyframe
  /// re-initialises. Uses `flushAndRemoveImage()` to clear the last-rendered
  /// frame from the CALayer — otherwise a scrub appears to play ~1s of
  /// pre-scrub footage until the first new keyframe renders.
  ///
  /// `targetPts` (0 = no gate, else FILETIME PTS in 100ns ticks) arms the
  /// seek-target gate in `feed()` so pending pre-scrub samples in flight
  /// on the bridge are dropped instead of re-populating the queue.
  func flush(targetPts: Double = 0) {
    displayLayer.flushAndRemoveImage()
    formatDescription = nil
    needsTimebaseAnchor = true
    needsKeyframeAfterGap = true
    previousPts = 0
    seekTargetPts = targetPts
    // Freeze timebase so any sample that sneaks in between flush and the
    // first post-scrub feed cannot be paced forward. Next feed() restores
    // rate via the needsTimebaseAnchor path.
    if let tb = controlTimebase {
      CMTimebaseSetRate(tb, rate: 0)
    }
  }

  /// Arm the keyframe gate without flushing the layer or clearing the
  /// format description. Caller asserts there may have been a delivery
  /// gap (e.g., live grid paging away and back, where the detach-grace
  /// sink-no-op may have eaten the IDR boundary). Subsequent non-keyframe
  /// feeds are dropped until the next IDR re-establishes references; the
  /// already-rendered last frame stays visible meanwhile, which is much
  /// less alarming than the green flash a stale-reference P-frame produces.
  func markPotentialGap() {
    needsKeyframeAfterGap = true
  }

  /// Update playback rate. 0 pauses; positive values scale timebase
  /// advance vs host clock (2x/4x/8x).
  private var currentSpeed: Double = 1.0
  /// Last non-zero speed. Tracked so we can detect a keyframe-mode
  /// threshold cross across a pause boundary and flush stale samples.
  private var lastNonZeroSpeed: Double = 1.0
  /// Matches the JS side's keyframe-mode threshold. Crossing it shifts
  /// PTS gaps from ~33ms to ~5s; we flush so old samples don't bleed in.
  private let keyframeModeThreshold: Double = 4.0
  func setSpeed(_ speed: Double) {
    let newSpeed = max(0, speed)
    guard let tb = controlTimebase else { return }
    // Pause: freeze timebase, preserve lastNonZeroSpeed so next resume
    // can detect a threshold cross across the pause boundary.
    if newSpeed == 0 {
      currentSpeed = 0
      CMTimebaseSetRate(tb, rate: 0)
      return
    }
    let wasAboveThreshold = lastNonZeroSpeed > keyframeModeThreshold
    let nowAboveThreshold = newSpeed > keyframeModeThreshold
    lastNonZeroSpeed = newSpeed
    currentSpeed = newSpeed
    if wasAboveThreshold != nowAboveThreshold {
      displayLayer.flush()
      formatDescription = nil
      needsTimebaseAnchor = true
      previousPts = 0
      CMTimebaseSetRate(tb, rate: 0)
      return
    }
    if !needsTimebaseAnchor {
      CMTimebaseSetRate(tb, rate: newSpeed)
    }
  }

  // MARK: – Annex-B parsing

  /// Split raw Annex-B data at start codes, returning the NAL unit bodies
  /// (without start codes). Handles both 4-byte (00 00 00 01) and 3-byte
  /// (00 00 01) start codes.
  private func splitAnnexBNALUnits(_ data: Data) -> [Data] {
    var nals: [Data] = []
    let bytes = [UInt8](data)
    let count = bytes.count
    var i = 0

    /// Detect a start code at position i. Returns the start code length (3 or 4), or 0 if none.
    func startCodeLen(at pos: Int) -> Int {
      guard pos + 2 < count else { return 0 }
      if pos + 3 < count &&
         bytes[pos] == 0 && bytes[pos+1] == 0 && bytes[pos+2] == 0 && bytes[pos+3] == 1 {
        return 4
      }
      if bytes[pos] == 0 && bytes[pos+1] == 0 && bytes[pos+2] == 1 {
        return 3
      }
      return 0
    }

    // Find first start code.
    while i < count {
      let sc = startCodeLen(at: i)
      if sc > 0 { break }
      i += 1
    }

    while i < count {
      let sc = startCodeLen(at: i)
      guard sc > 0 else { break }
      let nalStart = i + sc

      // Scan forward for the next start code (or end of data).
      var j = nalStart
      while j < count {
        let nextSc = startCodeLen(at: j)
        if nextSc > 0 { break }
        j += 1
      }

      if j > nalStart {
        nals.append(Data(bytes[nalStart..<j]))
      }
      i = j
    }

    return nals
  }

  // MARK: – NAL type helpers

  /// Returns the NAL unit type for either H.264 or H.265.
  private func nalType(of nal: Data) -> UInt8 {
    guard let first = nal.first else { return 0 }
    // H.265: type is bits 1-6 of the first byte  → (first >> 1) & 0x3F
    // H.264: type is bits 0-4 of the first byte  → first & 0x1F
    // We peek at the value to decide codec on the fly.
    let h264Type = first & 0x1F
    let h265Type = (first >> 1) & 0x3F

    // If we already know the codec, use the right mask.
    if isHEVC { return h265Type }

    // Heuristic: H.265 VPS=32, SPS=33, PPS=34, IDR=19/20 all have
    // h264Type values that don't correspond to common H.264 types, so
    // we can distinguish by checking h265Type range.
    if h265Type >= 32 && h265Type <= 34 { return h265Type }
    return h264Type
  }

  /// Whether a NAL is a parameter set (SPS, PPS, VPS).
  private func isParameterSetNAL(_ nal: Data) -> Bool {
    guard let first = nal.first else { return false }
    if isHEVC {
      let t = (first >> 1) & 0x3F
      return t == 32 || t == 33 || t == 34   // VPS, SPS, PPS
    } else {
      let t = first & 0x1F
      return t == 7 || t == 8                 // SPS, PPS
    }
  }

  // MARK: – Parameter set extraction & format description

  private func extractParameterSets(from nals: [Data]) {
    // Determine codec from the NAL types present.
    var sps: Data?
    var pps: Data?
    var vps: Data?
    var detectedHEVC = false

    for nal in nals {
      guard let first = nal.first else { continue }

      let h264Type = first & 0x1F
      let h265Type = (first >> 1) & 0x3F

      // Check H.265 parameter sets first.
      if h265Type == 32 { vps = nal; detectedHEVC = true }
      else if h265Type == 33 && detectedHEVC { sps = nal }
      else if h265Type == 34 && detectedHEVC { pps = nal }
      // H.264 parameter sets.
      else if h264Type == 7 && !detectedHEVC { sps = nal }
      else if h264Type == 8 && !detectedHEVC { pps = nal }
    }

    isHEVC = detectedHEVC

    if detectedHEVC {
      guard let vps = vps, let sps = sps, let pps = pps else { return }
      createHEVCFormatDescription(vps: vps, sps: sps, pps: pps)
    } else {
      guard let sps = sps, let pps = pps else { return }
      createH264FormatDescription(sps: sps, pps: pps)
    }
  }

  private func createH264FormatDescription(sps: Data, pps: Data) {
    let paramSets: [Data] = [sps, pps]
    let pointers = paramSets.map { data -> UnsafePointer<UInt8> in
      return (data as NSData).bytes.assumingMemoryBound(to: UInt8.self)
    }
    let sizes = paramSets.map { $0.count }

    var fmt: CMFormatDescription?
    let status = pointers.withUnsafeBufferPointer { ptrBuf in
      sizes.withUnsafeBufferPointer { sizeBuf in
        CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: kCFAllocatorDefault,
          parameterSetCount: 2,
          parameterSetPointers: ptrBuf.baseAddress!,
          parameterSetSizes: sizeBuf.baseAddress!,
          nalUnitHeaderLength: 4,
          formatDescriptionOut: &fmt
        )
      }
    }

    if status == noErr, let fmt = fmt {
      formatDescription = fmt
      reportVideoSize(fmt)
    } else {
      emitError(
        "format_description",
        "CMVideoFormatDescriptionCreateFromH264ParameterSets failed (status=\(status))"
      )
    }
  }

  private func createHEVCFormatDescription(vps: Data, sps: Data, pps: Data) {
    if #available(iOS 11.0, *) {
      let paramSets: [Data] = [vps, sps, pps]
      let pointers = paramSets.map { data -> UnsafePointer<UInt8> in
        return (data as NSData).bytes.assumingMemoryBound(to: UInt8.self)
      }
      let sizes = paramSets.map { $0.count }

      var fmt: CMFormatDescription?
      let status = pointers.withUnsafeBufferPointer { ptrBuf in
        sizes.withUnsafeBufferPointer { sizeBuf in
          CMVideoFormatDescriptionCreateFromHEVCParameterSets(
            allocator: kCFAllocatorDefault,
            parameterSetCount: 3,
            parameterSetPointers: ptrBuf.baseAddress!,
            parameterSetSizes: sizeBuf.baseAddress!,
            nalUnitHeaderLength: 4,
            extensions: nil,
            formatDescriptionOut: &fmt
          )
        }
      }

      if status == noErr, let fmt = fmt {
        formatDescription = fmt
        reportVideoSize(fmt)
      } else {
        emitError(
          "format_description",
          "CMVideoFormatDescriptionCreateFromHEVCParameterSets failed (status=\(status))"
        )
      }
    }
  }

  // MARK: – AVCC / HVCC conversion

  /// Replace Annex-B start codes with 4-byte big-endian lengths.
  /// Takes already-split NAL bodies (no start codes) and concatenates them
  /// with length prefixes.
  private func annexBToLengthPrefixed(_ nals: [Data]) -> Data {
    var result = Data()
    for nal in nals {
      var length = UInt32(nal.count).bigEndian
      result.append(Data(bytes: &length, count: 4))
      result.append(nal)
    }
    return result
  }

  // MARK: – CMSampleBuffer construction

  private func createSampleBuffer(
    from avccData: Data,
    formatDescription: CMFormatDescription,
    pts: Double,
    duration: CMTime = CMTime.invalid
  ) -> CMSampleBuffer? {

    // --- Block buffer ---
    var blockBuffer: CMBlockBuffer?
    let dataLength = avccData.count

    // Allocate a block buffer and copy data into it.
    var status = CMBlockBufferCreateWithMemoryBlock(
      allocator: kCFAllocatorDefault,
      memoryBlock: nil,
      blockLength: dataLength,
      blockAllocator: kCFAllocatorDefault,
      customBlockSource: nil,
      offsetToData: 0,
      dataLength: dataLength,
      flags: 0,
      blockBufferOut: &blockBuffer
    )
    guard status == kCMBlockBufferNoErr, let bb = blockBuffer else {
      emitError("sample_buffer", "CMBlockBufferCreateWithMemoryBlock failed (status=\(status))")
      return nil
    }

    status = CMBlockBufferReplaceDataBytes(
      with: (avccData as NSData).bytes,
      blockBuffer: bb,
      offsetIntoDestination: 0,
      dataLength: dataLength
    )
    guard status == kCMBlockBufferNoErr else {
      emitError("sample_buffer", "CMBlockBufferReplaceDataBytes failed (status=\(status))")
      return nil
    }

    // --- Timing ---
    let presentationTime = CMTime(value: CMTimeValue(pts), timescale: ptsTimescale)
    var timingInfo = CMSampleTimingInfo(
      duration: duration,
      presentationTimeStamp: presentationTime,
      decodeTimeStamp: CMTime.invalid
    )

    // --- Sample buffer ---
    var sampleBuffer: CMSampleBuffer?
    var sampleSize = dataLength

    status = CMSampleBufferCreateReady(
      allocator: kCFAllocatorDefault,
      dataBuffer: bb,
      formatDescription: formatDescription,
      sampleCount: 1,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timingInfo,
      sampleSizeEntryCount: 1,
      sampleSizeArray: &sampleSize,
      sampleBufferOut: &sampleBuffer
    )

    guard status == noErr, let sb = sampleBuffer else {
      emitError("sample_buffer", "CMSampleBufferCreateReady failed (status=\(status))")
      return nil
    }

    // Do NOT set kCMSampleAttachmentKey_DisplayImmediately here — the
    // controlTimebase paces by PTS, spreading bursts evenly. Setting it
    // would render every frame the moment it's decoded (burst judder).

    return sb
  }
}

// MARK: – UIColor hex helper

private extension UIColor {
  convenience init?(hex: String) {
    var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let n = UInt32(s, radix: 16) else { return nil }
    self.init(
      red:   CGFloat((n >> 16) & 0xff) / 255,
      green: CGFloat((n >> 8)  & 0xff) / 255,
      blue:  CGFloat( n        & 0xff) / 255,
      alpha: 1
    )
  }
}
