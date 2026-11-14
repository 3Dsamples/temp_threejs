// file number : 402
// full path name : src/context/402_TerrainFullSourceImportBarrel.js
//### Description : The complete, canonical import barrel for the entire
//###               Threejs_gl/src/ tree. Re-exports every file across the
//###               math/, core/, ecs/, textures/, materials/, and context/
//###               subfolders into a single stable import surface, so that
//###               downstream terrain pipeline files (403+) and external
//###               systems never reach into individual module paths. The
//###               barrel is pure re-export — zero runtime overhead, zero
//###               allocations, zero side effects, tree-shake-friendly. It
//###               covers:
//###                 • math/        — 005_Vec2 through 082_ColorSpace
//###                 • core/        — 001_Hierarchy through 103_Raycaster
//###                 • ecs/         — 014_BitECS through 017_Systems
//###                 • textures/    — 150_source through 175_texture_stacking
//###                 • materials/   — 176_material through 262_magicspelllightning
//###                 • context/     — 263_ContextFrame through 401_TerrainB3DMParser
//###               and all Z-suffixed variants (386_Z01 through 386_Z07,
//###               326_Z01 through 326_Z17, etc.). Because every import is a
//###               plain `export * from`, the barrel imposes no order-of-
//###               evaluation constraints and can be freely imported from any
//###               file, in any order, without circular dependency issues.
//###               No external loader, no CDN access, no static server.
//###               Designed for Android arm64 under the 8 ms per-tick CPU
//###               ceiling and 200 MB resident memory cap.
//### Best for : The single import surface every downstream terrain pipeline
//###            file and every external integration should use. Importing
//###            from this barrel guarantees that all modules share the same
//###            module identity, avoiding the "two copies of the same class"
//###            bug that plagues deep import trees.
//### License : MIT

// ═════════════════════════════════════════════════════════════════════
// 1. MATH FOLDER — every file 005 through 082
// ═════════════════════════════════════════════════════════════════════

export * from '../math/005_Vec2.js';
export * from '../math/006_Vec3.js';
export * from '../math/007_Vec4.js';
export * from '../math/008_Mat2.js';
export * from '../math/009_Mat3.js';
export * from '../math/010_Mat4.js';
export * from '../math/011_Quat.js';
export * from '../math/012_Quat2.js';
export * from '../math/013_SimplexNoise.js';
export * from '../math/014_DoubleDouble.js';
export * from '../math/019_Algebra.js';
export * from '../math/020_Autodiff.js';
export * from '../math/021_Backend.js';
export * from '../math/022_Calculus.js';
export * from '../math/023_Complex.js';
export * from '../math/024_Computation.js';
export * from '../math/025_Distribution.js';
export * from '../math/026_Geometry.js';
export * from '../math/027_LinearAlgebra.js';
export * from '../math/028_Numeric.js';
export * from '../math/029_Optimization.js';
export * from '../math/030_Policy.js';
export * from '../math/031_Precision.js';
export * from '../math/032_Probability.js';
export * from '../math/033_Scalar.js';
export * from '../math/034_Special.js';
export * from '../math/035_Statistics.js';
export * from '../math/036_Uncertainty.js';
export * from '../math/037_LinearAlgebra.js';
export * from '../math/038_MatrixML.js';
export * from '../math/039_MatrixConvolution.js';
export * from '../math/040_MatrixLU.js';
export * from '../math/041_MatrixQR.js';
export * from '../math/042_MatrixCholesky.js';
export * from '../math/042_MatrixSVD.js';
export * from '../math/043_MatrixEVD.js';
export * from '../math/043_MatrixNIPALS.js';
export * from '../math/045_MatrixDecompositions.js';
export * from '../math/046_MatrixCorrelation.js';
export * from '../math/047_MatrixDCUtil.js';
export * from '../math/048_MatrixCovariance.js';
export * from '../math/049_MatrixDeterminant.js';
export * from '../math/050_MatrixSymmetric.js';
export * from '../math/051_MatrixPseudoInverse.js';
export * from '../math/052_MatrixLinearDependencies.js';
export * from '../math/053_MatrixStat.js';
export * from '../math/054_MatrixMathOps.js';
export * from '../math/055_MatrixInspect.js';
export * from '../math/056_MatrixUtil.js';
export * from '../math/057_ConvolutionFFT.js';
export * from '../math/058_ConvolutionUtil.js';
export * from '../math/059_Euler.js';
export * from '../math/060_Line3.js';
export * from '../math/061_Plane.js';
export * from '../math/062_Sphere.js';
export * from '../math/063_Box2.js';
export * from '../math/064_Box3.js';
export * from '../math/065_Ray.js';
export * from '../math/066_Triangle.js';
export * from '../math/067_Frustum.js';
export * from '../math/068_ColorManagement.js';
export * from '../math/069_Color.js';
export * from '../math/070_PerceptualColor.js';
export * from '../math/071_IESLighting.js';
export * from '../math/072_ArchvizLighting.js';
export * from '../math/073_Cylindrical.js';
export * from '../math/074_Interpolant.js';
export * from '../math/075_CubicInterpolant.js';
export * from '../math/076_LinearInterpolant.js';
export * from '../math/077_DiscreteInterpolant.js';
export * from '../math/078_QuaternionLinearInterpolant.js';
export * from '../math/080_BezierInterpolant.js';
export * from '../math/081_OBB.js';
export * from '../math/082_ColorSpace.js';

