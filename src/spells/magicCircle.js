/**
 * The casting sigil.
 *
 * Three coaxial discs, one mesh, one draw, twelve vertices. Everything drawn on
 * them is analytic — see `magicCircle.fragment.wgsl` — so this file owns only
 * the frame the sigil stands in and the two numbers that drive it: how much of
 * it has been inscribed, and how hard it is discharging.
 *
 * The frame is built from an *axis*, not from the camera. The sigil is a thing
 * standing in the world that the lance leaves through, so it foreshortens to a
 * line when you sight along the shot. Billboarding it would make it face you
 * from every angle, which reads as an interface element rather than as an
 * object.
 *
 * Allocation per frame: none.
 */

import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3, Color3 } from "@babylonjs/core/Maths/math";

import { S } from "../core/settings.js";
import { whenReady } from "../core/gpuUtil.js";

const DISCS = 3;

/**
 * Per disc: (radius scale, spin rate rad/s, axial offset m, build delay 0..1).
 *
 * The middle disc turns the other way. Two counter-rotating fences at close
 * radii is most of what stops a flat sigil reading as a sticker — one ring
 * turning is a wheel, two turning against each other is machinery.
 *
 * The axial offsets are small and negative: the discs stack *behind* the ball,
 * away from the target, so the ball sits proud of the sigil rather than inside
 * it. They are also what gives the stack parallax when the camera moves.
 */
const DISC_DATA = new Float32Array([
    1.00, 0.55, -0.02, 0.00,
    0.74, -0.95, -0.16, 0.18,
    0.46, 1.45, -0.30, 0.42,
]);

const _right = new Vector3();
const _up = new Vector3();
const _axis = new Vector3();
const _colour = new Color3(0.52, 0.80, 1.0);

export class MagicCircle {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../render/sky.js").Sky} sky
     */
    constructor(scene, sky) {
        this.scene = scene;
        this.sky = sky;

        this.mesh = buildDiscs(scene);
        this.material = this._makeMaterial();
        this.mesh.material = this.material;
        // With the water and the spray, after the opaque pass. Behind the water
        // in the alpha order: the ball is a water strand and it stands in front
        // of the sigil by construction.
        this.mesh.renderingGroupId = 2;
        this.mesh.alphaIndex = 1;
        this.mesh.isVisible = false;

        this.center = new Vector3();
        this.radius = 1;
        this.build = 0;
        this.alpha = 0;
        this.flare = 0;
        /**
         * 0 = the casting sigil, 1 = the Comet's seismic front.
         *
         * The same mesh and the same material draw both, because they are the
         * same *pipeline* — three coaxial quads, alpha-blended, depth-tested and
         * not depth-written. A second material for the front would mean a second
         * warm-up covering a render state already covered. Set by the owner
         * before `update`; `hide` puts it back.
         */
        this.mode = 0;
        this._t = 0;
    }

