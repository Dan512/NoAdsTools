// js/privacy.js — editor privacy glue.
//
// The privacy panel mechanism now lives in shared/privacy.js. This module
// registers the EDITOR's disclosure rows (the libraries/models it fetches, the
// platform-wide "what we don't do"/external/AI/open-source/tip sections, and
// the localStorage keys it sets) and the panel chrome (title/lead + the editor's
// static privacy.html link), then boots the shared panel. The section bodies are
// the editor's i18n HTML keys, resolved via t() in the shared renderer. main.js
// still does `import { initPrivacy } from './privacy.js'`.
import { registerPrivacyRows, initPrivacy as initSharedPrivacy } from '../../shared/privacy.js';

export function initPrivacy() {
  registerPrivacyRows([
    { headingKey: 'privacyFetchesHeading',    bodyKey: 'privacyFetchesList',    kind: 'list' },
    { headingKey: 'privacyNotHeading',        bodyKey: 'privacyNotList',        kind: 'list' },
    { headingKey: 'privacyExternalHeading',   bodyKey: 'privacyExternalList',   kind: 'list' },
    { headingKey: 'privacyStorageHeading',    bodyKey: 'privacyStorageBody',    kind: 'text' },
    { headingKey: 'privacyAIHeading',         bodyKey: 'privacyAIBody',         kind: 'text' },
    { headingKey: 'privacyOpenSourceHeading', bodyKey: 'privacyOpenSourceBody', kind: 'text' },
    { headingKey: 'privacyTipHeading',        bodyKey: 'privacyTipBody',        kind: 'text' },
  ]);
  initSharedPrivacy({
    titleKey: 'privacyTitle',
    leadKey: 'privacyLead',
    staticHref: '/photo-editor/privacy.html',
    staticLinkKey: 'privacyStaticLink',
  });
}

// Re-export the test reset so any importer of './privacy.js' keeps resolving.
export { _resetForTest } from '../../shared/privacy.js';
