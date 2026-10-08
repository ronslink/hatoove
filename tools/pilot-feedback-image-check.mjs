import assert from 'node:assert/strict';
import fs from 'node:fs';
import { feedbackPng } from './lib/feedback-image-fixtures.mjs';
import { readImageHeader } from '../server/image-header.mjs';
let failed = 0, count = 0;
const check = (name, run) => { count++; try { run(); console.log('PASS ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message); } };
const png = feedbackPng();
check('PNG contains a decodable raster with exact dimensions', () =>
  assert.deepEqual(readImageHeader(png,'image/png'),{mimeType:'image/png',width:1280,height:720}));
check('declared MIME must match bytes', () => assert.equal(readImageHeader(png,'image/webp'),null));
check('header-only PNG is refused', () => assert.equal(readImageHeader(png.subarray(0,33)),null));
check('PNG CRC corruption is refused', () => {
  const corrupt = Buffer.from(png); corrupt[29] ^= 1; assert.equal(readImageHeader(corrupt),null);
});
check('PNG without compressed pixels is refused', () => {
  assert.equal(readImageHeader(Buffer.concat([png.subarray(0,33),png.subarray(-12)])),null);
});
check('PNG trailing payload is refused', () => assert.equal(readImageHeader(Buffer.concat([png,Buffer.from('payload')])),null));
check('PNG truncated payload is refused', () => assert.equal(readImageHeader(png.subarray(0,-1)),null));
check('non-image binary is refused', () => assert.equal(readImageHeader(Buffer.from('this is not a screenshot')),null));
check('metadata-only WebP is refused', () => {
  const b = Buffer.alloc(30); b.write('RIFF'); b.writeUInt32LE(22,4); b.write('WEBP',8); b.write('VP8X',12); b.writeUInt32LE(10,16);
  assert.equal(readImageHeader(b,'image/webp'),null);
});
const asset = fs.readFileSync(new URL('../hatoove-site/dist/assets/orange-path-900.webp',import.meta.url));
// The screenshot encoder emits a still frame without the asset's C2PA provenance chunk.
const webp = Buffer.from(asset.subarray(0, 20 + asset.readUInt32LE(16)));
webp.writeUInt32LE(webp.length - 8, 4);
check('real shipped WebP frame is accepted', () => {
  const result = readImageHeader(webp,'image/webp'); assert.ok(result); assert.equal(result.width,900);
});
check('RIFF underclaim and overclaim are refused', () => {
  for (const size of [0, webp.length + 100]) {
    const b = Buffer.from(webp); b.writeUInt32LE(size,4); assert.equal(readImageHeader(b),null);
  }
});
check('truncated WebP frame is refused', () => assert.equal(readImageHeader(webp.subarray(0,-5)),null));
console.log(count - failed + '/' + count + ' image checks passed');
if (failed) process.exitCode = 1;
