import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { useCameraList } from '@/src/hooks/use-camera-list';
import { useCameraStore } from '@/src/store/camera-store';
import { useUIStore } from '@/src/store/ui-store';
import { CameraTile } from './camera-tile';
import { ThemedText } from '@/src/components/ui/themed-text';
import { Surface } from '@/src/constants/theme';
import type { CameraInfo, GridLayout } from '@/src/nvr/types';

interface GridDimensions {
  columns: number;
  rows: number;
}

function getGridDimensions(layout: GridLayout, isLandscape: boolean): GridDimensions {
  switch (layout) {
    case 1:
      return { columns: 1, rows: 1 };
    case 4:
      return { columns: 2, rows: 2 };
    case 6:
      return isLandscape ? { columns: 3, rows: 2 } : { columns: 2, rows: 3 };
    case 9:
      return { columns: 3, rows: 3 };
    case 12:
      return isLandscape ? { columns: 4, rows: 3 } : { columns: 3, rows: 4 };
    case 16:
      return { columns: 4, rows: 4 };
    default:
      return { columns: 2, rows: 2 };
  }
}

interface CameraGridProps {
  /** Available height for the grid (excludes top bar, tab bar, etc.) */
  availableHeight: number;
  /** Display mode: 'live' shows live streams, 'playback' shows placeholders */
  mode?: 'live' | 'playback';
  /** Custom empty state text */
  emptyText?: string;
}

const INDICATOR_HEIGHT = 24;
const DOTS_BREAKPOINT = 8;

export function CameraGrid({ availableHeight, mode = 'live', emptyText }: CameraGridProps) {
  const { width: screenWidth, height: windowHeight } = useWindowDimensions();
  const gridLayout = useUIStore((s) => s.gridLayout);
  const { cameras } = useCameraList();
  const reconnecting = useCameraStore((s) => s.reconnecting);
  const isLandscape = screenWidth > windowHeight;

  const { columns, rows } = getGridDimensions(gridLayout, isLandscape);
  const pageSize = columns * rows;

  const pageCount = Math.max(1, Math.ceil(cameras.length / pageSize));
  const showIndicator = pageCount > 1;
  const gridHeight = showIndicator
    ? Math.max(0, availableHeight - INDICATOR_HEIGHT)
    : availableHeight;

  const cellWidth = screenWidth / columns;
  const cellHeight = gridHeight / rows;

  const scrollRef = useRef<ScrollView>(null);
  const [activePage, setActivePage] = useState(0);

  // Snap to page 0 whenever the layout (and therefore page geometry) changes.
  // Per design: page indices are not preserved across layout changes — the
  // cameras-per-page changes, so any "same page" mapping would land users on
  // unexpected start cameras.
  //
  // The scrollTo is deferred one frame: when the new layout produces fewer
  // pages (e.g., 2×2 third page → 2×3 with two pages), the ScrollView's
  // contentSize hasn't shrunk yet at the moment the effect fires, and iOS
  // ends up landing the offset at the new max scroll instead of 0. Punting
  // to requestAnimationFrame lets the new contentSize settle first.
  useEffect(() => {
    setActivePage(0);
    const id = requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ x: 0, animated: false });
    });
    return () => cancelAnimationFrame(id);
  }, [pageSize]);

  // Clamp if camera count shrinks (e.g., a camera goes offline / list reload
  // returns fewer entries) so we never sit on a page that no longer exists.
  useEffect(() => {
    if (activePage >= pageCount) {
      const target = Math.max(0, pageCount - 1);
      setActivePage(target);
      const id = requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({
          x: target * screenWidth,
          animated: false,
        });
      });
      return () => cancelAnimationFrame(id);
    }
  }, [pageCount, activePage, screenWidth]);

  const pages = useMemo(() => {
    const result: (CameraInfo | null)[][] = [];
    for (let p = 0; p < pageCount; p++) {
      const slice: (CameraInfo | null)[] = [];
      for (let i = 0; i < pageSize; i++) {
        const cameraIdx = p * pageSize + i;
        slice.push(cameraIdx < cameras.length ? cameras[cameraIdx] : null);
      }
      result.push(slice);
    }
    return result;
  }, [cameras, pageCount, pageSize]);

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
        <ThemedText style={styles.emptyText}>
          {emptyText ?? 'No cameras available on this NVR.'}
        </ThemedText>
      </View>
    );
  }

  // ScrollView fires onMomentumScrollEnd once the scroll inertia settles on a
  // page. During a fast multi-page flick this only fires once at the final
  // resting page, so intermediate pages never enter the active set and never
  // call attach() — same coalescing behavior we'd get from PagerView's
  // onPageSelected.
  const handleMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const idx = Math.round(e.nativeEvent.contentOffset.x / screenWidth);
    if (idx !== activePage) setActivePage(idx);
  };

  // Single-page case: render the original grid directly. Avoids wrapping in
  // a ScrollView for setups where it adds nothing (1×1 layout with one
  // camera, etc.) and keeps the no-paging code path identical to before.
  if (pageCount === 1) {
    return (
      <View style={styles.grid}>
        <PageGrid
          cells={pages[0]}
          rows={rows}
          columns={columns}
          cellWidth={cellWidth}
          cellHeight={cellHeight}
          mode={mode}
          pageActive
        />
      </View>
    );
  }

  return (
    <View style={styles.grid}>
      <ScrollView
        ref={scrollRef}
        style={{ height: gridHeight }}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleMomentumEnd}
        scrollEventThrottle={16}
        // Page boundaries are exact multiples of screenWidth — no need to
        // bounce, which would let users see beyond the last page.
        bounces={false}
      >
        {pages.map((slice, pageIdx) => (
          <View
            key={pageIdx}
            style={{ width: screenWidth, height: gridHeight }}
          >
            <PageGrid
              cells={slice}
              rows={rows}
              columns={columns}
              cellWidth={cellWidth}
              cellHeight={cellHeight}
              mode={mode}
              pageActive={pageIdx === activePage}
            />
          </View>
        ))}
      </ScrollView>
      <PageIndicator
        pageCount={pageCount}
        activePage={activePage}
        height={INDICATOR_HEIGHT}
      />
    </View>
  );
}

