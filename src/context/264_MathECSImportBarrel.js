// file number : 264
// full path name : src/context/264_MathECSImportBarrel.js
// description : Single canonical import of math (all vectors, matrices, quaternions, simplex noise, double-double), ecs (BitECS, World, Components, Systems), core (EventDispatcher, Layers, Timer, buffers, render targets), textures (DataTexture, Data3DTexture, DataArrayTexture, CubeTexture, DepthTexture), materials (PBR, anime/toon, NodeMaterial/TSL family, plus classic WebGL materials), and renderer entry points for both WebGLRenderer and WebGPURenderer (with automatic WebGL2 fallback). Tree-shakeable named re-exports only; no side effects. Exposes a single `useWebGPU` flag so downstream code can select the backend without changing imports.
// best for : The only place imports fan out. Every downstream file imports from this barrel, never from individual source files, so the runtime controls exactly which kernel primitives, materials, and renderer path are loaded. WebGL is supported as an explicit option, not as a hidden fallback.
// license : MIT

// ─── backend selection flag ────────────────────────────────────────
// Downstream code sets this before constructing a renderer.
// When false, WebGLRenderer is used directly.
// When true, WebGPURenderer is used; if WebGPU is unavailable it
// automatically falls back to a WebGL2 backend.
export const backendConfig = { useWebGPU: true };

// ─── math / 001–017 canonical kernel ───────────────────────────────
export { Vec2 } from '../math/005_Vec2.js';
export { Vec3 } from '../math/006_Vec3.js';
export { Vec4 } from '../math/007_Vec4.js';
export { Mat2 } from '../math/008_Mat2.js';
export { Mat3 } from '../math/009_Mat3.js';
export { Mat4 } from '../math/010_Mat4.js';
export { Quat } from '../math/011_Quat.js';
export { Quat2 } from '../math/012_Quat2.js';
export { SimplexNoise } from '../math/013_SimplexNoise.js';
export { DoubleDouble } from '../math/014_DoubleDouble.js';
export { Precision } from '../math/031_Precision.js';

// geometric primitives used by culling and spatial partitioning
export { Plane } from '../math/061_Plane.js';
export { Sphere } from '../math/062_Sphere.js';
export { Box3 } from '../math/064_Box3.js';
export { Ray } from '../math/065_Ray.js';
export { Frustum } from '../math/067_Frustum.js';
export { OBB } from '../math/081_OBB.js';

// color correctness for PBR / anime blend
export { ColorManagement } from '../math/068_ColorManagement.js';
export { ColorSpace } from '../math/082_ColorSpace.js';

// interpolation kernels for LOD cross-fade and camera extrapolation
export { Interpolant } from '../math/074_Interpolant.js';
export { CubicInterpolant } from '../math/075_CubicInterpolant.js';
export { LinearInterpolant } from '../math/076_LinearInterpolant.js';
export { DiscreteInterpolant } from '../math/077_DiscreteInterpolant.js';
export { BezierInterpolant } from '../math/080_BezierInterpolant.js';

// ─── ecs / 014–017 (every ecs file) ───────────────────────────────
export { BitECS } from '../ecs/014_BitECS.js';
export { World } from '../ecs/015_World.js';
export { Components } from '../ecs/016_Components.js';
export { Systems } from '../ecs/017_Systems.js';

