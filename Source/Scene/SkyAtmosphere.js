import Cartesian3 from "../Core/Cartesian3.js";
import defaultValue from "../Core/defaultValue.js";
import defined from "../Core/defined.js";
import destroyObject from "../Core/destroyObject.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import EllipsoidGeometry from "../Core/EllipsoidGeometry.js";
import GeometryPipeline from "../Core/GeometryPipeline.js";
import CesiumMath from "../Core/Math.js";
import VertexFormat from "../Core/VertexFormat.js";
import BufferUsage from "../Renderer/BufferUsage.js";
import DrawCommand from "../Renderer/DrawCommand.js";
import RenderState from "../Renderer/RenderState.js";
import ShaderProgram from "../Renderer/ShaderProgram.js";
import ShaderSource from "../Renderer/ShaderSource.js";
import VertexArray from "../Renderer/VertexArray.js";
import SkyAtmosphereCommon from "../Shaders/SkyAtmosphereCommon.js";
import SkyAtmosphereFS from "../Shaders/SkyAtmosphereFS.js";
import SkyAtmosphereVS from "../Shaders/SkyAtmosphereVS.js";
import BlendingState from "./BlendingState.js";
import CullFace from "./CullFace.js";
import SceneMode from "./SceneMode.js";

/**
 * An atmosphere drawn around the limb of the provided ellipsoid.  Based on
 * {@link https://developer.nvidia.com/gpugems/GPUGems2/gpugems2_chapter16.html|Accurate Atmospheric Scattering}
 * in GPU Gems 2.
 * <p>
 * This is only supported in 3D. Atmosphere is faded out when morphing to 2D or Columbus view.
 * </p>
 *
 * @alias SkyAtmosphere
 * @constructor
 *
 * @param {Ellipsoid} [ellipsoid=Ellipsoid.WGS84] The ellipsoid that the atmosphere is drawn around.
 *
 * @example
 * scene.skyAtmosphere = new Cesium.SkyAtmosphere();
 *
 * @demo {@link https://sandcastle.cesium.com/index.html?src=Sky%20Atmosphere.html|Sky atmosphere demo in Sandcastle}
 *
 * @see Scene.skyAtmosphere
 */
function SkyAtmosphere(ellipsoid) {
  ellipsoid = defaultValue(ellipsoid, Ellipsoid.WGS84);

  /**
   * Determines if the atmosphere is shown.
   *
   * @type {Boolean}
   * @default true
   */
  this.show = true;

  this._ellipsoid = ellipsoid;
  this._command = new DrawCommand({
    owner: this,
  });
  this._spSkyFromSpace = undefined;
  this._spSkyFromAtmosphere = undefined;

  this._flags = undefined;

  /**
   * The hue shift to apply to the atmosphere. Defaults to 0.0 (no shift).
   * A hue shift of 1.0 indicates a complete rotation of the hues available.
   * @type {Number}
   * @default 0.0
   */
  this.hueShift = 0.0;

  /**
   * The saturation shift to apply to the atmosphere. Defaults to 0.0 (no shift).
   * A saturation shift of -1.0 is monochrome.
   * @type {Number}
   * @default 0.0
   */
  this.saturationShift = 0.0;

  /**
   * The brightness shift to apply to the atmosphere. Defaults to 0.0 (no shift).
   * A brightness shift of -1.0 is complete darkness, which will let space show through.
   * @type {Number}
   * @default 0.0
   */
  this.brightnessShift = 0.0;

  this._hueSaturationBrightness = new Cartesian3();

  // camera height, outer radius, inner radius, dynamic atmosphere color flag
  var radiiAndDynamicAtmosphereColor = new Cartesian3();

  // Toggles whether the sun position is used. 0 treats the sun as always directly overhead.
  radiiAndDynamicAtmosphereColor.z = 0;
  radiiAndDynamicAtmosphereColor.x = Cartesian3.maximumComponent(
    Cartesian3.multiplyByScalar(ellipsoid.radii, 1.025, new Cartesian3())
  );
  radiiAndDynamicAtmosphereColor.y = ellipsoid.maximumRadius;

  this._radiiAndDynamicAtmosphereColor = radiiAndDynamicAtmosphereColor;

  var that = this;

  this._command.uniformMap = {
    u_radiiAndDynamicAtmosphereColor: function () {
      return that._radiiAndDynamicAtmosphereColor;
    },
    u_hsbShift: function () {
      that._hueSaturationBrightness.x = that.hueShift;
      that._hueSaturationBrightness.y = that.saturationShift;
      that._hueSaturationBrightness.z = that.brightnessShift;
      return that._hueSaturationBrightness;
    },
  };
}

Object.defineProperties(SkyAtmosphere.prototype, {
  /**
   * Gets the ellipsoid the atmosphere is drawn around.
   * @memberof SkyAtmosphere.prototype
   *
   * @type {Ellipsoid}
   * @readonly
   */
  ellipsoid: {
    get: function () {
      return this._ellipsoid;
    },
  },
});

/**
 * @private
 */
SkyAtmosphere.prototype.setDynamicAtmosphereColor = function (
  enableLighting,
  useSunDirection
) {
  var lightEnum = enableLighting ? (useSunDirection ? 2.0 : 1.0) : 0.0;
  this._radiiAndDynamicAtmosphereColor.z = lightEnum;
};

/**
 * @private
 */
