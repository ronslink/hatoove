import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jpegDimensions } from './redesign-image-dimensions.mjs';
import { readImageHeader } from '../server/image-header.mjs';

for (const [name, width, height] of [['product-wide',1400,900],['product-narrow',900,1200],['og-card',1200,630]]) {
  const bytes=readFileSync(new URL('../public/assets/'+name+'.jpg',import.meta.url));
  assert.deepEqual(jpegDimensions(bytes),{width,height});
  assert.ok(bytes.length<200000,name+' must be below 200 KB');
  assert.equal(jpegDimensions(bytes.subarray(0,20)),null,'truncated JPEG refused');
  console.log('PASS '+name+' actual JPEG dimensions, size and truncation');
}
for(const [name,width,height] of [['product-wide',1400,900],['product-narrow',900,1200]]) {
  const bytes=readFileSync(new URL('../public/assets/'+name+'.webp',import.meta.url));
  const dimensions=readImageHeader(bytes,'image/webp');
  assert.equal(dimensions.width,width);assert.equal(dimensions.height,height);assert.ok(bytes.length<200000);
  assert.equal(readImageHeader(bytes.subarray(0,24),'image/webp'),null);
  console.log('PASS '+name+' WebP dimensions, size and truncation');
}
assert.equal(jpegDimensions(Buffer.from('<svg width="1200" height="630"/>')),null);
assert.equal(jpegDimensions(Buffer.from([255,216,255,224,0,1])),null);
assert.equal(jpegDimensions(Buffer.from([255,216,255,192,255,255])),null);
console.log('PASS forged and invalid image headers refused');
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
assert.ok(html.includes('/assets/product-wide.jpg')&&html.includes('/assets/product-narrow.jpg'));
assert.ok(!html.includes('/assets/landing-item'));
assert.equal((html.match(/https:\/\/hatoove.com\/assets\/og-card.jpg/g)||[]).length,2);
console.log('PASS approved captures used by landing and social metadata');
