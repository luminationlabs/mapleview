import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { ThemedText } from "@/src/components/ui/themed-text";
import { unixToDisplayTime } from "../utils/time";
import type { TimeRange } from "../nvr/types";

const DAY_SECONDS = 24 * 3600;
const HOURS_VISIBLE = 4;
const ACCENT_BLUE = "#0A84FF";
const BAR_BG = "#1C1C1E";
const PLAYHEAD_COLOR = "#FFFFFF";
const BAR_HEIGHT = 48;
const TOTAL_HEIGHT = 80;
const DEBOUNCE_MS = 200;

const HOUR_LABELS = [
  "12 AM",
  "1 AM",
  "2 AM",
  "3 AM",
  "4 AM",
  "5 AM",
  "6 AM",
  "7 AM",
  "8 AM",
  "9 AM",
  "10 AM",
  "11 AM",
  "12 PM",
  "1 PM",
  "2 PM",
  "3 PM",
  "4 PM",
  "5 PM",
  "6 PM",
  "7 PM",
  "8 PM",
  "9 PM",
  "10 PM",
  "11 PM",
];

export interface TimelineProps {
  segments: TimeRange[];
  dayStartUnix: number;
  currentTime: number;
  isPlaying: boolean;
  onSeek: (unixTime: number) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** Extra black padding beneath the bar — used to keep it clear of the iOS
   *  home-indicator swipe region on screens where no tab bar sits below. */
  bottomInset?: number;
  /** Block scrubbing while the Recorded view is still loading segments.
   *  Dims the bar so the user can see the disabled state. */
  disabled?: boolean;
}

