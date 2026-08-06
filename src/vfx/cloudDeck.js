/**
 * The cloud deck the sky tier flies on.
 *
 * A field of soft billboards laid out on a **toroidal cell window** that follows
 * the player — the deformation buffer's trick, moved into the air. The window is
 * 3.6 km across and holds 169 cells of nine puffs; as the player flies, cells
 * leave one edge and reappear on the other with a new integer index, and only
 * those cells are regenerated. Everything a cell contains is hashed from that
 * integer index, so a cloud is a fixed feature of the world: fly out and back
 * and the same tower is where you left it, without a single byte of it having
 * been stored.
 *
 * The whole deck then translates by an accumulated wind offset. Drift and cell
 * identity are kept apart on purpose — the hash is evaluated in the deck's own
 * frame and the offset is added afterwards, so the pattern slides intact rather
 * than being re-diced every time it moves a metre.
 *
 * ## Why billboards
 *
 * Because the alternative is a raymarched slab, and a slab cannot be flown
 * through cheaply. What this mode needs is cloud with an *inside*: towers that
 * come up through the flight path, holes that go all the way down to the snow.
 * Eight hundred discs give that for one pipeline, and they land in the same
 * place every other effect here has landed — one static mesh whose `position`
 * attribute is an index, one data texture, no per-frame allocation.
 *
 * ## The sheet and the towers
 *
 * A cell holds two separate things and they answer to different rules.
 *
 * Six puffs make the **sheet** — four in the top surface, two hanging below it.
 * That is the deck proper: near-continuous, flat-based, and the thing the sky
 * tier's ceiling is set against.
 *
 * Three more make a **tower**, and most cells do not have one. The sheet on its
 * own is a floor, and a floor is what you get to look at for the whole of a
 * cruise it is impossible to climb above — the ceiling is absolute, so there is
 * no gaining height to find something. The towers are what puts cloud *at* and
 * *above* the flight path, so the cruise has things to go through rather than a
 * surface to slide over, and `vfx/cloudVortex.js` has something to be torn out
 * of. They are gated at two scales — see `TOWER_LO` — so they arrive in clumps
 * of a few with long clear stretches between, which is what a congestus field
 * over a stratocumulus deck actually looks like.
 *
 * ## The two things that constrain the layout
 *
 * **Coverage has to be high.** Four top puffs of ~140 m per 300 m cell is 2.7x
 * the cell's area, which random placement turns into about 94% cover; the hole
 * mask takes a further tenth of the cells out deliberately, because a deck with
 * no way through it is a ceiling rather than weather. That is roughly one hole
 * every 900 m, which is often enough to dive through and rare enough to hold the
 * deck together — and holding it together is load-bearing, not cosmetic. The
 * clipmap stops at 870 m and there is no fog at this altitude to hide its rim
 * with, so what stops the world from drawing as a disc floating in the sky is
 * the deck being under you when you look toward the horizon.
 *
 * **Sorting is not optional.** Alpha-blended discs this large read as stacked
 * cards in any order but back-to-front. The pool is sorted per frame and the
 * texture rows are written in depth order rather than in slot order; see the
 * note in `cloud.vertex.wgsl`.
 *
 * One consequence of the two together, which looks like waste and is a choice:
 * the lattice is a square and the cull is its inscribed disc, so of 1521 puffs
 * only about 850 are ever drawn. The corners could be kept — at 2.5 km they are
 * 93% hazed and popping in and out of them would be close to invisible — but
 * "close to" is the whole of the argument, and what it buys is a fifth of a hash
 * and a fifth of a sort on a system that costs neither. A disc has no
 * orientation, so there is no boundary that can rotate into view.
 *
 * The towers waste far more of the pool than that and for the same reason. Every
 * cell carries three tower slots and about one cell in five builds anything in
 * them, so 500 slots carry some eighty live puffs. What that buys is the slot
 * a puff lives in staying `cell * PER_CELL + k` — which is the whole of the
 * toroidal refresh, and the alternative is a second allocator with its own free
 * list running against a window that is already recycling itself. A dead slot
 * costs a hash it does not use, one comparison in a nearly-sorted array, and
 * eight floats in an upload that is one call whatever is in it. It does not cost
 * a single fragment, which is the only number here that is large.
 *
 * ## Presence
 *
 * The deck fades in on the *camera's* height, not on the controller's tier — it
 * is a feature of the world and has to be there whether the player climbed to it
 * or is falling past it. It is absent at ground level, and that is a choice
 * rather than an oversight: the sky here is a clean analytic gradient with
 * restrained cirrus, tuned against a sun 13 degrees up, and hanging a permanent
 * overcast at 430 m would rewrite every frame of the ground game for the sake of
 * a mode entered deliberately. You climb into the weather.
 *
 * Below `FADE_LO` the radii are written as zero rather than the alphas, which is
 * what keeps eight hundred screen-filling quads from costing their fill for the
 * entire time nobody is looking at them.
 *
 * Allocation: none per frame.
 */

