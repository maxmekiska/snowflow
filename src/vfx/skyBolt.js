/**
 * The strike that carries the character between the two flight tiers.
 *
 * Built the way `slipstream.js` and `cloudVortex.js` are and not the way the
 * spells are: it owns **no mesh, no material and no shader**, so there is
 * nothing here for the warm-up to compile. It writes into three things that
 * already exist — the shared spray pool, the shared `ArcField`, and the
 * deformation buffer — and gets their lighting, sorting, pipelines and warm-up
 * for free. Adding a pipeline for this would have meant a fourth alpha-blended
 * pass to sort against the other three, for an effect that is lightning and
 * therefore already exactly what `ArcField` draws.
 *
 * It is a pure reader of `character/controller.js`'s five published strike
 * numbers — `charge`, `bolt`, `boltT`, `boltDir`, `land`, plus the one-frame
 * `landImpact` — and holds no opinion about the phase machine behind them.
 *
 * **Every arc it strikes is world-anchored, and that is the whole trick.** The
 * Comet's bolts are `local`, because a ball of lightning held in a moving hand
 * has to travel with the hand. Here the opposite is true: a strike is a channel
 * in the air that was there for a moment and is not any more, so the character
 * flying out of the top of it at 620 m/s while it hangs where it was struck is
 * the effect rather than a bug in it. It also means this never touches
 * `arcs.setOrigin()`, which the Comet owns and which there is no protocol for
 * sharing.
 *
 * Allocation per frame: none.
 */

import { S } from "../core/settings.js";
import { perpendicularFrame } from "./slipstream.js";

/**
 * Column bolts per metre climbed, and how long one lives.
 *
 * Metered per metre and not per frame, for the reason every pooled system here
 * meters per metre: at 620 m/s a per-frame rate that reads correctly at 60 fps
 * puts four times as many bolts in the air at 240 and empties a 128-slot pool
 * into a single shot. Per metre, the live count is `rate × speed × life` and
 * depends on the frame rate not at all — here about 35 alive, against a pool
 * the Comet can want 80 of.
 *
 * The life is what decides how far the column trails: a bolt struck now is
 * still burning 124 m below the character when it dies, which is what turns a
 * sequence of instants into a channel.
 */
const COLUMN_PER_M = 0.28;
const COLUMN_LIFE = 0.20;
/**
 * How far past the segment travelled each column bolt reaches, metres.
 *
 * The segment itself is only 10 m at 60 fps, and a column built from 10 m
 * bolts laid end to end reads as a dashed line — the taper `ArcField` puts on
 * every bolt pinches each one to nothing at both ends, so the joins are gaps.
 * Overlapping them by this much buries every join inside its neighbours.
 */
const COLUMN_REACH = 26;

/** Arcs wrapping the body, per metre, and their life. */
const WRAP_PER_M = 0.35;
const WRAP_LIFE = 0.08;
/** Radius the wrapping arcs are struck across, metres. */
const WRAP_R = 1.15;

/**
 * Sparks shed along the column, per metre.
 *
 * `kind` 2 — the ember branch of `spray.fragment.wgsl`, which emits rather than
 * reflects. They are the only part of this that survives being looked at from
 * the ground a kilometre away, because they are the only part that is not
 * competing with a sunlit sky for contrast.
 */
const SPARK_PER_M = 1.2;

/**
 * How far up the strike stays tethered to the ground it left from, metres.
 *
 * This is what makes it read as a strike rather than as a character with
 * lightning around them: for the first stretch of the climb there are bolts
 * running all the way back down to the launch point, so the column is
 * *connected* to somewhere. Above this it lets go and only the trailing column
 * is left, which is correct — a real return stroke is finished long before this
 * point.
 *
 * 90 m rather than further because `ARC_POINTS` is 24 whatever the length: at
 * 90 m the segments are already 3.7 m and the kinks that make a bolt read as a
 * discharge are getting coarse. Past about 120 it draws as a bent wire.
 */
const TETHER_REACH = 90;
/** Tether strikes per second while inside that reach. */
const TETHER_RATE = 14;

/** Charge filaments per second at full wind-up, and their life. */
const CHARGE_RATE = 46;
const CHARGE_LIFE = 0.10;
/** Snow drawn up off the ground during the wind-up, grains per second. */
const CHARGE_SPRAY = 70;

