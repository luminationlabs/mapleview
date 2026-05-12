import { ActivityIndicator, StyleSheet, View } from 'react-native';
import DraggableFlatList, {
  type RenderItemParams,
} from 'react-native-draggable-flatlist';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useCameraList } from '@/src/hooks/use-camera-list';
import { useCameraStore } from '@/src/store/camera-store';
import { CameraListRow } from './camera-list-row';
import { ThemedText } from '@/src/components/ui/themed-text';
import { Surface } from '@/src/constants/theme';
import type { CameraInfo } from '@/src/nvr/types';

export function CameraList() {
  const { cameras, reorder } = useCameraList();
  const reconnecting = useCameraStore((s) => s.reconnecting);

  const renderItem = ({ item, drag, isActive }: RenderItemParams<CameraInfo>) => (
    <CameraListRow camera={item} drag={drag} isActive={isActive} />
  );

  const keyExtractor = (item: CameraInfo) => item.channelId;

  const handleDragEnd = ({ from, to }: { from: number; to: number }) => {
    if (from !== to) {
      reorder(from, to);
    }
  };

  if (cameras.length === 0) {
    if (reconnecting) {
      return (
        <View style={styles.empty}>
          <ActivityIndicator size="small" color={Surface.connecting} />
        </View>
      );
    }
    return (
      <View style={styles.empty}>
        <ThemedText style={{ color: Surface.secondaryText }}>
          No cameras available on this NVR.
        </ThemedText>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={styles.container}>
      <DraggableFlatList
        data={cameras}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        onDragEnd={handleDragEnd}
        containerStyle={styles.list}
        contentContainerStyle={styles.content}
      />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  list: {
    flex: 1,
  },
  content: {
    paddingTop: 8,
    paddingBottom: 24,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000000',
  },
});