// ═════════════════════════════════════════════════════════════════════
// 2. CORE FOLDER — every file 001 through 103
// ═════════════════════════════════════════════════════════════════════

export * from '../core/001_Hierarchy.js';
export * from '../core/002_Constants.js';
export * from '../core/003_Common.js';
export * from '../core/004_Precision.js';
export * from '../core/083_EventDispatcher.js';
export * from '../core/084_GLBufferAttribute.js';
export * from '../core/085_Layers.js';
export * from '../core/086_Timer.js';
export * from '../core/087_Uniform.js';
export * from '../core/088_UniformsGroup.js';
export * from '../core/089_RenderTarget.js';
export * from '../core/090_RenderTarget3D.js';
export * from '../core/091_RenderTargetArray.js';
export * from '../core/092_CubeRenderTarget.js';
export * from '../core/094_BufferAttribute.js';
export * from '../core/095_Float16BufferAttribute.js';
export * from '../core/096_InstancedInterleavedBuffer.js';
export * from '../core/097_BufferGeometry.js';
export * from '../core/098_Clock.js';
export * from '../core/099_InterleavedBuffer.js';
export * from '../core/100_InterleavedBufferAttribute.js';
export * from '../core/101_Object3D.js';
export * from '../core/102_Group.js';
export * from '../core/103_Raycaster.js';

// ═════════════════════════════════════════════════════════════════════
// 3. ECS FOLDER — every file 014 through 017
// ═════════════════════════════════════════════════════════════════════

export * from '../ecs/014_BitECS.js';
export * from '../ecs/015_World.js';
export * from '../ecs/016_Components.js';
export * from '../ecs/017_Systems.js';

// ═════════════════════════════════════════════════════════════════════
// 4. TEXTURES FOLDER — every file 150 through 175
// ═════════════════════════════════════════════════════════════════════

