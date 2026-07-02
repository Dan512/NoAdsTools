// photo-editor/js/settings.js — editor settings glue.
//
// The settings store now lives in shared/settings.js (tool-agnostic micro-
// store). This module: (1) registers the editor's 6 tool-scoped settings,
// (2) wires the reactivity bridge so a settings change re-fires the editor's
// state.subscribe consumers (canvas repaint picks up showOverlayOutlines /
// smoothBrushStrokes), (3) re-exports getSetting/setSetting/initSettings so
// existing call sites (`import { getSetting } from './settings.js'`) and
// main.js are unchanged, (4) seeds state.export from the user's defaults.
import { update } from './state.js';
import {
  registerSetting, subscribeSettings, getSetting, hasExplicitValue,
} from '../../shared/settings.js';

// Register the 6 editor (tool-scoped) settings. Label/aria/option keys live in
// the editor i18n dict and resolve through the merged i18n store via t().
export function registerEditorSettings() {
  registerSetting('defaultExportFormat', {
    kind: 'enum', scope: 'tool', default: 'png',
    options: [
      { value: 'png',  labelKey: 'exportFormatPng' },
      { value: 'jpeg', labelKey: 'exportFormatJpg' },
      { value: 'webp', labelKey: 'exportFormatWebp' },
    ],
    labelKey: 'settingsDefaultFormat', ariaKey: 'settingsDefaultFormatAria',
  });
  registerSetting('defaultQuality', {
    kind: 'number', scope: 'tool', min: 0.5, max: 1.0, step: 0.01, default: 0.92,
    labelKey: 'settingsDefaultQuality', ariaKey: 'settingsDefaultQualityAria',
  });
  registerSetting('confirmBeforeRemove', {
    kind: 'bool', scope: 'tool', default: false,
    labelKey: 'settingsConfirmRemove', ariaKey: 'settingsConfirmRemoveAria',
  });
  registerSetting('showOverlayOutlines', {
    kind: 'bool', scope: 'tool', default: false,
    labelKey: 'settingsOverlayOutlines', ariaKey: 'settingsOverlayOutlinesAria',
  });
  registerSetting('smoothBrushStrokes', {
    kind: 'bool', scope: 'tool', default: true,
    labelKey: 'settingsSmoothBrush', ariaKey: 'settingsSmoothBrushAria',
  });
  registerSetting('autoRefreshThumbnails', {
    kind: 'bool', scope: 'tool', default: true,
    labelKey: 'settingsAutoRefreshThumbs', ariaKey: 'settingsAutoRefreshThumbsAria',
  });
}

// Reactivity bridge: re-fire the editor's existing state.subscribe consumers on
// any settings change. Only showOverlayOutlines is genuinely reactive (canvas
// repaint); the rest are read on demand, so a no-op state.update() is enough.
export function initSettingsReactivity() {
  subscribeSettings(() => update(() => {}));
}

// Seed state.export with the user's defaults BEFORE the editor renders its
// panels. If the user explicitly stored a defaultExportFormat (came from
// localStorage, not the schema default), lock it so the smart match-source
// default (ops/formatSmart.js) doesn't override their stated preference.
export function seedExportDefaults() {
  const fmt = getSetting('defaultExportFormat');
  const q = getSetting('defaultQuality');
  const userHasExplicitFormat = hasExplicitValue('defaultExportFormat');
  update((s) => {
    if (!s.export) return;
    s.export.format = fmt;
    s.export.quality = q;
    if (userHasExplicitFormat) s.export._userFormatLocked = true;
  });
}

// Re-exports so consumers + main.js keep importing from './settings.js'.
export { getSetting, setSetting, initSettings } from '../../shared/settings.js';