    _makeMaterial() {
        const mat = new ShaderMaterial(
            "magicCircle", this.scene,
            { vertex: "magicCircle", fragment: "magicCircle" },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection", "cameraPos",
                    "circleCenter", "circleRight", "circleUp", "circleAxis",
                    "circleRadius", "discParams",
                    "circleTime", "circleBuild", "circleAlpha", "circleFlare",
                    "circleColor", "circleMode",
                    "sunDir", "sunRadiance",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                ],
                samplers: ["skyLUT"],
                shaderLanguage: ShaderLanguage.WGSL,
                needAlphaBlending: true,
            }
        );
        // Seen from both sides: the caster is behind it and the target in front,
        // and it has to be legible from either.
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.alphaMode = Constants.ALPHA_COMBINE;
        mat.needAlphaBlending = () => true;
        mat.setTexture("skyLUT", this.sky.lut);
        mat.setArray4("discParams", DISC_DATA);
        return mat;
    }

    /**
     * Stand the sigil at a point, facing along an axis.
     *
     * The in-plane basis is referred to world up. It degenerates when the axis
     * passes through vertical, which would spin the sigil through a half turn in
     * one frame — but the axis here is the caster's aim, and the sigil is only
     * up while they are holding a charge. Aiming *exactly* at the zenith through
     * that window is the only way to see it.
     *
     * @param {number} x @param {number} y @param {number} z
     * @param {number} ax @param {number} ay @param {number} az unit aim
     * @param {number} radius metres
     */
    setFrame(x, y, z, ax, ay, az, radius) {
        this.center.set(x, y, z);
        this.radius = radius;
        _axis.set(ax, ay, az);
        _axis.normalize();

        // right = up x axis, falling back to world forward where that vanishes.
        if (Math.abs(_axis.y) > 0.995) {
            _right.set(0, 0, 1);
        } else {
            _right.set(-_axis.z, 0, _axis.x);
        }
        _right.normalize();
        Vector3.CrossToRef(_axis, _right, _up);
        _up.normalize();
    }

    /**
     * @param {number} dt
     * @param {number} build 0..1 how much of the sigil is inscribed
     * @param {number} alpha 0..1 global fade
     * @param {number} flare 0..1 discharge brightness
     */
    update(dt, build, alpha, flare) {
        this._t += dt;
        this.build = build;
        this.alpha = alpha;
        this.flare = flare;

        // `build` gates the sigil because a sigil that has not started being
        // inscribed is nothing. The front has no build — it is either expanding
        // or gone — so it answers to alpha alone.
        this.mesh.isVisible =
            alpha > 0.004
            && (this.mode > 0.5 || build > 0.001)
            && S.showSpells !== false;
        if (!this.mesh.isVisible) return;
        this._push();
    }

    _push() {
        const m = this.material;
        const cam = this.scene.activeCamera;
        m.setVector3("cameraPos", cam.position);
        m.setVector3("circleCenter", this.center);
        m.setVector3("circleRight", _right);
        m.setVector3("circleUp", _up);
        m.setVector3("circleAxis", _axis);
        m.setFloat("circleRadius", this.radius);
        m.setFloat("circleTime", this._t);
        m.setFloat("circleBuild", this.build);
        m.setFloat("circleAlpha", this.alpha);
        m.setFloat("circleFlare", this.flare);
        m.setColor3("circleColor", _colour);
        m.setFloat("circleMode", this.mode);
        m.setVector3("sunDir", this.sky.sunDir);
        m.setColor3("sunRadiance", this.sky.sunRadiance);
        m.setFloat("fogDensity", S.fogDensity);
        m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
        m.setFloat("fogStart", S.fogStart);
        m.setFloat("aerialStrength", S.aerialStrength);
    }

    hide() {
        this.mesh.isVisible = false;
        this.mode = 0;
    }

    get triangles() {
        return this.mesh.isVisible ? this.mesh.metadata.triangles : 0;
    }

    /**
     * Compile behind the loading screen, and leave the sigil *standing* so the
     * warm-up frames in `main` actually rasterise it.
     *
     * Same reasoning as `WaterBody.warmUp`: `isReady()` builds the shader
     * modules, but the WebGPU render pipeline is keyed on the blend and depth
     * state and is only created when the mesh is drawn. `finishWarmUp` takes it
     * down afterwards.
     */
    async warmUp(x, y, z) {
        this.setFrame(x, y + 1.2, z, 0, 0, 1, 0.9);
        this.update(0, 1, 1, 0.2);
        this.mesh.isVisible = true;
        this._push();
        await whenReady(this.material, "magic circle", [this.mesh, false]);
    }

    finishWarmUp() {
        this.build = 0;
        this.alpha = 0;
        this.flare = 0;
        this.mode = 0;
        this.mesh.isVisible = false;
    }

    dispose() {
        this.mesh.dispose();
        this.material.dispose();
    }
}

/**
 * Three quads. `position` is (cornerX, cornerY, discIndex) and carries no
 * geometry — the vertex shader places every corner from the sigil's frame.
 */
function buildDiscs(scene) {
    const pos = new Float32Array(DISCS * 4 * 3);
    const idx = new Uint32Array(DISCS * 6);
    const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

    for (let d = 0; d < DISCS; d++) {
        for (let c = 0; c < 4; c++) {
            const o = (d * 4 + c) * 3;
            pos[o] = CORNERS[c * 2];
            pos[o + 1] = CORNERS[c * 2 + 1];
            pos[o + 2] = d;
        }
        const b = d * 4;
        const q = d * 6;
        idx[q] = b; idx[q + 1] = b + 1; idx[q + 2] = b + 2;
        idx[q + 3] = b; idx[q + 4] = b + 2; idx[q + 5] = b + 3;
    }

    const mesh = new Mesh("magicCircle", scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { triangles: DISCS * 2, vertices: DISCS * 4 };
    return mesh;
}