export * from '../textures/150_source.js';
export * from '../textures/151_texture.js';
export * from '../textures/152_canvastexture.js';
export * from '../textures/153_compressedtexture.js';
export * from '../textures/154_cubetexture.js';
export * from '../textures/155_datatexture.js';
export * from '../textures/156_dataarraytexture.js';
export * from '../textures/157_data3dtexture.js';
export * from '../textures/158_depthtexture.js';
export * from '../textures/159_framebuffertexture.js';
export * from '../textures/160_videotexture.js';
export * from '../textures/161_externaltexture.js';
export * from '../textures/162_htmltexture.js';
export * from '../textures/163_compressedarraytexture.js';
export * from '../textures/164_compressedcubetexture.js';
export * from '../textures/165_cubedepthtexture.js';
export * from '../textures/166_videoframetexture.js';
export * from '../textures/167_anisotropic_filtering.js';
export * from '../textures/168_stochastic_texture_filtering.js';
export * from '../textures/169_multi_aspect_ratio_mipmaps.js';
export * from '../textures/170_gpu_native_compression.js';
export * from '../textures/171_neural_texture_compression.js';
export * from '../textures/172_triplanar_mapping.js';
export * from '../textures/173_texture_bombing.js';
export * from '../textures/174_virtual_texturing.js';
export * from '../textures/175_texture_stacking.js';

// ═════════════════════════════════════════════════════════════════════
// 5. MATERIALS FOLDER — every file 176 through 262
// ═════════════════════════════════════════════════════════════════════

export * from '../materials/176_material.js';
export * from '../materials/177_linebasicmaterial.js';
export * from '../materials/178_meshbasicmaterial.js';
export * from '../materials/179_meshdepthmaterial.js';
export * from '../materials/180_linedashedmaterial.js';
export * from '../materials/181_meshdistancematerial.js';
export * from '../materials/182_meshlambertmaterial.js';
export * from '../materials/183_meshmatcapmaterial.js';
export * from '../materials/184_meshnormalmaterial.js';
export * from '../materials/185_meshphongmaterial.js';
export * from '../materials/186_meshstandardmaterial.js';
export * from '../materials/187_meshtoonmaterial.js';
export * from '../materials/188_pointsmaterial.js';
export * from '../materials/189_shadowmaterial.js';
export * from '../materials/190_spritematerial.js';
export * from '../materials/191_shadermaterial.js';
export * from '../materials/192_rawshadermaterial.js';
export * from '../materials/193_meshphysicalmaterial.js';
export * from '../materials/194_materials.js';
export * from '../materials/195_architecturalglassmaterial.js';
export * from '../materials/196_architecturalwoodmaterial.js';
export * from '../materials/197_architecturalconcretematerial.js';
export * from '../materials/198_architecturalmetalmaterial.js';
export * from '../materials/199_architecturalfabricmaterial.js';
export * from '../materials/200_architecturalbrickmaterial.js';
export * from '../materials/201_architecturalstonematerial.js';
export * from '../materials/202_architecturaltilematerial.js';
export * from '../materials/203_architecturalroofingmaterial.js';
export * from '../materials/204_architecturalplastermaterial.js';
export * from '../materials/205_architecturalpaintmaterial.js';
export * from '../materials/206_architecturalglazingmaterial.js';
export * from '../materials/207_architecturalvegetationmaterial.js';
export * from '../materials/208_architecturalgravelmaterial.js';
export * from '../materials/209_architecturalasphaltmaterial.js';
export * from '../materials/210_architecturalgroundmaterial.js';
export * from '../materials/211_architecturalwatermaterial.js';
export * from '../materials/212_organicskinmaterial.js';
export * from '../materials/213_organichairmaterial.js';
export * from '../materials/214_organiceyematerial.js';
export * from '../materials/215_organicbarkmaterial.js';
export * from '../materials/216_organicleafmaterial.js';
export * from '../materials/217_organicfishscalematerial.js';
export * from '../materials/218_organicinsectchitinmaterial.js';
export * from '../materials/219_architecturalleathermaterial.js';
export * from '../materials/220_organicbonematerial.js';
export * from '../materials/221_organiccoralmaterial.js';
export * from '../materials/222_organicshellmaterial.js';
export * from '../materials/223_organiceggshellmaterial.js';
export * from '../materials/224_organicfeathermaterial.js';
export * from '../materials/225_organicscalematerial.js';
export * from '../materials/226_organicamphibianskinmaterial.js';
export * from '../materials/227_organicmarinemammalmaterial.js';
export * from '../materials/228_humanfairskinmaterial.js';
export * from '../materials/229_humanmediumskinmaterial.js';
export * from '../materials/231_cloudcumulusmaterial.js';
export * from '../materials/232_cloudstratusmaterial.js';
export * from '../materials/233_organicdarkhumanmaterial.js';
export * from '../materials/234_organicgelatinmaterial.js';
export * from '../materials/236_octopusdefaultmaterial.js';
export * from '../materials/237_octopuschromatophorematerial.js';
export * from '../materials/238_octopussuckermaterial.js';
export * from '../materials/240_furmaterial.js';
export * from '../materials/242_carpaintmaterial.js';
export * from '../materials/243_carmetallicpaintmaterial.js';
export * from '../materials/245_metalsteelbeammaterial.js';
export * from '../materials/246_metalgalvanizedbeammaterial.js';
export * from '../materials/248_crystalbasematerial.js';
export * from '../materials/249_icebasematerial.js';
export * from '../materials/250_iceglaciermaterial.js';
export * from '../materials/252_neonbasematerial.js';
export * from '../materials/254_laserwhitecorebasematerial.js';
export * from '../materials/255_laserbeamvolumetricmaterial.js';
export * from '../materials/256_laserplasmamaterial.js';
export * from '../materials/257_laserbeamtrailmaterial.js';
export * from '../materials/258_laserexplosionmaterial.js';
export * from '../materials/259_magicspellbasematerial.js';
export * from '../materials/260_magicspellfirematerial.js';
export * from '../materials/261_magicspellicematerial.js';
export * from '../materials/262_magicspelllightningmaterial.js';

