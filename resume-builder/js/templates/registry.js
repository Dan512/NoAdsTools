// resume-builder/js/templates/registry.js — template id → { label, atsSafe, render }.
// atsSafe drives an honest labeled badge in the template picker once more than
// one template exists (glyph + words, never hue alone). Adding a template =
// one renderer file + one line here.
import { render as classic } from './classic.js';

export const TEMPLATES = Object.freeze({
  classic: { label: 'Classic (single column)', atsSafe: true, render: classic },
});
