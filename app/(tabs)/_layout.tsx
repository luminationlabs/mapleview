import { Tabs } from 'expo-router';
import React from 'react';
import { StackActions } from '@react-navigation/native';

import { HapticTab } from '@/src/components/ui/haptic-tab';
import { IconSymbol } from '@/src/components/ui/icon-symbol';
import { Surface } from '@/src/constants/theme';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#FFFFFF',
        tabBarInactiveTintColor: Surface.secondaryText,
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarStyle: {
          backgroundColor: '#000000',
          borderTopColor: Surface.separator,
        },
      }}>
      <Tabs.Screen
        name="(live)"
        options={{
          title: 'Live',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="video.fill" color={color} />,
        }}
        listeners={({ navigation }) => ({
          // Mirror of the (playback) listener: tapping Live always lands on
          // the Live grid, so a pushed single-cam view doesn't stick around
          // when the user switches away and back.
          tabPress: () => {
            const state = navigation.getState();
            const liveRoute = state?.routes?.find(
              (r: { name: string }) => r.name === '(live)',
            );
            if (liveRoute?.state?.key) {
              navigation.dispatch({
                ...StackActions.popToTop(),
                target: liveRoute.state.key,
              });
            }
          },
        })}
      />
      <Tabs.Screen
        name="(playback)"
        options={{
          title: 'Recorded',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="clock.arrow.trianglehead.counterclockwise.rotate.90" color={color} />,
        }}
        listeners={({ navigation }) => ({
          // Pop the Recorded tab's stack to root on every tab press. Without
          // this, a pushed single-camera screen (e.g. via the Live single-
          // cam's "view recordings" button) sticks on top — so the user taps
          // Recorded expecting the grid but lands on the stale single-view
          // instead. popToTop is dispatched against the (playback) stack's
          // own key so it doesn't affect the other tabs' stacks.
          tabPress: () => {
            const state = navigation.getState();
            const playbackRoute = state?.routes?.find(
              (r: { name: string }) => r.name === '(playback)',
            );
            if (playbackRoute?.state?.key) {
              navigation.dispatch({
                ...StackActions.popToTop(),
                target: playbackRoute.state.key,
              });
            }
          },
        })}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <IconSymbol size={28} name="gearshape.fill" color={color} />,
        }}
      />
    </Tabs>
  );
}