import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Vector3 } from "@babylonjs/core/Maths/math";
import { Color3 } from "@babylonjs/core/Maths/math.color";

import { S } from "../core/settings.js";
import { whenReady } from "../core/gpuUtil.js";

/**
 * Mean height of the cloud **tops**, metres — the surface the sky tier flies on,
 * not the height of anything in the pool.
 *
 * Paired with `SKY_CEILING` in `character/controller.js`, which sits 25 m above
 * it. Moving one without the other either buries the flight path in cloud or
 * lifts it clear of the deck entirely — see the note on `SKY_CEILING` for why
 * that clearance is as small as it is.
 */
export const DECK_TOP = 430;

/**
 * The condensation level: the height the deck's underside is not allowed below,
 * metres.
 *
 * A floor rather than a taper, and that is not a shortcut — a real stratocumulus
 * base is famously flat, because cloud begins at the height where rising air
 * reaches saturation and that height is the same for miles around. Without it
 * the largest body puffs hang three hundred metres below the smallest and the
 * deck reads as a drift of cotton rather than as weather.
 */
const DECK_BASE = 70;

/** Cell pitch of the window, metres. */
const CELL = 300;
/** Cells per side. Odd, so there is a cell centred on the player. */
const CELLS = 13;
/**
 * Puffs per cell, in three runs: four in the top surface, two body puffs hanging
 * below it, three in the tower. The runs are laid out in that order and indexed
 * by `k`, so the three constants below are also the boundaries between them.
 */
const PER_CELL = 9;
/** How many of a cell's puffs belong to the top surface. */
const TOP_PER_CELL = 4;
/** How many hang below it as the deck's body. */
const BODY_PER_CELL = 2;
/** How many stack into a tower above it. Most cells build none of them. */
const TOWER_PER_CELL = 3;
/** First `k` belonging to the tower. */
const TOWER_K0 = TOP_PER_CELL + BODY_PER_CELL;

const CAPACITY = CELLS * CELLS * PER_CELL;
const HALF_CELLS = (CELLS - 1) / 2;
/** Radius the window is culled to, metres — a disc, so the pattern has no corners. */
const WINDOW_R = HALF_CELLS * CELL;

/**
 * Peak-to-trough undulation of the top surface, metres.
 *
 * The deck has to have relief or the flight path is a plane skimming a plane.
 * At ±40 m against 25 m of clearance the taller swells stand fifteen metres
 * *above* the character and the troughs open out well below — so the cruise
 * alternates between clear air over the mean surface and ploughing through the
 * crest of a swell, which is the whole of "surfing" the deck. It costs one noise
 * lookup per cell.
 */
const DECK_SWELL = 40;

/**
 * Radius range of a top-surface puff, metres.
 *
 * Four of these per 300 m cell is 2.7 times the cell's area, which random
 * placement turns into about 94% cover. Both halves of that are constrained.
 * Fewer, larger puffs would be cheaper to sort and place, but a billboard is a
 * sphere and a deck built out of them cannot be thinner than one diameter — at
 * 200 m the mass would reach from the tops down through the ground. Smaller ones
 * would need proportionally more of them for the same cover, at the same total
 * fill and several times the sort.
 */
const TOP_R_MIN = 115;
const TOP_R_MAX = 165;
/** Radius range of a body puff, metres. */
const BODY_R_MIN = 100;
const BODY_R_MAX = 150;
/** How far below the top surface a body puff's own top sits, metres. */
const BODY_DROP_MIN = 50;
const BODY_DROP_MAX = 130;

/**
 * Hole mask thresholds against the coverage noise.
 *
 * The band between them is the soft shoulder of a hole rather than a hard rim —
 * a cloud does not have an edge you can stand on. Roughly a tenth of cells fall
 * below `HOLE_HI`.
 */
const HOLE_LO = 0.30;
const HOLE_HI = 0.46;

/**
 * Tower thresholds against a *coarse* coverage noise — one lattice step is
 * 5.5 cells, so what falls above these is a clump five or six cells across
 * rather than a cell.
 *
 * Two gates rather than one, and the pair is the whole of the placement. The
 * noise decides where the clumps are; `TOWER_FILL` decides which cells inside
 * one actually build. With only the noise a clump comes out as a solid ridge of
 * cloud two kilometres long, which is a wall rather than weather; with only the
 * hash the towers land evenly at 300 m everywhere and read as a texture on the
 * deck instead of as a feature in it.
 *
 * Measured over a contiguous 60x60 block of cells, the pair builds in 21% of
 * them and a tower's four-neighbourhood is another tower 48% of the time — 2.3x
 * what an independent scatter of the same density would give, which is the
 * number that says these are groups and not a sprinkle. That works out at
 * 2.4 towers per km², or 650 m of mean spacing, with the gaps concentrated
 * between clumps rather than spread evenly.
 *
 * The noise value also survives as the tower's *weight*: cells at the edge of a
 * clump build short, faint knolls and cells at its centre build the full thing,
 * so a group has a shape rather than an outline.
 */
