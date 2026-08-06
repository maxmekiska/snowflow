/**
 * The spell system — dispatch, shared context, and the casting pose.
 *
 * Owns the six spells, the water body they draw into, the ice they leave, and
 * the light pool every material reads. One `update()` per frame, in this order,
 * and the order is load-bearing:
 *
 *   1. clear the light pool
 *   2. dispatch input
 *   3. update every spell — they declare lights and write brushes here
 *   4. upload the water and the crystals
 *
 * The lights have to be cleared before the spells run and uploaded after, or a
 * spell that ended last frame keeps lighting the snow. The brushes have to be
 * written before `terrain.update()` runs the simulation pass, which is why this
 * is called from `main` alongside the character contact rather than after the
 * terrain.
 *
 * Allocation per frame: none.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { input } from "../core/input.js";
import { S } from "../core/settings.js";
import { expDamp } from "../core/camera.js";
import { SpellLights } from "./spellLights.js";
import { WaterBody } from "./waterBody.js";
import { CrystalField } from "./crystals.js";
import { MagicCircle } from "./magicCircle.js";
import { ArcField } from "./arcs.js";
import { Sweep } from "./sweep.js";
import { Ribbon } from "./ribbon.js";
import { Bloom } from "./bloom.js";
import { Crystallize } from "./crystallize.js";
import { Vortex } from "./vortex.js";
import { Comet } from "./comet.js";
import { aimPoint, clamp01 } from "./bending.js";

/**
 * @typedef {{
 *   controller: import("../character/controller.js").CharacterController,
 *   figure: import("../character/figure.js").Figure|null,
 *   rig: import("../core/camera.js").CameraRig,
 *   terrain: import("../terrain/terrain.js").Terrain,
 *   deform: import("../terrain/deformation.js").DeformationField,
 *   spray: import("../vfx/particles.js").SprayField,
 *   water: WaterBody,
 *   crystals: CrystalField,
 *   circle: MagicCircle,
 *   arcs: ArcField,
 *   lights: SpellLights,
 *   time: number,
 *   sprayScale: number,
 *   handPosition: (which:number, out:Float32Array, off:number) => void,
 * }} SpellContext
 */

const _aim = new Float32Array(3);
const _hand = new Float32Array(3);

export class SpellSystem {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../character/controller.js").CharacterController} controller
     * @param {import("../character/figure.js").Figure|null} figure
     * @param {import("../core/camera.js").CameraRig} rig
     * @param {import("../vfx/particles.js").SprayField} spray
     */
    constructor(scene, sky, shadows, terrain, controller, figure, rig, spray) {
        this.lights = new SpellLights();
        this.water = new WaterBody(scene, sky, shadows, this.lights);
        this.crystals = new CrystalField(scene, sky, shadows, this.lights);
        // The casting sigil. Owned here rather than by the Comet so that its
        // pipeline is warmed with everything else — a mesh that first draws on
        // the frame a spell is cast is a compile in the middle of that frame.
        this.circle = new MagicCircle(scene, sky);
        // Lightning. Owned here rather than by the Comet for the same reason the
        // sigil is: it is a mesh, so it has to be warmed with everything else.
        this.arcs = new ArcField(scene, sky);

        /** @type {SpellContext} */
        this.ctx = {
            controller,
            figure: figure || null,
            rig,
            terrain,
            deform: terrain.deform,
            spray,
            water: this.water,
            crystals: this.crystals,
            circle: this.circle,
            arcs: this.arcs,
            lights: this.lights,
            time: 0,
            sprayScale: 1,
            handPosition: (which, out, off) => this._handPosition(which, out, off),
        };

        this.sweep = new Sweep(this.ctx);
        this.ribbon = new Ribbon(this.ctx);
        this.bloom = new Bloom(this.ctx);
        this.crystallize = new Crystallize(this.ctx);
        this.vortex = new Vortex(this.ctx);
        this.comet = new Comet(this.ctx);

        this.spells = [
            this.sweep, this.ribbon, this.bloom,
            this.crystallize, this.vortex, this.comet,
        ];

        /**
         * Materials outside the spell system that shade with the spell lights.
         *
         * They are pushed rather than pulled because the pool is only complete
         * once every spell has declared, and that is later in the frame than any
         * of these systems runs. Registering them here keeps "who is lit by a
         * spell" a single list in one file instead of a `lights.apply()` call
         * scattered across five unrelated `_pushUniforms`.
         *
         * @type {import("@babylonjs/core/Materials/shaderMaterial").ShaderMaterial[]}
         */
        this._consumers = [];

        /**
         * Systems outside the spell system that *emit* into the light pool,
         * rather than reading from it.
         *
         * The mirror of `_consumers` above, and it exists for the same reason:
         * the pool is cleared at the top of this `update` and uploaded at the
         * bottom, so anything wanting a slot has to declare inside that window
         * — and `vfx/skyBolt.js` runs before this system does, because its
         * arcs have to be spawned before `arcs.update()` uploads them. It
         * resolves its light during its own update and hands it over here.
         *
         * @type {Array<(lights: SpellLights) => void>}
         */
        this._lightSources = [];

        /** Aim direction, refreshed each frame from the rig. */
        this.aim = new Vector3(0, 0, 1);
        /** 0..1 eased: how far into a casting stance the figure should be. */
        this.castBlend = 0;
        /** 0..1 eased: which stance that is — 0 bending throw, 1 channelling. */
        this.channelBlend = 0;
        /**
         * The stance the blend above is heading for, latched.
         *
         * Asserted by a spell when it starts and left alone otherwise, rather
         * than sampled from what is currently active. A spell ending is not a
         * request for the other stance — it is a request for no stance at all,
         * which `castBlend` already describes.
         */
        this._stance = 0;
        this._lastCast = -99;
        this._time = 0;
        /** Console override for the Ribbon hold. */
        this.debugRibbon = false;
        /** Console override for the Comet charge. */
        this.debugComet = false;
    }

