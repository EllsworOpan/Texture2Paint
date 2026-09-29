import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const prusaExecutable =
  process.env.PRUSA_SLICER || 'C:/Program Files/Prusa3D/PrusaSlicer/prusa-slicer-console.exe';
export const canSlicePrusa = existsSync(prusaExecutable);

// Force the vendor to interpret paint. The oracle is extruding G-code, not our
// own paint decoder or an opaque native save. Settings exist only in this test.
export function assertPrusaUsesPaint(bytes, slot) {
  const root = resolve('.tmp/paint-slicing');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(resolve(root, 'run-'));
  const input = resolve(dir, 'paint.3mf'),
    output = resolve(dir, 'paint.gcode'),
    config = resolve(dir, 'test.ini');
  writeFileSync(input, bytes);
  const vector = (value) => Array(slot).fill(value).join(',');
  writeFileSync(
    config,
    [
      `nozzle_diameter = ${vector('0.4')}`,
      `filament_diameter = ${vector('1.75')}`,
      `temperature = ${vector('200')}`,
      `first_layer_temperature = ${vector('200')}`,
      'single_extruder_multi_material = 1',
      'wipe_tower = 0',
      'layer_height = 0.2',
      'first_layer_height = 0.2',
      'perimeters = 1',
      'fill_density = 0%',
      'top_solid_layers = 0',
      'bottom_solid_layers = 0',
      'start_gcode =',
      'end_gcode =',
      'gcode_flavor = reprap',
      'use_relative_e_distances = 1',
    ].join('\n'),
  );
  const run = spawnSync(
    prusaExecutable,
    [
      '--datadir',
      resolve(dir, 'profiles'),
      '--load',
      config,
      '--slice',
      '--center',
      '100,100',
      '--output',
      output,
      input,
    ],
    { cwd: dir, windowsHide: true, encoding: 'utf8', timeout: 45000 },
  );
  assert.equal(run.status, 0, String(run.error || '') + run.stdout + run.stderr);
  assert.ok(existsSync(output), 'Slicer did not generate G-code');
  let tool = -1,
    extrusionMoves = 0;
  const extrudingTools = new Set();
  for (const raw of readFileSync(output, 'utf8').split(/\r?\n/)) {
    const line = raw.split(';')[0];
    const change = line.match(/^T(\d+)\b/);
    if (change) tool = Number(change[1]);
    if (
      /^G[01]\s/.test(line) &&
      /[XY][-\d.]/.test(line) &&
      Number(line.match(/\bE([-\d.]+)/)?.[1]) > 0
    ) {
      extrudingTools.add(tool);
      extrusionMoves++;
    }
  }
  assert.ok(extrusionMoves > 0, 'No printable extrusion was found');
  assert.deepEqual([...extrudingTools], [slot - 1], `All painted perimeters must use slot ${slot}`);
}
