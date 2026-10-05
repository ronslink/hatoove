/**
 * PILOT-FEEDBACK-01 (slice FB-E) — capture the page the learner was on.
 *
 * WHAT IT IS FOR. A report about a listening item, a layout or a translation is far more actionable with the
 * page in front of the operator. So the sheet attaches a screenshot of the page — taken BEFORE the sheet opens,
 * because an image of the form tells nobody anything.
 *
 * THE RULES IT MUST KEEP.
 *
 *   * It captures `#main` and the top bar only, which is the app area the learner was reading. Not the whole
 *     document: that would include a drawer or a dialog that happens to be open.
 *   * It NEVER touches playback, the run state or the route. It reads the DOM and returns a blob; the listening
 *     lesson of 5 October was a form whose mount flushed the controller mid-recording.
 *   * It is bounded: at most 1280 px wide, and it gives up after `timeoutMs` rather than holding the UI. A
 *     failure returns null and the sheet opens WITHOUT a thumbnail — the report still works, which is the
 *     contract's rule and the reason this function never throws.
 *
 * MASKING. `data-feedback-private` elements are drawn as flat grey blocks. The library's `filter` receives the
 * CLONED node, so the original page is untouched — that is why this library was chosen. Password inputs are
 * masked by type as well, belt and braces, since a password field should never reach an image.
 *
 * The library itself is vendored in `public/assets/vendor/`, pinned by digest, and loaded from there: no CDN, no
 * third-party origin at page load. See `public/assets/vendor/README.md` for its provenance.
 */

const LIBRARY = '/assets/vendor/html-to-image-1.11.13.js';
const MAX_WIDTH = 1280;
const TIMEOUT_MS = 3000;
const QUALITY = 0.7;
/** The grey a masked element is replaced with: mid-grey, legible against both themes. */
const MASK_COLOUR = '#9ca3af';

let libraryPromise = null;

/** Load the vendored UMD bundle once, from this origin. Resolves to the global, or null if it cannot load. */
function loadCaptureLibrary() {
  if (globalThis.htmlToImage) return Promise.resolve(globalThis.htmlToImage);
  if (libraryPromise) return libraryPromise;
  libraryPromise = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = LIBRARY;
    script.async = true;
    script.onload = () => resolve(globalThis.htmlToImage ?? null);
    script.onerror = () => resolve(null);
    document.head.append(script);
  });
  return libraryPromise;
}

/**
 * Turn private content into a grey block IN THE CLONE. Returning true keeps the node, so the layout an operator
 * sees still has the shape of the page while the content is gone.
 */
function maskPrivate(node) {
  if (!node || node.nodeType !== 1) return true;
  const dataset = node.dataset ?? {};
  const password = node.tagName === 'INPUT' && node.type === 'password';
  if (dataset.feedbackPrivate === undefined && !password) return true;
  node.style.setProperty('background', MASK_COLOUR, 'important');
  node.style.setProperty('color', 'transparent', 'important');
  node.style.setProperty('border-color', 'transparent', 'important');
  node.style.setProperty('text-shadow', 'none', 'important');
  node.style.setProperty('filter', 'blur(0)', 'important');
  if (password) node.value = '';
  // A masked element must not leak its content through a child that sets its own colour back.
  for (const child of node.querySelectorAll?.('*') ?? []) {
    child.style?.setProperty('color', 'transparent', 'important');
    child.style?.setProperty('background-image', 'none', 'important');
  }
  return true;
}

/** One node to a canvas at the natural size, scaled so the result is no wider than `maxWidth`. */
async function nodeToCanvas(htmlToImage, node, maxWidth) {
  const rect = node.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const ratio = Math.min(1, maxWidth / rect.width);
  return htmlToImage.toCanvas(node, {
    width: Math.ceil(rect.width),
    height: Math.ceil(rect.height),
    pixelRatio: ratio,
    // Every private element is greyed in the clone, and the page itself is never modified.
    filter: maskPrivate,
    // The interface ships Arabic; a capture that dropped the embedded fonts would render boxes.
    skipFonts: false,
    cacheBust: false,
  });
}

/**
 * Capture the app area. Resolves to `{ blob, width, height, mimeType }` or **null** — never a rejection, because
 * a caller that has to catch is a caller that can forget to.
 */
export async function capturePage({
  maxWidth = MAX_WIDTH,
  timeoutMs = TIMEOUT_MS,
  quality = QUALITY,
  doc = document,
} = {}) {
  const work = (async () => {
    const htmlToImage = await loadCaptureLibrary();
    if (!htmlToImage) return null;
    const nodes = [doc.querySelector('header.topbar'), doc.getElementById('main')].filter(Boolean);
    if (!nodes.length) return null;

    const canvases = [];
    for (const node of nodes) {
      const canvas = await nodeToCanvas(htmlToImage, node, maxWidth);
      if (canvas) canvases.push(canvas);
    }
    if (!canvases.length) return null;

    // Stacked in document order: the top bar sits above the content, so stacking reproduces the page rather than
    // inventing a layout.
    const width = Math.max(...canvases.map((canvas) => canvas.width));
    const height = canvases.reduce((sum, canvas) => sum + canvas.height, 0);
    const sheet = doc.createElement('canvas');
    sheet.width = width;
    sheet.height = height;
    const context = sheet.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    let y = 0;
    for (const canvas of canvases) {
      context.drawImage(canvas, 0, y);
      y += canvas.height;
    }

    const blob = await new Promise((resolve) => {
      sheet.toBlob((webp) => {
        // Safari before 14 has no WebP encoder and silently returns a PNG; the declared type must match the
        // bytes, so fall back explicitly rather than trusting the call.
        if (webp && webp.type === 'image/webp') return resolve(webp);
        sheet.toBlob((png) => resolve(png ?? null), 'image/png');
      }, 'image/webp', quality);
    });
    if (!blob) return null;
    return { blob, width: sheet.width, height: sheet.height, mimeType: blob.type };
  })();

  // BOUNDED. The sheet opens with a note instead of a thumbnail if this loses the race, and the learner's report
  // is never held hostage by a slow capture.
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  try {
    return await Promise.race([work.catch(() => null), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The postage-stamp preview, as a data URL the sheet can drop into an <img>. Failure is null, never a throw. */
export async function capturePreview(options) {
  const capture = await capturePage(options);
  if (!capture) return null;
  const url = await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(capture.blob);
  });
  return url ? { ...capture, previewUrl: url } : null;
}
