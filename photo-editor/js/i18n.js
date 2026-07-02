// photo-editor/js/i18n.js — editor i18n shim. Registers the editor's
// translation dictionary into the shared i18n machinery, then re-exports the
// machinery so existing `import { t, … } from './i18n.js'` call sites are
// unchanged. The register() side-effect runs on first import (before any t()).
import { registerTranslations } from '../../shared/i18n.js';
import { EDITOR_TRANSLATIONS } from './i18n-strings.js';

registerTranslations(EDITOR_TRANSLATIONS);

export * from '../../shared/i18n.js';