const TOWER_LO = 0.48;
const TOWER_HI = 0.80;
/** Fraction of the cells inside a clump that build at all. */
const TOWER_FILL = 0.62;

/**
 * How far a full-weight tower's crown stands above the sheet it grows out of,
 * metres.
 *
 * Read against the 25 m of clearance the sky tier holds: the ceiling sits at
 * 455 and the sheet's own swell puts the surface anywhere in 390..470. Measured
 * over 16000 cells, and after the weight scaling below has had its say, that
 * puts crowns at a median 584 m with a fifth of them under 524 and a twentieth
 * over 780 — so the typical tower stands 130 m above the cruise and presents
 * about 70 m of half-width at it, and the tall ones are most of a Shard.
 *
 * The bottom of the range earns its place as much as the top. There is no
 * climbing above a tower — the ceiling is absolute — so if every one of them
 * reached the same way past the cruise the transit would be a run of identical
 * gates. The low ones are the only cloud in this mode the player is ever above,
 * and they are what makes the tall ones read as tall.
 */
const TOWER_RISE_MIN = 110;
const TOWER_RISE_MAX = 400;

/**
 * Radius of the tower's lowest bubble and of its crown, metres — *for a 300 m
 * tower*. Every other height scales off these; see `width` in `_buildCell`.
 */
const TOWER_R_BASE = 128;
const TOWER_R_TOP = 74;

/**
 * Horizontal lean of a tower, metres across per metre of rise.
 *
 * Hashed per cell rather than taken from `S.windDirection`, and that is not
 * laziness: a cell is only rebuilt when it rotates through the window, so a lean
 * read from a live setting would apply to whichever cells happened to refresh
 * after the slider moved and leave every other tower leaning the old way. The
 * deck's *drift* can follow the wind because it is one offset applied to
 * everything at once; its shape cannot.
 */
const TOWER_LEAN = 0.16;

/**
 * Camera heights between which the deck fades in, metres.
 *
 * The floor has to clear everything the deck tier can reach, and that is higher
 * than it looks: 20 m of hold over a 25 m dune is 45, and the spring arm at full
 * zoom and full downward pitch sits nine metres above the character on top of
 * that. Eighty is clear of the lot, so no amount of ordinary flying can make a
 * single cloud fragment appear.
 */
const FADE_LO = 80;
const FADE_HI = 240;

/** Peak alpha of a single puff at its core. Density comes from overlap. */
const PUFF_ALPHA = 0.62;

/** Drift speed of the whole deck at `windStrength` 1, m/s. */
const DRIFT = 1.8;

/**
 * How deep inside a puff the camera has to be before that puff is gone.
 *
 * A view-facing quad whose centre is closer than its own radius straddles the
 * near plane, and the clip produces a hard straight edge sweeping across the
 * frame — the classic tell of flying into a billboard. Fading the puff out over
 * the last fraction of its radius removes the geometry before it can do that,
 * and the whiteout it would have given is paid back by the composite's veil,
 * which `immersion` below drives.
 */
const NEAR_FADE = 0.95;

/**
 * Turns summed puff density at the camera into the composite's veil, 0..1.
 *
 * Measured rather than picked: probing the deck on a grid, the summed density
 * runs a median of 0.30 through the thick of the mass, 0.02 a hundred metres
 * under the tops, and exactly 0 anywhere above them. At 2.6 that puts a dive
 * into the body at a full whiteout, leaves the crest of a swell as a faint
 * misting, and keeps the cruise over the mean surface completely clear — which
 * is the shape the mode wants, because a whiteout that is on all the time is
 * just a fog setting.
 */
const IMMERSION_GAIN = 2.6;

const _right = new Vector3();
const _up = new Vector3();

