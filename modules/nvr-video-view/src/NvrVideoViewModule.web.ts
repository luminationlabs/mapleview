import { registerWebModule, NativeModule } from 'expo';

class NvrVideoViewModule extends NativeModule {
  getVersion() {
    return '0.0.1-dummy-web';
  }
}

export default registerWebModule(NvrVideoViewModule, 'NvrVideoViewModule');
