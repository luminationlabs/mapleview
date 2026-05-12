import * as React from 'react';

import type { NvrVideoViewProps, NvrVideoViewRef } from './NvrVideoView.types';

const NvrVideoView = React.forwardRef<NvrVideoViewRef, NvrVideoViewProps>(
  (props, ref) => {
    React.useImperativeHandle(ref, () => ({
      feed: async () => {
        // Web stub — no-op.
      },
      flush: async (_targetPts: number) => {
        // Web stub — no-op.
      },
      setSpeed: async () => {
        // Web stub — no-op.
      },
      markPotentialGap: async () => {
        // Web stub — no-op.
      },
    }));
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          background: props.backgroundHex ?? '#3a32a8',
          color: 'white',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'monospace',
        }}
      >
        NvrVideoView (web stub)
      </div>
    );
  },
);

NvrVideoView.displayName = 'NvrVideoView';

export default NvrVideoView;