export class CloudDeck {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../render/sky.js").Sky} sky
     */
    constructor(scene, sky) {
        this.scene = scene;
        this.sky = sky;

        /** Puff attributes in *deck space* — world minus the wind drift. */
        this._local = new Float32Array(CAPACITY * 3);
        this._radius = new Float32Array(CAPACITY);
        this._seed = new Float32Array(CAPACITY);
        this._topness = new Float32Array(CAPACITY);
        /** Per-puff coverage weight, 0 in a hole. */
        this._cover = new Float32Array(CAPACITY);

        /** Integer cell index currently occupying each window slot. */
        this._ci = new Int32Array(CELLS * CELLS).fill(0x7fffffff);
        this._cj = new Int32Array(CELLS * CELLS).fill(0x7fffffff);

        /** Depth order and the distances it is sorted on. */
        this._order = new Int32Array(CAPACITY);
        for (let i = 0; i < CAPACITY; i++) this._order[i] = i;
        this._dist = new Float32Array(CAPACITY);
        this._alpha = new Float32Array(CAPACITY);

        /**
         * Accumulated wind offset, metres. Left to grow rather than folded back:
         * folding by a whole cell would have to shift every cell index to
         * compensate, and shifting the index changes the hash, so the deck would
         * re-dice itself every few minutes. At 1.8 m/s an hour of flying is 6.5
         * km, where a float32 still resolves under a millimetre.
         */
        this._driftX = 0;
        this._driftZ = 0;

        /** 0..1, how much cloud the camera is currently inside. */
        this.immersion = 0;
        /**
         * Radiance the inside of the deck settles at, in the scene's own units.
         * Read by `main.js` and handed to the composite's veil.
         */
        this.veilColor = new Color3(1, 1, 1);
        /** Puffs with a non-zero radius this frame, for the triangle counter. */
        this.liveCount = 0;

        /** Forces full presence through the warm-up frames. See `warmUp`. */
        this._forced = false;
        /** This frame's presence, kept for `densityAt`. */
        this._presence = 0;
        /** True once a fully-zeroed frame has been uploaded; skips idle work. */
        this._idle = false;

        // Rows: 0 = (x, y, z, radius), 1 = (seed, topness, alpha, 0).
        this._texData = new Float32Array(CAPACITY * 2 * 4);
        this.dataTex = RawTexture.CreateRGBATexture(
            this._texData, CAPACITY, 2, scene,
            false, false,
            Constants.TEXTURE_NEAREST_SAMPLINGMODE,
            Constants.TEXTURETYPE_FLOAT
        );
        this.dataTex.wrapU = Constants.TEXTURE_CLAMP_ADDRESSMODE;
        this.dataTex.wrapV = Constants.TEXTURE_CLAMP_ADDRESSMODE;

        this.mesh = buildQuadMesh(scene);
        this.material = this._makeMaterial();
        this.mesh.material = this.material;
        this.mesh.renderingGroupId = 2;
        // Ahead of everything else in the transparent pass. The deck is the
        // backdrop the character's own airflow is seen against, and it is
        // kilometres behind it; the water body's 0 is the next index up.
        this.mesh.alphaIndex = -1;

        this._camPos = new Vector3();
    }

    _makeMaterial() {
        const mat = new ShaderMaterial(
            "cloud", this.scene, { vertex: "cloud", fragment: "cloud" },
            {
                attributes: ["position"],
                uniforms: [
                    "viewProjection", "cameraPos", "camRight", "camUp",
                    "sunDir", "sunRadiance", "shR", "ambientIntensity",
                    "groundBounce",
                ],
                samplers: ["cloudTex", "skyLUT"],
                shaderLanguage: ShaderLanguage.WGSL,
                needAlphaBlending: true,
            }
        );
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.alphaMode = Constants.ALPHA_COMBINE;
        mat.needAlphaBlending = () => true;
        mat.setTexture("cloudTex", this.dataTex);
        mat.setTexture("skyLUT", this.sky.lut);
        return mat;
    }

    /**
     * Rebuild whichever cells have rotated through the window, then place, fade
     * and sort the whole pool.
     *
     * @param {number} dt
     * @param {Vector3} cameraPos
     */
    update(dt, cameraPos) {
        this._camPos.copyFrom(cameraPos);

        const density = S.cloudDeck;
        const presence = this._forced
            ? 1
            : density * smoothstep(FADE_LO, FADE_HI, cameraPos.y);
        this._presence = presence;

        if (presence <= 0.001) {
            this.immersion = 0;
            this.liveCount = 0;
            // One zeroed upload, then nothing at all. The deck is absent for the
            // whole of the ground game and this is the path that runs for it.
            if (this._idle) return;
            this._texData.fill(0);
            this.dataTex.update(this._texData);
            this._idle = true;
            return;
        }
        this._idle = false;

        const a = (S.windDirection * Math.PI) / 180;
        this._driftX += Math.sin(a) * DRIFT * S.windStrength * dt;
        this._driftZ += Math.cos(a) * DRIFT * S.windStrength * dt;

        this._refreshCells(cameraPos);
        this._place(cameraPos, presence);
        this._sortAndUpload();
        this._pushUniforms();
        this._solveVeilColor();
    }

