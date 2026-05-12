import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Surface } from '@/src/constants/theme';
import { IconSymbol } from '@/src/components/ui/icon-symbol';
import { useCameraStore } from '@/src/store/camera-store';
import type { CameraInfo } from '@/src/nvr/types';

const THUMBNAIL_WIDTH = 80;
const THUMBNAIL_HEIGHT = 45; // 16:9
const ROW_HEIGHT = 80;

interface CameraListRowProps {
  camera: CameraInfo;
  drag: () => void;
  isActive: boolean;
}

export function CameraListRow({ camera, drag, isActive }: CameraListRowProps) {
  const router = useRouter();
  const reconnecting = useCameraStore((s) => s.reconnecting);
  const effectiveStatus = reconnecting ? 'connecting' : camera.status;

  const handlePress = () => {
    router.push({
      pathname: '/(tabs)/(live)/camera/[channelId]',
      params: { channelId: camera.channelId },
    });
  };

  const statusLabel =
    effectiveStatus === 'online'
      ? 'Online'
      : effectiveStatus === 'offline'
        ? 'Offline'
        : effectiveStatus === 'connecting'
          ? 'Connecting...'
          : 'Failed';

  const statusColor =
    effectiveStatus === 'online'
      ? Surface.secondaryText
      : effectiveStatus === 'failed'
        ? Surface.failed
        : effectiveStatus === 'offline'
          ? Surface.offline
          : Surface.connecting;

  return (
    <Pressable
      onPress={handlePress}
      style={[styles.row, isActive && styles.rowActive]}
    >
      {/* Thumbnail placeholder — no live stream to avoid conflicting
           with the grid's stream sinks (grid stays mounted underneath) */}
      <View style={styles.thumbnail}>
        <IconSymbol
          size={24}
          name="video.fill"
          color={effectiveStatus === 'online' ? Surface.secondaryText : Surface.offline}
        />
      </View>

      {/* Info */}
      <View style={styles.info}>
        <Text style={styles.name} numberOfLines={1}>
          {camera.name}
        </Text>
        <Text style={[styles.status, { color: statusColor }]}>{statusLabel}</Text>
      </View>

      {/* Drag handle */}
      <Pressable onLongPress={drag} delayLongPress={150} style={styles.grip}>
        <IconSymbol size={20} name="line.3.horizontal" color={Surface.secondaryText} />
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    height: ROW_HEIGHT,
    backgroundColor: Surface.card,
    marginHorizontal: 12,
    marginBottom: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    overflow: 'hidden',
  },
  rowActive: {
    backgroundColor: Surface.input,
    transform: [{ scale: 1.02 }],
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  thumbnail: {
    width: THUMBNAIL_WIDTH,
    height: THUMBNAIL_HEIGHT,
    borderRadius: 6,
    backgroundColor: Surface.input,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    flex: 1,
    marginLeft: 12,
    justifyContent: 'center',
  },
  name: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  status: {
    fontSize: 13,
    marginTop: 2,
  },
  grip: {
    padding: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
