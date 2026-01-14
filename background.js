// Manifest V3 service worker entry point
// This file imports all the background scripts for Vimium

// Define global object for compatibility (service workers don't have window)
globalThis.global = globalThis;

// Import all background scripts in order
importScripts(
  'vimium/lib/utils.js',
  'vimium/lib/settings.js',
  'vimium/background_scripts/bg_utils.js',
  'vimium/background_scripts/commands.js',
  'vimium/background_scripts/exclusions.js',
  'vimium/background_scripts/completion_engines.js',
  'vimium/background_scripts/completion_search.js',
  'vimium/background_scripts/completion.js',
  'vimium/background_scripts/marks.js',
  'vimium/background_scripts/main.js'
);
