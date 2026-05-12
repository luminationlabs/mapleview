// Reexport the native module. On web, it will be resolved to NvrVideoViewModule.web.ts
// and on native platforms to NvrVideoViewModule.ts
export { default } from './src/NvrVideoViewModule';
export { default as NvrVideoView } from './src/NvrVideoView';
export * from  './src/NvrVideoView.types';