// ═════════════════════════════════════════════════════════════════════
// 6. CONTEXT FOLDER — every file 263 through 401, plus Z-suffixed variants
// ═════════════════════════════════════════════════════════════════════

// ---- Context core and math barrels ----
export * from './263_ContextFrame.js';
export * from './264_MathECSImportBarrel.js';
export * from './265_CoreEventDispatcher.js';
export * from './266_CoreLayers.js';
export * from './267_CoreClock.js';
export * from './268_ExtrasCurveUtils.js';
export * from './269_ExtrasLODHelper.js';
export * from './270_ExtrasTimerUtils.js';

// ---- Spatial acceleration ----
export * from './271_SpatialHashGrid.js';
export * from './272_DynamicBVH.js';
export * from './273_FrustumCullingSystem.js';
export * from './274_OcclusionGraph.js';

// ---- Context providers ----
export * from './275_SpatialContextProvider.js';
export * from './276_TemporalContextProvider.js';
export * from './277_PhysicalContextProvider.js';
export * from './278_CausalContextProvider.js';
export * from './279_PlayerContextProvider.js';

// ---- Terrain providers ----
export * from './280_TerrainProvider.js';
export * from './281_ElevationProvider.js';
export * from './282_SlopeGradientProvider.js';
export * from './282_Z01_ReliefGradientProvider.js';
export * from './282_Z02_CliffsGradientProvider.js';
export * from './282_Z03_CarveGradientProvider.js';
export * from './282_Z04_NaturalFormationGradientProvider.js';
export * from './282_Z06_RockGradientProvider.js';
export * from './282_Z07_ForestGradientProvider.js';
export * from './282_Z08_GrassAndFlowresGradientProvider.js';
export * from './282_Z09_ContinentalReliefGradientProvider.js';

