/**
 * Lightning — a pooled set of arcs in one mesh, one material, one draw.
 *
 * The same idea as the water body and for the same reasons: one pipeline, one
 * warm-up, one set of fog uniforms, one idea of what a discharge looks like. An
 * arc is claimed by `spawn()`, lives for a fraction of a second and recycles
 * itself; a slot that is not alive has zero width at every point, which
 * collapses its ribbon and costs nothing to draw.
 *
 * **Why this is not a water strand.** The strand pool is exactly full at the
 * demo's worst case (Sweep 1, Ribbon 1, Bloom 1, Vortex 3, Comet 2 = 8), so
 * there was nothing to take. That turned out to be the right forcing function:
 * a bolt wants to be a flat ribbon facing the camera, not a swept tube with a
 * transported frame, and it wants a hundred of itself alive at once rather than
 * one. The two systems have almost nothing in common but the addressing trick.
 *
 * **The path is generated once, at spawn, and then held.** The temptation is to
 * re-randomise it every frame for "flicker", and it is wrong: at sixty frames a
 * second the bolt stops being an object and becomes a shimmering cloud with no
 * shape at all. Real flicker is arcs *appearing and dying*, which is what the
 * short lifetimes here do — a bolt is coherent for its whole life and there are
 * simply a lot of lives per second.
 *
 * **Local vs world anchoring.** Arcs around a ball held in a flying character's
 * hands have to travel with it: at 26 m/s a bolt living 0.12 s would otherwise
 * be left three metres behind the thing that threw it. Those are spawned
 * `local`, storing offsets against `setOrigin()`, which the owner moves each
 * frame. Everything the detonation throws is spawned in world space, because a
 * blast is fixed to the ground it went off on.
 *
 * Allocation per frame: none.
 */

import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3 } from "@babylonjs/core/Maths/math";

import { S } from "../core/settings.js";
import { whenReady } from "../core/gpuUtil.js";

/**
 * Pool size. A hard cap, not a target — a bolt is simply dropped when it is
 * exhausted, which at these rates is invisible and is the right failure anyway.
 *
 * This was 24 and is 128, which is what "a ball crawling with lightning" costs:
 * sixty-odd bolts alive through the charge and eighty through the detonation,
 * with headroom above both. The cost is a 24 x 256 float texture (98 KB) and
 * 5888 triangles, against the spray's 160 KB and 10k — so the pool is sized by
 * what reads rather than by what is affordable, because at this scale
 * everything is affordable.
 *
 * Note it is no longer mirrored by anything in the shader. The per-arc
 * parameters used to be a `array<vec4f, N>` uniform, which made this constant a
 * cross-file invariant that had to be kept in step by hand; they now live in a
 * second texture row per arc, so the shader neither knows nor cares how many
 * there are.
 */
export const ARC_MAX = 128;

/**
 * Points per bolt.
 *
 * Twenty-four is set by the kinks rather than by the curve. A bolt is
 * piecewise-linear and the corners *are* the read — smooth it and you have a
 * ribbon of ink. Below about sixteen the segments are long enough that the eye
 * resolves them as a deliberate zigzag pattern instead of as a discharge, and
 * above about thirty-two the kinks are finer than a pixel at the distance the
 * blast is watched from and nothing is gained.
 */
const ARC_POINTS = 24;

