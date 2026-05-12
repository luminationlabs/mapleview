import { useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useUIStore } from '@/src/store/ui-store';
import { Surface } from '@/src/constants/theme';
import type { GridLayout } from '@/src/nvr/types';

const LAYOUTS: GridLayout[] = [1, 4, 6, 9, 12, 16];
const LITE_MAX: GridLayout = 4;

export function LayoutPicker() {
  const gridLayout = useUIStore((s) => s.gridLayout);
  const setGridLayout = useUIStore((s) => s.setGridLayout);
  const isPro = useUIStore((s) => s.isPro);
  const setPaywallOpen = useUIStore((s) => s.setPaywallOpen);

  // If entitlement is revoked (refund) while user is on a >4 layout, clamp.
  useEffect(() => {
    if (!isPro && gridLayout > LITE_MAX) {
      setGridLayout(LITE_MAX);
    }
  }, [isPro, gridLayout, setGridLayout]);

  return (
    <View style={styles.container}>
      {LAYOUTS.map((layout) => {
        const active = layout === gridLayout;
        const locked = !isPro && layout > LITE_MAX;
        const onPress = () => {
          if (locked) {
            setPaywallOpen(true);
            return;
          }
          setGridLayout(layout);
        };
        return (
          <Pressable
            key={layout}
            style={[styles.segment, active && styles.segmentActive]}
            onPress={onPress}
          >
            <View style={styles.segmentInner}>
              <Text style={[styles.label, active && styles.labelActive]}>
                {layout}
              </Text>
              {locked && (
                <Ionicons
                  name="lock-closed"
                  size={10}
                  color={Surface.secondaryText}
                  style={styles.lockIcon}
                />
              )}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    backgroundColor: Surface.input,
    borderRadius: 8,
    padding: 2,
  },
  segment: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    minWidth: 32,
    alignItems: 'center',
  },
  segmentActive: {
    backgroundColor: Surface.separator,
  },
  segmentInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: Surface.secondaryText,
  },
  labelActive: {
    color: '#FFFFFF',
  },
  lockIcon: {
    marginLeft: 1,
  },
});
