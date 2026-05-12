import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#FFFFFF',
    background: '#000000',
    tint: '#FFFFFF',
    icon: '#8E8E93',
    tabIconDefault: '#8E8E93',
    tabIconSelected: '#FFFFFF',
  },
  dark: {
    text: '#FFFFFF',
    background: '#000000',
    tint: '#FFFFFF',
    icon: '#8E8E93',
    tabIconDefault: '#8E8E93',
    tabIconSelected: '#FFFFFF',
  },
};

/** Dark theme surface colors */
export const Surface = {
  /** Pure black background */
  background: '#000000',
  /** Dark gray for cards/forms */
  card: '#1C1C1E',
  /** Slightly lighter gray for inputs */
  input: '#2C2C2E',
  /** Separator / border */
  separator: '#38383A',
  /** Placeholder text */
  placeholder: '#636366',
  /** Secondary text */
  secondaryText: '#8E8E93',
  /** Destructive red */
  destructive: '#FF453A',
  /** Success green */
  success: '#30D158',
  /** Error red */
  error: '#FF453A',
  /** Connecting — dim/semi-transparent white */
  connecting: '#FFFFFF80',
  /** Offline — iOS secondary label */
  offline: '#8E8E93',
  /** Failed — iOS system red dark mode */
  failed: '#FF453A',
};

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