    /**
     * The colour of being inside the deck.
     *
     * Deep inside a cloud there is no direction left — the light has been
     * scattered so many times that it arrives equally from everywhere, which is
     * exactly why a whiteout is featureless. So this is the fragment shader's
     * terms with every directional factor collapsed out: the sun heavily
     * attenuated by the depth it has come through, the sky's mean radiance, and
     * the snow bounce coming back up from underneath.
     *
     * The coefficients are the one part that is taste rather than derivation,
     * and they are set to land the interior a little under sunlit snow — which
     * the exposure is tuned against at about 12 in linear. Brighter and the veil
     * clips to flat white before the tone curve's shoulder can do anything with
     * it; much darker and flying into a cloud reads as flying into fog.
     */
    _solveVeilColor() {
        const sky = this.sky;
        const sun = sky.sunRadiance;
        const bounce = sky.groundBounce;
        // Band 0 of the SH is the sky's mean radiance over the whole sphere.
        const Y00 = 0.282095;
        const sh = sky.sh;
        const amb = S.ambientIntensity;

        this.veilColor.set(
            sun.r * 0.34 + sh[0] * Y00 * 1.7 * amb + bounce.r * 0.8,
            sun.g * 0.34 + sh[1] * Y00 * 1.7 * amb + bounce.g * 0.8,
            sun.b * 0.34 + sh[2] * Y00 * 1.7 * amb + bounce.b * 0.8
        );
    }

    /**
     * Regenerate any window slot whose integer cell index has changed.
     *
     * The slot a cell lands in is its index modulo the window, which is what
     * makes this toroidal: the window never moves in memory and nothing is ever
     * copied, only overwritten.
     */
    _refreshCells(cameraPos) {
        // The player in deck space — the frame the hash is evaluated in.
        const px = cameraPos.x - this._driftX;
        const pz = cameraPos.z - this._driftZ;
        const baseI = Math.round(px / CELL);
        const baseJ = Math.round(pz / CELL);

        for (let dj = -HALF_CELLS; dj <= HALF_CELLS; dj++) {
            const cj = baseJ + dj;
            for (let di = -HALF_CELLS; di <= HALF_CELLS; di++) {
                const ci = baseI + di;
                const slot = wrapMod(ci, CELLS) * CELLS + wrapMod(cj, CELLS);
                if (this._ci[slot] === ci && this._cj[slot] === cj) continue;
                this._ci[slot] = ci;
                this._cj[slot] = cj;
                this._buildCell(slot, ci, cj);
            }
        }
    }