SkyAtmosphere.prototype.update = function (frameState, globe) {
  if (!this.show) {
    return undefined;
  }

  var mode = frameState.mode;
  if (mode !== SceneMode.SCENE3D && mode !== SceneMode.MORPHING) {
    return undefined;
  }

  // The atmosphere is only rendered during the render pass; it is not pickable, it doesn't cast shadows, etc.
  if (!frameState.passes.render) {
    return undefined;
  }

  var context = frameState.context;

  var colorCorrect = hasColorCorrection(this);
  var translucent = frameState.globeTranslucencyState.translucent;
  var fullAtmosphere =
    translucent ||
    (defined(globe) &&
      (!globe.show || globe._surface._tilesToRender.length === 0));

  var command = this._command;

  if (!defined(command.vertexArray)) {
    var geometry = EllipsoidGeometry.createGeometry(
      new EllipsoidGeometry({
        radii: Cartesian3.multiplyByScalar(
          this._ellipsoid.radii,
          1.025,
          new Cartesian3()
        ),
        slicePartitions: 256,
        stackPartitions: 256,
        vertexFormat: VertexFormat.POSITION_ONLY,
      })
    );
    command.vertexArray = VertexArray.fromGeometry({
      context: context,
      geometry: geometry,
      attributeLocations: GeometryPipeline.createAttributeLocations(geometry),
      bufferUsage: BufferUsage.STATIC_DRAW,
    });
    command.renderState = RenderState.fromCache({
      cull: {
        enabled: true,
        face: CullFace.FRONT,
      },
      blending: BlendingState.ALPHA_BLEND,
      depthMask: false,
    });
  }

  var flags = colorCorrect | (fullAtmosphere << 2);

  if (flags !== this._flags) {
    this._flags = flags;

    var defines = [];

    if (colorCorrect) {
      defines.push("COLOR_CORRECT");
    }

    if (fullAtmosphere) {
      defines.push("FULL_ATMOSPHERE");
    }

    var vs = new ShaderSource({
      defines: defines.concat("SKY_FROM_SPACE"),
      sources: [SkyAtmosphereCommon, SkyAtmosphereVS],
    });

    var fs = new ShaderSource({
      defines: defines.concat("SKY_FROM_SPACE"),
      sources: [SkyAtmosphereCommon, SkyAtmosphereFS],
    });

    this._spSkyFromSpace = ShaderProgram.fromCache({
      context: context,
      vertexShaderSource: vs,
      fragmentShaderSource: fs,
    });

    vs = new ShaderSource({
      defines: defines.concat("SKY_FROM_ATMOSPHERE"),
      sources: [SkyAtmosphereCommon, SkyAtmosphereVS],
    });

    fs = new ShaderSource({
      defines: defines.concat("SKY_FROM_ATMOSPHERE"),
      sources: [SkyAtmosphereCommon, SkyAtmosphereFS],
    });

    this._spSkyFromAtmosphere = ShaderProgram.fromCache({
      context: context,
      vertexShaderSource: vs,
      fragmentShaderSource: fs,
    });
  }

  var cameraPosition = frameState.camera.positionWC;
  var cameraHeight = Cartesian3.magnitude(cameraPosition);

  if (cameraHeight > this._radiiAndDynamicAtmosphereColor.x) {
    // Camera in space
    command.shaderProgram = this._spSkyFromSpace;
  } else {
    // Camera in atmosphere
    command.shaderProgram = this._spSkyFromAtmosphere;
  }

  return command;
};

function hasColorCorrection(skyAtmosphere) {
  return !(
    CesiumMath.equalsEpsilon(
      skyAtmosphere.hueShift,
      0.0,
      CesiumMath.EPSILON7
    ) &&
    CesiumMath.equalsEpsilon(
      skyAtmosphere.saturationShift,
      0.0,
      CesiumMath.EPSILON7
    ) &&
    CesiumMath.equalsEpsilon(
      skyAtmosphere.brightnessShift,
      0.0,
      CesiumMath.EPSILON7
    )
  );
}

/**
 * Returns true if this object was destroyed; otherwise, false.
 * <br /><br />
 * If this object was destroyed, it should not be used; calling any function other than
 * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.
 *
 * @returns {Boolean} <code>true</code> if this object was destroyed; otherwise, <code>false</code>.
 *
 * @see SkyAtmosphere#destroy
 */
SkyAtmosphere.prototype.isDestroyed = function () {
  return false;
};

/**
 * Destroys the WebGL resources held by this object.  Destroying an object allows for deterministic
 * release of WebGL resources, instead of relying on the garbage collector to destroy this object.
 * <br /><br />
 * Once an object is destroyed, it should not be used; calling any function other than
 * <code>isDestroyed</code> will result in a {@link DeveloperError} exception.  Therefore,
 * assign the return value (<code>undefined</code>) to the object as done in the example.
 *
 * @exception {DeveloperError} This object was destroyed, i.e., destroy() was called.
 *
 *
 * @example
 * skyAtmosphere = skyAtmosphere && skyAtmosphere.destroy();
 *
 * @see SkyAtmosphere#isDestroyed
 */
SkyAtmosphere.prototype.destroy = function () {
  var command = this._command;
  command.vertexArray = command.vertexArray && command.vertexArray.destroy();
  this._spSkyFromSpace = this._spSkyFromSpace && this._spSkyFromSpace.destroy();
  this._spSkyFromAtmosphere =
    this._spSkyFromAtmosphere && this._spSkyFromAtmosphere.destroy();
  return destroyObject(this);
};
export default SkyAtmosphere;
