/** Capture a sanitized snapshot before the report dialog opens. The live DOM and audio are never modified. */
const LIBRARY = '/assets/vendor/html-to-image-1.11.13.js';
const MAX_WIDTH = 1280;
const MAX_BYTES = 1572864;
const TIMEOUT_MS = 3000;
const MASK_COLOUR = '#9ca3af';
const PRIVATE = '[data-feedback-private], textarea, input:not([type=radio]):not([type=checkbox]):not([type=range]):not([type=button]):not([type=submit]), .archived-writing, .feedback-item-body, blockquote.evidence';
let libraryPromise = null;

function loadCaptureLibrary(doc) {
  if (globalThis.htmlToImage) return Promise.resolve(globalThis.htmlToImage);
  if (libraryPromise) return libraryPromise;
  libraryPromise = new Promise(resolve => {
    const script = doc.createElement('script');
    script.src = LIBRARY;
    script.async = true;
    script.onload = () => resolve(globalThis.htmlToImage ?? null);
    script.onerror = () => resolve(null);
    doc.head.append(script);
  });
  return libraryPromise;
}

/**
 * html-to-image's filter receives ORIGINAL nodes, not clones. Give it an already sanitized snapshot instead.
 * Copy computed styles while reading the source, sanitize before mounting, and mount offscreen/inert so font
 * metrics remain available. No callback receives a live private node. Removing ids avoids duplicate shell ids.
 */
export function snapshotForCapture(source, doc = source.ownerDocument) {
  const rect = source.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const clone = source.cloneNode(true);
  const originals = [source, ...source.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  const view = doc.defaultView;
  for (let i = 0; i < originals.length; i++) {
    const original = originals[i], copy = copies[i];
    if (copy !== clone && !clone.contains(copy)) continue;
    const computed = view.getComputedStyle(original);
    if (original !== source && (computed.display === 'none' || computed.visibility === 'hidden')) {
      copy.remove();
      continue;
    }
    for (const property of computed) copy.style.setProperty(property, computed.getPropertyValue(property));
    copy.removeAttribute('id');
    for (const attribute of [...copy.attributes]) {
      if (/^on/i.test(attribute.name)) copy.removeAttribute(attribute.name);
    }
    if (original.matches(PRIVATE) || original.closest('[data-feedback-private]')) {
      const box = original.getBoundingClientRect();
      copy.replaceChildren();
      for (const attribute of [...copy.attributes]) if (attribute.name !== 'style') copy.removeAttribute(attribute.name);
      if ('value' in copy) copy.value = '';
      copy.style.setProperty('background', MASK_COLOUR, 'important');
      copy.style.setProperty('color', 'transparent', 'important');
      copy.style.setProperty('background-image', 'none', 'important');
      copy.style.setProperty('text-shadow', 'none', 'important');
      copy.style.setProperty('min-width', `${box.width}px`, 'important');
      copy.style.setProperty('min-height', `${box.height}px`, 'important');
      copy.dataset.feedbackMasked = '';
      continue;
    }
    if (original.tagName === 'INPUT') copy.checked = original.checked;
    if (original.tagName === 'SELECT') copy.value = original.value;
    if (['AUDIO', 'VIDEO', 'SOURCE', 'IFRAME', 'SCRIPT'].includes(original.tagName)) {
      copy.removeAttribute('src');
      copy.removeAttribute('srcdoc');
      copy.removeAttribute('autoplay');
      copy.replaceChildren();
      if (original.tagName === 'SCRIPT') copy.remove();
    }
    if (original.tagName === 'IMG') {
      const url = new URL(original.currentSrc || original.src, doc.baseURI);
      if (url.origin !== view.location.origin && !['data:', 'blob:'].includes(url.protocol)) copy.removeAttribute('src');
      copy.removeAttribute('srcset');
    }
  }
  const mount = doc.createElement('div');
  mount.dataset.feedbackCapture = '';
  mount.setAttribute('aria-hidden', 'true');
  mount.inert = true;
  mount.style.cssText = `position:fixed;left:-100000px;top:0;width:${rect.width}px;pointer-events:none;z-index:-1;`;
  clone.style.setProperty('position', 'relative', 'important');
  clone.style.setProperty('inset', 'auto', 'important');
  clone.style.setProperty('margin', '0', 'important');
  clone.style.setProperty('width', `${rect.width}px`, 'important');
  clone.style.setProperty('transform', 'none', 'important');
  mount.append(clone);
  source.parentElement.append(mount);
  return { node: clone, rect, remove: () => mount.remove() };
}

export async function capturePage({ maxWidth = MAX_WIDTH, timeoutMs = TIMEOUT_MS, quality = 0.7,
  doc = document, library = null } = {}) {
  const snapshots = [];
  let cancelled = false;
  const cleanup = () => { for (const snapshot of snapshots) snapshot.remove(); };
  const work = (async () => {
    const htmlToImage = library ?? await loadCaptureLibrary(doc);
    if (!htmlToImage || cancelled) return null;
    const nodes = [doc.querySelector('header.topbar'), doc.getElementById('main')].filter(Boolean);
    const canvases = [];
    for (const source of nodes) {
      const snapshot = snapshotForCapture(source, doc);
      if (!snapshot) continue;
      snapshots.push(snapshot);
      const { rect } = snapshot;
      // The report records the visible page, not an unbounded document taller than a device screen.
      const height = Math.min(rect.height, Math.max(1, doc.defaultView.innerHeight - Math.max(0, rect.top)));
      const canvas = await htmlToImage.toCanvas(snapshot.node, {
        width: Math.ceil(rect.width), height: Math.ceil(height),
        pixelRatio: Math.min(1, maxWidth / rect.width), skipFonts: false, cacheBust: false,
        style: { transform: `translateY(${Math.min(0, rect.top)}px)` },
      });
      if (cancelled) return null;
      if (canvas) canvases.push(canvas);
    }
    if (!canvases.length || cancelled) return null;
    const image = doc.createElement('canvas');
    image.width = Math.max(...canvases.map(canvas => canvas.width));
    image.height = canvases.reduce((sum, canvas) => sum + canvas.height, 0);
    const context = image.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, image.width, image.height);
    let y = 0;
    for (const canvas of canvases) { context.drawImage(canvas, 0, y); y += canvas.height; }
    const blob = await new Promise(resolve => image.toBlob(webp => {
      if (webp?.type === 'image/webp') resolve(webp);
      else image.toBlob(png => resolve(png ?? null), 'image/png');
    }, 'image/webp', quality));
    if (cancelled || !blob || blob.size > MAX_BYTES) return null;
    return { blob, width: image.width, height: image.height, mimeType: blob.type };
  })();
  let timer;
  try {
    return await Promise.race([work.catch(() => null), new Promise(resolve => {
      timer = setTimeout(() => { cancelled = true; cleanup(); resolve(null); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); cleanup(); }
}

export async function capturePreview(options) {
  try {
    const capture = await capturePage(options);
    if (!capture) return null;
    const previewUrl = await new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(capture.blob);
    });
    return previewUrl ? { ...capture, previewUrl } : null;
  } catch { return null; }
}