    /** Hash one cell's nine puffs into deck space. */
    _buildCell(slot, ci, cj) {
        // The top surface, and the holes in it. Both are smooth noise on the
        // cell lattice rather than per-cell hashes: a swell that changes by a
        // random amount from one cell to the next is not a swell, and a hole one
        // cell across is not a hole.
        const swell = vnoise(ci / 3.4, cj / 3.4, 7) - 0.5;
        const surfaceY = DECK_TOP + swell * 2 * DECK_SWELL;
        const cover = smoothstep(HOLE_LO, HOLE_HI, vnoise(ci / 2.2, cj / 2.2, 11));

        // Does this cell build a tower, and how much of one. See `TOWER_LO` for
        // why it takes two gates. Multiplied by `cover` last so that a tower
        // never stands in a hole — the hole is a shaft the player can dive down,
        // and putting a two-hundred-metre column of cloud in the mouth of it
        // closes the only way through the deck there is.
        const towerW = smoothstep(TOWER_LO, TOWER_HI, vnoise(ci / 5.5, cj / 5.5, 101));
        const grow = hash3i(ci, cj, 103) < TOWER_FILL ? towerW * cover : 0;

        // The column's own centre, lean and height, shared by all three of its
        // puffs. They are one object, so they are placed from one point rather
        // than scattered across the cell the way the sheet's are — jittering
        // them independently gives three separate blobs at a common altitude.
        const tcx = ci * CELL + (hash3i(ci, cj, 107) - 0.5) * CELL * 0.5;
        const tcz = cj * CELL + (hash3i(ci, cj, 109) - 0.5) * CELL * 0.5;
        const la = hash3i(ci, cj, 113) * 6.28318530718;
        const leanX = Math.cos(la) * TOWER_LEAN;
        const leanZ = Math.sin(la) * TOWER_LEAN;
        // Weight drives height as hard as it drives opacity, and most of the
        // useful spread in the tower field comes from this line rather than from
        // the range above. A clump edge builds a low knoll of the same stuff; a
        // clump centre builds the full thing. Scaling opacity alone instead
        // gives every tower the same silhouette rendered at a different density,
        // which reads as fog patches rather than as a cloud field with a shape.
        const rise = (TOWER_RISE_MIN + hash3i(ci, cj, 127) * (TOWER_RISE_MAX - TOWER_RISE_MIN))
            * (0.30 + 0.70 * grow);
        // A convective tower is about as wide as it is tall, so the radii below
        // are scaled by the height rather than hashed independently of it —
        // `TOWER_R_BASE` and `TOWER_R_TOP` are the widths of a 300 m one, and
        // this is what every other height is measured against.
        //
        // Without it a short tower is a 128 m bubble sitting half out of the
        // sheet: wider than it is tall, standing at exactly the altitude the
        // cruise runs at, and present in *every* tower cell however little that
        // cell was asked to build. This is the line that makes a low one low.
        //
        // Capped a little above 1 rather than at it, so the tallest towers do
        // not all resolve to the same width and lose the one cue that says which
        // of two overlapping ones is nearer.
        const width = Math.min(1.15, rise / 300);

        const ox = ci * CELL;
        const oz = cj * CELL;

        for (let k = 0; k < PER_CELL; k++) {
            const p = slot * PER_CELL + k;
            const o = p * 3;

            const h1 = hash3i(ci, cj, k * 5 + 1);
            const h2 = hash3i(ci, cj, k * 5 + 2);
            const h3 = hash3i(ci, cj, k * 5 + 3);
            const h4 = hash3i(ci, cj, k * 5 + 4);

            if (k >= TOWER_K0) {
                // ---- tower ---------------------------------------------------
                // A stack of bubbles narrowing with height. Equal radii give a
                // chimney, which is the one shape a convective cloud never has.
                const t = (k - TOWER_K0) / (TOWER_PER_CELL - 1);
                const r = (TOWER_R_BASE + (TOWER_R_TOP - TOWER_R_BASE) * t)
                    * width * (0.84 + h4 * 0.30);
                // Base bubble centred *on* the sheet, so half of it is buried
                // and the column grows out of the deck rather than resting on
                // it; crown placed by its own top, for the same reason the
                // surface layer is. Both fall out of one lerp, and what makes it
                // one is that `rise` then means the height of the cloud rather
                // than the height of a centre that happens to have a radius
                // above it: at t = 1 the top lands on `surfaceY + rise` whatever
                // the crown's radius turned out to be.
                this._local[o + 1] = surfaceY + (rise - r) * t;
                this._local[o] = tcx + leanX * rise * t + (h1 - 0.5) * r * 0.30;
                this._local[o + 2] = tcz + leanZ * rise * t + (h2 - 0.5) * r * 0.30;
                this._radius[p] = r;
                // Lit as a top rather than as a base, increasingly so with
                // height: a tower is struck on its flank by a 13-degree sun and
                // has very little sky above it that is not more of itself.
                this._topness[p] = 0.55 + 0.45 * t;
                this._seed[p] = hash3i(ci, cj, k * 5 + 5);
                this._cover[p] = grow;
                continue;
            }

            // Jittered across most of the cell. Anything tighter and the deck
            // shows the lattice it was built on.
            this._local[o] = ox + (h1 - 0.5) * CELL * 0.9;
            this._local[o + 2] = oz + (h2 - 0.5) * CELL * 0.9;

            if (k >= TOP_PER_CELL) {
                const r = BODY_R_MIN + h4 * (BODY_R_MAX - BODY_R_MIN);
                const drop = BODY_DROP_MIN + h3 * (BODY_DROP_MAX - BODY_DROP_MIN);
                // Hung by its own top, then floored by its own bottom. See
                // `DECK_BASE` — this is the line that gives the deck a base.
                this._local[o + 1] = Math.max(DECK_BASE + r, surfaceY - drop - r);
                this._radius[p] = r;
                this._topness[p] = 0;
            } else {
                // Placed by its *top*, not by its centre, so every puff in the
                // surface layer reaches exactly the swell height whatever its
                // radius. Centring them instead makes the small ones sit in pits
                // and the large ones stand proud, and the surface stops being one.
                const r = TOP_R_MIN + h4 * (TOP_R_MAX - TOP_R_MIN);
                // A little scatter on top of that, so the skin is lumpy rather
                // than a sheet ruled at one height.
                this._local[o + 1] = surfaceY - r + (h3 - 0.5) * 26;
                this._radius[p] = r;
                this._topness[p] = 1;
            }

            this._seed[p] = hash3i(ci, cj, k * 5 + 5);
            this._cover[p] = cover;
        }
    }