    /**
     * Declare a material that reads `snowSpellLights`.
     * @param {...import("@babylonjs/core/Materials/shaderMaterial").ShaderMaterial} mats
     */
    addConsumers(...mats) {
        for (let i = 0; i < mats.length; i++) {
            if (mats[i]) this._consumers.push(mats[i]);
        }
    }

    /**
     * Declare a non-spell system that contributes a light each frame.
     * @param {...(lights: SpellLights) => void} fns
     */
    addLightSource(...fns) {
        for (let i = 0; i < fns.length; i++) {
            if (fns[i]) this._lightSources.push(fns[i]);
        }
    }

    /**
     * Where a hand is, in world space.
     *
     * Falls back to a point in front of the chest when the figure is hidden, so
     * a spell cast with the character switched off still comes from somewhere
     * sensible rather than from the origin.
     */
    _handPosition(which, out, off) {
        const fig = this.ctx.figure;
        if (fig && S.showCharacter !== false) {
            fig.handPosition(which, out, off);
            return;
        }
        const ch = this.ctx.controller;
        const fx = Math.sin(ch.facing);
        const fz = Math.cos(ch.facing);
        const side = which === 0 ? -0.28 : 0.28;
        out[off] = ch.position.x + fx * 0.35 + Math.cos(ch.facing) * side;
        out[off + 1] = ch.position.y + 1.25;
        out[off + 2] = ch.position.z + fz * 0.35 - Math.sin(ch.facing) * side;
    }

