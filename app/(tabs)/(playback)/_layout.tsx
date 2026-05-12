import { Stack } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useIsFocused } from '@react-navigation/native';

import { playbackManager } from '@/src/nvr/playback-manager';
import { playbackStore, usePlaybackStore } from '@/src/store/playback-store';
import { cameraStore } from '@/src/store/camera-store';
import { useUIStore } from '@/src/store/ui-store';
import { dayToUnixRange } from '@/src/utils/time';

export default function PlaybackLayout() {
  // This layout IS the tab screen inside the tab navigator, so its focus
  // state tracks the tab (not any inner stack screen). On tab blur we tear
  // down the playback streams so the app isn't pulling video while the user
  // is on Live/Settings; on refocus we reopen at the saved playhead.
  const isFocused = useIsFocused();
  const wasPlayingRef = useRef(false);
  const savedTimeRef = useRef(0);
  const hadStreamsRef = useRef(false);

  // Install the HQ provider — the manager doesn't import ui-store
  // directly because it's expo-file-system-backed and breaks Node tests.
  useEffect(() => {
    playbackManager.setHqModeProvider(
      () => useUIStore.getState().hqMode,
    );
  }, []);

  // Advance the playhead while playing, scaled by speed. This lived on the
  // grid screen originally, which meant cold-launching directly into the
  // single-camera screen (no grid mounted) would leave currentTime frozen
  // at 0 — breaking timeline cursor movement, stall-reopen seeks, and
  // speed-change seeks. Lift it to the tab layout so it runs whenever the
  // Recorded tab is focused regardless of inner screen.
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const speed = usePlaybackStore((s) => s.speed);
  useEffect(() => {
    if (!isFocused || !isPlaying) return;
    let lastTick = Date.now();
    const id = setInterval(() => {
      const now = Date.now();
      const elapsedSec = ((now - lastTick) / 1000) * speed;
      lastTick = now;
      const t = playbackStore.getState().currentTime;
      playbackStore.getState().setCurrentTime(t + elapsedSec);
    }, 250);
    return () => clearInterval(id);
  }, [isFocused, isPlaying, speed]);

  useEffect(() => {
    if (!isFocused) {
      const pb = playbackStore.getState();
      // Only remember/close if we actually had streams open — avoids a
      // spurious setPlaying(false) on cold launch before init.
      if (pb.currentTime > 0) {
        wasPlayingRef.current = pb.isPlaying;
        savedTimeRef.current = pb.currentTime;
        hadStreamsRef.current = true;
        playbackManager.closeAll();
        pb.setPlaying(false);
      }
      return;
    }
    if (!hadStreamsRef.current) return;
    // Reopen on return.
    const { cameras } = cameraStore.getState();
    const pb = playbackStore.getState();
    const camsWithRec = cameras.filter((c) => {
      const segs = pb.cameraSegments[c.channelId];
      return segs && segs.length > 0;
    });
    if (camsWithRec.length === 0) return;
    const { end: dayEnd } = dayToUnixRange(pb.selectedDate);
    playbackManager.openAll(camsWithRec, savedTimeRef.current, dayEnd, 'main');
    pb.setPlaying(wasPlayingRef.current);
  }, [isFocused]);

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: '#000000' },
      }}
    />
  );
}