/** Grains thrown by the launch and by the landing. */
const LAUNCH_GRAINS = 110;
const LAND_GRAINS = 150;

/**
 * Colour of everything here, linear and unnormalised.
 *
 * The same blue-white the Comet's discharge uses. It is deliberately not tuned
 * separately — two kinds of lightning in one demo that do not match read as one
 * of them being wrong, and there is no in-world reason for them to differ.
 */
const COL_R = 0.55;
const COL_G = 0.82;
const COL_B = 1.0;

// ------------------------------------------------------- module-scope scratch
const _axis = new Float32Array(3);
const _perpA = new Float32Array(3);
const _perpB = new Float32Array(3);

export class SkyBolt {
    /**
     * @param {import("../character/controller.js").CharacterController} controller
     * @param {import("../character/figure.js").Figure|null} figure
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("./particles.js").SprayField} spray
     * @param {import("../spells/arcs.js").ArcField} arcs
     */
    constructor(controller, figure, terrain, spray, arcs) {
        this.controller = controller;
        this.figure = figure;
        this.terrain = terrain;
        this.spray = spray;
        this.arcs = arcs;

        this._owedColumn = 0;
        this._owedWrap = 0;
        this._owedSpark = 0;
        this._owedCharge = 0;
        this._owedChargeSpray = 0;
        this._owedTether = 0;

        this._prevX = controller.position.x;
        this._prevY = controller.position.y;
        this._prevZ = controller.position.z;

        /**
         * Edge detector for the shot leaving the ground.
         *
         * `bolt` is snapped to 1 by the controller's `_fire` and only ever
         * decays from there, so the rising edge is unambiguous and there is no
         * need for the controller to publish a second one-frame flag for it.
         * The landing is different — `land` is held flat at 1 for a fifth of a
         * second, so a threshold on it would fire on whichever frame it
         * happened to be sampled, which is why *that* one is published.
         */
        this._prevBolt = 0;

        /** Where the shot left from. The tether and the crater both need it. */
        this._launchX = 0;
        this._launchY = 0;
        this._launchZ = 0;

        // The light this declares, resolved in `update` and handed over in
        // `declareLight`. Two calls rather than one because the spell light
        // pool is cleared and uploaded inside `SpellSystem.update`, and this
        // system runs before it — see `addLightSource` there.
        this._lightX = 0;
        this._lightY = 0;
        this._lightZ = 0;
        this._lightR = 0;
        this._lightI = 0;
    }

    /** @param {number} dt */
    update(dt) {
        const ch = this.controller;

        // Distance actually travelled, taken from the position delta rather
        // than from a speed, so a clamped frame cannot emit for time the
        // character did not move through. Same reasoning as `slipstream.js`.
        const dx = ch.position.x - this._prevX;
        const dy = ch.position.y - this._prevY;
        const dz = ch.position.z - this._prevZ;
        const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
        this._prevX = ch.position.x;
        this._prevY = ch.position.y;
        this._prevZ = ch.position.z;

        this._lightI = 0;

        const amount = S.skyBolt;
        const idle = ch.charge < 0.001 && ch.bolt < 0.001 && ch.land < 0.001;
        if (idle || amount <= 0 || !this.spray || !this.arcs) {
            // Dropped rather than banked, exactly as the slipstream drops its
            // owed distance when the stream stops: a debt carried across an
            // idle period is spent all at once wherever the character happens
            // to be standing when the next one starts.
            this._owedColumn = 0;
            this._owedWrap = 0;
            this._owedSpark = 0;
            this._owedCharge = 0;
            this._owedChargeSpray = 0;
            this._owedTether = 0;
            this._prevBolt = ch.bolt;
            return;
        }

        if (ch.charge > 0.001) this._charge(dt, amount);

        // The rising edge of the shot. Ordered before `_strike` so the launch
        // crater is written from the ground position the character still has on
        // this frame — the altitude curve moves them on the same frame the
        // phase changes, and one frame at 620 m/s is ten metres of climb.
        if (ch.bolt >= 0.5 && this._prevBolt < 0.5) this._launch();
        this._prevBolt = ch.bolt;

        if (ch.landImpact) this._impact();

        if (ch.bolt > 0.001 && moved > 1e-5) {
            _axis[0] = dx / moved;
            _axis[1] = dy / moved;
            _axis[2] = dz / moved;
            // Crossed against the least-aligned cardinal, never against world
            // up — this axis is *exactly* world up for the whole of a launch,
            // which is the case that makes the obvious construction produce NaN
            // and poison every position built on it. See `perpendicularFrame`.
            perpendicularFrame(_axis, _perpA, _perpB);
            this._strike(dt, moved, amount);
        }

        this._resolveLight();
    }