export class ArcField {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../render/sky.js").Sky} sky
     */
    constructor(scene, sky) {
        this.scene = scene;
        this.sky = sky;

        // Two rows per arc. Row `2a` is the path, one texel per point:
        // (x, y, z, half-width). Row `2a + 1` holds the arc's constants in its
        // first texel: (intensity, alpha, colour mix, unused).
        //
        // The rest of that second row is unused, which looks wasteful and buys
        // the thing that matters: the pool size stops being a number the shader
        // has to agree about. A uniform array would have to be declared with a
        // literal length in the WGSL, and a mismatch between the two is exactly
        // the kind of bug that compiles, runs, and quietly draws garbage.
        this._texData = new Float32Array(ARC_MAX * 2 * ARC_POINTS * 4);
        this.dataTex = RawTexture.CreateRGBATexture(
            this._texData, ARC_POINTS, ARC_MAX * 2, scene,
            false, false,
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT
        );
        this.dataTex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.dataTex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

        // CPU-side lifetime and geometry. None of it is read by a shader, so it
        // is kept out of the texture — the texture is written from it each
        // frame, which is also where the fade is applied.
        this.age = new Float32Array(ARC_MAX);
        this.life = new Float32Array(ARC_MAX);
        this.alive = new Uint8Array(ARC_MAX);
        /** Spawned local to `_origin` rather than fixed in the world. */
        this.local = new Uint8Array(ARC_MAX);
        /** Path, three floats per point per arc. Local arcs hold offsets. */
        this.path = new Float32Array(ARC_MAX * ARC_POINTS * 3);
        /** Half-width at the belly, metres. Tapered along the bolt on upload. */
        this.width = new Float32Array(ARC_MAX);
        this.intensity = new Float32Array(ARC_MAX);
        this.warm = new Float32Array(ARC_MAX);

        this._next = 0;
        this.liveCount = 0;
        this._origin = new Vector3();
        this._t = 0;

        this.mesh = buildRibbons(scene);
        this.material = this._makeMaterial();
        this.mesh.material = this.material;
        // With the water and the spray, after the opaque pass. Last of the
        // three: bolts are the brightest thing in any frame that has them and
        // they belong in front of the body they are wrapping.
        this.mesh.renderingGroupId = 2;
        this.mesh.alphaIndex = 2;
        this.mesh.isVisible = false;
    }

