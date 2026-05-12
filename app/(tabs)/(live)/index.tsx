import { Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { CameraGrid } from '@/src/components/camera-grid';
import { CameraList } from '@/src/components/camera-list';
import { DisconnectBanner } from '@/src/components/disconnect-banner';
import { LayoutPicker } from '@/src/components/layout-picker';
import { useUIStore } from '@/src/store/ui-store';
import { IconSymbol } from '@/src/components/ui/icon-symbol';
import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useWindowDimensions } from 'react-native';

export default function LiveScreen() {
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  let tabBarHeight: number;
  try {
    tabBarHeight = useBottomTabBarHeight();
  } catch {
    tabBarHeight = 49 + insets.bottom;
  }

  const topBarHeight = 44;
  const availableHeight =
    windowHeight - insets.top - topBarHeight - tabBarHeight;

  const toggleViewMode = () => {
    setViewMode(viewMode === 'grid' ? 'list' : 'grid');
  };

  return (
    <View style={styles.root}>
      <SafeAreaView edges={['top']} style={styles.safeTop}>
        <View style={styles.topBar}>
          {viewMode === 'grid' ? <LayoutPicker /> : <View />}
          <Pressable onPress={toggleViewMode} style={styles.toggleButton}>
            <IconSymbol
              size={22}
              name={viewMode === 'grid' ? 'list.bullet' : 'square.grid.2x2.fill'}
              color="#FFFFFF"
            />
          </Pressable>
        </View>
      </SafeAreaView>

      {/* Grid always mounted (keeps streams alive). List conditionally on top. */}
      <View style={styles.content}>
        <CameraGrid availableHeight={availableHeight} />
        {viewMode === 'list' && (
          <View style={StyleSheet.absoluteFill}>
            <CameraList />
          </View>
        )}
      </View>

      {/* Connection-state overlay sits last so it paints on top. Absolute
          positioning means show/hide doesn't shift the grid. */}
      <DisconnectBanner />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000000',
  },
  safeTop: {
    backgroundColor: '#000000',
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    height: 44,
  },
  toggleButton: {
    padding: 8,
  },
  content: {
    flex: 1,
  },
});
