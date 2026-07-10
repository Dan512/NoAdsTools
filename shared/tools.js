// shared/tools.js — single source of truth for the platform's tools.
//
// Drives the topbar "Tools" dropdown and the footer "Other NoAds tools" links
// today; the homepage tile grid + publish.mjs include list in Plan C. Adding a
// tool = adding one entry here.
//
// status:
//   'live'    — built + shipped; rendered as a working link everywhere.
//   'planned' — on the roadmap, not built yet; kept here so this file stays the
//               single source of truth, but filtered out of live link lists
//               (liveTools()) AND out of the publish include-set. (Flipping a
//               tool to 'live' without its directory existing makes
//               scripts/publish.mjs fail hard — deliberately.)
//
// title/blurb/category label are plain English strings (NOT i18n keys) — tool
// names are English-first per the platform i18n decision; the homepage can
// localize later without touching this contract.
export const CATEGORIES = Object.freeze([
  { id: 'image',     label: 'Image tools' },
  { id: 'pdf',       label: 'PDF tools' },
  { id: 'generator', label: 'Generators' },
  { id: 'dev',       label: 'Developer' },
]);

export const TOOLS = Object.freeze([
  { slug: 'photo-editor', title: 'Photo Editor', category: 'image',
    blurb: 'Crop, resize, redact, remove backgrounds, batch-export — in your browser.',
    status: 'live' },
  { slug: 'remove-exif', title: 'Remove EXIF data', category: 'image',
    blurb: 'Strip location and camera metadata from photos. Nothing uploaded.',
    status: 'live' },
  { slug: 'heic-to-jpg', title: 'HEIC to JPG', category: 'image',
    blurb: 'Convert iPhone HEIC photos to JPG, entirely on your device.',
    status: 'live' },
  { slug: 'find-duplicate-photos', title: 'Find Duplicate Photos', category: 'image',
    blurb: 'Spot duplicate and near-duplicate photos and keep only the best copy. Nothing uploaded.',
    status: 'live' },
  { slug: 'compress-images', title: 'Compress images', category: 'image',
    blurb: 'Shrink JPG, PNG, and WebP files without uploading them.',
    status: 'live' },
  { slug: 'resize-image', title: 'Resize Image', category: 'image',
    blurb: 'Resize photos to exact pixels or by percentage — high quality, nothing uploaded.',
    status: 'live' },
  { slug: 'convert-image', title: 'Convert Image', category: 'image',
    blurb: 'Convert between JPEG, PNG, WebP, and AVIF — any to any, nothing uploaded.',
    status: 'live' },
  { slug: 'crop-image', title: 'Crop Image', category: 'image',
    blurb: 'Crop photos with an interactive box and aspect presets — nothing uploaded.',
    status: 'live' },
  { slug: 'color-palette-from-image', title: 'Color Palette From Image', category: 'image',
    blurb: 'Pull a color palette and hex codes from any image — nothing uploaded.',
    status: 'live' },
  { slug: 'favicon-generator', title: 'Favicon Generator', category: 'image',
    blurb: 'Turn an image into a full favicon package — .ico, PNGs, and manifest. Nothing uploaded.',
    status: 'live' },
  { slug: 'image-to-pdf', title: 'Image to PDF', category: 'pdf',
    blurb: 'Combine images into a single PDF, locally.',
    status: 'live' },
  { slug: 'qr-code-generator', title: 'QR Code Generator', category: 'generator',
    blurb: 'Make QR codes. No tracking, no account.',
    status: 'live' },
]);

export function liveTools() {
  return TOOLS.filter(tl => tl.status === 'live');
}

export function toolBySlug(slug) {
  return TOOLS.find(tl => tl.slug === slug) || null;
}

export function toolsByCategory(cat) {
  return TOOLS.filter(tl => tl.category === cat);
}