    _makeMaterial() {
        const mat = new ShaderMaterial(
            "spellArc", this.scene, { vertex: "arc", fragment: "arc" },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection", "cameraPos",
                    "arcPoints", "arcTime",
                    "sunDir", "sunRadiance",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                ],
                samplers: ["arcTex", "skyLUT"],
                shaderLanguage: ShaderLanguage.WGSL,
                needAlphaBlending: true,
            }
        );
        // A ribbon has no back: it is turned to face the camera every frame, and
        // culling it would drop half the bolts depending on which way the path
        // happened to run.
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.alphaMode = Constants.ALPHA_COMBINE;
        mat.needAlphaBlending = () => true;
        mat.setTexture("arcTex", this.dataTex);
        mat.setTexture("skyLUT", this.sky.lut);
        mat.setFloat("arcPoints", ARC_POINTS);
        return mat;
    }

    /**
     * Move the frame that `local` arcs are drawn against. Call once a frame,
     * before spawning any.
     *
     * @param {number} x @param {number} y @param {number} z
     */
    setOrigin(x, y, z) {
        this._origin.set(x, y, z);
    }

    /**
     * Strike an arc between two points.
     *
     * The path is a straight line displaced perpendicular to itself by three
     * octaves of smooth noise plus a per-point jitter. The octaves give it the
     * long lazy wander a discharge has between its kinks; the jitter gives it
     * the kinks. Only having the first produces a ribbon of seaweed, and only
     * having the second produces a saw blade — it is the two together at
     * roughly a four-to-one amplitude ratio that reads as lightning.
     *
     * The displacement envelope is zero at both ends, so a bolt actually
     * terminates on the points it was asked to connect.
     *
     * @param {boolean} local anchor to `setOrigin` rather than to the world
     * @param {number} ax @param {number} ay @param {number} az
     * @param {number} bx @param {number} by @param {number} bz
     * @param {number} jag lateral wander, metres
     * @param {number} width half-width at the belly, metres
     * @param {number} life seconds
     * @param {number} intensity brightness multiplier
     * @param {number} [warm] 0 electric blue, 1 violet — for arcs inside fire
     * @returns {number} slot index, or -1 when the pool is exhausted
     */
    spawn(local, ax, ay, az, bx, by, bz, jag, width, life, intensity, warm) {
        // Bounded scan for a free slot, exactly as the spray does. A dropped
        // bolt is invisible at these rates; a hitch would not be.
        let i = this._next;
        let found = -1;
        for (let n = 0; n < ARC_MAX; n++) {
            if (!this.alive[i]) { found = i; break; }
            i = (i + 1) % ARC_MAX;
        }
        if (found < 0) return -1;
        this._next = (found + 1) % ARC_MAX;

        let ox = ax, oy = ay, oz = az;
        let px = bx, py = by, pz = bz;
        if (local) {
            ox -= this._origin.x; oy -= this._origin.y; oz -= this._origin.z;
            px -= this._origin.x; py -= this._origin.y; pz -= this._origin.z;
        }

        let dx = px - ox, dy = py - oy, dz = pz - oz;
        const len = Math.hypot(dx, dy, dz) || 1e-4;
        dx /= len; dy /= len; dz /= len;

        // Two perpendiculars to displace within. Referred to whichever world
        // axis the bolt is least aligned with, so neither cross degenerates.
        let ux, uy, uz;
        if (Math.abs(dy) > 0.9) { ux = 1; uy = 0; uz = 0; }
        else { ux = 0; uy = 1; uz = 0; }
        let s1x = uy * dz - uz * dy;
        let s1y = uz * dx - ux * dz;
        let s1z = ux * dy - uy * dx;
        const s1l = Math.hypot(s1x, s1y, s1z) || 1;
        s1x /= s1l; s1y /= s1l; s1z /= s1l;
        const s2x = dy * s1z - dz * s1y;
        const s2y = dz * s1x - dx * s1z;
        const s2z = dx * s1y - dy * s1x;

        // Random phases, so two bolts struck along the same line are different
        // bolts rather than the same one drawn twice.
        const ph = [
            Math.random() * 6.283, Math.random() * 6.283, Math.random() * 6.283,
            Math.random() * 6.283, Math.random() * 6.283, Math.random() * 6.283,
        ];

        const base = found * ARC_POINTS * 3;
        for (let p = 0; p < ARC_POINTS; p++) {
            const t = p / (ARC_POINTS - 1);
            // Broad envelope, zero at both ends. The 0.7 power holds the bolt
            // wide for most of its length instead of pinching it into a lens.
            const env = Math.pow(Math.sin(Math.PI * t), 0.7);

            const w1 =
                Math.sin(t * 5.4 + ph[0]) * 1.0
                + Math.sin(t * 13.7 + ph[1]) * 0.45
                + Math.sin(t * 29.3 + ph[2]) * 0.22
                + (Math.random() - 0.5) * 0.85;
            const w2 =
                Math.sin(t * 6.1 + ph[3]) * 1.0
                + Math.sin(t * 15.2 + ph[4]) * 0.45
                + Math.sin(t * 31.7 + ph[5]) * 0.22
                + (Math.random() - 0.5) * 0.85;

            const k = jag * env * 0.42;
            const o = base + p * 3;
            this.path[o] = ox + dx * len * t + (s1x * w1 + s2x * w2) * k;
            this.path[o + 1] = oy + dy * len * t + (s1y * w1 + s2y * w2) * k;
            this.path[o + 2] = oz + dz * len * t + (s1z * w1 + s2z * w2) * k;
        }

        this.alive[found] = 1;
        this.local[found] = local ? 1 : 0;
        this.age[found] = 0;
        this.life[found] = life;
        this.width[found] = width;
        this.intensity[found] = intensity;
        this.warm[found] = warm === undefined ? 0 : warm;
        return found;
    }

    /**
     * Age every arc and upload.
     * @param {number} dt
     */
    update(dt) {
        this._t += dt;
        const h = Math.min(dt, 1 / 30);
        const d = this._texData;
        const ox = this._origin.x, oy = this._origin.y, oz = this._origin.z;

        let live = 0;
        for (let a = 0; a < ARC_MAX; a++) {
            const tbase = a * 2 * ARC_POINTS * 4;
            const pbase = (a * 2 + 1) * ARC_POINTS * 4;

            if (!this.alive[a]) {
                // A dead slot still has to be written, or last frame's bolt
                // keeps rendering. Zero width collapses the ribbon.
                d[pbase + 1] = 0;
                for (let p = 0; p < ARC_POINTS; p++) d[tbase + p * 4 + 3] = 0;
                continue;
            }

            this.age[a] += h;
            if (this.age[a] >= this.life[a]) {
                this.alive[a] = 0;
                d[pbase + 1] = 0;
                for (let p = 0; p < ARC_POINTS; p++) d[tbase + p * 4 + 3] = 0;
                continue;
            }

            const a01 = this.age[a] / this.life[a];
            // Struck instantly and decaying. A bolt that fades *in* is a light
            // being turned up, which is the one thing a discharge never does.
            const fade = (1 - a01) * (1 - a01);

            const lx = this.local[a] ? ox : 0;
            const ly = this.local[a] ? oy : 0;
            const lz = this.local[a] ? oz : 0;

            const wid = this.width[a];
            const sbase = a * ARC_POINTS * 3;
            for (let p = 0; p < ARC_POINTS; p++) {
                const t = p / (ARC_POINTS - 1);
                const so = sbase + p * 3;
                const to = tbase + p * 4;
                d[to] = this.path[so] + lx;
                d[to + 1] = this.path[so + 1] + ly;
                d[to + 2] = this.path[so + 2] + lz;
                // Thickest a third of the way along and tapering to a point at
                // both ends, so a bolt has a direction and does not read as a
                // length of cable cut off at each end.
                d[to + 3] = wid * Math.sin(Math.PI * Math.pow(t, 0.8)) * (0.55 + 0.45 * fade);
            }

            d[pbase] = this.intensity[a] * (0.35 + 0.65 * fade);
            d[pbase + 1] = fade;
            d[pbase + 2] = this.warm[a];
            d[pbase + 3] = 0;
            live++;
        }

        this.liveCount = live;
        // Visibility is the live count and nothing else. This used to also test
        // `S.showSpells`, which was belt-and-braces — switching spells off runs
        // `_cancelAll`, and the Comet's `cancel` clears this pool — and became
        // wrong once `vfx/skyBolt.js` started striking into it. The sky strike
        // is a movement mode, not a spell, and hiding it because the spell
        // toggle is off would make the launch vanish mid-climb.
        this.mesh.isVisible = live > 0;
        if (!this.mesh.isVisible) return;

        this.dataTex.update(d);
        this._pushUniforms();
    }

    _pushUniforms() {
        const m = this.material;
        m.setVector3("cameraPos", this.scene.activeCamera.position);
        m.setFloat("arcTime", this._t);
        m.setVector3("sunDir", this.sky.sunDir);
        m.setColor3("sunRadiance", this.sky.sunRadiance);
        m.setFloat("fogDensity", S.fogDensity);
        m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
        m.setFloat("fogStart", S.fogStart);
        m.setFloat("aerialStrength", S.aerialStrength);
    }

    /** Kill everything. Used when a spell is cancelled. */
    clear() {
        this.alive.fill(0);
        this._texData.fill(0);
        this.liveCount = 0;
    }

    get triangles() {
        return this.mesh.isVisible
            ? (this.liveCount / ARC_MAX) * this.mesh.metadata.triangles
            : 0;
    }

    /**
     * Compile behind the loading screen, and leave a bolt *standing* so the
     * warm-up frames in `main` actually rasterise one.
     *
     * Same reasoning as `WaterBody.warmUp`: `isReady()` builds the shader
     * modules, but the WebGPU render pipeline is keyed on blend and depth state
     * and is only created when the mesh is drawn.
     */
    async warmUp(x, y, z) {
        this.setOrigin(0, 0, 0);
        this.spawn(false, x, y + 0.4, z, x + 1.5, y + 2.2, z + 0.6, 0.5, 0.05, 999, 1, 0);
        this.update(0);
        this.mesh.isVisible = true;
        this._pushUniforms();
        await whenReady(this.material, "arc material", [this.mesh, false]);
    }

    /** Take the synthetic bolt down, after the warm-up frames have drawn. */
    finishWarmUp() {
        this.clear();
        this.dataTex.update(this._texData);
        this.mesh.isVisible = false;
    }

    dispose() {
        this.mesh.dispose();
        this.material.dispose();
        this.dataTex.dispose();
    }
}

