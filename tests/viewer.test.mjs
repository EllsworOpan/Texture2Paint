import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Viewer } from '../src/viewer.js';

function testViewer(root) {
  const viewer = Object.create(Viewer.prototype);
  viewer.currentModel = root;
  viewer._envIntensity = 1.4;
  viewer._wireframe = false;
  viewer._materialEffects = true;
  viewer._materialEffectStates = new WeakMap();
  viewer._alphaCutout = true;
  viewer._alphaTest = 0.5;
  return viewer;
}

test('matte print preview preserves printable color inputs and restores PBR properties', () => {
  const baseMap = new THREE.Texture({ width: 1, height: 1 });
  const normalMap = new THREE.Texture({ width: 1, height: 1 });
  const roughnessMap = new THREE.Texture({ width: 1, height: 1 });
  const metalnessMap = new THREE.Texture({ width: 1, height: 1 });
  const material = new THREE.MeshPhysicalMaterial({
    color: 0x8a341f,
    map: baseMap,
    normalMap,
    roughness: 0.23,
    roughnessMap,
    metalness: 0.82,
    metalnessMap,
    clearcoat: 0.7,
    sheen: 0.4,
    transmission: 0.35,
    emissive: 0x221100,
    emissiveIntensity: 1.8,
    opacity: 0.75,
    transparent: true,
  });
  const originalColor = material.color.getHex();
  const originalEmissive = material.emissive.getHex();
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));
  const viewer = testViewer(root);

  viewer.setMaterialEffects(false);

  assert.equal(material.color.getHex(), originalColor);
  assert.equal(material.map, baseMap);
  assert.equal(material.opacity, 0.75);
  assert.equal(material.transparent, true);
  assert.equal(material.metalness, 0);
  assert.equal(material.roughness, 1);
  assert.equal(material.normalMap, null);
  assert.equal(material.roughnessMap, null);
  assert.equal(material.metalnessMap, null);
  assert.equal(material.clearcoat, 0);
  assert.equal(material.sheen, 0);
  assert.equal(material.transmission, 0);
  assert.equal(material.emissive.getHex(), 0x000000);
  assert.equal(material.envMapIntensity, 0);

  // Reapplying the disabled state must not overwrite the original snapshot.
  viewer.applyMaterialSettings();
  viewer.setMaterialEffects(true);

  assert.equal(material.color.getHex(), originalColor);
  assert.equal(material.map, baseMap);
  assert.equal(material.normalMap, normalMap);
  assert.equal(material.roughness, 0.23);
  assert.equal(material.roughnessMap, roughnessMap);
  assert.equal(material.metalness, 0.82);
  assert.equal(material.metalnessMap, metalnessMap);
  assert.equal(material.clearcoat, 0.7);
  assert.equal(material.sheen, 0.4);
  assert.equal(material.transmission, 0.35);
  assert.equal(material.emissive.getHex(), originalEmissive);
  assert.equal(material.emissiveIntensity, 1.8);
  assert.equal(material.envMapIntensity, 1.4);
});

test('export copies restore display-only material effects without changing the preview', () => {
  const material = new THREE.MeshStandardMaterial({
    color: 0x336699,
    roughness: 0.2,
    metalness: 0.9,
  });
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material));
  const viewer = testViewer(root);
  viewer.setMaterialEffects(false);

  const exportObject = viewer.createExportObject();
  const exportMaterial = exportObject.children[0].material;

  assert.equal(material.roughness, 1);
  assert.equal(material.metalness, 0);
  assert.equal(exportMaterial.roughness, 0.2);
  assert.equal(exportMaterial.metalness, 0.9);
});