// ---- Environmental providers ----
export * from './283_BathymetryProvider.js';
export * from './284_GroundwaterProvider.js';
export * from './285_MoistureLevelProvider.js';
export * from './286_DecomposersSystem.js';
export * from './287_ClimateTemperatureProvider.js';
export * from './288_ClimatePrecipitationProvider.js';
export * from './289_ClimateWindProvider.js';
export * from './290_SoilCompositionProvider.js';
export * from './291_SoilFertilityProvider.js';
export * from './292_SoilColorTextureProvider.js';
export * from './293_LightingSunIntensityProvider.js';
export * from './294_LightingTimeOfDayProvider.js';
export * from './295_AirQualityAtmosphereProvider.js';
export * from './296_SeasonalitySystem.js';

// ---- Sensory ----
export * from './297_SensoryDetailsProvider.js';

// ---- Performance governance ----
export * from './303_HLODController.js';
export * from './304_MemoryCeilingEnforcer.js';
export * from './305_FrameBudgetMonitor.js';
export * from './306_GCPauseMonitor.js';
export * from './307_MemoryProfiler.js';

// ---- Context runtime ----
export * from './308_ContextConsumerTiers.js';
export * from './309_ContextRuntime.js';
export * from './310_GeometryContextFrameReader.js';

// ---- Consumer systems ----
export * from './311_UpdateLODConsumer.js';
export * from './312_UpdateLoadStateConsumer.js';
export * from './313_IsVisibleConsumer.js';
export * from './314_ApplyNoiseConsumer.js';
export * from './315_SetMaterialParamsConsumer.js';
export * from './316_EcologyResponseSystem.js';

// ---- Audio/light emission ----
export * from './317_AudioLightEmissionSystem.js';

// ---- Biome descriptors (318–326) ----
export * from './318_TropicalRainforestBiome.js';
export * from './319_TemperateDeciduousForestBiome.js';
export * from './320_TaigaBorealForestBiome.js';
export * from './321_GrasslandSavannaBiome.js';
export * from './322_DesertBiome.js';
export * from './323_TundraBiome.js';
export * from './324_AquaticFreshwaterBiome.js';
export * from './325_AquaticMarineBiome.js';
export * from './326_AlpineBiome.js';
export * from './326_Z01_WetlandMarshSwampBiome.js';
export * from './326_Z02_MediterraneanChaparralBiome.js';
export * from './326_Z03_SteppePrairieBiome.js';
export * from './326_Z04_SavannaWoodlandBiome.js';
export * from './326_Z05_MangroveCoastalBiome.js';
export * from './326_Z06_TaigaBorealConiferousForestBiome.js';
export * from './326_Z07_TemperateDeciduousForestBiome.js';
export * from './326_Z08_TemperateRainforestBiome.js';
export * from './326_Z09_SubtropicalHumidForestBiome.js';
export * from './326_Z10_FloodingPampaGrasslandBiome.js';
export * from './326_Z11_CamposGrasslandBiome.js';
export * from './326_Z12_CerradoSavannaBiome.js';
export * from './326_Z13_AndeanPunaGrasslandBiome.js';
export * from './326_Z14_CanyonlandsBiome.js';
export * from './326_Z15_MountainLakeValleyBiome.js';
export * from './326_Z16_RiverDeltaEstuaryBiome.js';
export * from './326_Z17_BadlandsErodedHillsBiome.js';

// ---- Biome registry & coupling ----
export * from './327_BiomeRegistryBarrel.js';
export * from './328_BiomeBlendField.js';
export * from './329_BiomeBlendSystem.js';
export * from './330_CrossBiomeEcotoneSystem.js';
export * from './331_BiomeBlendMaterialBridge.js';
export * from './332_BiomeClimateCoupling.js';
export * from './333_BiomeSoilCoupling.js';
export * from './334_BiomeHydrologyCoupling.js';
export * from './335_BiomeFaunaMigrationSystem.js';

// ---- Landscape chunk infrastructure ----
export * from './336_LandscapeChunkDescriptor.js';
export * from './337_LandscapeChunkStreamer.js';
export * from './338_LandscapeChunkHLOD.js';
export * from './339_LandscapeChunkSpatialHash.js';
export * from './340_LandscapeChunkOcclusion.js';
export * from './341_LandscapeChunkPersistence.js';