    /**
     * The wind-up: filaments gathering on the body, snow lifting off the
     * ground, and the first strikes going *down* into it.
     *
     * All of it is metered per second rather than per metre, because the
     * character is standing still — the controller scrubs their velocity across
     * exactly this window. Per-time metering is frame-rate independent for the
     * same reason per-distance is: what the eye counts is `rate × life`, and
     * neither term is a frame.
     */
    _charge(dt, amount) {
        const ch = this.controller;
        const arcs = this.arcs;
        const sp = this.spray;
        // Squared, so the wind-up is quiet for its first half and then arrives.
        // Linear reads as a light being turned up at a constant rate, which is
        // the one thing that makes a fixed-length charge feel like a wait.
        const k = ch.charge * ch.charge;

        const bx = ch.position.x;
        const by = ch.position.y;
        const bz = ch.position.z;

        // ---- filaments crawling the body ---------------------------------
        this._owedCharge += dt * CHARGE_RATE * k * amount;
        let n = this._owedCharge | 0;
        if (n > 0) {
            this._owedCharge -= n;
            if (n > 6) n = 6;
            for (let i = 0; i < n; i++) {
                // Anywhere on a capsule roughly the size of a crouched figure.
                const h0 = Math.random() * 1.5;
                const h1 = h0 + (Math.random() - 0.5) * 0.7;
                const a0 = Math.random() * Math.PI * 2;
                const a1 = a0 + (Math.random() - 0.5) * 2.4;
                const r = 0.30 + Math.random() * 0.22;
                arcs.spawn(
                    false,
                    bx + Math.cos(a0) * r, by + h0, bz + Math.sin(a0) * r,
                    bx + Math.cos(a1) * r, by + h1, bz + Math.sin(a1) * r,
                    0.28, 0.020 + Math.random() * 0.035,
                    CHARGE_LIFE * (0.6 + Math.random() * 0.8),
                    0.9 + 1.4 * k, 0
                );
            }
        }

        // ---- strikes into the snow, in the last third only ----------------
        //
        // Held back rather than scaled from zero. These are the thing that says
        // the ground is about to be involved, and something that has been
        // happening quietly the whole time does not announce anything.
        if (ch.charge > 0.62 && Math.random() < dt * 26 * amount) {
            const a = Math.random() * Math.PI * 2;
            const d = 1.1 + Math.random() * 2.6;
            const gx = bx + Math.cos(a) * d;
            const gz = bz + Math.sin(a) * d;
            const gy = this.terrain.heightAt(gx, gz);
            arcs.spawn(
                false,
                bx, by + 0.7, bz,
                gx, gy, gz,
                d * 0.34, 0.05 + Math.random() * 0.07,
                0.07 + Math.random() * 0.07,
                1.6, 0
            );
            // The mark it leaves, at a fraction of the visual rate. The field
            // integrates and the strikes come thirty a second; written at the
            // depth one strike wants, the wind-up would dig a pit. Same
            // separation the Comet's ground strikes make and for the same
            // reason.
            if (Math.random() < 0.22) {
                this.terrain.deform.brush(
                    gx, gz, 0.34,
                    0.04, 0.02, 0.20, 0.16 * ch.charge,
                    a, 1.0, 1.0
                );
            }
        }

        // ---- snow drawn up off the ground --------------------------------
        //
        // Inward and up, which is the opposite of everything else in this file
        // and is the entire read: a blast throws snow outward, and something
        // gathering pulls it in. It is the same trick the Comet's implosion
        // plays before its detonation.
        this._owedChargeSpray += dt * CHARGE_SPRAY * k * amount;
        let m = this._owedChargeSpray | 0;
        if (m > 0) {
            this._owedChargeSpray -= m;
            if (m > 14) m = 14;
            for (let i = 0; i < m; i++) {
                const a = Math.random() * Math.PI * 2;
                const ca = Math.cos(a);
                const sa = Math.sin(a);
                const d = 1.4 + Math.random() * 3.2;
                const gx = bx + ca * d;
                const gz = bz + sa * d;
                const gy = this.terrain.heightAt(gx, gz);
                // Toward the caster, and rising as it comes.
                const pull = (2.2 + Math.random() * 3.4) * k;
                sp.emit(
                    gx, gy + Math.random() * 0.25, gz,
                    -ca * pull, 1.4 + Math.random() * 2.6, -sa * pull,
                    0.045 + Math.random() * 0.075,
                    0.35 + Math.random() * 0.30,
                    0,
                    // Low drag, so a grain actually completes the journey
                    // inward. At the powder default it stops after 20 cm and
                    // the gather reads as a ring of snow twitching.
                    1.0
                );
            }
        }
    }