// ─── core / EventDispatcher, Layers, Timer, buffers, render targets ─
export { EventDispatcher } from '../core/083_EventDispatcher.js';
export { Layers } from '../core/085_Layers.js';
export { Timer } from '../core/086_Timer.js';
export { BufferAttribute } from '../core/094_BufferAttribute.js';
export { Float16BufferAttribute } from '../core/095_Float16BufferAttribute.js';
export { InstancedInterleavedBuffer } from '../core/096_InstancedInterleavedBuffer.js';
export { BufferGeometry } from '../core/097_BufferGeometry.js';
export { InterleavedBuffer } from '../core/099_InterleavedBuffer.js';
export { InterleavedBufferAttribute } from '../core/100_InterleavedBufferAttribute.js';
export { Uniform } from '../core/087_Uniform.js';
export { UniformsGroup } from '../core/088_UniformsGroup.js';
export { RenderTarget } from '../core/089_RenderTarget.js';
export { RenderTarget3D } from '../core/090_RenderTarget3D.js';
export { RenderTargetArray } from '../core/091_RenderTargetArray.js';
export { CubeRenderTarget } from '../core/092_CubeRenderTarget.js';
export { Raycaster } from '../core/103_Raycaster.js';

// ─── textures / all load-bearing for lighting, streaming, IBL ─────
export { Texture } from '../textures/Texture.js';
export { CanvasTexture } from '../textures/CanvasTexture.js';
export { DataTexture } from '../textures/DataTexture.js';
export { Data3DTexture } from '../textures/Data3DTexture.js';
export { DataArrayTexture } from '../textures/DataArrayTexture.js';
export { CubeTexture } from '../textures/CubeTexture.js';
export { CubeDepthTexture } from '../textures/CubeDepthTexture.js';
export { DepthTexture } from '../textures/DepthTexture.js';
export { CompressedTexture } from '../textures/CompressedTexture.js';
export { CompressedArrayTexture } from '../textures/CompressedArrayTexture.js';
export { CompressedCubeTexture } from '../textures/CompressedCubeTexture.js';
export { FramebufferTexture } from '../textures/FramebufferTexture.js';
export { Source } from '../textures/Source.js';

// ─── materials / PBR, anime, and classic WebGL variants ──────────
export { Material } from '../materials/Material.js';

// PBR and anime materials — work on both WebGL and WebGPU
// (WebGPU routes them through their Node equivalents automatically)
export { MeshStandardMaterial } from '../materials/MeshStandardMaterial.js';
export { MeshPhysicalMaterial } from '../materials/MeshPhysicalMaterial.js';
export { MeshToonMaterial } from '../materials/MeshToonMaterial.js';
export { ShaderMaterial } from '../materials/ShaderMaterial.js';
export { RawShaderMaterial } from '../materials/RawShaderMaterial.js';

// classic WebGL materials — useful for LOD fallbacks, debug views,
// and lightweight scenes where full PBR is not required.
export { MeshBasicMaterial } from '../materials/MeshBasicMaterial.js';
export { MeshLambertMaterial } from '../materials/MeshLambertMaterial.js';
export { MeshPhongMaterial } from '../materials/MeshPhongMaterial.js';
export { PointsMaterial } from '../materials/PointsMaterial.js';
export { LineBasicMaterial } from '../materials/LineBasicMaterial.js';
export { SpriteMaterial } from '../materials/SpriteMaterial.js';

// NodeMaterial family — required for ClusteredLighting and the
// anime/PBR blend on the WebGPU path. On WebGL these are not used;
// the classic materials above take their place.
export { MeshStandardNodeMaterial } from '../materials/nodes/MeshStandardNodeMaterial.js';
export { MeshPhysicalNodeMaterial } from '../materials/nodes/MeshPhysicalNodeMaterial.js';
export { MeshToonNodeMaterial } from '../materials/nodes/MeshToonNodeMaterial.js';
export { MeshBasicNodeMaterial } from '../materials/nodes/MeshBasicNodeMaterial.js';

// ─── renderer entry points / choose one at runtime ───────────────
// WebGLRenderer: explicit WebGL 2 path.
// WebGPURenderer: WebGPU path with automatic WebGL 2 fallback.
// Both are exported so downstream code can branch on backendConfig.useWebGPU
// without changing imports.
export { WebGLRenderer } from '../renderers/WebGLRenderer.js';
export { WebGPURenderer } from '../renderers/webgpu/WebGPURenderer.js';