// ---- Terrain tileset pipeline ----
export * from './360_WKTContextProvider.js';
export * from './361_WKBContextProvider.js';
export * from './362_WKTCRSContextProvider.js';
export * from './363_DBFContextProvider.js';
export * from './364_SHPContextProvider.js';
export * from './365_SeamlessTerrainTileContextProvider.js';
export * from './366_FlatGeobufContextProvider.js';
export * from './367_TWKBContextProvider.js';
export * from './368_GPXContextProvider.js';
export * from './369_TCXContextProvider.js';
export * from './370_GeoPackageContextProvider.js';
export * from './371_TerrainHeightmapDecoder.js';
export * from './372_TerrainQuantizedMeshDecoder.js';
export * from './373_Tileset2DTypes.js';
export * from './374_TerrainHeightmapTile.js';
export * from './375_TerrainParseQuantizedMesh.js';
export * from './376_Tile2DHeader.js';
export * from './377_Tileset2DAdapter.js';
export * from './378_Tileset2D.js';
export * from './379_Tileset2DIndex.js';
export * from './380_TerrainSource.js';
export * from './381_ReconcileTerrainTiles.js';
export * from './382_TerrainPipelineIndex.js';
export * from './383_TerrainMaterialPainter.js';
export * from './384_TerrainRenderDispatch.js';
export * from './385_TerrainPipelineOrchestrator.js';
export * from './386_ProceduralTerrainGenerator.js';
export * from './386_Z01_ProceduralTerrainGenerator_Ext.js';
export * from './386_Z02_ProceduralTerrainGenerator_Adv.js';
export * from './386_Z03_ProceduralTerrainGenerator_Ultimate.js';
export * from './386_Z04_ProceduralTerrainGenerator_UltimateFulfill.js';
export * from './386_Z05_ProceduralTerrainGenerator_UltimateIntegrated.js';
export * from './386_Z06_ProceduralTerrainGenerator_FullyIntegrated.js';
export * from './386_Z07_ProceduralTerrainGenerator_StreamingIntegrated.js';
export * from './387_TerrainNormalizeCRSIdentifier.js';
export * from './388_TerrainSpatialCoordinateFrame.js';
export * from './389_TerrainI3SElevationDecoder.js';
export * from './390_TerrainPointCloudTypes.js';
export * from './391_TerrainSpatialCoordinateTransformer.js';
export * from './392_TerrainI3SSpatialTransformer.js';
export * from './393_TerrainRenderDispatch3D.js';
export * from './394_TerrainMaterialBridge3D.js';
export * from './395_TerrainLODFidelity3D.js';
export * from './396_TerrainSeamStitcher3D.js';
export * from './397_TerrainQueryCollision3D.js';
export * from './398_TerrainTile3D.js';
export * from './399_Tileset3D.js';
export * from './400_TerrainTiles3DArchiveSource.js';
export * from './401_TerrainB3DMParser.js';

// ═════════════════════════════════════════════════════════════════════
// 7. CONVENIENCE NAMESPACE GROUPS
// ═════════════════════════════════════════════════════════════════════

/**
 * Namespace groups — optional convenience for callers that prefer
 * `import FullSource from './402_TerrainFullSourceImportBarrel.js'` and
 * then `FullSource.Math.Vec3`, etc.
 *
 * The groups are populated with `import * as` statements, which do NOT
 * add any runtime cost to the top-level barrel: they are only evaluated
 * if the caller actually accesses them.
 */

import * as MathGroup from '../math/006_Vec3.js';
import * as CoreGroup from '../core/083_EventDispatcher.js';
import * as ECSGroup from '../ecs/015_World.js';
import * as TexturesGroup from '../textures/151_texture.js';
import * as MaterialsGroup from '../materials/186_meshstandardmaterial.js';
import * as ContextGroup from './263_ContextFrame.js';