    /**
     * @param {number} dt
     * @param {Vector3} cameraPos
     */
    update(dt, cameraPos) {
        const ctx = this.ctx;
        this._time += dt;
        ctx.time = this._time;
        ctx.sprayScale = S.spellSpray;
        this.lights.scale = S.spellLight;

        // Aim comes off the rig rather than the character: the player points
        // with the camera, and the figure turns to follow.
        this.aim.copyFrom(this.ctx.rig.forward);

        this.lights.begin();

        if (S.showSpells !== false) this._dispatch();
        else this._cancelAll();

        for (let i = 0; i < this.spells.length; i++) this.spells[i].update(dt);

        // After the spells and before the upload. Deliberately not gated on
        // `showSpells` — these are not spells, and the sky strike is a movement
        // mode rather than something the player cast.
        for (let i = 0; i < this._lightSources.length; i++) {
            this._lightSources[i](this.lights);
        }

        // The casting stance eases in while anything is up and out again after.
        // Nothing about it is a switch.
        //
        // The Comet's wind-up is longer than the stock post-cast window, so it
        // holds the stance explicitly — otherwise the figure would come out of
        // the brace before the lance had left the hands.
        const casting =
            this.ribbon.active || this.comet.charging
            || this._time - this._lastCast < 0.55 ? 1 : 0;
        // Sampled before the blend moves, so a stance asserted on the same frame
        // a cast begins is in place before the arms have left the walk pose.
        const posed = this.castBlend >= 0.01;
        this.castBlend = expDamp(this.castBlend, casting, casting ? 7.0 : 3.2, dt);

        // Which stance. The Comet gathers with both hands; every other spell
        // throws with one.
        //
        // The target is latched, and that is the whole of it: when the Comet is
        // released the stance stays where it is and only `castBlend` goes out,
        // so the arms leave the gather the same way they entered it. Driving
        // this from `comet.charging` instead looks right on the way in and wrong
        // on the way out — the hold sets `_lastCast`, so the cast blend is still
        // at 1 for 0.55 s after release, and the stance falling away underneath
        // it swings the arms out through the one-handed throw before they drop.
        //
        // Snapped rather than eased while nothing is posed, because there is no
        // pose to cross *from* — easing from a stance the arms are not in is
        // what puts a half-and-half shape on them as they come up into the next
        // spell.
        this.channelBlend = posed
            ? expDamp(this.channelBlend, this._stance, 7.0, dt)
            : this._stance;

        const ch = this.ctx.controller;
        ch.cast = this.castBlend;
        ch.channel = this.channelBlend;
        ch.castAimX = this.aim.x;
        ch.castAimY = this.aim.y;
        ch.castAimZ = this.aim.z;

        // Everything outside the spell system that answers a spell light, after
        // the last declaration and before anything renders.
        for (let i = 0; i < this._consumers.length; i++) {
            this.lights.apply(this._consumers[i]);
        }

        this.water.update(dt, cameraPos);
        this.crystals.update(dt, cameraPos);
        // Last, and after the spell updates above: a bolt struck this frame has
        // to be aged and uploaded in the same frame it was struck, or the first
        // frame of every discharge is a hole.
        this.arcs.update(dt);
    }

    _dispatch() {
        // Ribbon and Comet are holds, so they are polled rather than
        // edge-triggered. `debugRibbon`/`debugComet` let the console hold them
        // without synthesising a key event — the poll would otherwise release
        // them on the very next frame.
        this.holdRibbon(input.spellHeld2 || this.debugRibbon);

        const key = input.spellPressed;

        // `spellPressed` is or'd in so that a tap short enough to begin and end
        // inside one frame still starts a charge; the next frame's release then
        // throws it at minimum power. Without it the shortest possible press of
        // `6` would do nothing at all, which reads as a broken key.
        this.holdComet(input.spellHeld6 || this.debugComet || key === 6);

        if (key && key !== 2 && key !== 6) this.cast(key);
    }

