import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';

import NvrVideoView from '@/modules/nvr-video-view/src/NvrVideoView';
import { useCamera } from '@/src/hooks/use-camera';
import { usePlayback } from '@/src/hooks/use-playback';
import { useCameraStore } from '@/src/store/camera-store';
import { usePlaybackStore, segmentCoveringTime } from '@/src/store/playback-store';
import { IconSymbol } from '@/src/components/ui/icon-symbol';
import { Surface } from '@/src/constants/theme';
import type { CameraInfo } from '@/src/nvr/types';
import { nvrClient } from '@/src/nvr/client';

interface CameraTileProps {
  camera: CameraInfo | null;
  width: number;
  height: number;
  mode?: 'live' | 'playback';
  /** When false, the tile renders its frame but does NOT attach to the
   *  underlying stream. Used by the paged grid so off-page tiles don't
   *  hold open sockets. Defaults to true for backwards compatibility. */
  pageActive?: boolean;
}

export function CameraTile({
  camera,
  width,
  height,
  mode = 'live',
  pageActive = true,
}: CameraTileProps) {
  if (!camera) {
    return <EmptyTile width={width} height={height} />;
  }

  if (mode === 'playback') {
    return (
      <PlaybackTile
        camera={camera}
        width={width}
        height={height}
        pageActive={pageActive}
      />
    );
  }

  return (
    <ActiveTile
      camera={camera}
      width={width}
      height={height}
      pageActive={pageActive}
    />
  );
}

function EmptyTile({ width, height }: { width: number; height: number }) {
  return (
    <View style={[styles.tile, styles.emptyTile, { width, height }]}>
      <Text style={styles.emptyText}>No camera</Text>
    </View>
  );
}

function ActiveTile({
  camera,
  width,
  height,
  pageActive,
}: {
  camera: CameraInfo;
  width: number;
  height: number;
  pageActive: boolean;
}) {
  // Pass '' when off-page so useCamera's effect short-circuits and the
  // socket is torn down. The hook handles the empty-channelId path.
  const { viewRef, hasFirstFrame } = useCamera(
    pageActive ? camera.channelId : '',
    'sub',
  );
  const router = useRouter();
  const reconnecting = useCameraStore((s) => s.reconnecting);

  // While the app is recovering from backgrounding, present every tile as
  // "connecting" regardless of the underlying stream status, so transient
  // failed states from torn-down sockets don't flash as red error tiles.
  const effectiveStatus = reconnecting ? 'connecting' : camera.status;

  // The NvrVideoView is black until the first frame arrives. Treat the
  // tile as "connecting" for display purposes until then — otherwise a
  // tile whose status says "online" (from enumerate) but which hasn't
  // streamed any frames yet sits black with no spinner.
  const waitingForFrame =
    !hasFirstFrame && effectiveStatus !== 'offline' && effectiveStatus !== 'failed';
  const displayStatus = waitingForFrame ? 'connecting' : effectiveStatus;

  const handlePress = () => {
    if (effectiveStatus === 'failed') {
      // A plain detach+attach would re-run scheduleOpen on the same
      // session the NVR is rejecting and loop forever. hardRetry
      // matches force-quit semantics: tear down live + playback, clear
      // extras/claims, fresh login, reopen. closeAllStreams inside
      // hardRetry sets cameraStore.reconnecting which already shrouds
      // this tile, so no explicit updateStatus needed.
      nvrClient.hardRetry();
      return;
    }
    router.push({
      pathname: '/(tabs)/(live)/camera/[channelId]',
      params: { channelId: camera.channelId },
    });
  };

  const borderColor =
    effectiveStatus === 'failed'
      ? Surface.failed
      : effectiveStatus === 'offline'
        ? Surface.offline
        : '#1A1A1A';

  const dimmed = displayStatus === 'connecting';

  return (
    <Pressable onPress={handlePress} style={[styles.tile, { width, height, borderColor }]}>
      <View style={[styles.videoContainer, dimmed && styles.dimmed]}>
        <NvrVideoView
          ref={viewRef}
          backgroundHex="#000000"
          style={StyleSheet.absoluteFill}
        />
      </View>

      {displayStatus === 'connecting' && (
        <View style={styles.overlay}>
          <ActivityIndicator size="small" color={Surface.connecting} />
        </View>
      )}

      {displayStatus === 'offline' && (
        <View style={styles.overlay}>
          <Text style={[styles.statusText, { color: Surface.offline }]}>Offline</Text>
        </View>
      )}

      {displayStatus === 'failed' && (
        <View style={[styles.overlay, styles.failedOverlay]}>
          <Text style={[styles.statusText, { color: Surface.failed }]}>
            Can't connect — tap to retry
          </Text>
        </View>
      )}

      <View style={styles.nameOverlay}>
        <Text style={styles.nameText} numberOfLines={1}>
          {camera.name}
        </Text>
      </View>
    </Pressable>
  );
}