    /**
     * The instant the shot leaves: a crater, a ring of thrown snow and a burst
     * of ground strikes.
     */
    _launch() {
        const ch = this.controller;
        const sp = this.spray;
        const arcs = this.arcs;
        const amount = S.skyBolt;

        const bx = ch.position.x;
        const bz = ch.position.z;
        const by = this.terrain.heightAt(bx, bz);
        this._launchX = bx;
        this._launchY = by;
        this._launchZ = bz;

        // Only mark the snow if the strike actually left from it. A shot fired
        // out of a deck-tier hover is twenty metres up and has nothing under it
        // to crater — the brush would land on ground the character is not
        // standing on, which is a scorch mark appearing under an empty patch of
        // snow.
        if (ch.lift < 1.5) {
            this.terrain.deform.brush(
                bx, bz, 1.5,
                0.30, 0.34, 0.55, 0.30,
                Math.random() * Math.PI, 1.1, 1.0
            );
            for (let i = 0; i < 5; i++) {
                const a = (i / 5) * Math.PI * 2 + Math.random() * 1.1;
                const d = 1.9 + Math.random() * 0.9;
                this.terrain.deform.brush(
                    bx + Math.cos(a) * d, bz + Math.sin(a) * d,
                    0.45 + Math.random() * 0.30,
                    0.03, 0.17 + Math.random() * 0.12, 0.12, 0.05,
                    a, 1.4, 1.0
                );
            }
        }

        // Snow blown off the ground, outward and up hard.
        const n = (LAUNCH_GRAINS * amount) | 0;
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const ca = Math.cos(a);
            const sa = Math.sin(a);
            const d = 0.4 + Math.random() * 2.8;
            const gx = bx + ca * d;
            const gz = bz + sa * d;
            const gy = this.terrain.heightAt(gx, gz);
            const out = 5.0 + Math.random() * 11.0;
            const up = 4.5 + Math.random() * 12.0;
            const clod = Math.random() < 0.18;
            sp.emit(
                gx, gy + Math.random() * 0.3, gz,
                ca * out, up, sa * out,
                clod ? 0.07 + Math.random() * 0.09 : 0.05 + Math.random() * 0.11,
                0.6 + Math.random() * 0.7,
                clod ? 1 : 0,
                clod ? 1.1 : 1.5
            );
        }

        // Sparks off the departure, on the ember branch.
        const e = (34 * amount) | 0;
        for (let i = 0; i < e; i++) {
            const a = Math.random() * Math.PI * 2;
            const out = 3.0 + Math.random() * 9.0;
            sp.emit(
                bx, by + 0.25, bz,
                Math.cos(a) * out, 6.0 + Math.random() * 16.0, Math.sin(a) * out,
                0.035 + Math.random() * 0.05,
                0.35 + Math.random() * 0.35,
                2,
                1.3
            );
        }

