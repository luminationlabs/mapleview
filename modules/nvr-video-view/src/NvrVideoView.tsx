import { requireNativeView } from 'expo';
import * as React from 'react';

import type { NvrVideoViewProps, NvrVideoViewRef } from './NvrVideoView.types';

const NativeView: React.ComponentType<
  NvrVideoViewProps & React.RefAttributes<NvrVideoViewRef>
> = requireNativeView('NvrVideoView');

const NvrVideoView = React.forwardRef<NvrVideoViewRef, NvrVideoViewProps>(
  (props, ref) => <NativeView {...props} ref={ref} />,
);

NvrVideoView.displayName = 'NvrVideoView';

export default NvrVideoView;
