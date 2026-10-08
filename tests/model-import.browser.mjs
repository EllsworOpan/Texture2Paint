// Serve the repository and open /tests/model-import.browser.html to run these
// regressions with the same XML and Three.js APIs used by the application.
import { Box3, Vector3 } from 'three';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { prepareColladaText } from '../src/model-import.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const identity = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1';
const brokenInverse = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 0';
const geometry = `<library_geometries><geometry id="triangle"><mesh>
  <source id="positions"><float_array id="positions-array" count="9">0 0 0 1 0 0 0 1 0</float_array>
    <technique_common><accessor source="#positions-array" count="3" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common>
  </source>
  <vertices id="vertices"><input semantic="POSITION" source="#positions"/></vertices>
  <triangles count="1"><input semantic="VERTEX" source="#vertices" offset="0"/><p>0 1 2</p></triangles>
</mesh></geometry></library_geometries>`;
const instance = '<instance_geometry url="#triangle"/>';
function collada(libraries, nodes) {
  return `<?xml version="1.0"?><COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
    <asset><unit name="meter" meter="0.0254"/><up_axis>Y_UP</up_axis></asset>
    ${geometry}${libraries}<library_visual_scenes><visual_scene id="scene">${nodes}</visual_scene></library_visual_scenes>
    <scene><instance_visual_scene url="#scene"/></scene>
  </COLLADA>`;
}
function rigged(inverse = brokenInverse) {
  const libraries = `<library_controllers><controller id="skin"><skin source="#triangle">
    <bind_shape_matrix>${identity}</bind_shape_matrix>
    <source id="joints"><Name_array id="joints-array" count="1">Joint</Name_array><technique_common><accessor source="#joints-array" count="1" stride="1"><param name="JOINT" type="Name"/></accessor></technique_common></source>
    <source id="inverse"><float_array id="inverse-array" count="16">${inverse}</float_array><technique_common><accessor source="#inverse-array" count="1" stride="16"><param name="TRANSFORM" type="float4x4"/></accessor></technique_common></source>
    <source id="weights"><float_array id="weights-array" count="1">1</float_array><technique_common><accessor source="#weights-array" count="1" stride="1"><param name="WEIGHT" type="float"/></accessor></technique_common></source>
    <joints><input semantic="JOINT" source="#joints"/><input semantic="INV_BIND_MATRIX" source="#inverse"/></joints>
    <vertex_weights count="3"><input semantic="JOINT" source="#joints" offset="0"/><input semantic="WEIGHT" source="#weights" offset="1"/><vcount>1 1 1</vcount><v>0 0 0 0 0 0</v></vertex_weights>
  </skin></controller></library_controllers>`;
  return collada(libraries, `<node id="Joint" sid="Joint" type="JOINT"><matrix>${identity}</matrix></node>
    <node id="mesh"><instance_controller url="#skin"><skeleton>#Joint</skeleton></instance_controller></node>`);
}

const tests = [
  ['valid Collada is passed through without changes', () => {
    const text = rigged(identity);
    assert(prepareColladaText(text) === text, 'Valid rigged Collada was rewritten');
  }],
  ['duplicate node IDs preserve each mesh and its transform', () => {
    const text = collada('', `<node id="part" name="parent"><node id="part" name="first">${instance}</node></node>
      <node id="tail"><node id="part" name="second"><translate>2 0 0</translate>${instance}</node></node>
      <node id="part__t2p_1" name="reserved"/>`);
    const prepared = prepareColladaText(text);
    const document = new DOMParser().parseFromString(prepared, 'application/xml');
    const ids = [...document.getElementsByTagName('node')].map(node => node.getAttribute('id'));
    assert(new Set(ids).size === ids.length, 'Node IDs still collide');
    assert(ids[0] === 'part' && ids.includes('part__t2p_1'), 'Existing IDs changed');
    const scene = new ColladaLoader().parse(prepared, '').scene;
    scene.updateMatrixWorld(true);
    const meshes = [];
    scene.traverse(object => { if (object.isMesh) meshes.push(object); });
    assert(meshes.length === 2, 'A duplicate-ID mesh was lost');
    const positions = meshes.map(mesh => mesh.getWorldPosition(new Vector3()).x).sort((a, b) => a - b);
    assert(Math.abs(positions[0]) < 1e-6 && Math.abs(positions[1] - 0.0508) < 1e-6, 'Node transforms changed');
  }],
  ['joint SIDs and skeleton references survive duplicate ID repair', () => {
    const text = rigged().replace('<node id="mesh">', '<node id="mesh" name="parent"><node id="mesh" name="child">').replace('</visual_scene>', '</node></visual_scene>');
    const document = new DOMParser().parseFromString(prepareColladaText(text), 'application/xml');
    const joint = [...document.getElementsByTagName('node')].find(node => node.getAttribute('type') === 'JOINT');
    assert(joint.getAttribute('id') === 'Joint' && joint.getAttribute('sid') === 'Joint', 'Joint identity changed');
    assert(document.getElementsByTagName('skeleton')[0].textContent === '#Joint', 'Skeleton reference changed');
  }],
  ['zero homogeneous inverse bind rows yield finite skinned bounds', () => {
    const scene = new ColladaLoader().parse(prepareColladaText(rigged()), '').scene;
    scene.updateMatrixWorld(true);
    const size = new Box3().setFromObject(scene).getSize(new Vector3()).toArray();
    assert(size.every(Number.isFinite), 'Skinned bounds are not finite');
    assert(Math.abs(size[0] - 0.0254) < 1e-6 && Math.abs(size[1] - 0.0254) < 1e-6, 'Rigged geometry changed size');
  }],
  ['only malformed affine inverse bind matrices are repaired', () => {
    const projective = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0';
    assert(prepareColladaText(rigged(projective)) === rigged(projective), 'Non-affine matrix changed');
    const singular = Array(16).fill(0).join(' ');
    assert(prepareColladaText(rigged(singular)) === rigged(singular), 'Singular matrix changed');
    const text = collada('', `<node id="node"><matrix>${brokenInverse}</matrix>${instance}</node>`);
    assert(prepareColladaText(text) === text, 'Unrelated node matrix changed');
  }],
  ['inverse matrix accessor offsets preserve other array values', () => {
    const text = rigged().replace('count="16">'+brokenInverse, 'count="18">123 456 '+brokenInverse)
      .replace('source="#inverse-array" count="1" stride="16"', 'source="#inverse-array" count="1" stride="16" offset="2"');
    const document = new DOMParser().parseFromString(prepareColladaText(text), 'application/xml');
    const values = document.querySelector('[id="inverse-array"]').textContent.trim().split(/\s+/).map(Number);
    assert(values[0] === 123 && values[1] === 456 && values[17] === 1, 'Accessor offset was ignored');
  }],
  ['invalid XML and other XML formats produce a useful error', () => {
    for (const text of ['<COLLADA>', '<other/>']) {
      let rejected = false;
      try { prepareColladaText(text); } catch (error) { rejected = /Invalid Collada/.test(error.message); }
      assert(rejected, 'Invalid XML was accepted');
    }
  }],
];

const results = [];
for (const [name, run] of tests) {
  try { run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); }
}
window.importTestResults = results;
document.getElementById('results').textContent = results.map(result =>
  `${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.error ? '\n'+result.error : ''}`).join('\n');