interface PageGridProps {
  cells: (CameraInfo | null)[];
  rows: number;
  columns: number;
  cellWidth: number;
  cellHeight: number;
  mode: 'live' | 'playback';
  pageActive: boolean;
}

function PageGrid({
  cells,
  rows,
  columns,
  cellWidth,
  cellHeight,
  mode,
  pageActive,
}: PageGridProps) {
  return (
    <View style={styles.pageGrid}>
      {Array.from({ length: rows }).map((_, rowIdx) => (
        <View key={rowIdx} style={styles.row}>
          {Array.from({ length: columns }).map((_, colIdx) => {
            const idx = rowIdx * columns + colIdx;
            const camera = cells[idx] ?? null;
            return (
              <CameraTile
                key={camera?.channelId ?? `empty-${idx}`}
                camera={camera}
                width={cellWidth}
                height={cellHeight}
                mode={mode}
                pageActive={pageActive}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
}

function PageIndicator({
  pageCount,
  activePage,
  height,
}: {
  pageCount: number;
  activePage: number;
  height: number;
}) {
  if (pageCount <= DOTS_BREAKPOINT) {
    return (
      <View style={[styles.indicatorRow, { height }]}>
        {Array.from({ length: pageCount }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              i === activePage ? styles.dotActive : styles.dotInactive,
            ]}
          />
        ))}
      </View>
    );
  }
  return (
    <View style={[styles.indicatorRow, { height }]}>
      <Text style={styles.indicatorText}>
        {activePage + 1} / {pageCount}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flex: 1,
    backgroundColor: '#000000',
  },
  pageGrid: {
    flex: 1,
    backgroundColor: '#000000',
  },
  row: {
    flexDirection: 'row',
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000000',
  },
  emptyText: {
    color: Surface.secondaryText,
    fontSize: 15,
  },
  indicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000000',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginHorizontal: 4,
  },
  dotActive: {
    backgroundColor: '#FFFFFF',
  },
  dotInactive: {
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
  },
  indicatorText: {
    color: 'rgba(255, 255, 255, 0.6)',
    fontSize: 12,
    fontWeight: '500',
  },
});