/**
 * The static ribbons: `position` is (arcIndex, pointIndex, side) and carries no
 * geometry. Every arc is a separate index range in one buffer, so the whole
 * system is a single draw however many bolts are alive.
 */
function buildRibbons(scene) {
    const perArc = ARC_POINTS * 2;
    const pos = new Float32Array(ARC_MAX * perArc * 3);
    const idx = new Uint32Array(ARC_MAX * (ARC_POINTS - 1) * 6);

    let vi = 0;
    let ii = 0;
    for (let a = 0; a < ARC_MAX; a++) {
        const base = a * perArc;
        for (let p = 0; p < ARC_POINTS; p++) {
            pos[vi++] = a; pos[vi++] = p; pos[vi++] = -1;
            pos[vi++] = a; pos[vi++] = p; pos[vi++] = 1;
        }
        for (let p = 0; p < ARC_POINTS - 1; p++) {
            const q = base + p * 2;
            idx[ii++] = q; idx[ii++] = q + 1; idx[ii++] = q + 3;
            idx[ii++] = q; idx[ii++] = q + 3; idx[ii++] = q + 2;
        }
    }

    const mesh = new Mesh("spellArc", scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { triangles: idx.length / 3, vertices: ARC_MAX * perArc };
    return mesh;
}

export { ARC_POINTS };
