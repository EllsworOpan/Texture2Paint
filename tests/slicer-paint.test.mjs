import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { exportMultiColor3MF } from '../src/processor.js';
import { assertPrusaUsesPaint, canSlicePrusa } from './helpers/prusa-slice.mjs';

async function paintedCube(slot, format = 'prusa2-bambu') {
  const palette = Array.from({ length: 32 }, (_, i) => [i * 8, i * 8, i * 8]);
  const texture = new THREE.Texture({ width: 1, height: 1 });
  texture.flipY = false;
  const material = new THREE.MeshBasicMaterial({ map: texture });
  Object.assign(material, {
    _originalMap: texture,
    _quantizedCanvas: {
      width: 1,
      height: 1,
      getContext: () => ({
        getImageData: () => ({ data: new Uint8ClampedArray([...palette[slot - 1], 255]) }),
      }),
    },
    _quantizedLabels: new Uint8Array([slot - 1]),
    _quantizedLabelsWidth: 1,
    _quantizedLabelsHeight: 1,
    _quantizationEnabled: true,
    _quantizedPalette: palette,
  });
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));
  root._quantizedPalette = palette;
  return new Uint8Array(
    await exportMultiColor3MF(root, 32, true, 3, false, palette, 0, 0, 0, { format }),
  );
}
for (const slot of [16, 17, 32])
  test(
    `Prusa 2 actually slices Texture2Paint slot ${slot} with the correct tool`,
    { skip: !canSlicePrusa },
    async () => {
      assertPrusaUsesPaint(await paintedCube(slot), slot);
    },
  );

const prusa3 = process.env.PRUSA_SLICER3 || resolve('.local/prusa3/PrusaSlicer.exe');
test(
  'Prusa 3 alpha12 native save retains Texture2Paint JSON paint at slot 32',
  { skip: !existsSync(prusa3) },
  async () => {
    const root = resolve('.tmp/prusa3-paint');
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(resolve(root, 'run-'));
    const input = resolve(dir, 'input.3mf'),
      output = resolve(dir, 'saved.3mf');
    writeFileSync(input, await paintedCube(32, 'prusa3'));
    const run = spawnSync(
      prusa3,
      [
        '--datadir',
        resolve(dir, 'profiles'),
        '--export-3mf',
        '--dont-arrange',
        '--output',
        output,
        input,
      ],
      { cwd: dir, windowsHide: true, encoding: 'utf8', timeout: 30000 },
    );
    assert.equal(run.status, 0, String(run.error || '') + run.stdout + run.stderr);
    const files = unzipSync(readFileSync(output));
    const paint = JSON.parse(strFromU8(files['Metadata/Slic3r_facets_annotation.json']));
    const faces = paint.flatMap((p) => p.mmSegmentationFacets || []);
    assert.equal(faces.length, 12);
    assert.deepEqual([...new Set(faces.map((f) => f.dividing))], ['0FEC']);
  },
);