    /**
     * Fire one spell, by key.
     *
     * Separated from the input poll so the console or a future rebind can cast
     * without synthesising a key event. `SNOWFLOW.spells` is the console handle.
     *
     * @param {number} key 1..6
     */
    cast(key) {
        const ctx = this.ctx;
        const rig = ctx.rig;

        if (key === 2) {
            this.holdRibbon(true);
            return;
        }

        this._lastCast = this._time;
        // The bending stance, claimed here for every one-shot. Key 6 falls
        // through to `holdComet` below and claims the other one back.
        this._stance = 0;

        if (key === 1) {
            // Flat aim: the crescent runs along the ground, so a camera pointed
            // at the sky must not launch it into the air.
            const fl = Math.hypot(this.aim.x, this.aim.z) || 1;
            this.sweep.trigger(this.aim.x / fl, this.aim.z / fl);
            rig.addTrauma(0.12);
            return;
        }

        if (key === 3 || key === 4) {
            // Both are placed where the player is looking. The ray starts at the
            // eye, so what the spell hits is exactly what is under the centre of
            // the screen — which is the only targeting rule that needs no
            // explanation and no reticle.
            //
            // Capped at 22 m of ray, not the 40 the terrain could answer for.
            // Looking out across a dune field the first surface the ray meets is
            // often forty metres away on the next ridge, and a Bloom that goes
            // off over there is an effect the player has to squint at. Beyond the
            // cap the spell lands at the cap distance instead, which is always
            // in front of them and always at a size worth looking at.
            const eye = rig.camera.position;
            aimPoint(
                _aim, ctx.terrain,
                eye.x, eye.y, eye.z,
                this.aim.x, this.aim.y, this.aim.z,
                22, 13
            );
            if (key === 3) this.bloom.trigger(_aim[0], _aim[1], _aim[2]);
            else this.crystallize.trigger(_aim[0], _aim[1], _aim[2]);
            return;
        }

        if (key === 5) {
            this.vortex.trigger();
            rig.addTrauma(0.10);
            return;
        }

        if (key === 6) {
            // Comet is a hold and is driven from `holdComet`. Reaching here at
            // all means something called `cast(6)` directly — the console, or a
            // future rebind — so it starts the charge and leaves the caller to
            // let go.
            this.holdComet(true);
        }
    }

    /**
     * Poll the Comet's charge.
     *
     * Unlike the Ribbon this is called every frame whether held or not, because
     * the spell needs the live aim while it charges: the sigil stands facing
     * wherever the player is looking, and the shot is targeted at release rather
     * than at the press.
     *
     * @param {boolean} held
     */
    holdComet(held) {
        this.comet.hold(held, this.aim.x, this.aim.y, this.aim.z);
        if (held) {
            this._lastCast = this._time;
            this._stance = 1;
        }
    }

    /** @param {boolean} held */
    holdRibbon(held) {
        if (held) {
            if (!this.ribbon.held) {
                this.ribbon.trigger();
                this._lastCast = this._time;
                this._stance = 0;
            }
        } else if (this.ribbon.held) {
            this.ribbon.release();
        }
    }

    _cancelAll() {
        for (let i = 0; i < this.spells.length; i++) this.spells[i].cancel();
    }

    /** Live spell count, for the overlay. */
    get activeCount() {
        let n = 0;
        for (let i = 0; i < this.spells.length; i++) if (this.spells[i].active) n++;
        return n;
    }

    /**
     * Register the ice formations with the depth prepass.
     *
     * Only the crystals: the water body is translucent and refractive, so a
     * depth for it would tell every screen-space consumer that the snow behind it
     * is not there — which is exactly wrong for a medium you can see through.
     *
     * @param {import("../render/depthPass.js").DepthPass} depth
     */
    registerPrepass(depth) {
        this.crystals.registerPrepass(depth);
    }

    get triangles() {
        return this.water.triangles + this.crystals.triangles
            + this.circle.triangles + this.arcs.triangles;
    }

    /**
     * Compile every spell pipeline behind the loading screen.
     *
     * The first cast of any spell must not hitch, and this is the only thing
     * standing between that and a multi-hundred-millisecond freeze the first
     * time somebody presses 3. Both water profiles and the ice material are
     * exercised with real geometry — a pipeline compiled against an empty draw
     * is a warm-up that quietly covers nothing.
     */
    async warmUp(x, y, z) {
        await this.water.warmUp(x, y, z);
        await this.crystals.warmUp(x, y, z);
        await this.circle.warmUp(x, y, z);
        await this.arcs.warmUp(x, y, z);
    }

    /**
     * Clear the warm-up geometry. Called after `main`'s warm-up frames, not
     * inside `warmUp` — the whole point is that those frames draw it.
     */
    finishWarmUp() {
        this.water.finishWarmUp();
        this.crystals.finishWarmUp();
        this.circle.finishWarmUp();
        this.arcs.finishWarmUp();
    }

    dispose() {
        this.water.dispose();
        this.crystals.dispose();
        this.circle.dispose();
        this.arcs.dispose();
    }
}