    /**
     * World-place every puff, work out its alpha, and measure how much cloud the
     * camera is standing in.
     */
    _place(cameraPos, presence) {
        const cx = cameraPos.x;
        const cy = cameraPos.y;
        const cz = cameraPos.z;
        const dx0 = this._driftX;
        const dz0 = this._driftZ;

        let inside = 0;
        let live = 0;

        for (let p = 0; p < CAPACITY; p++) {
            const o = p * 3;
            const wx = this._local[o] + dx0;
            const wy = this._local[o + 1];
            const wz = this._local[o + 2] + dz0;

            const ex = wx - cx;
            const ey = wy - cy;
            const ez = wz - cz;
            const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
            this._dist[p] = d;

            const r = this._radius[p];

            // The window is a disc. Cells outside it are still generated — they
            // cost a hash apiece and the alternative is a second loop bound —
            // but they draw nothing, and the ones just inside the rim fade out
            // so the boundary is never a visible arc.
            const horiz = Math.hypot(ex, ez);
            const edge = smoothstep(WINDOW_R, WINDOW_R * 0.86, horiz);

            // Fade a puff out as the camera enters it, before the quad can
            // straddle the near plane. See `NEAR_FADE`.
            const near = clamp01(d / (r * NEAR_FADE));

            // How much of this puff the camera is standing in. Deliberately a
            // *different* curve from the fade above, because it answers a
            // different question: the fade is geometry, and this is density. It
            // is the fragment shader's own profile — `1 - r²`, the parabola a
            // billboarded sphere's optical depth follows — so what the veil
            // reports and what the deck draws are the same falloff, and grazing
            // the crest of a swell mists the frame by the same fraction that the
            // crest is drawn at.
            //
            // Weighted by `cover`, which it was not originally. Radius and cover
            // are independent — a puff in a hole keeps its full radius and is
            // switched off by its alpha — so an unweighted sum whites the frame
            // out for the whole of a dive down a hole, which is the one manoeuvre
            // where there is visibly nothing there. Towers made that miss
            // constant rather than occasional: seven cells in eight build no
            // tower, and their three slots are still placed and still carry a
            // hundred-odd metres of radius each — five hundred puffs' worth of
            // density that nothing in the frame is drawing.
            const q = d / r;
            inside += Math.max(0, 1 - q * q) * this._cover[p];

            const alpha = presence * this._cover[p] * edge * near * PUFF_ALPHA;
            this._alpha[p] = alpha;
            if (alpha > 0.002) live++;
        }

        this.liveCount = live;
        // Each puff the camera is inside contributes a share rather than a
        // maximum. Two overlapping towers *are* thicker than one, and the whole
        // point of the veil is that it deepens as you go further in.
        this.immersion = clamp01(inside * presence * IMMERSION_GAIN);
    }

    /**
     * Summed puff density at an arbitrary world point.
     *
     * The same `1 - q²` profile the veil and the fragment shader use, so a
     * caller asking "how much cloud is here" gets the number the deck is
     * actually drawing rather than a second model of itself. Weighted by cover
     * and by presence for the same reasons `_place` is.
     *
     * `reach` inflates every puff's radius, and it is how a caller asks about
     * being *near* cloud rather than in it. The profile falls to exactly zero at
     * the silhouette, so an un-inflated probe reports nothing at all everywhere
     * the deck is plainly there and not touching you — which is most of a cruise.
     * At 1.3 a 100 m puff is felt about 30 m outside its own edge.
     *
     * One pass over the pool, no square roots: fifteen hundred iterations of a
     * subtract and three multiplies, against the five thousand the spray steps
     * every frame. Callers may treat it as free and probe more than once.
     *
     * @param {number} x @param {number} y @param {number} z
     * @param {number} [reach] radius multiplier, default 1
     * @returns {number} 0 in clear air, ~1 per puff whose centre you are at
     */
    densityAt(x, y, z, reach) {
        if (this._idle || this._presence <= 0) return 0;
        const k = reach === undefined ? 1 : reach;
        const dx0 = this._driftX;
        const dz0 = this._driftZ;
        let sum = 0;

        for (let p = 0; p < CAPACITY; p++) {
            const c = this._cover[p];
            if (c <= 0.004) continue;
            const r = this._radius[p] * k;
            const o = p * 3;
            const dx = this._local[o] + dx0 - x;
            const dy = this._local[o + 1] - y;
            const dz = this._local[o + 2] + dz0 - z;
            const d2 = dx * dx + dy * dy + dz * dz;
            const r2 = r * r;
            if (d2 >= r2) continue;
            sum += (1 - d2 / r2) * c;
        }

        return sum * this._presence;
    }