export function Timeline({
  segments,
  dayStartUnix,
  currentTime,
  isPlaying,
  onSeek,
  onDragStart,
  onDragEnd,
  bottomInset = 0,
  disabled = false,
}: TimelineProps) {
  const { width: screenWidth } = useWindowDimensions();
  const totalWidth = (24 / HOURS_VISIBLE) * screenWidth;
  const halfScreen = screenWidth / 2;

  const scrollRef = useRef<ScrollView>(null);
  const isDragging = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSeekTime = useRef(0);
  const [scrubTime, setScrubTime] = useState<number | null>(null);

  // Convert unix time to scroll offset
  const timeToOffset = useCallback(
    (unix: number) => {
      const secondsIntoDay = unix - dayStartUnix;
      return (secondsIntoDay / DAY_SECONDS) * totalWidth;
    },
    [dayStartUnix, totalWidth],
  );

  // Convert scroll offset to unix time
  const offsetToTime = useCallback(
    (offset: number) => {
      const clamped = Math.max(0, Math.min(offset, totalWidth));
      return dayStartUnix + (clamped / totalWidth) * DAY_SECONDS;
    },
    [dayStartUnix, totalWidth],
  );

  // Auto-scroll during playback
  useEffect(() => {
    if (!isPlaying || isDragging.current) return;
    const offset = timeToOffset(currentTime);
    scrollRef.current?.scrollTo({ x: offset, animated: false });
  }, [currentTime, isPlaying, timeToOffset]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (!isDragging.current) return;
      const offsetX = event.nativeEvent.contentOffset.x;
      const time = offsetToTime(offsetX);
      setScrubTime(time);

      // Debounced seek
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
      lastSeekTime.current = time;
      debounceTimer.current = setTimeout(() => {
        onSeek(lastSeekTime.current);
        debounceTimer.current = null;
      }, DEBOUNCE_MS);
    },
    [offsetToTime, onSeek],
  );

  const handleScrollBeginDrag = useCallback(() => {
    isDragging.current = true;
    onDragStart?.();
  }, [onDragStart]);

  const handleScrollEndDrag = useCallback(() => {
    isDragging.current = false;
    // Fire any pending seek immediately
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
      onSeek(lastSeekTime.current);
    }
    setScrubTime(null);
    onDragEnd?.();
  }, [onDragEnd, onSeek]);

  // While scrubbing, show the estimated time at the playhead position; otherwise
  // show the actual playback time.
  const displayTime = unixToDisplayTime(
    scrubTime ?? currentTime ?? dayStartUnix,
  );

  // Segment rectangles
  const segmentViews = segments.map((seg, i) => {
    const left = timeToOffset(Math.max(seg.start, dayStartUnix));
    const right = timeToOffset(Math.min(seg.end, dayStartUnix + DAY_SECONDS));
    const width = Math.max(right - left, 1);
    return (
      <View
        key={i}
        style={[styles.segment, { left, width, height: BAR_HEIGHT }]}
      />
    );
  });

  // Hour markers
  const hourMarkers = HOUR_LABELS.map((label, hour) => {
    const left = (hour / 24) * totalWidth;
    return (
      <View key={hour} style={[styles.hourMarker, { left }]}>
        <View style={styles.hourTick} />
        <ThemedText style={styles.hourLabel}>{label}</ThemedText>
      </View>
    );
  });

  return (
    <View
      style={[
        styles.container,
        { height: TOTAL_HEIGHT + bottomInset, paddingBottom: bottomInset },
        disabled ? { opacity: 0.4 } : null,
      ]}
    >
      {/* Time display above playhead */}
      <View style={[styles.timeDisplay, { left: halfScreen }]}>
        <ThemedText style={styles.timeText}>{displayTime}</ThemedText>
      </View>

      {/* Scrollable timeline */}
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        scrollEnabled={!disabled}
        contentContainerStyle={[
          styles.scrollContent,
          // Outer box must include the padding so the scrollable range is the
          // full 24h bar. With `width: totalWidth` and box-sizing including
          // padding, max scroll was totalWidth - screenWidth = 20h, which
          // capped scrubbing at 8pm.
          { width: totalWidth + screenWidth, paddingHorizontal: halfScreen },
        ]}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        decelerationRate="fast"
      >
        <View style={[styles.bar, { width: totalWidth, height: BAR_HEIGHT }]}>
          {segmentViews}
          {hourMarkers}
        </View>
      </ScrollView>

      {/* Fixed playhead — positioned to overlay the bar, which sits at the
          bottom of the TOTAL_HEIGHT content area (scrollContent uses
          alignItems: flex-end). */}
      <View
        style={[
          styles.playhead,
          {
            left: halfScreen - 1,
            top: TOTAL_HEIGHT - BAR_HEIGHT,
            height: BAR_HEIGHT - 2,
          },
        ]}
        pointerEvents="none"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "relative",
    backgroundColor: "#1C1C1E",
    borderTopWidth: 1,
    borderTopColor: "#38383A",
  },
  timeDisplay: {
    position: "absolute",
    top: 2,
    zIndex: 10,
    alignItems: "center",
    width: 100,
    marginLeft: -50,
  },
  timeText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontVariant: ["tabular-nums"],
    textAlign: "center",
  },
  scrollContent: {
    alignItems: "flex-end",
  },
  bar: {
    backgroundColor: BAR_BG,
    position: "relative",
    borderRadius: 4,
  },
  segment: {
    position: "absolute",
    top: 0,
    backgroundColor: ACCENT_BLUE,
    borderRadius: 2,
  },
  hourMarker: {
    position: "absolute",
    bottom: 0,
    alignItems: "center",
    zIndex: 5,
  },
  hourTick: {
    width: 1,
    height: 10,
    backgroundColor: "rgba(255,255,255,0.85)",
  },
  hourLabel: {
    color: "#FFFFFF",
    fontSize: 9,
    marginTop: 1,
    textShadowColor: "rgba(0,0,0,0.85)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 2,
  },
  playhead: {
    position: "absolute",
    width: 2,
    backgroundColor: PLAYHEAD_COLOR,
    zIndex: 20,
  },
});