        // The return stroke: a fan of bolts off the launch point, thrown wide.
        const s = (11 * amount) | 0;
        for (let i = 0; i < s; i++) {
            const a = Math.random() * Math.PI * 2;
            const d = 2.5 + Math.random() * 9.0;
            const gx = bx + Math.cos(a) * d;
            const gz = bz + Math.sin(a) * d;
            arcs.spawn(
                false,
                bx, by + 1.0, bz,
                gx, this.terrain.heightAt(gx, gz) + Math.random() * 1.5, gz,
                d * 0.30, 0.09 + Math.random() * 0.14,
                0.09 + Math.random() * 0.10,
                1.8, 0
            );
        }
    }

    /**
     * The strike in flight: the column, the arcs wrapping the body, the sparks
     * shed off it, and the tether back to the ground for the first stretch.
     */
    _strike(dt, moved, amount) {
        const ch = this.controller;
        const arcs = this.arcs;
        const sp = this.spray;

        // Last frame's position. `_prevX` has already been advanced to this
        // frame's by `update`, so it is walked back along the axis rather than
        // stored twice — everything below places itself at a fraction along the
        // segment between the two.
        const px = this._prevX - _axis[0] * moved;
        const py = this._prevY - _axis[1] * moved;
        const pz = this._prevZ - _axis[2] * moved;

        // ---- the column ---------------------------------------------------
        this._owedColumn += moved * COLUMN_PER_M * amount;
        let n = this._owedColumn | 0;
        if (n > 0) {
            this._owedColumn -= n;
            // Capped and the excess *dropped*, not carried. A cap that banks
            // its overflow keeps firing for seconds after the shot has landed,
            // which is the bug this system's two neighbours both had.
            //
            // Every cap in this file is set above what the *slowest* frame rate
            // asks for rather than below it. The controller clamps its step to
            // 1/30, so the longest segment the strike can produce is 620/30 =
            // 21 m, which wants six bolts here. A cap that bit at 30 fps and
            // not at 240 would make the count frame-rate dependent in exactly
            // the direction the per-metre metering exists to prevent — these
            // are a guard against a resumed tab, not a budget.
            if (n > 8) { n = 8; this._owedColumn = 0; }
            for (let i = 0; i < n; i++) {
                // Sub-frame placement, as `cloudVortex` lays its helix and the
                // surf wake samples its columns: at 620 m/s the body moves ten
                // metres between frames, and striking a frame's bolts all from
                // one point beats the column at the frame rate.
                const f = (i + Math.random()) / n;
                const cx = px + _axis[0] * moved * f;
                const cy = py + _axis[1] * moved * f;
                const cz = pz + _axis[2] * moved * f;

                const reach = COLUMN_REACH * (0.7 + Math.random() * 0.6);
                // Offset off the axis, so the column has a thickness rather
                // than being a stack of bolts through one line.
                const oa = Math.random() * Math.PI * 2;
                const oca = Math.cos(oa);
                const osa = Math.sin(oa);
                const orr = Math.random() * 1.5;
                const ox = (_perpA[0] * oca + _perpB[0] * osa) * orr;
                const oy = (_perpA[1] * oca + _perpB[1] * osa) * orr;
                const oz = (_perpA[2] * oca + _perpB[2] * osa) * orr;

                arcs.spawn(
                    false,
                    cx + ox - _axis[0] * reach,
                    cy + oy - _axis[1] * reach,
                    cz + oz - _axis[2] * reach,
                    cx + ox + _axis[0] * reach,
                    cy + oy + _axis[1] * reach,
                    cz + oz + _axis[2] * reach,
                    // Wide wander. A bolt this long with the jag of a short one
                    // draws as a straight bar.
                    reach * 0.22,
                    0.35 + Math.random() * 0.55,
                    COLUMN_LIFE * (0.7 + Math.random() * 0.6),
                    1.7 + Math.random() * 0.9,
                    0
                );
            }
        }

        // ---- arcs wrapping the body ---------------------------------------
        //
        // Struck across the axis rather than along it, close in. These are what
        // put the character *inside* the strike instead of alongside it, and
        // they are the reason the figure stays visible through the shot at all
        // — the column alone is a bright line the eye reads as the subject.
        this._owedWrap += moved * WRAP_PER_M * amount;
        let w = this._owedWrap | 0;
        if (w > 0) {
            this._owedWrap -= w;
            if (w > 9) { w = 9; this._owedWrap = 0; }
            for (let i = 0; i < w; i++) {
                const f = (i + Math.random()) / w;
                // Along the body rather than at a point on it: the figure is
                // 1.8 m and the wrap has to cover it.
                const alongA = (Math.random() - 0.5) * 1.9;
                const alongB = alongA + (Math.random() - 0.5) * 1.1;
                const a0 = Math.random() * Math.PI * 2;
                const a1 = a0 + 1.4 + Math.random() * 2.6;
                const c0 = Math.cos(a0);
                const s0 = Math.sin(a0);
                const c1 = Math.cos(a1);
                const s1 = Math.sin(a1);
                const r0 = WRAP_R * (0.5 + Math.random() * 0.7);
                const r1 = WRAP_R * (0.5 + Math.random() * 0.7);

                // Placed against last frame's position too, so the wrap does
                // not sit in a clump at the head of a ten-metre step.
                const mx = px + _axis[0] * moved * f;
                const my = py + _axis[1] * moved * f + 0.9;
                const mz = pz + _axis[2] * moved * f;

                arcs.spawn(
                    false,
                    mx + (_perpA[0] * c0 + _perpB[0] * s0) * r0 + _axis[0] * alongA,
                    my + (_perpA[1] * c0 + _perpB[1] * s0) * r0 + _axis[1] * alongA,
                    mz + (_perpA[2] * c0 + _perpB[2] * s0) * r0 + _axis[2] * alongA,
                    mx + (_perpA[0] * c1 + _perpB[0] * s1) * r1 + _axis[0] * alongB,
                    my + (_perpA[1] * c1 + _perpB[1] * s1) * r1 + _axis[1] * alongB,
                    mz + (_perpA[2] * c1 + _perpB[2] * s1) * r1 + _axis[2] * alongB,
                    WRAP_R * 0.9,
                    0.06 + Math.random() * 0.11,
                    WRAP_LIFE * (0.6 + Math.random() * 0.9),
                    1.5 + Math.random() * 1.0,
                    0
                );
            }
        }

        // ---- sparks -------------------------------------------------------
        this._owedSpark += moved * SPARK_PER_M * amount;
        let s = this._owedSpark | 0;
        if (s > 0) {
            this._owedSpark -= s;
            if (s > 30) { s = 30; this._owedSpark = 0; }
            for (let i = 0; i < s; i++) {
                const f = (i + Math.random()) / s;
                const a = Math.random() * Math.PI * 2;
                const ca = Math.cos(a);
                const sa = Math.sin(a);
                const r = 0.3 + Math.random() * 1.4;
                const ox = _perpA[0] * ca + _perpB[0] * sa;
                const oy = _perpA[1] * ca + _perpB[1] * sa;
                const oz = _perpA[2] * ca + _perpB[2] * sa;
                // Born carrying almost none of the body's velocity, unlike the
                // slipstream's grains beside them. These are meant to be left
                // behind — a spark that keeps up with the character is a light
                // attached to them.
                sp.emit(
                    px + _axis[0] * moved * f + ox * r,
                    py + _axis[1] * moved * f + oy * r + 0.9,
                    pz + _axis[2] * moved * f + oz * r,
                    ox * (1.5 + Math.random() * 4.0),
                    oy * (1.5 + Math.random() * 4.0) + 1.0,
                    oz * (1.5 + Math.random() * 4.0),
                    0.030 + Math.random() * 0.055,
                    0.28 + Math.random() * 0.34,
                    2,
                    2.2
                );
            }
        }

        // ---- the tether ---------------------------------------------------
        const up = ch.position.y - this._launchY;
        if (ch.boltDir > 0 && up > 2 && up < TETHER_REACH) {
            this._owedTether += dt * TETHER_RATE * amount;
            let t = this._owedTether | 0;
            if (t > 0) {
                this._owedTether -= t;
                if (t > 3) { t = 3; this._owedTether = 0; }
                for (let i = 0; i < t; i++) {
                    const j = (Math.random() - 0.5) * 1.6;
                    arcs.spawn(
                        false,
                        ch.position.x + j, ch.position.y + 0.5, ch.position.z + j,
                        this._launchX + j * 0.5, this._launchY, this._launchZ + j * 0.5,
                        up * 0.13,
                        0.20 + Math.random() * 0.30,
                        0.07 + Math.random() * 0.07,
                        1.5, 0
                    );
                }
            }
        }
    }

    /**
     * The superhero landing: a crater with a heavy rim, a ring of snow thrown
     * flat and outward, and lightning running away across the surface.
     *
     * Fired from `landImpact`, which is one frame wide — see `_prevBolt` for
     * why the two ends of the strike are detected differently.
     */
    _impact() {
        const ch = this.controller;
        const sp = this.spray;
        const arcs = this.arcs;
        const amount = S.skyBolt;

        const bx = ch.position.x;
        const bz = ch.position.z;
        const by = this.terrain.heightAt(bx, bz);

        // Deeper and harder than the launch. A landing is the whole descent
        // arriving at once, and the fist and knee are in this hole — the
        // figure's own `sink` is what puts them in it, and this is the same
        // hole from the outside.
        this.terrain.deform.brush(
            bx, bz, 1.7,
            0.50, 0.44, 0.85, 0.20,
            Math.random() * Math.PI, 1.15, 1.0
        );
        // A broken outer rim rather than one wide brush, for the reason the
        // Bloom's crater gives: an evenly-rimmed circle is the tell that gives
        // a single radial brush away.
        for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2 + Math.random() * 1.0;
            const d = 2.0 + Math.random() * 1.3;
            this.terrain.deform.brush(
                bx + Math.cos(a) * d, bz + Math.sin(a) * d,
                0.55 + Math.random() * 0.40,
                0.04, 0.22 + Math.random() * 0.16, 0.20, 0,
                a, 1.5, 1.0
            );
        }

        // The ring. Thrown *flat* — a landing drives snow outward along the
        // ground, where a launch throws it up. That difference is most of what
        // distinguishes the two events at a glance.
        const n = (LAND_GRAINS * amount) | 0;
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const ca = Math.cos(a);
            const sa = Math.sin(a);
            const d = 0.5 + Math.random() * 2.2;
            const gx = bx + ca * d;
            const gz = bz + sa * d;
            const gy = this.terrain.heightAt(gx, gz);
            const out = 7.0 + Math.random() * 14.0;
            const clod = Math.random() < 0.22;
            sp.emit(
                gx, gy + Math.random() * 0.22, gz,
                ca * out, 1.2 + Math.random() * 4.5, sa * out,
                clod ? 0.07 + Math.random() * 0.10 : 0.05 + Math.random() * 0.12,
                0.7 + Math.random() * 0.8,
                clod ? 1 : 0,
                clod ? 1.1 : 1.6
            );
        }

        // Lightning running out across the snow, low and flat.
        const s = (14 * amount) | 0;
        for (let i = 0; i < s; i++) {
            const a = Math.random() * Math.PI * 2;
            const d = 3.0 + Math.random() * 11.0;
            const gx = bx + Math.cos(a) * d;
            const gz = bz + Math.sin(a) * d;
            arcs.spawn(
                false,
                bx, by + 0.5, bz,
                gx, this.terrain.heightAt(gx, gz) + 0.1, gz,
                d * 0.26,
                0.08 + Math.random() * 0.16,
                0.08 + Math.random() * 0.12,
                1.9, 0
            );
        }
    }

    /**
     * Resolve this frame's light.
     *
     * One slot out of the four, and it is competing with whatever spells are
     * up. Note the intensity is only meaningful against the radius it is paired
     * with — `spellAttenuation` is a *windowed* inverse square, so a light with
     * twice the radius needs far more than twice the intensity to match. These
     * are scaled off the Bloom's 11 m / 22 and the Comet's 30 m / 120.
     */
    _resolveLight() {
        const ch = this.controller;

        if (ch.bolt > 0.001) {
            this._lightX = ch.position.x;
            this._lightY = ch.position.y + 0.9;
            this._lightZ = ch.position.z;
            this._lightR = 18.0;
            this._lightI = 70.0 * ch.bolt;
        } else if (ch.land > 0.001) {
            this._lightX = ch.position.x;
            this._lightY = ch.position.y + 0.4;
            this._lightZ = ch.position.z;
            this._lightR = 15.0;
            // Squared, so the flash is over well before the pose is. A light
            // that decays on the same curve as the recovery leaves the
            // character kneeling in a glow for most of a second, which reads as
            // an aura rather than as an impact.
            this._lightI = 52.0 * ch.land * ch.land;
        } else if (ch.charge > 0.001) {
            this._lightX = ch.position.x;
            this._lightY = ch.position.y + 0.8;
            this._lightZ = ch.position.z;
            this._lightR = 10.0;
            this._lightI = 26.0 * ch.charge * ch.charge;
        }
    }

    /**
     * Declare this frame's light into the shared pool.
     *
     * Called by `SpellSystem` between `lights.begin()` and the upload, because
     * that window is inside its `update` and this system's is not. Registered
     * through `spells.addLightSource(...)` in `main.js`.
     *
     * @param {import("../spells/spellLights.js").SpellLights} lights
     */
    declareLight(lights) {
        if (this._lightI <= 0) return;
        lights.add(
            this._lightX, this._lightY, this._lightZ, this._lightR,
            COL_R, COL_G, COL_B, this._lightI
        );
    }
}
