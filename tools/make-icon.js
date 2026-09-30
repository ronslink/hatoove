/**
 * Generate the B1 Prep application icon.
 *
 * Renders the icon on a canvas in a real browser (so the text is properly hinted
 * and kerned) and packs the sizes into a multi-resolution .ico. Windows has
 * supported PNG-compressed icon entries since Vista, so no BMP encoding is needed.
 *
 * Usage: node tools/make-icon.js [outputPath]
 */

import fs from 'node:fs';
import path from 'node:path';
import { findBrowser, launchBrowser, connectToPage, sleep } from './cdp.js';

const OUT = process.argv[2] || 'b1prep.ico';
const PORT = 9228;
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Draw one icon at a given pixel size and return it as a PNG buffer. */
function renderScripts(sizes) {
  return `
    return (async () => {
      const sizes = ${JSON.stringify(sizes)};
      const out = {};
      const hexToRgb = (h) => [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];

      const roundRect = (ctx, x, y, w, h, r) => {
        if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
      };

      for (const size of sizes) {
        const c = document.createElement('canvas');
        c.width = size; c.height = size;
        const ctx = c.getContext('2d');

        // Rounded tile with the app's accent gradient.
        const g = ctx.createLinearGradient(0, 0, size, size);
        g.addColorStop(0, '#7d9bff');
        g.addColorStop(1, '#3f4fc4');
        ctx.fillStyle = g;
        roundRect(ctx, 0, 0, size, size, size * 0.22);
        ctx.fill();

        // Subtle top highlight so it reads as a tile rather than a flat square.
        const hi = ctx.createLinearGradient(0, 0, 0, size * 0.5);
        hi.addColorStop(0, 'rgba(255,255,255,0.22)');
        hi.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = hi;
        roundRect(ctx, 0, 0, size, size * 0.55, size * 0.22);
        ctx.fill();

        if (size >= 32) {
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold ' + Math.round(size * 0.44) + 'px "Segoe UI", system-ui, Arial, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('B1', size / 2, size * 0.53);
        } else {
          // At 16px the text turns to mush, so use a bolder, simpler mark.
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold ' + Math.round(size * 0.62) + 'px "Segoe UI", system-ui, Arial, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('B1', size / 2, size * 0.55);
        }

        out[size] = c.toDataURL('image/png');
      }
      return out;
    })();
  `;
}

/** Pack PNG buffers into a .ico container. */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  entries.forEach((entry, i) => {
    const base = i * 16;
    // 0 means 256 in the ICO format.
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 0);
    dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1);
    dir.writeUInt8(0, base + 2); // palette size
    dir.writeUInt8(0, base + 3); // reserved
    dir.writeUInt16LE(1, base + 4); // colour planes
    dir.writeUInt16LE(32, base + 6); // bits per pixel
    dir.writeUInt32LE(entry.png.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

async function main() {
  if (!findBrowser()) {
    console.error('No Chrome or Edge found, so the icon cannot be rendered.');
    process.exit(2);
  }

  const { cleanup } = await launchBrowser(PORT, { headless: true, extraArgs: ['--force-device-scale-factor=1'] });
  let cdp = null;
  try {
    cdp = await connectToPage(PORT);
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(300);

    const dataUrls = await cdp.evaluate(renderScripts(SIZES));
    const entries = [];
    for (const size of SIZES) {
      const url = dataUrls[size];
      if (!url || !url.startsWith('data:image/png;base64,')) throw new Error(`no PNG for ${size}px`);
      const png = Buffer.from(url.split(',')[1], 'base64');
      entries.push({ size, png });
    }

    const ico = buildIco(entries);
    const target = path.resolve(OUT);
    fs.writeFileSync(target, ico);

    console.log(`Wrote ${target}`);
    console.log(`  sizes : ${SIZES.join(', ')}`);
    console.log(`  bytes : ${ico.length}`);
    for (const e of entries) console.log(`    ${String(e.size).padStart(3)}px  ${e.png.length} bytes`);
  } catch (err) {
    console.error('icon generation failed:', err.message);
    process.exitCode = 1;
  } finally {
    await cleanup();
    if (cdp) {
      try {
        cdp.ws.close();
      } catch {
        /* ignore */
      }
    }
    await sleep(200);
  }
}

main();