function PlaybackTile({
  camera,
  width,
  height,
  pageActive,
}: {
  camera: CameraInfo;
  width: number;
  height: number;
  pageActive: boolean;
}) {
  // Only pull frames when the grid screen is actually focused. Without
  // this guard, a pushed single-camera screen on top of the grid keeps
  // these tiles mounted, and their attach calls can race the single-cam
  // attach and steal the sink, leaving the single-cam spinner forever.
  const isFocused = useIsFocused();
  const shouldAttach = isFocused && pageActive;
  const { viewRef, hasFirstFrame } = usePlayback(
    shouldAttach ? camera.channelId : '',
    'main',
  );
  const router = useRouter();

  // Check if this camera has recordings for the selected date
  const cameraSegments = usePlaybackStore(
    (s) => s.cameraSegments[camera.channelId],
  );
  const loadingSegments = usePlaybackStore((s) => s.loadingSegments);
  const hasQueriedSegments = usePlaybackStore((s) => s.hasQueriedSegments);
  const channelLoading = usePlaybackStore(
    (s) => s.loadingChannels[camera.channelId] ?? false,
  );
  const channelFailed = usePlaybackStore(
    (s) => s.failedChannels[camera.channelId] ?? false,
  );
  const hasRecordings = cameraSegments && cameraSegments.length > 0;
  // Boolean selector — Object.is equality means this component only
  // re-renders on coverage transitions, not on every 250ms playhead tick.
  const hasFootageAtPlayhead = usePlaybackStore((s) =>
    segmentCoveringTime(s.cameraSegments[camera.channelId], s.currentTime) != null,
  );
  // Show the "No footage" overlay only once segments have been queried AND
  // the camera has some segments for the day. Zero-segment cameras are
  // covered by the existing "No recordings" overlay.
  const showNoFootage =
    hasQueriedSegments && hasRecordings && !hasFootageAtPlayhead;

  const handlePress = () => {
    router.push({
      pathname: '/(tabs)/(playback)/camera/[channelId]',
      params: { channelId: camera.channelId },
    });
  };

  return (
    <Pressable onPress={handlePress} style={[styles.tile, { width, height, borderColor: '#1A1A1A' }]}>
      <View style={styles.videoContainer}>
        <NvrVideoView
          ref={viewRef}
          backgroundHex="#000000"
          style={StyleSheet.absoluteFill}
        />
      </View>

      {/* No recordings overlay — only after we've confirmed a successful
          query for this date, so we don't flash "No recordings" in the
          pre-init window or while a retry is pending. */}
      {!loadingSegments && hasQueriedSegments && !hasRecordings && (
        <View style={styles.overlay}>
          <Text style={[styles.statusText, { color: Surface.secondaryText }]}>No recordings</Text>
        </View>
      )}

      {/* No footage overlay — camera has segments for the day, but the
          current playhead sits in one of its gaps (e.g., a newly-online
          camera whose recordings started mid-day while the grid is
          playing earlier content from other cameras). The manager keeps
          the connection closed in this state to avoid the NVR clamping
          start_time to this camera's nearest recording. */}
      {showNoFootage && (
        <View style={[styles.overlay, styles.loadingOverlay]}>
          <Text style={[styles.statusText, { color: Surface.secondaryText }]}>No footage</Text>
        </View>
      )}

      {/* Failed overlay — playback connection retry chain exhausted.
          Tapping the tile routes to single-cam where the user can tap
          Retry to run hardRetry. Shown instead of the spinner so the
          tile doesn't sit on an indefinite loader. */}
      {channelFailed && !showNoFootage && (
        <View style={[styles.overlay, styles.failedOverlay]}>
          <Text style={[styles.statusText, { color: Surface.failed }]}>
            Can't load
          </Text>
        </View>
      )}

      {/* Loading overlay — covers the decoder's transient green frames during
          stream restarts (seek, initial open) with a clean spinner. Also
          shown during the pre-query window so the user sees a spinner
          instead of a premature "No recordings" overlay, and while the
          tile is waiting on its first frame so it doesn't sit black.
          Suppressed when we're intentionally in a gap (showNoFootage) or
          on explicit failure (channelFailed) — no connection to load. */}
      {!showNoFootage && !channelFailed &&
        (loadingSegments ||
          !hasQueriedSegments ||
          (hasRecordings && channelLoading) ||
          (hasRecordings && !hasFirstFrame)) && (
        <View style={[styles.overlay, styles.loadingOverlay]}>
          <ActivityIndicator size="small" color={Surface.connecting} />
        </View>
      )}

      <View style={styles.nameOverlay}>
        <Text style={styles.nameText} numberOfLines={1}>
          {camera.name}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    borderWidth: 1,
    borderColor: '#1A1A1A',
    backgroundColor: '#000000',
    overflow: 'hidden',
  },
  emptyTile: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    color: Surface.placeholder,
    fontSize: 13,
  },
  videoContainer: {
    ...StyleSheet.absoluteFillObject,
  },
  dimmed: {
    opacity: 0.4,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  failedOverlay: {
    backgroundColor: 'rgba(255, 69, 58, 0.15)',
  },
  loadingOverlay: {
    backgroundColor: '#000000',
  },
  statusText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '500',
  },
  nameOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  nameText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
  },
});