export const Math = MathGroup;
export const Core = CoreGroup;
export const ECS = ECSGroup;
export const Textures = TexturesGroup;
export const Materials = MaterialsGroup;
export const Context = ContextGroup;

// ═════════════════════════════════════════════════════════════════════
// 8. DEFAULT NAMESPACE EXPORT
// ═════════════════════════════════════════════════════════════════════

export default {
  // Source tree roots
  Math: MathGroup,
  Core: CoreGroup,
  ECS: ECSGroup,
  Textures: TexturesGroup,
  Materials: MaterialsGroup,
  Context: ContextGroup,

  // Most-frequently-used terrain symbols
  Tileset3D: ContextGroup.Tileset3D,
  Tile3D: ContextGroup.Tile3D,
  BoundingVolume3D: ContextGroup.BoundingVolume3D,
  TerrainTiles3DArchiveSource: ContextGroup.TerrainTiles3DArchiveSource,
  TerrainB3DMParser: ContextGroup.TerrainB3DMParser,
  TerrainSource: ContextGroup.TerrainSource,
  TerrainPipelineOrchestrator: ContextGroup.TerrainPipelineOrchestrator,
  TerrainSeamStitcher3D: ContextGroup.TerrainSeamStitcher3D,
  TerrainQueryCollision3D: ContextGroup.TerrainQueryCollision3D,
  TerrainLODFidelity3D: ContextGroup.TerrainLODFidelity3D,
  TerrainMaterialBridge3D: ContextGroup.TerrainMaterialBridge3D,
  TerrainRenderDispatch3D: ContextGroup.TerrainRenderDispatch3D,
  TerrainI3SSpatialTransformer: ContextGroup.TerrainI3SSpatialTransformer,
  TerrainSpatialCoordinateTransformer: ContextGroup.TerrainSpatialCoordinateTransformer,
  TerrainNormalizeCRSIdentifier: ContextGroup.TerrainNormalizeCRSIdentifier,
  TerrainSpatialCoordinateFrame: ContextGroup.TerrainSpatialCoordinateFrame,
  TerrainI3SElevationDecoder: ContextGroup.TerrainI3SElevationDecoder,
  TerrainQuantizedMeshDecoder: ContextGroup.TerrainQuantizedMeshDecoder,
  TerrainHeightmapDecoder: ContextGroup.TerrainHeightmapDecoder,

  // Core math primitives (for convenience)
  Vec2: MathGroup.Vec2,
  Vec3: MathGroup.Vec3,
  Vec4: MathGroup.Vec4,
  Mat2: MathGroup.Mat2,
  Mat3: MathGroup.Mat3,
  Mat4: MathGroup.Mat4,
  Quat: MathGroup.Quat,
  SimplexNoise: MathGroup.SimplexNoise,

  // Core ECS
  World: ECSGroup.World,
  Components: ECSGroup.Components,
  Systems: ECSGroup.Systems,
  BitECS: ECSGroup.BitECS,

  // Core utilities
  EventDispatcher: CoreGroup.EventDispatcher,
  Timer: CoreGroup.Timer,
  BufferAttribute: CoreGroup.BufferAttribute,
  BufferGeometry: CoreGroup.BufferGeometry,
  Raycaster: CoreGroup.Raycaster,

  // Textures
  Texture: TexturesGroup.Texture,
  DataTexture: TexturesGroup.DataTexture,
  DataArrayTexture: TexturesGroup.DataArrayTexture,
  Data3DTexture: TexturesGroup.Data3DTexture,

  // Materials
  Material: MaterialsGroup.Material,
  MeshBasicMaterial: MaterialsGroup.MeshBasicMaterial,
  MeshStandardMaterial: MaterialsGroup.MeshStandardMaterial,
  MeshPhysicalMaterial: MaterialsGroup.MeshPhysicalMaterial,
  ShaderMaterial: MaterialsGroup.ShaderMaterial
};