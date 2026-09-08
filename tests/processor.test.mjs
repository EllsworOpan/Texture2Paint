import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUvFlip, extractGlbImages } from '../src/processor.js';

test('applyUvFlip correctly inverts Y coordinates and restores original on unflip', () => {
  // Simulate Three.js mesh geometry structure
  const uvArray = new Float32Array([
    0.1, 0.2,   // vertex 0: u=0.1, v=0.2
    0.4, 0.7,   // vertex 1: u=0.4, v=0.7
    0.9, 0.0,   // vertex 2: u=0.9, v=0.0
    0.5, 1.0,   // vertex 3: u=0.5, v=1.0
  ]);

  const mockMesh = {
    isMesh: true,
    geometry: {
      attributes: {
        uv: {
          array: uvArray,
          itemSize: 2,
          needsUpdate: false,
        }
      }
    }
  };

  const mockScene = {
    traverse(callback) {
      callback(mockMesh);
    }
  };

  // Flip UVs
  applyUvFlip(mockScene, true);
  assert.equal(mockMesh.geometry.attributes.uv.needsUpdate, true);

  // U values should remain unchanged
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[0] - 0.1) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[2] - 0.4) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[4] - 0.9) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[6] - 0.5) < 1e-5);

  // V values should be 1.0 - V
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[1] - 0.8) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[3] - 0.3) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[5] - 1.0) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[7] - 0.0) < 1e-5);

  // Unflip UVs - should restore exact original values without float drift
  applyUvFlip(mockScene, false);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[1] - 0.2) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[3] - 0.7) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[5] - 0.0) < 1e-5);
  assert.ok(Math.abs(mockMesh.geometry.attributes.uv.array[7] - 1.0) < 1e-5);
});

test('extractGlbImages returns empty array on invalid or non-GLB buffers', () => {
  assert.deepEqual(extractGlbImages(null), []);
  assert.deepEqual(extractGlbImages(new ArrayBuffer(10)), []);
  assert.deepEqual(extractGlbImages(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).buffer), []);
});

test('extractGlbImages extracts embedded images from valid GLB mock buffer', () => {
  const jsonContent = JSON.stringify({
    asset: { version: '2.0' },
    images: [
      { bufferView: 0, mimeType: 'image/webp' },
      { bufferView: 1, mimeType: 'image/png' }
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 4 },
      { buffer: 0, byteOffset: 4, byteLength: 4 }
    ],
    buffers: [{ byteLength: 8 }]
  });

  const jsonBytes = new TextEncoder().encode(jsonContent);
  const jsonPadded = (jsonBytes.length + 3) & ~3;
  const binLength = 8;
  const totalLength = 12 + 8 + jsonPadded + 8 + binLength;

  const buffer = new ArrayBuffer(totalLength);
  const dv = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  // GLB header
  dv.setUint32(0, 0x46546c67, true); // 'glTF'
  dv.setUint32(4, 2, true);          // version 2
  dv.setUint32(8, totalLength, true);

  // JSON chunk header
  dv.setUint32(12, jsonPadded, true);
  dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
  u8.set(jsonBytes, 20);
  for (let i = jsonBytes.length; i < jsonPadded; i++) u8[20 + i] = 0x20;

  // BIN chunk header
  const binHeaderOffset = 20 + jsonPadded;
  dv.setUint32(binHeaderOffset, binLength, true);
  dv.setUint32(binHeaderOffset + 4, 0x004e4942, true); // 'BIN\0'

  // BIN data (mock image bytes)
  const binDataOffset = binHeaderOffset + 8;
  u8.set([0x52, 0x49, 0x46, 0x46], binDataOffset);     // RIFF (WebP)
  u8.set([0x89, 0x50, 0x4e, 0x47], binDataOffset + 4); // PNG

  const extracted = extractGlbImages(buffer);
  assert.equal(extracted.length, 2);
  assert.equal(extracted[0].mimeType, 'image/webp');
  assert.equal(extracted[0].byteLength, 4);
  assert.equal(extracted[1].mimeType, 'image/png');
  assert.equal(extracted[1].byteLength, 4);
});

test('extractGlbImages extracts texture from sample_textured.glb fixture', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sample_textured.glb');
  if (!existsSync(fixturePath)) return;

  const buf = readFileSync(fixturePath);
  const images = extractGlbImages(buf);
  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, 'image/png');
  assert.ok(images[0].byteLength > 0);
});
