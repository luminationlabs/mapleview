import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";

const SPEEDS = [1, 2, 4, 8] as const;
type Speed = (typeof SPEEDS)[number];

export interface TransportControlsProps {
  isPlaying: boolean;
  speed: Speed;
  onPlayPause: () => void;
  onSpeedChange: (speed: Speed) => void;
  onSkipBackward?: () => void;
  onSkipForward?: () => void;
  dateLabel: string;
  onDatePress: () => void;
  /** Dim and disable play/pause, skip, and speed while the Recorded view
   *  is still fetching segments. Date picker stays active so the user can
   *  retry a different day. */
  disabled?: boolean;
}

export function TransportControls({
  isPlaying,
  speed,
  onPlayPause,
  onSpeedChange,
  onSkipBackward,
  onSkipForward,
  dateLabel,
  onDatePress,
  disabled = false,
}: TransportControlsProps) {
  const handleSpeedPress = () => {
    const currentIndex = SPEEDS.indexOf(speed);
    const nextIndex = (currentIndex + 1) % SPEEDS.length;
    onSpeedChange(SPEEDS[nextIndex]);
  };
  const dimmed = disabled ? styles.dimmed : undefined;
  const transportColor = disabled ? "#666666" : "#FFFFFF";

  return (
    <View style={styles.container}>
      {/* Left: date button — intentionally stays tappable while disabled so
          the user can switch days if loading stalls. */}
      <Pressable onPress={onDatePress} style={styles.dateButton} hitSlop={8}>
        <Text style={styles.dateLabel}>{dateLabel}</Text>
      </Pressable>

      {/* Center: skip backward / play-pause / skip forward */}
      <View style={styles.centerGroup}>
        {onSkipBackward && (
          <Pressable
            onPress={disabled ? undefined : onSkipBackward}
            disabled={disabled}
            style={[styles.skipButton, dimmed]}
            hitSlop={8}
          >
            <Ionicons name="play-back" size={22} color={transportColor} />
          </Pressable>
        )}

        <Pressable
          onPress={disabled ? undefined : onPlayPause}
          disabled={disabled}
          style={[styles.playPause, dimmed]}
          hitSlop={8}
        >
          <Ionicons
            name={isPlaying ? "pause" : "play"}
            size={28}
            color={transportColor}
          />
        </Pressable>

        {onSkipForward && (
          <Pressable
            onPress={disabled ? undefined : onSkipForward}
            disabled={disabled}
            style={[styles.skipButton, dimmed]}
            hitSlop={8}
          >
            <Ionicons name="play-forward" size={22} color={transportColor} />
          </Pressable>
        )}
      </View>

      {/* Right: speed selector */}
      <Pressable
        onPress={disabled ? undefined : handleSpeedPress}
        disabled={disabled}
        style={[styles.speedButton, dimmed]}
        hitSlop={8}
      >
        <Text
          style={[
            styles.speedLabel,
            disabled ? styles.speedLabelDisabled : undefined,
          ]}
        >
          {speed}x
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    backgroundColor: "#0D0D0D",
  },
  dateButton: {
    minWidth: 60,
  },
  dateLabel: {
    color: "#0A84FF",
    fontSize: 15,
  },
  centerGroup: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 24,
  },
  playPause: {
    alignItems: "center",
    justifyContent: "center",
  },
  skipButton: {
    alignItems: "center",
    justifyContent: "center",
  },
  speedButton: {
    minWidth: 60,
    alignItems: "flex-end",
  },
  speedLabel: {
    color: "#FFFFFF",
    fontSize: 15,
  },
  speedLabelDisabled: {
    color: "#666666",
  },
  dimmed: {
    opacity: 0.4,
  },
});
