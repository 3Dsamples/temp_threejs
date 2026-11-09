// file number : 001
// full path name : src/core/001_Hierarchy.js
// description : Topological hierarchy structure of all modules for the 3D engine.
// best for : Understanding the load order and dependencies of the entire system.
// license : MIT

export const HIERARCHY = [
  // Core
  'src/core/001_Hierarchy.js',
  'src/core/002_Constants.js',
  'src/core/003_Common.js',
  'src/core/004_Precision.js',
  
  // Math
  'src/math/005_Vec2.js',
  'src/math/006_Vec3.js',
  'src/math/007_Vec4.js',
  'src/math/008_Mat2.js',
  'src/math/009_Mat3.js',
  'src/math/010_Mat4.js',
  'src/math/011_Quat.js',
  'src/math/012_Quat2.js',
  'src/math/013_SimplexNoise.js',
  
  // ECS
  'src/ecs/014_BitECS.js',
  'src/ecs/015_World.js',
  'src/ecs/016_Components.js',
  'src/ecs/017_Systems.js',
  
  // Three.js Integration
  'src/three/018_Renderer.js',
  'src/three/019_Scene.js',
  'src/three/020_Camera.js',
  'src/three/021_Materials.js',
  'src/three/022_PBRMaterial.js',
  'src/three/023_AnimeMaterial.js',
  'src/three/024_SemiRealisticMaterial.js',
  'src/three/025_CustomShaderMaterial.js',
  'src/three/026_PhysicsMaterial.js',
  
  // Physics
  'src/physics/027_PhysicsWorld.js',
  'src/physics/028_RigidBody.js',
  'src/physics/029_Collider.js',
  
  // Utilities
  'src/utils/030_MemoryPool.js',
  'src/utils/031_PerformanceMonitor.js',
  'src/utils/032_ContextAwareness.js'
];

// Continue with next file?