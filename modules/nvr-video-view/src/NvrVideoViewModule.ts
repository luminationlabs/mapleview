import { NativeModule, requireNativeModule } from 'expo';

declare class NvrVideoViewModule extends NativeModule {
  getVersion(): string;
}

export default requireNativeModule<NvrVideoViewModule>('NvrVideoView');