    /** Sort back-to-front and write the texture rows in that order. */
    _sortAndUpload() {
        const dist = this._dist;
        const order = this._order;
        // Sorted in place, carrying last frame's order in rather than resetting
        // to identity: the deck moves a few metres a frame, so the array arrives
        // very nearly sorted already and the comparison count collapses.
        order.sort((a, b) => dist[b] - dist[a]);

        const d = this._texData;
        const dx0 = this._driftX;
        const dz0 = this._driftZ;

        for (let s = 0; s < CAPACITY; s++) {
            const p = order[s];
            const o = p * 3;
            const t0 = s * 4;
            const t1 = (CAPACITY + s) * 4;

            const alpha = this._alpha[p];
            d[t0] = this._local[o] + dx0;
            d[t0 + 1] = this._local[o + 1];
            d[t0 + 2] = this._local[o + 2] + dz0;
            // Zero radius, not zero alpha: an invisible quad with area still
            // costs its fill. See the note in the vertex shader.
            d[t0 + 3] = alpha > 0.002 ? this._radius[p] : 0;
            d[t1] = this._seed[p];
            d[t1 + 1] = this._topness[p];
            d[t1 + 2] = alpha;
            d[t1 + 3] = 0;
        }

        this.dataTex.update(d);
    }

    _pushUniforms() {
        const m = this.material;
        const sky = this.sky;
        const cam = this.scene.activeCamera;

        const v = cam.getViewMatrix();
        _right.set(v.m[0], v.m[4], v.m[8]);
        _up.set(v.m[1], v.m[5], v.m[9]);

        m.setVector3("cameraPos", this._camPos);
        m.setVector3("camRight", _right);
        m.setVector3("camUp", _up);
        m.setVector3("sunDir", sky.sunDir);
        m.setColor3("sunRadiance", sky.sunRadiance);
        m.setArray4("shR", sky.sh);
        m.setFloat("ambientIntensity", S.ambientIntensity);
        m.setColor3("groundBounce", sky.groundBounce);
    }

    /**
     * Compile, and lay a deck that stays standing.
     *
     * The pipeline is keyed on blend, depth and cull state and is only built when
     * the mesh is actually drawn, so `isReady()` alone covers the shader module
     * and not the pipeline — this has to leave real geometry up through the
     * warm-up frames in `main.js` and be cleared afterwards, exactly as the water
     * body and the arcs do. Forcing presence rather than moving the camera to
     * 430 m is the cheap way to get there.
     */
    async warmUp(cameraPos) {
        this._forced = true;
        this.update(0, cameraPos);
        await whenReady(this.material, "cloud material", [this.mesh, false]);
    }

    /** Release the warm-up deck. Called after the warm-up frames have rendered. */
    finishWarmUp() {
        this._forced = false;
    }

    dispose() {
        this.mesh.dispose();
        this.material.dispose();
        this.dataTex.dispose();
    }
}

// ------------------------------------------------------------------ helpers

/**
 * A static grid of quads. `position` is `(puffIndex, cornerX, cornerY)` and
 * carries no geometry — the vertex shader places every corner.
 */
function buildQuadMesh(scene) {
    const pos = new Float32Array(CAPACITY * 4 * 3);
    const idx = new Uint32Array(CAPACITY * 6);
    const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

    for (let i = 0; i < CAPACITY; i++) {
        for (let c = 0; c < 4; c++) {
            const o = (i * 4 + c) * 3;
            pos[o] = i;
            pos[o + 1] = CORNERS[c * 2];
            pos[o + 2] = CORNERS[c * 2 + 1];
        }
        const b = i * 4;
        const q = i * 6;
        idx[q] = b; idx[q + 1] = b + 1; idx[q + 2] = b + 2;
        idx[q + 3] = b; idx[q + 4] = b + 2; idx[q + 5] = b + 3;
    }

    const mesh = new Mesh("cloudDeck", scene);
    const vd = new VertexData();
    vd.positions = pos;
    vd.indices = idx;
    vd.applyToMesh(mesh, false);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { triangles: CAPACITY * 2, vertices: CAPACITY * 4 };
    return mesh;
}

/** Positive modulo — `%` is not one for negative cell indices. */
function wrapMod(a, n) {
    return ((a % n) + n) % n;
}

/** 32-bit integer hash of a cell index and a salt, returned as 0..1. */
function hash3i(i, j, salt) {
    let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(salt, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

/** Smooth value noise on the cell lattice, 0..1. */
function vnoise(x, y, salt) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);

    const a = hash3i(ix, iy, salt);
    const b = hash3i(ix + 1, iy, salt);
    const c = hash3i(ix, iy + 1, salt);
    const e = hash3i(ix + 1, iy + 1, salt);

    const top = a + (b - a) * ux;
    const bot = c + (e - c) * ux;
    return top + (bot - top) * uy;
}

function smoothstep(a, b, x) {
    const t = clamp01((x - a) / (b - a));
    return t * t * (3 - 2 * t);
}

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

export { CAPACITY as CLOUD_CAPACITY };
