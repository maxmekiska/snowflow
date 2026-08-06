/**
 * Spell 6 — Comet.
 *
 * The long shot, and the only held cast here besides the Ribbon. Hold `6` and a
 * sigil inscribes itself in front of the caster; a ball of lightning gathers
 * through it, throwing more and more discharge in every direction as it builds,
 * until it is striking the snow underneath; the ground for eight metres around
 * is driven off by the pressure of it. Let go and it is thrown at the horizon,
 * and where it lands the field goes up in fire and lightning together.
 *
 * Five things happen on five different clocks, and the *gaps between them* are
 * the spell:
 *
 *   charge      held, as long as you like. The sigil is drawn on first — outer
 *               ring, tick fence, runes, star — and only once it is written does
 *               the ball start to gather in the middle of it. Charge decides how
 *               big the shot is, so the wind-up is a decision and not a delay,
 *               and the lightning is what reports that decision back: a few
 *               filaments crawling the surface at first, then bolts radiating
 *               further and further out, then strikes reaching the ground.
 *   flight      released, the ball draws out into a lance and leaves at 215 m/s.
 *               It is watched the entire way. A quarter of a kilometre takes well
 *               over a second, which is a very long time to hold a frame — and
 *               holding it is the point.
 *   detonation  one of three, chosen by `S.cometBlast`, all built to be read at
 *               250 metres rather than at five.
 *
 *                 dome    draws everything *inward*, holds an almost empty
 *                         frame for an eighth of a second, flashes, and throws
 *                         a hemisphere that then becomes the rolling wall.
 *                 disc    the same wind-up, ending in a flat planar front.
 *                 pillar  a mushroom column and a fireball at its root.
 *
 *               The first two share their order, and the order is the whole of
 *               it: every other explosion in and out of this file is a sphere
 *               going outward, so one that goes in first is doing something the
 *               eye has no template for. The held beat is what makes the flash
 *               land — a flash is a ratio, and leaving any light burning
 *               through the pause halves it.
 *
 *               The dome's second half is the part worth reading the code for.
 *               The hemisphere does not get replaced by the wall; it *becomes*
 *               it. Both are drawn at the same radius off one curve, so the
 *               shell's equator and the wall's centre line are the same circle
 *               at every instant, and the conversion is nothing but the dome
 *               thinning from the top while the wall thickens underneath. There
 *               is no cross-fade because there are never two radii. It is also
 *               what a blast physically does — the overpressure shell's top
 *               spends itself into air that is not there to push against, and
 *               what is left running along the ground is the surge.
 *   arrival     and then, most of a second later, the ground shock reaches the
 *               caster.
 *
 * That last gap is the entire reason this spell is aimed at the far field. A
 * blast you feel at the instant you see it is a blast that went off where you are
 * standing; a blast you see, wait for, and *then* feel is a blast that went off
 * somewhere else — and the wait is the only thing in the frame that can say how
 * far away somewhere else was. The shock front is a scalar radius expanding at
 * 330 m/s, and when it passes the caster it spends itself all at once: camera
 * trauma, a ring of snow blown off the ground, and a gust of powder driven
 * downrange.
 *
 * Under the pillar that radius is never drawn — it is purely a clock. Under the
 * dome and the disc it **is** the front, so what the player watches crossing the
 * field is exactly the thing that eventually hits them, rather than two
 * constants that have to be kept in agreement. The floor on its reach
 * (`this.range * 1.15`) exists for that reason alone — a front that stops short
 * while the shock arrives anyway gives the trick away.
 *
 * **The order of the wind-up is the whole read.** Sigil, then ball, then throw.
 * Building them together makes a glowing blob with a decal behind it; building
 * them in sequence makes the sigil look like the thing that is *doing* the
 * gathering. The sigil's own construction is in `magicCircle.fragment.wgsl` and
 * is analytic to the last tick mark; this file only tells it how far along it is.
 *
 * **Fire.** The fireball is deliberately not a new system: it is the ordinary
 * spray pool with `kind = 2`, shaded down a different branch of
 * `spray.fragment.wgsl`. Same billboard, same sort, same pipeline. The cold end
 * of its ramp is soot rather than dim red, because what a fireball leaves behind
 * is smoke, and against snow that dark tail is most of what sells the bright end.
 *
 * **Lightning** is the one thing here that *did* need its own system, and the
 * reason is instructive: the water strand pool is exactly full at the demo's
 * worst case, so there was nothing to draw a bolt on. That turned out to be the
 * right constraint — see `arcs.js`. A bolt wants to be a flat ribbon facing the
 * camera rather than a swept tube, and it wants twenty of itself alive at once
 * rather than one. It appears at all four stages, and the scale changes by two
 * orders of magnitude across them: centimetre filaments around the ball, a wake
 * of discharge shed off the lance, and metre-wide bolts tens of metres long
 * climbing the pillar, which is what it takes to still be visible at 250 m.
 *
 * Two strands, and the first is used three times over — the ball becomes the
 * lance becomes the pillar. Releasing and re-acquiring between those would be the
 * obvious structure and it is the wrong one: with six spells able to be up at
 * once the pool of eight is exactly full, so a re-acquire could come back -1 and
 * the payoff would be the only part of the spell that failed to draw.
 *
 * **Why the far field is hard here, and what answers it.** Both of the demo's
 * heavy systems stop well short of where this goes off. The deformation buffer is
 * 80 m across, so a crater at 250 m is outside it by a factor of three; and at
 * ground level a quarter kilometre of haze leaves about a fifth of whatever is
 * standing there. One property answers both: the pillar is *tall*. Fog here has a
 * height falloff, so it thins with altitude — 90 m up is more than twice as
 * visible as the ground beneath it, which is why the mass of this effect is put
 * in a column rather than in a crater nobody could see. And the only marks the
 * spell writes into the snow are the three it makes within arm's reach of the
 * caster: the wind scour while it charges, the scar under the launch, and the
 * blast ring when the shock arrives.
 */

import { S } from "../core/settings.js";
import { PROFILE_TUBE } from "./waterBody.js";
import { clamp01, smooth01, bell, transport, groundRay } from "./bending.js";

/** Spine samples. The pillar's cap is the tightest curve this spell draws. */
const COLS = 64;

// -------------------------------------------------------------------- aiming
/** Furthest the targeting ray is marched at full charge, metres. */
const MAX_RANGE = 420;
/** Where it lands when the ray finds no ground — aimed at the sky, mostly. */
const FALLBACK_RANGE = 265;
/**
 * Closest it is allowed to go off, metres.
 *
 * Aimed at the ground in front of your own boots this would detonate in the
 * caster's lap, which is both unreadable and — at this scale — faintly absurd.
 * Pushing it out to the minimum instead is the only rule that is never a
 * surprise: the shot always lands downrange, however far down you were looking.
 */
const MIN_RANGE = 85;
/** Keep the impact inside the baked heightfield, whose half-extent is 1024 m. */
const WORLD_LIMIT = 960;

// -------------------------------------------------------------------- charge
/** Seconds for the sigil to finish inscribing itself. */
const SIGIL_TIME = 0.72;
/** Seconds into the hold at which the ball starts to gather. */
const BALL_START = 0.44;
/** Seconds of hold for a full-power shot. */
const CHARGE_FULL = 1.95;
/**
 * Power floor.
 *
 * A tap still throws something. Requiring a minimum charge before the key does
 * anything makes the spell feel broken on the first press; scaling the shot
 * instead means the wind-up is a decision the player is making rather than a
 * toll they are paying.
 */
const MIN_POWER = 0.22;
/** Radius of the ball at full charge, metres. */
const BALL_R = 0.72;
/** Sigil radius as a multiple of the ball's, at full charge. */
const SIGIL_SCALE = 3.1;

/**
 * Radius of the dense core at the middle of the ball, as a fraction of the
 * ball's own.
 *
 * The ball is lightning, and lightning is a set of curves with nothing between
 * them — a cage of bolts with an empty middle reads as a wireframe rather than
 * as an object. This is the one piece of actual volume in it: a small, very
 * milky sphere on the lance's strand, bright enough to be the thing the arcs
 * are wrapping and small enough that they are plainly outside it.
 */
const CORE_FRAC = 0.42;

/**
 * Bolts per second around the ball at full charge.
 *
 * With lives averaging about an eighth of a second this lands near sixty alive
 * at once — half the pool of 128, the other half being headroom for the
 * detonation, which is the only moment both are ever asked for together.
 *
 * The floor matters as much as the ceiling. A charge that begins with *no*
 * lightning and grows some looks like a loading bar; a charge that begins with
 * a few filaments and ends in a cage of them looks like something being held
 * down.
 *
 * The relationship between rate and life is the thing to keep hold of when
 * tuning this. What the eye counts is `rate * life` — how many are up at once —
 * and what it reads as *electricity* is the churn, which is the rate alone.
 * Getting the same population out of a lower rate and a longer life gives a
 * ball wrapped in stationary wire.
 */
const BALL_ARC_LO = 34.0;
const BALL_ARC_HI = 470.0;

// -------------------------------------------------------------------- flight
const SPEED = 215;
/** Length of the lance body, metres. Not the distance it travels. */
const LANCE_LEN = 30;
/** Radius at the lance's belly, metres. */
const LANCE_R = 1.3;
/**
 * How far downrange the launch still writes into the snow, metres.
 *
 * The deformation window is 80 m across and follows the player, so anything past
 * about 40 m is a brush the field rejects anyway. Stopping here rather than
 * relying on that rejection is what keeps the 96-brush frame budget clear: at
 * 215 m/s a rank per 0.5 m is nine brushes a frame, and there is no reason to pay
 * for the ones that cannot land.
 */
const SCOUR_RANGE = 42;

// ---------------------------------------------------------------- detonation
/** Height of the pillar at full extension and full charge, metres. */
const PILLAR_H = 92;
/** Radius of the cap at its widest, metres. */
const PILLAR_R = 15;
/** Seconds from impact to the pillar being fully up. */
const RISE = 0.55;
/** Seconds from impact to everything being gone. */
const BLAST_LIFE = 5.8;
/**
 * Outer radius the visible base surge reaches, metres.
 *
 * Three hundred, doubled from the hundred and fifty this was tuned at. The ring
 * expands as `RING_MAX * (1 - exp(-t * 1.25))`, so doubling the radius doubles
 * the front's speed for free and the surge still spends itself over the same
 * few seconds — it just covers twice the ground doing it, which is the whole
 * point of the change.
 *
 * Two things move with it. The wall is thickened in proportion, or a ring twice
 * the size is the same amount of powder stretched round twice the circumference
 * and reads as a thread. And it is lifted further off the snow, because the
 * spine is only 64 samples however wide the circle is: at 300 m those samples
 * are 29 m apart, against a dune wavelength of 58, so the ring can no longer
 * follow the ground between them. Where it does cut into a crest the crest
 * occludes it, which reads as the surge passing behind the landform and is
 * right — what has to be avoided is the *spine* sitting buried in flat ground.
 */
const RING_MAX = 300;
const RING_LIFE = 5.0;
/**
 * Speed of the front that decides when the caster feels it, m/s.
 *
 * Roughly the speed of sound, and that is not a physics claim — it is the number
 * that makes the delay at this spell's working range land between half a second
 * and a second and a quarter. Much faster and the wait stops registering as a
 * wait; much slower and the player has looked away.
 */
const SHOCK_SPEED = 330;

// ------------------------------------------------------------------- seismic
/**
 * The wind-up shared by the `dome` and `disc` detonations: implosion, a held
 * beat of nothing, then a flash. What they do after it differs; how they arrive
 * at it does not.
 *
 * What makes it read is not the blast, it is the *order*. Both halves of that
 * are load-bearing, and the beat of nothing between them is what makes the
 * flash land.
 */
/** Seconds the implosion spends drawing inward. */
const IMPLODE_TIME = 0.42;
/**
 * Seconds of held near-nothing between the collapse and the flash.
 *
 * This is the whole effect and it is the part that looks like a bug. An eighth
 * of a second of an almost empty frame is long enough to register as a pause
 * and short enough that it never reads as the spell having failed — and the
 * flash out of *darkness* is four times the flash out of a glow.
 */
const HOLD_TIME = 0.13;
/** Radius the implosion gathers from at full charge, metres. */
const IMPLODE_R = 46;
/** Seconds the flash takes to blow out. */
const FLASH_TIME = 0.17;
/** Furthest the front reaches before it gives out, metres. */
const DISC_MAX = 430;
/** Height the front's plane is centred above the impact, metres. */
const DISC_LIFT = 9.0;
/** Seconds from the flash to everything being gone, for the flat front. */
const SEISMIC_LIFE = 3.4;

/**
 * The dome: a hemisphere thrown up by the flash that then *becomes* the rolling
 * wall, rather than being replaced by it.
 *
 * The conversion is free, and that is the reason to build it this way. Both are
 * drawn at the same radius off the same curve, so the dome's equator and the
 * wall's centre line are the same circle at every instant — the dome simply
 * fades from the top down while the wall thickens underneath it. There is no
 * cross-fade between two objects because there is only ever one radius.
 *
 * It is also what a blast actually does. The overpressure shell is a hemisphere;
 * its top thins out into air that is not there to push against, and what is left
 * running along the ground is the surge. Getting the physics for free is a
 * coincidence, but it is the reason the handoff reads as one event.
 */
/** Seconds the dome holds closed before it starts giving way. */
const DOME_HOLD = 0.26;
/**
 * Seconds the tear then takes to run from the pole down to the equator.
 *
 * The shell does not dissolve. Its rim descends, so what gives way is the top
 * of it, and by the time this is spent the rim has arrived at the equator where
 * the wall already is. That is why extending the shell's life costs nothing
 * structurally: the dome and the surge are drawn at the same radius, so a shell
 * still standing at t = 1.4 s is standing on a wall that has been thickening
 * underneath it since 0.7 — they were never competing for the same moment.
 *
 * Together with `DOME_HOLD` this is 1.4 s of hemisphere against the 0.80 it had
 * when the give-way was an alpha fade. The shape is the most recognisable thing
 * in the spell and it had the least screen time of anything in it.
 */
const DOME_TEAR = 1.15;
/** Seconds from the flash to everything being gone, for the dome. */
const DOME_LIFE = 5.2;
/**
 * How far the front's plane is tipped from facing the caster toward horizontal,
 * 0..1.
 *
 * A disc is only legible off-plane, and this is the one number that decides
 * whether the effect works at all. At 1 it lies flat, which is faithful to the
 * reference and — from a caster standing at eye height on the same ground —
 * presents as a bright horizontal *line*, because the viewer is in its plane.
 * At 0 it faces the shot squarely and reads as a circle with no depth to it.
 * Just under a third tips it back far enough to come across as an ellipse
 * leaning away, which is the shape that says "plane" rather than "ring".
 */
const DISC_TILT = 0.30;

const P_IDLE = 0;
const P_CHARGE = 1;
const P_FLIGHT = 2;
const P_BLAST = 3;
const P_IMPLODE = 4;

// ------------------------------------------------------- module-scope scratch
const _rgt = new Float32Array(3);
const _handL = new Float32Array(3);
const _handR = new Float32Array(3);

export class Comet {
    /** @param {import("./spellSystem.js").SpellContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        this.active = false;
        this.phase = P_IDLE;
        /** True while the key is down and the charge is building. */
        this.held = false;

        /** The ball, then the lance, then the pillar. */
        this.strandLance = -1;
        /** The base surge ring. */
        this.strandRing = -1;

        this.t = 0;
        /** Seconds the charge has been held. */
        this.charge = 0;
        /** 0..1, decided at release. Scales range, pillar, blast and shake. */
        this.power = 0;
        /** Discharge brightness on the sigil, eased out after the throw. */
        this._flare = 0;

        // Live aim, refreshed by `hold` every frame the charge is up.
        this._aimX = 0; this._aimY = 0; this._aimZ = 1;

        // Launch frame, frozen at release.
        this.ox = 0; this.oy = 0; this.oz = 0;
        this.dx = 0; this.dy = 0; this.dz = 1;
        /** Impact point, fixed at release. */
        this.ix = 0; this.iy = 0; this.iz = 0;
        /** Distance from launch to impact, metres. */
        this.range = 0;
        /** Metres of that the lance has covered. */
        this.travelled = 0;

        /** Angle at which the ring's two tapered ends meet, fixed at impact. */
        this._seam = 0;
        /** Radius of the undrawn shock front, metres. */
        this._shock = 0;
        this._shockHit = false;

        this._scourOwed = 0;
        this._trailOwed = 0;
        this._windOwed = 0;
        this._falloutOwed = 0;
        this._burnOwed = 0;
        this._arcOwed = 0;
        this._blastArcOwed = 0;
        this._implodeOwed = 0;
        this._discOwed = 0;

        /**
         * Which detonation this cast committed to — "dome", "disc" or "pillar".
         * Latched at impact so flipping the setting mid-blast cannot tear one
         * detonation in half.
         */
        this._blastKind = "dome";
        /** Radius the front is allowed to reach, fixed at the flash. */
        this._frontMax = 0;
        /** Flash brightness, 1 at the instant of detonation. */
        this._flash = 0;
        /** The front's plane: axis, and an in-plane basis for its rim. */
        this._ax = 0; this._ay = 1; this._az = 0;
        this._drx = 1; this._dry = 0; this._drz = 0;
        this._dux = 0; this._duy = 0; this._duz = 1;
    }

    /**
     * True while the figure should be holding the wind-up.
     *
     * Read by the spell system's casting blend. The stock 0.55 s post-cast window
     * every other spell uses cannot describe a hold of unbounded length, so this
     * spell states it directly — otherwise the character would come out of the
     * brace while still visibly charging.
     */
    get charging() {
        return this.phase === P_CHARGE;
    }

    /**
     * Poll the hold. Called every frame by the spell system, held or not.
     *
     * Edge-triggered inside rather than outside so that a tap short enough to
     * begin and end within one frame still starts a charge, which the next
     * frame's `held = false` then releases at minimum power.
     *
     * @param {boolean} held
     * @param {number} ax @param {number} ay @param {number} az unit aim
     */
    hold(held, ax, ay, az) {
        this._aimX = ax;
        this._aimY = ay;
        this._aimZ = az;

        if (held) {
            if (!this.held) {
                this.held = true;
                this._beginCharge();
            }
        } else if (this.held) {
            this.held = false;
            this._release();
        }
    }

    _beginCharge() {
        const ctx = this.ctx;
        // A recast during flight or blast restarts the whole spell. Two of these
        // overlapping is not a bigger effect, it is two half-legible ones.
        if (this.strandLance < 0) this.strandLance = ctx.water.acquire();
        if (this.strandRing < 0) this.strandRing = ctx.water.acquire();

        this.phase = P_CHARGE;
        this.active = true;
        this.charge = 0;
        this.power = 0;
        this.t = 0;
        this._flare = 0;
        this._windOwed = 0;
        this._arcOwed = 0;
    }

    // ------------------------------------------------------------------ charge

    _updateCharge(dt) {
        const ctx = this.ctx;
        this.charge += dt;

        // The sigil is inscribed first and the ball gathers afterwards. Both
        // curves are keyed to the same clock, and the overlap between them is
        // deliberately small — the ball should appear to be a consequence of the
        // sigil closing, not a second thing happening at the same time.
        const build = clamp01(this.charge / SIGIL_TIME);
        const power = clamp01(
            (this.charge - BALL_START) / (CHARGE_FULL - BALL_START)
        );
        this.power = power;

        this._handMid();
        this._normaliseAim();

        // The sigil stands at the hands, facing down the aim, and the ball sits
        // proud of it — so the lance leaves *through* the circle.
        const ballR = BALL_R * (0.16 + 0.84 * power);
        const circle = ctx.circle;
        if (circle) {
            circle.setFrame(
                this.ox, this.oy, this.oz,
                this._aimX, this._aimY, this._aimZ,
                BALL_R * SIGIL_SCALE * (0.55 + 0.45 * build)
            );
            // Pulses once it is written and the ball is still growing, so a long
            // hold is never a still image.
            //
            // The pulse rides the *flare* rather than the alpha. Alpha is the
            // blend weight and a value over 1 over-composites; brightness is
            // where a throb belongs anyway, since what is pulsing is how hard
            // the sigil is working rather than how solid it is.
            const pulse = 0.10 * Math.max(0, Math.sin(this.charge * 9.0)) * build * power;
            circle.update(dt, build, clamp01(build * 1.2), pulse);
        }

        // The core is a fraction of the ball; the lightning occupies the rest of
        // it. See `CORE_FRAC`.
        if (power > 0.001) this._ball(ballR * CORE_FRAC, power);
        else if (this.strandLance >= 0) {
            ctx.water.setParams(this.strandLance, PROFILE_TUBE, 0.7, 0, 0);
        }

        this._ballArcs(dt, build, power, ballR);
        this._windOff(dt, build, power);

        // One light for the pair. It sits between the sigil and the ball so both
        // are lit by it, and it is what throws the caster's own shadow forward
        // across the snow while they charge.
        //
        // It strobes, and that is not decoration. This light is the only part of
        // the discharge that reaches the snow and the caster, so a steady one
        // under a ball of flickering bolts reads as two unrelated effects
        // happening in the same place. The beat is a product of two
        // incommensurate sines rather than a single one, which keeps it from
        // settling into a visible pulse.
        const flick =
            0.70 + 0.30 * Math.sin(this.charge * 47.0) * Math.sin(this.charge * 23.0);
        ctx.lights.add(
            this.ox + this._aimX * ballR * 0.5,
            this.oy + this._aimY * ballR * 0.5,
            this.oz + this._aimZ * ballR * 0.5,
            6.5 + 8.0 * power,
            0.55, 0.78, 1.0,
            (4.0 * build + 34.0 * power * power) * flick
        );
    }

    /**
     * The lightning that is the ball.
     *
     * Three families, and the mix is what makes it read as a contained
     * discharge rather than as a sparkler:
     *
     *  - **Crawling** the surface, both ends anchored on the sphere. These are
     *    what give the ball an apparent skin, and they are the majority.
     *  - **Radiating** outward in every direction, reaching further as the
     *    charge builds. These are what make it look like it is straining, and
     *    their reach growing with power is most of what the wind-up communicates.
     *  - **Striking the ground**, once the charge is past halfway. Only a few,
     *    and they do more than the other two put together: they are the only
     *    thing tying a ball held at chest height to the snow it is standing
     *    over, and each one leaves a scorch through the deformation buffer.
     *
     * All of them are spawned `local`, so they travel with the hands — a bolt
     * living an eighth of a second would otherwise be left three metres behind a
     * caster who is flying while they charge.
     */
    _ballArcs(dt, build, power, radius) {
        const ctx = this.ctx;
        const arcs = ctx.arcs;
        if (!arcs || build < 0.02) return;

        arcs.setOrigin(this.ox, this.oy, this.oz);

        const rate = (BALL_ARC_LO + (BALL_ARC_HI - BALL_ARC_LO) * power) * build;
        this._arcOwed += dt * rate;
        let count = this._arcOwed | 0;
        if (count <= 0) return;
        this._arcOwed -= count;
        // A 30 Hz frame at full rate owes sixteen; the cap is above that so the
        // budget is never quietly clipped at the frame rates this runs at, and
        // still bounded if a frame hitches.
        if (count > 20) count = 20;

        for (let i = 0; i < count; i++) {
            const r = Math.random();
            const width = (0.008 + Math.random() * 0.020) * (0.6 + 0.6 * power);
            const life = 0.06 + Math.random() * 0.15;
            const bright = 0.75 + 0.85 * power;

            if (r < 0.12 && power > 0.4) {
                // Ground strike.
                const a = Math.random() * Math.PI * 2;
                const sx = Math.cos(a) * radius * 0.5;
                const sz = Math.sin(a) * radius * 0.5;
                const gx = this.ox + sx * 3.0 + (Math.random() - 0.5) * 2.2;
                const gz = this.oz + sz * 3.0 + (Math.random() - 0.5) * 2.2;
                const gy = ctx.terrain.heightAt(gx, gz);
                arcs.spawn(
                    true,
                    this.ox + sx, this.oy - radius * 0.6, this.oz + sz,
                    gx, gy, gz,
                    0.55, width * 1.5, life, bright * 1.25, 0
                );
                // What it leaves — but only one strike in four, and much
                // lighter than it was when there were a tenth as many.
                //
                // At this rate the strikes come about fifty a second, and
                // marking every one at the depth a single strike wanted would
                // excavate a pit under the caster inside two seconds. The
                // deformation field integrates; the *visual* rate and the rate
                // it is written at are separate numbers and have to be tuned
                // separately.
                if (Math.random() < 0.25) {
                    ctx.deform.brush(
                        gx, gz, 0.42,
                        0.07 * power, 0.03 * power, 0.22 * power, 0.10 * power,
                        a, 1.0, 1.0
                    );
                }
                continue;
            }

            // A point on the sphere, uniformly: `z` flat and the angle free is
            // the standard construction, and the naive one (two uniform angles)
            // bunches every bolt at the poles.
            const u = Math.random() * 2 - 1;
            const th = Math.random() * Math.PI * 2;
            const su = Math.sqrt(Math.max(0, 1 - u * u));
            const nx = su * Math.cos(th), ny = u, nz = su * Math.sin(th);

            if (r < 0.47) {
                // Crawling: a second point far enough round the sphere that the
                // bolt has a length worth drawing.
                const v = Math.random() * 2 - 1;
                const th2 = Math.random() * Math.PI * 2;
                const sv = Math.sqrt(Math.max(0, 1 - v * v));
                let mx = sv * Math.cos(th2), my = v, mz = sv * Math.sin(th2);
                // Push the far end away from the near one when they land close
                // together, or the bolt is a dot.
                if (nx * mx + ny * my + nz * mz > 0.55) { mx = -mx; my = -my; mz = -mz; }
                // Wander well off the surface. A crawl held tight to the sphere
                // draws a clean wireframe globe, which is the one shape this
                // must not be — the skin wants to be fuzzy and a centimetre or
                // two thick, not a set of great circles.
                arcs.spawn(
                    true,
                    this.ox + nx * radius, this.oy + ny * radius, this.oz + nz * radius,
                    this.ox + mx * radius, this.oy + my * radius, this.oz + mz * radius,
                    radius * (0.8 + Math.random() * 0.7), width, life, bright, 0
                );
            } else {
                // Radiating, and this is the family that answers "all over".
                //
                // The reach is spread very wide on purpose — from about a ball's
                // radius out to seven or eight of them at full charge — because
                // a set of bolts that all stop at the same distance draws a
                // second sphere, a shell around the first, and reads as a
                // containment field rather than as something escaping. The
                // spread is what makes it look like it is throwing lightning
                // *off* rather than wearing it.
                const reach = radius * (1.5 + 2.9 * power) * (0.5 + Math.random() * 1.1);
                const jx = (Math.random() - 0.5) * 0.7;
                const jy = (Math.random() - 0.5) * 0.7;
                const jz = (Math.random() - 0.5) * 0.7;
                arcs.spawn(
                    true,
                    this.ox + nx * radius * 0.9,
                    this.oy + ny * radius * 0.9,
                    this.oz + nz * radius * 0.9,
                    this.ox + (nx + jx) * reach,
                    this.oy + (ny + jy) * reach,
                    this.oz + (nz + jz) * reach,
                    // Longer bolts kink more, or a four-metre one reads as a
                    // drawn line next to a half-metre one that reads as a spark.
                    reach * 0.30, width, life * 0.85, bright, 0
                );
            }
        }
    }

    /**
     * The core of the gathering ball.
     *
     * A sphere drawn on the same strand the lance will use, by running a spine
     * one diameter long and giving it a circular radius profile — `sqrt(1 - s²)`
     * is a sphere by construction and is zero at both ends, which is what the
     * swept surface needs if it is not to close on an open disc.
     *
     * This used to be the whole ball and is now the nucleus inside it, at
     * `CORE_FRAC` of the radius the lightning wraps. Drawn much denser than it
     * was for that reason: at 0.62 it was a body of water being held, which is
     * exactly the read the lightning replaced, and at 0.9 it is an opaque hot
     * mass that the bolts are visibly outside of.
     *
     * Reusing the lance's strand rather than taking a third is not only pool
     * economy: it means the throw is one object changing shape, and nothing has
     * to be cross-faded at the moment of release.
     */
    _ball(radius, power) {
        const s = this.strandLance;
        if (s < 0 || radius < 0.01) return;
        const ctx = this.ctx;
        const water = ctx.water;
        const tm = ctx.time;

        // Centre it a ball's radius in front of the sigil plane.
        const cx = this.ox + this._aimX * (radius + 0.10);
        const cy = this.oy + this._aimY * (radius + 0.10);
        const cz = this.oz + this._aimZ * (radius + 0.10);

        // Any vector off the axis; transport carries the frame from there.
        let px = -this._aimZ;
        let pz = this._aimX;
        const pl = Math.hypot(px, pz) || 1;
        px /= pl;
        pz /= pl;

        let lx = 0, ly = 0, lz = 0;
        let rx = px, ry = 0, rz = pz;
        let t0x = this._aimX, t0y = this._aimY, t0z = this._aimZ;
        let dist = 0;

        for (let c = 0; c < COLS; c++) {
            const u = c / (COLS - 1);
            // Column 0 is the leading face, so `s` runs from the front of the
            // ball to the back — the same "u is distance behind the head"
            // convention every strand in this project follows.
            const sp = 1 - 2 * u;
            const x = cx + this._aimX * sp * radius;
            const y = cy + this._aimY * sp * radius;
            const z = cz + this._aimZ * sp * radius;

            if (c > 0) {
                let t1x = x - lx, t1y = y - ly, t1z = z - lz;
                const l = Math.hypot(t1x, t1y, t1z) || 1e-4;
                t1x /= l; t1y /= l; t1z /= l;
                dist += l;
                transport(_rgt, 0, rx, ry, rz, t0x, t0y, t0z, t1x, t1y, t1z);
                rx = _rgt[0]; ry = _rgt[1]; rz = _rgt[2];
                t0x = t1x; t0y = t1y; t0z = t1z;
            }

            // Circular profile, with a slow boil so the surface is not a
            // billiard ball. The boil is keyed to the section parameter rather
            // than to world distance, which keeps it under the sample rate.
            const prof = Math.sqrt(Math.max(0, 1 - sp * sp));
            const boil = 0.90 + 0.14 * Math.sin(u * 5.3 + tm * 3.4)
                       + 0.08 * Math.sin(u * 11.0 - tm * 5.1);
            water.column(
                s, c, x, y, z, radius * prof * boil,
                rx, ry, rz, tm * 1.6 + u * 2.0,
                dist, u,
                // Brightest across the leading face, which is where it is being
                // compressed against the air it is about to be thrown through.
                clamp01(0.35 + 0.55 * (1 - u)),
                1
            );

            lx = x; ly = y; lz = z;
        }

        water.setParams(s, PROFILE_TUBE, 0.90, clamp01(power * 2.2), COLS);
    }

    /**
     * The wind coming off the charge.
     *
     * Snow driven *away* from the caster, harder as the charge builds — grains
     * lifted off the ground and thrown outward, and a ring of scour in the
     * terrain state buffer directly under them so the snow that left is visibly
     * gone from where it left. This is the one part of the spell that is pure
     * anticipation: it does nothing at all and it is what makes the wind-up read
     * as pressure rather than as a loading bar.
     */
    _windOff(dt, build, power) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        const ch = ctx.controller;
        const k = 0.25 * build + 0.75 * power;
        if (k < 0.02) return;

        if (sp) {
            const rate = 1250 * ctx.sprayScale * k;
            this._windOwed += dt * rate;
            let count = this._windOwed | 0;
            if (count > 0) {
                this._windOwed -= count;
                if (count > 110) count = 110;

                for (let i = 0; i < count; i++) {
                    const a = Math.random() * Math.PI * 2;
                    // Born close in and thrown out, so the motion is legibly
                    // radial rather than a ring of drifting haze.
                    const r = 0.9 + Math.random() * 3.2;
                    const x = ch.position.x + Math.cos(a) * r;
                    const z = ch.position.z + Math.sin(a) * r;
                    const y = ctx.terrain.heightAt(x, z) + Math.random() * 0.35;
                    const out = (4.5 + Math.random() * 11.0) * k;

                    sp.emit(
                        x, y, z,
                        Math.cos(a) * out + (Math.random() - 0.5) * 1.6,
                        0.5 + Math.random() * 3.0 * k,
                        Math.sin(a) * out + (Math.random() - 0.5) * 1.6,
                        0.03 + Math.random() * 0.07,
                        0.55 + Math.random() * 0.75,
                        0,
                        // Low enough to carry the throw for its whole life: this
                        // grain has to visibly *leave*, not stall two metres out.
                        1.3
                    );
                }
            }
        }

        // The ground it came off. Depression under the ring and a little berm
        // thrown outward — this snow was blown aside, not lifted straight up.
        const N = 7;
        for (let i = 0; i < N; i++) {
            const a = (i / N) * Math.PI * 2 + this.charge * 3.1;
            const r = 1.6 + Math.random() * 3.0;
            ctx.deform.brush(
                ch.position.x + Math.cos(a) * r,
                ch.position.z + Math.sin(a) * r,
                0.62,
                0.42 * dt * k,
                0.30 * dt * k,
                0.16 * dt * k,
                0,
                a + Math.PI * 0.5,
                1.8,
                1.0
            );
        }
    }

    // ----------------------------------------------------------------- release

    _release() {
        const ctx = this.ctx;
        if (this.phase !== P_CHARGE) return;

        this.power = Math.max(this.power, MIN_POWER);
        const P = this.power;

        this._handMid();
        this._normaliseAim();

        const dx = this._aimX;
        const dy = this._aimY;
        const dz = this._aimZ;

        // Where it lands. The ray starts at the eye, so what the shot hits is
        // exactly what is under the centre of the screen — the same targeting
        // rule Bloom and Crystallise use, with the 22 m cap taken off and the
        // reach scaled by how long it was held.
        const reach = MIN_RANGE + (MAX_RANGE - MIN_RANGE) * P;
        const eye = ctx.rig.camera.position;
        const hit = groundRay(ctx.terrain, eye.x, eye.y, eye.z, dx, dy, dz, reach);

        const fl = Math.hypot(dx, dz) || 1;
        let ix;
        let iz;
        if (hit > 0) {
            ix = eye.x + dx * hit;
            iz = eye.z + dz * hit;
        } else {
            // Flatten and step out, exactly as `aimPoint` does for the short
            // spells. Looking at the sky and letting go has to do something.
            const fb = Math.min(FALLBACK_RANGE * (0.45 + 0.55 * P), reach);
            ix = eye.x + (dx / fl) * fb;
            iz = eye.z + (dz / fl) * fb;
        }

        // Floor the range, measured from the launch point rather than the eye.
        if (Math.hypot(ix - this.ox, iz - this.oz) < MIN_RANGE) {
            ix = this.ox + (dx / fl) * MIN_RANGE;
            iz = this.oz + (dz / fl) * MIN_RANGE;
        }

        // The heightfield is finite. Past its edge `heightAt` clamps, which would
        // stand the pillar on a plateau of the last texel row — visible as a
        // dead-flat shelf under it.
        const rad = Math.hypot(ix, iz);
        if (rad > WORLD_LIMIT) {
            const k = WORLD_LIMIT / rad;
            ix *= k;
            iz *= k;
        }

        this.ix = ix;
        this.iz = iz;
        this.iy = ctx.terrain.heightAt(ix, iz);
        this._aimAtImpact();

        this.phase = P_FLIGHT;
        this.t = 0;
        this.travelled = 0;
        this._scourOwed = 0;
        this._trailOwed = 0;
        // The sigil discharges rather than switching off.
        this._flare = 1;

        ctx.rig.addTrauma(0.14 + 0.26 * P);
        this._launchScar(P);
    }

    // ------------------------------------------------------------------ flight

    _updateFlight(dt) {
        const ctx = this.ctx;
        this.t += dt;
        const step = SPEED * dt;
        this.travelled += step;

        // The sigil hangs where it was and blows out over a third of a second.
        this._flare = Math.max(0, this._flare - dt * 3.2);
        const circle = ctx.circle;
        if (circle) {
            const f = this._flare;
            circle.update(dt, 1, f * f, f);
        }

        if (this.travelled >= this.range) {
            this._detonate();
            return;
        }

        this._lay(this.travelled, LANCE_LEN, 1, 1);
        this._scour(step);
        this._trail(step);
        this._lanceArcs(dt);

        // Rides the head. Out past a hundred metres this lights nothing the
        // player can see, which is correct — it is a light, not a decal, and a
        // light that far away has nothing near it to light. What it is for is
        // the first fifth of a second, when the lance is still crossing the snow
        // in front of the caster and should visibly drag a wash along with it.
        const hx = this.ox + this.dx * this.travelled;
        const hy = this.oy + this.dy * this.travelled;
        const hz = this.oz + this.dz * this.travelled;
        ctx.lights.add(hx, hy, hz, 30.0, 0.55, 0.82, 1.0, 120.0);
    }

    /**
     * Lay the lance along the spine.
     *
     * The body is not dead straight. A perfectly straight swept tube reads as a
     * rendered cylinder no matter what is on its surface — the same problem
     * Bloom's column has, and the same answer: a waver of a quarter of a metre
     * over thirty is nowhere near enough to see as a bend, and is entirely enough
     * to stop the silhouette being a primitive.
     *
     * @param {number} head metres from the launch point to the tip
     * @param {number} len body length, metres
     * @param {number} env 0..1 amplitude
     * @param {number} lit 0..1 how hot the head runs
     */
    _lay(head, len, env, lit) {
        const s = this.strandLance;
        if (s < 0 || len < 0.2) return;
        const water = this.ctx.water;
        const tm = this.ctx.time;
        const sx = this.ox;
        const sy = this.oy;
        const sz = this.oz;

        // Perpendicular basis for the waver.
        let px = -this.dz;
        let pz = this.dx;
        const pl = Math.hypot(px, pz) || 1;
        px /= pl;
        pz /= pl;
        const qx = this.dy * pz;
        const qy = this.dz * px - this.dx * pz;
        const qz = -this.dy * px;

        let lx = 0, ly = 0, lz = 0;
        let rx = 1, ry = 0, rz = 0;
        let t0x = this.dx, t0y = this.dy, t0z = this.dz;
        let dist = 0;

        for (let c = 0; c < COLS; c++) {
            const u = c / (COLS - 1);
            // Column 0 is the head, so `u` runs backward down the body — the
            // convention every strand in this project follows. The tail is
            // floored at the launch point, which is how the lance emerges from
            // the sigil rather than appearing at full length behind it.
            let d = head - u * len;
            if (d < 0) d = 0;

            const w = Math.sin(u * 7.4 + tm * 5.0) * 0.22 * u;
            const x = sx + this.dx * d + (px * w + qx * w * 0.6);
            const y = sy + this.dy * d + qy * w * 0.6;
            const z = sz + this.dz * d + (pz * w + qz * w * 0.6);

            if (c > 0) {
                let t1x = x - lx, t1y = y - ly, t1z = z - lz;
                const l = Math.hypot(t1x, t1y, t1z) || 1e-4;
                t1x /= l; t1y /= l; t1z /= l;
                dist += l;
                transport(_rgt, 0, rx, ry, rz, t0x, t0y, t0z, t1x, t1y, t1z);
                rx = _rgt[0]; ry = _rgt[1]; rz = _rgt[2];
                t0x = t1x; t0y = t1y; t0z = t1z;
            } else {
                // Any vector off the axis will do; transport carries it from here.
                rx = px; ry = 0; rz = pz;
            }

            // A point at the tip, a belly a quarter of the way back, and a long
            // taper to nothing. Zero at both ends, which is what the swept
            // surface needs if it is not to end on an open disc.
            const nose = smooth01(u / 0.11);
            const tail = 1 - smooth01((u - 0.22) / 0.78);
            const radius = LANCE_R * (0.45 + 0.55 * this.power) * nose * tail * env;

            water.column(
                s, c, x, y, z, radius,
                rx, ry, rz, tm * 2.2 + u * 3.0,
                dist, u,
                // Foam is the ablation off the head; it dies away down the body.
                clamp01(0.95 * (1 - smooth01(u / 0.45)) + 0.15),
                1
            );

            lx = x; ly = y; lz = z;
        }

        // Dense. This is not a body of water being bent, it is snow and ice
        // driven together hard enough to hold a point.
        water.setParams(s, PROFILE_TUBE, 0.72 * lit, clamp01(env * 1.4), COLS);
    }

    /** The mark the launch leaves under the caster's own feet. */
    _launchScar(P) {
        const ctx = this.ctx;
        const ch = ctx.controller;
        const fx = this.dx;
        const fz = this.dz;
        const fl = Math.hypot(fx, fz) || 1;

        // Blown backward off the launch: the recoil goes into the snow behind,
        // the muzzle blast into the snow in front.
        for (let i = 0; i < 5; i++) {
            const d = -1.4 - i * 0.9;
            ctx.deform.brush(
                ch.position.x + (fx / fl) * d,
                ch.position.z + (fz / fl) * d,
                0.75,
                (0.30 - i * 0.04) * P,
                (0.26 - i * 0.03) * P,
                0.45 * P,
                0,
                Math.atan2(fz, -fx),
                1.9,
                1.0
            );
        }

        const sp = ctx.spray;
        if (!sp) return;
        const n = (260 * ctx.sprayScale * P) | 0;
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * 2.6;
            const back = 3.0 + Math.random() * 7.0;
            sp.emit(
                ch.position.x + Math.cos(a) * r,
                this.oy - 0.4 + Math.random() * 1.1,
                ch.position.z + Math.sin(a) * r,
                -(fx / fl) * back + (Math.random() - 0.5) * 2.4,
                1.6 + Math.random() * 3.4,
                -(fz / fl) * back + (Math.random() - 0.5) * 2.4,
                0.05 + Math.random() * 0.09,
                0.9 + Math.random() * 0.9,
                0,
                1.5
            );
        }
    }

    /** The channel the launch ploughs, for as long as it is still in the window. */
    _scour(step) {
        if (this.travelled > SCOUR_RANGE) return;
        const ctx = this.ctx;

        this._scourOwed += step;
        if (this._scourOwed < 0.5) return;
        const k = Math.min(this._scourOwed, 1.4) * this.power;
        this._scourOwed = 0;

        // Fades out over the last stretch rather than stopping dead, or the
        // trench would end on a step at exactly 42 metres every time.
        const fade = 1 - smooth01(this.travelled / SCOUR_RANGE);
        const d = this.travelled;
        const x = this.ox + this.dx * d;
        const z = this.oz + this.dz * d;

        ctx.deform.brush(
            x, z,
            0.9,
            0.85 * k * fade,
            0.70 * k * fade,
            0.60 * k * fade,
            0.12 * k * fade,
            Math.atan2(this.dz, -this.dx),
            2.4,
            0.85
        );
    }

    /**
     * Discharge shed off the lance in flight.
     *
     * World-anchored rather than local, which looks like the wrong choice and is
     * not: at 215 m/s the lance clears seventeen metres in the life of one of
     * these, so a bolt left standing where it was struck reads as something the
     * shot *shed* — a wake of discharge hanging in the air behind it. Carrying
     * them along instead would weld them to the head and lose that entirely.
     *
     * Gated to the first hundred metres for the same reason the powder trail is:
     * past that they are sub-pixel and would only be spending pool slots the
     * detonation is about to want.
     */
    _lanceArcs(dt) {
        const arcs = this.ctx.arcs;
        if (!arcs || this.travelled > 100) return;

        this._arcOwed += dt * 34.0 * this.power;
        let count = this._arcOwed | 0;
        if (count <= 0) return;
        this._arcOwed -= count;
        if (count > 3) count = 3;

        for (let i = 0; i < count; i++) {
            // Somewhere along the body, measured back from the head.
            const d0 = this.travelled - Math.random() * LANCE_LEN * 0.55;
            const d1 = d0 - (1.5 + Math.random() * 5.0);
            const off = () => (Math.random() - 0.5) * LANCE_R * 2.2;
            arcs.spawn(
                false,
                this.ox + this.dx * d0 + off(), this.oy + this.dy * d0 + off(),
                this.oz + this.dz * d0 + off(),
                this.ox + this.dx * d1 + off(), this.oy + this.dy * d1 + off(),
                this.oz + this.dz * d1 + off(),
                0.9, 0.05 + Math.random() * 0.07, 0.05 + Math.random() * 0.06,
                1.1 + 0.7 * this.power, 0
            );
        }
    }

    /** Powder torn off the lance as it goes. */
    _trail(step) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        // Past a hundred metres these are sub-pixel and would only be spending
        // pool slots the arrival gust is about to want.
        if (!sp || this.travelled > 120) return;

        const perMetre = 3.2 * ctx.sprayScale;
        this._trailOwed += step;
        let count = (this._trailOwed * perMetre) | 0;
        if (count <= 0) return;
        this._trailOwed -= count / perMetre;
        if (count > 40) count = 40;

        for (let i = 0; i < count; i++) {
            // Fractional positions along the step, so the trail is continuous
            // rather than a burst per frame — the same rule the surf plume uses.
            const d = this.travelled - Math.random() * step;
            const x = this.ox + this.dx * d;
            const y = this.oy + this.dy * d;
            const z = this.oz + this.dz * d;
            const a = Math.random() * Math.PI * 2;
            const r = 0.3 + Math.random() * 1.5;

            sp.emit(
                x + Math.cos(a) * r,
                y + (Math.random() - 0.5) * 1.2,
                z + Math.sin(a) * r,
                Math.cos(a) * 2.6 - this.dx * 5.0,
                (Math.random() - 0.3) * 2.0,
                Math.sin(a) * 2.6 - this.dz * 5.0,
                0.07 + Math.random() * 0.13,
                0.5 + Math.random() * 0.8,
                0,
                2.2
            );
        }
    }

    // -------------------------------------------------------------- detonation

    _detonate() {
        const ctx = this.ctx;
        this.t = 0;
        this._shock = 0;
        this._shockHit = false;
        this._falloutOwed = 0;
        this._burnOwed = 0;
        this._blastArcOwed = 0;
        this._implodeOwed = 0;
        this._discOwed = 0;
        if (ctx.circle) ctx.circle.hide();

        // Put the ring's seam — where its tube tapers to nothing at both ends —
        // on the far side of the blast from the caster, and fix it there. It is
        // the one part of a closed sweep that cannot be hidden by the geometry
        // itself, so it is hidden behind the pillar instead.
        const ch = ctx.controller;
        this._seam = Math.atan2(this.iz - ch.position.z, this.ix - ch.position.x);

        this._blastKind =
            S.cometBlast === "pillar" ? "pillar"
            : S.cometBlast === "disc" ? "disc"
            : "dome";

        if (this._blastKind === "pillar") {
            this.phase = P_BLAST;
            this._blastThrow();
            this._fireball();
            this._strike();
            return;
        }

        // Neither of the other two goes off on impact. They draw in first.
        this.phase = P_IMPLODE;
        this._flash = 0;
    }

    // --------------------------------------------------------------- implosion

    /**
     * The draw-in, and then the silence.
     *
     * Snow is torn off the ground and thrown *inward*, lightning is struck from
     * a shell toward the middle, and a ring on the surface closes on the impact
     * point. All three tighten together and all three stop dead at
     * `IMPLODE_TIME`, leaving `HOLD_TIME` of an almost empty frame.
     *
     * The light is the part worth reading twice. It brightens as the mass
     * converges — energy going into a smaller and smaller volume — and is then
     * cut to nothing for the hold. Leaving even a dim glow burning through that
     * pause halves the flash, because a flash is a *ratio* and not a value.
     */
    _updateImplode(dt) {
        const ctx = this.ctx;
        this.t += dt;
        const P = this.power;

        const draw = clamp01(this.t / IMPLODE_TIME);
        const held = this.t > IMPLODE_TIME;

        if (!held) {
            this._implodeArcs(dt, draw, P);
            this._implodeSpray(dt, draw, P);
        }
        this._implodeRing(draw, P, held);

        if (!held) {
            // Small and getting brighter, rather than big and getting dimmer:
            // the radius closes with the mass so the lit patch of snow shrinks
            // to a point instead of fading out where it stands.
            const k = draw * draw;
            ctx.lights.add(
                this.ix, this.iy + 3.0 + 6.0 * (1 - draw), this.iz,
                IMPLODE_R * P * (1.1 - 0.75 * draw),
                0.46, 0.74, 1.0,
                (30.0 + 900.0 * k) * P
            );
        }

        if (this.t >= IMPLODE_TIME + HOLD_TIME) this._seismicDetonate();
    }

    /** Lightning struck inward, from a closing shell toward the middle. */
    _implodeArcs(dt, draw, P) {
        const arcs = this.ctx.arcs;
        if (!arcs) return;

        this._implodeOwed += dt * (60.0 + 220.0 * draw) * P;
        let count = this._implodeOwed | 0;
        if (count <= 0) return;
        this._implodeOwed -= count;
        if (count > 14) count = 14;

        const shell = IMPLODE_R * P * (1.0 - 0.72 * draw);
        for (let i = 0; i < count; i++) {
            const u = Math.random() * 2 - 1;
            const th = Math.random() * Math.PI * 2;
            const su = Math.sqrt(Math.max(0, 1 - u * u));
            // Biased into the upper hemisphere: below the impact point there is
            // ground, and a bolt drawn up out of the snow reads better than one
            // drawn through it.
            const nx = su * Math.cos(th), ny = Math.abs(u) * 0.9 + 0.05, nz = su * Math.sin(th);
            const inner = shell * (0.05 + Math.random() * 0.22);
            arcs.spawn(
                false,
                this.ix + nx * shell, this.iy + ny * shell + 1.0, this.iz + nz * shell,
                this.ix + nx * inner, this.iy + ny * inner + 1.0, this.iz + nz * inner,
                shell * 0.22, (0.25 + Math.random() * 0.8) * P,
                0.07 + Math.random() * 0.11,
                1.1 + 1.3 * draw, 0
            );
        }
    }

    /** Snow torn off the ground and thrown at the middle. */
    _implodeSpray(dt, draw, P) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp) return;

        const n = ((90 + 520 * draw) * ctx.sprayScale * P * dt) | 0;
        const shell = IMPLODE_R * P * (1.0 - 0.55 * draw);
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = shell * (0.35 + Math.random() * 0.65);
            const x = this.ix + Math.cos(a) * r;
            const z = this.iz + Math.sin(a) * r;
            const y = ctx.terrain.heightAt(x, z) + Math.random() * 3.0;
            // Aimed at the middle and fast enough to arrive before the hold.
            // Low drag, or the air stops them where they were lifted and the
            // whole thing reads as snow rising rather than snow being taken.
            const sx = this.ix - x, sy = this.iy + 5.0 - y, sz = this.iz - z;
            const l = Math.hypot(sx, sy, sz) || 1;
            const v = (24 + Math.random() * 46) * (0.5 + 0.5 * draw);
            sp.emit(
                x, y, z,
                (sx / l) * v, (sy / l) * v + 3.0, (sz / l) * v,
                1.1 + Math.random() * 2.6,
                0.30 + Math.random() * 0.45,
                Math.random() < 0.2 ? 1 : 0,
                0.22
            );
        }
    }

    /** A ring on the snow, closing on the impact point. */
    _implodeRing(draw, P, held) {
        const s = this.strandLance;
        if (s < 0) return;
        const ctx = this.ctx;
        const water = ctx.water;
        const terrain = ctx.terrain;

        const R = IMPLODE_R * P * (1.0 - 0.93 * draw);
        if (held || R < 1.5) {
            water.setParams(s, PROFILE_TUBE, 0.9, 0, 0);
            return;
        }

        // It thickens as it closes — the same mass around a shorter circle.
        const thick = 1.6 * P * (0.35 + 1.5 * draw);

        let dist = 0;
        let px = 0, py = 0, pz = 0;
        for (let c = 0; c < COLS; c++) {
            const u = c / (COLS - 1);
            const ang = this._seam + u * Math.PI * 2;
            const cs = Math.cos(ang);
            const sn = Math.sin(ang);
            const x = this.ix + cs * R;
            const z = this.iz + sn * R;
            const y = terrain.heightAt(x, z) + thick * 0.5;
            if (c > 0) dist += Math.hypot(x - px, y - py, z - pz);
            const taper = Math.pow(bell(u), 0.30);
            const lump = 0.8 + 0.3 * Math.sin(ang * 7.0 + draw * 9.0);
            water.column(
                s, c, x, y, z, thick * taper * lump,
                cs, 0, sn, 0, dist, u, 0.75, 0.5
            );
            px = x; py = y; pz = z;
        }
        water.setParams(s, PROFILE_TUBE, 0.86, clamp01(draw * 3.0), COLS);
    }

    // ------------------------------------------------------------- the front

    _seismicDetonate() {
        const ctx = this.ctx;
        const P = this.power;
        this.phase = P_BLAST;
        this.t = 0;
        this._shock = 0;
        this._shockHit = false;
        this._flash = 1;
        this._falloutOwed = 0;
        // Reset here as well as in `_detonate`, now that the dome has a
        // fireball of its own. Without it a cast that follows a `pillar` starts
        // with whatever fractional debt that left behind and dumps a batch of
        // embers on the first frame — invisible at these rates, but the kind of
        // thing that only ever shows up when the settings have been switched
        // between casts, which is exactly what this enum is for.
        this._burnOwed = 0;
        this._blastArcOwed = 0;
        this._discOwed = 0;

        // How far the front is allowed to get, fixed here.
        //
        // Never less than the distance back to the caster: without that floor a
        // half-power shot fired 250 m out has a 215 m front, so it stops short,
        // and the shock still arrives on schedule from something the player
        // watched come to a halt. The front and the clock are only one object
        // if the front actually gets here.
        this._frontMax = Math.max(RING_MAX * P, this.range * 1.15);

        // The flat front draws no water geometry at all — it is the disc mesh,
        // the arcs, the spray and the lights. The dome needs both strands: the
        // hemisphere on one and the wall it becomes on the other.
        if (this._blastKind === "disc") {
            if (this.strandLance >= 0) {
                ctx.water.setParams(this.strandLance, PROFILE_TUBE, 0.9, 0, 0);
            }
            if (this.strandRing >= 0) {
                ctx.water.setParams(this.strandRing, PROFILE_TUBE, 0.9, 0, 0);
            }
        }

        // The plane of the front. The axis starts as the shot direction — which
        // puts the disc square to the player, since they are standing behind the
        // shot — and is then tipped toward vertical by `DISC_TILT` so it comes
        // across as an ellipse rather than a flat ring. See that constant.
        let ax = this.dx * (1 - DISC_TILT);
        let ay = this.dy * (1 - DISC_TILT) + DISC_TILT;
        let az = this.dz * (1 - DISC_TILT);
        const al = Math.hypot(ax, ay, az) || 1;
        ax /= al; ay /= al; az /= al;
        this._ax = ax; this._ay = ay; this._az = az;

        // In-plane basis, built the same way `MagicCircle.setFrame` builds its
        // own — so the rim this file walks and the rim the shader draws are the
        // same circle.
        let rx, ry, rz;
        if (Math.abs(ay) > 0.995) { rx = 0; ry = 0; rz = 1; }
        else { rx = -az; ry = 0; rz = ax; }
        const rl = Math.hypot(rx, ry, rz) || 1;
        rx /= rl; ry /= rl; rz /= rl;
        this._drx = rx; this._dry = ry; this._drz = rz;
        // up = axis x right
        this._dux = ay * rz - az * ry;
        this._duy = az * rx - ax * rz;
        this._duz = ax * ry - ay * rx;

        this._blastThrow();
        this._seismicStrike();
        ctx.rig.addTrauma(0.05);
    }

    /** The bolts thrown outward at the flash. */
    _seismicStrike() {
        const arcs = this.ctx.arcs;
        if (!arcs) return;
        const P = this.power;

        const n = 14 + Math.round(30 * P);
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + Math.random() * (Math.PI * 2 / n);
            const ca = Math.cos(a), sa = Math.sin(a);
            let ox, oy, oz;
            if (this._blastKind === "dome") {
                // Up and out over the shell that is about to exist, rather than
                // flat in a plane: the dome's silhouette is a curve and the
                // first bolts have to be climbing it.
                const el = 0.25 + Math.random() * 1.0;
                const ce = Math.cos(el);
                ox = ca * ce; oy = Math.sin(el); oz = sa * ce;
            } else {
                ox = this._drx * ca + this._dux * sa;
                oy = this._dry * ca + this._duy * sa;
                oz = this._drz * ca + this._duz * sa;
            }
            const lift = this._blastKind === "dome" ? 1.0 : DISC_LIFT;
            const r0 = 2.0 + Math.random() * 8.0;
            const r1 = (26 + Math.random() * 70) * P;
            arcs.spawn(
                false,
                this.ix + ox * r0, this.iy + lift + oy * r0, this.iz + oz * r0,
                this.ix + ox * r1, this.iy + lift + oy * r1, this.iz + oz * r1,
                9.0 * P, (0.4 + Math.random() * 1.5) * P,
                0.14 + Math.random() * 0.26,
                1.8 + Math.random() * 1.3,
                0
            );
        }
    }

    /**
     * The expanding front.
     *
     * Its radius **is** `_shock` — the scalar clock that decides when the caster
     * feels it. The two used to be separate: an invisible number racing outward
     * and a drawn thing kept roughly in step with it. Making them one object
     * means what you watch coming is exactly what hits you, and the wait stops
     * being a coincidence of two constants agreeing.
     */
    _updateDisc(dt) {
        const ctx = this.ctx;
        this.t += dt;
        const t = this.t;
        const P = this.power;

        if (t >= SEISMIC_LIFE) {
            this._end();
            return;
        }

        this._flash = Math.max(0, this._flash - dt / FLASH_TIME);

        // Advances `_shock` and fires `_arrive` when it passes the caster. Its
        // own travelling light is suppressed — the front has one of its own.
        this._shockFront(dt, false);

        const reach = Math.max(DISC_MAX * P, this.range * 1.15);
        const R = Math.min(this._shock, reach);
        // Spent once it stops growing, and gone shortly after.
        const spent = clamp01((this._shock - reach) / 70);
        const env = (1 - spent) * (1 - smooth01((t - (SEISMIC_LIFE - 1.0)) / 1.0));

        const circle = ctx.circle;
        if (circle) {
            if (R > 1.5 && env > 0.005) {
                circle.mode = 1;
                circle.setFrame(
                    this.ix, this.iy + DISC_LIFT, this.iz,
                    this._ax, this._ay, this._az, R
                );
                circle.update(dt, 1, env, this._flash);
            } else {
                circle.hide();
            }
        }

        this._discGround(dt, R, env, P);
        this._discArcs(dt, R, env, P);
        this._fallout(dt, t);

        // The flash. Enormous, white, and over in a sixth of a second — see the
        // note on `spellAttenuation` in the pillar's light: over a 300 m window
        // the inverse square costs four orders of magnitude that a close light
        // never pays, so the number is only meaningful against its radius.
        if (this._flash > 0.002) {
            const f = this._flash * this._flash;
            ctx.lights.add(
                this.ix, this.iy + DISC_LIFT, this.iz,
                300.0, 0.88, 0.95, 1.0, 42000.0 * f * P
            );
        }

        // And a cooler one carried by the front itself, so the snow lights up in
        // a band that sweeps outward with it.
        if (env > 0.01) {
            ctx.lights.add(
                this.ix, this.iy + DISC_LIFT * 0.6, this.iz,
                Math.max(70.0, R * 1.25), 0.46, 0.76, 1.0,
                3400.0 * env * P
            );
        }
    }

    /**
     * The radius of the front, whichever front this cast is drawing.
     *
     * Fast out of the crater and decelerating hard, which is what a shell
     * running into still air does. One curve, shared: under the dome this is
     * simultaneously the hemisphere's radius and the wall's centre line, which
     * is what makes the handoff between them free.
     *
     * @param {number} t seconds since the flash
     * @param {number} maxR metres it asymptotes toward
     */
    _frontRadius(t, maxR) {
        return maxR * (1 - Math.exp(-t * 1.25));
    }

    // ------------------------------------------------------------------- dome

    /**
     * Hemisphere into rolling wall.
     *
     * The dome and the wall are drawn at the same radius off `_frontRadius`, so
     * they are never two objects being kept in step — the dome's equator *is*
     * the wall's centre line at every instant. The conversion is then nothing
     * but the dome fading from the top while the wall thickens underneath it,
     * and it needs no cross-fade logic at all.
     */
    _updateDome(dt) {
        const ctx = this.ctx;
        this.t += dt;
        const t = this.t;
        const P = this.power;

        if (t >= DOME_LIFE) {
            this._end();
            return;
        }

        this._flash = Math.max(0, this._flash - dt / FLASH_TIME);

        const R = this._frontRadius(t, this._frontMax);
        // The front is the clock: what the player watches crossing the field is
        // the thing that eventually hits them.
        this._shock = R;
        this._checkArrival(R);

        // The shell gives way from the top down, and now it actually does.
        //
        // This used to be one scalar into the strand's alpha, which fades a
        // surface of revolution uniformly — the comment claimed a top-down
        // give-way and the code dissolved the whole shell at once. Alpha and
        // milkiness are per-*strand* (`setParams`), so a fade can never be
        // top-down; but radius and foam are per-*column*, so the rim can be.
        // `tear` is where that rim has got to, and `_dome` starts the sweep
        // there rather than at the pole.
        const tear = smooth01((t - DOME_HOLD) / DOME_TEAR);
        // Presence. Snapped on with the flash — a dome that fades *in* is a
        // light being turned up, and the whole point of the held beat before it
        // was to earn a hard cut. It then thins far more slowly than the tear
        // runs, because the give-way is geometric now and the alpha only has to
        // take the last of it out. Squared, so the shell is still at three
        // quarters opacity when the rim is halfway down.
        const domeEnv = smooth01(t / 0.05) * (1 - tear * tear);

        this._dome(R, domeEnv, tear, P);
        this._surge(t, this._frontMax);
        this._frontGround(dt, R, domeEnv, P);
        this._domeArcs(dt, R, domeEnv, tear, P);
        this._domeBurn(dt, t);
        this._fallout(dt, t);

        // The flash. Enormous, white, and over in a sixth of a second — see the
        // note on `spellAttenuation` in the pillar's light: over a 300 m window
        // the inverse square costs four orders of magnitude that a close light
        // never pays, so the number is only meaningful against its radius.
        if (this._flash > 0.002) {
            const f = this._flash * this._flash;
            ctx.lights.add(
                this.ix, this.iy + 12.0, this.iz,
                300.0, 0.88, 0.95, 1.0, 42000.0 * f * P
            );
        }

        // The fireball's own light: warm, low, and tight enough to stay under
        // the shell. An orange light running the snow's own subsurface term is
        // what puts the glow *through* the drifts around the crater instead of
        // on them — the same reason the pillar's core light is warm, and the
        // whole reason this is worth a slot of its own rather than being folded
        // into the glow below.
        //
        // 4200 at 110 m. `spellAttenuation` is a windowed inverse square, so
        // the number only means anything against its radius: the two known-good
        // pairings here are Bloom's 11 m / 22 and the pillar's 210 m / 9000,
        // which sit on a slope of very nearly radius², and that puts
        // pillar-equivalent brightness at this radius around 2400. This is
        // 1.75x that — brighter than the pillar's core because it is a tighter
        // ball of the same fire, and well short of the 3.5x the cool glow below
        // already runs at.
        const burn = smooth01(t / 0.08) * (1 - smooth01((t - 0.30) / 1.15));
        if (burn > 0.01) {
            ctx.lights.add(
                this.ix, this.iy + 6.0, this.iz,
                110.0, 1.00, 0.46, 0.16, 4200.0 * burn * P
            );
        }

        // And a cooler one inside the shell, so the snow under the dome lights
        // up and the wall carries a glow outward with it as it takes over.
        //
        // It cools as the fire goes out rather than being blue from the first
        // frame: while the core is alight the shell is being lit from inside by
        // something burning, and a cold interior over an orange fireball is two
        // lights disagreeing about the same volume. The colour is crossed on
        // `burn`, so by the time the wall is alone this is exactly the
        // blue-white it always was.
        const glow = Math.max(domeEnv, 1 - smooth01((t - 1.2) / 2.4));
        if (glow > 0.01) {
            ctx.lights.add(
                this.ix, this.iy + R * 0.25, this.iz,
                Math.max(70.0, R * 1.3),
                0.52 + 0.42 * burn,
                0.74 - 0.16 * burn,
                1.0 - 0.42 * burn,
                3200.0 * glow * P
            );
        }
    }

    /**
     * The hemisphere.
     *
     * A vertical spine with a circular radius profile, which is a surface of
     * revolution about that spine and therefore a hemisphere by construction —
     * the same trick the charging ball used, stood on its end and cut in half.
     * The tangent is constant, so the section frame needs no transport: a fixed
     * reference right vector is already the transported one.
     *
     * The spine is carried past the equator and under the snow by `SKIRT`, with
     * the profile held at full radius through that stretch. The sweep therefore
     * ends on an open disc, which the convention forbids — except that disc is
     * several metres underground, which is the same allowance the pillar makes
     * for its base pinch.
     *
     * **The top end deliberately ends on an open disc too, once `tear` is up,
     * and that one is not buried.** It is the hole. A surface of revolution
     * whose sweep starts at `hN = 0.5` has a rim there of radius `0.866 R` and
     * nothing above it, so the eye looks straight through and sees the inside
     * of the far wall — which is exactly what a shell venting from the top
     * should show, and is free because the missing cap was never drawn anyway.
     *
     * @param {number} R front radius
     * @param {number} env 0..1 opacity of the shell
     * @param {number} tear 0..1 how far the rim has descended from the pole
     * @param {number} P power
     */
    _dome(R, env, tear, P) {
        const s = this.strandLance;
        if (s < 0) return;
        const water = this.ctx.water;
        const tm = this.ctx.time;

        if (env < 0.004 || R < 1.5) {
            water.setParams(s, PROFILE_TUBE, 0.9, 0, 0);
            return;
        }

        const SKIRT = 0.14;
        // The rim descends from the pole to the equator. At `tear` = 0 the two
        // lines below collapse to `hN = 1 - u * (1 + SKIRT)`, which is exactly
        // what this was before any of it existed — the closed shell is
        // unchanged and only the giving-way is new.
        const hTop = 1 - tear;
        const hBot = -SKIRT;
        // The shell breaks up as it gives way rather than staying a clean
        // mathematical surface to the last frame. Amplitude only — the phases
        // and frequencies are the ones that were already here, so a shell that
        // has not started tearing boils exactly as it used to. Held to 1.8 at
        // full tear: the profile is a radius, so a ±45% swing is a shell
        // pulsing like a jellyfish rather than one coming apart.
        const boilAmp = 1 + 1.8 * tear;
        let py = 0;
        let dist = 0;

        for (let c = 0; c < COLS; c++) {
            const u = c / (COLS - 1);
            // Column 0 is the rim — the leading edge of what is left of the
            // shell, and the pole itself only while `tear` is zero. Same "u is
            // distance behind the head" convention every strand here follows;
            // the head has simply started moving.
            const hN = hTop + (hBot - hTop) * u;
            const y = this.iy + hN * R;
            const prof = hN > 0 ? Math.sqrt(Math.max(0, 1 - hN * hN)) : 1;
            // A slow boil, keyed to the section parameter rather than to world
            // height so it does not crawl down the shell as the shell grows.
            // Note the amplitude multiplies each term rather than their sum.
            // That is not a style choice: factoring it out re-associates the
            // addition, and `(0.93 + a) + b` and `0.93 + (a + b)` round
            // differently. The grouping here is the original's, so multiplying
            // by exactly 1.0 leaves an untorn shell bit-identical rather than
            // one ULP away from it — which is the difference between a claim
            // that can be tested and one that cannot.
            const boil = 0.93 + 0.09 * Math.sin(u * 7.0 + tm * 2.2) * boilAmp
                              + 0.05 * Math.sin(u * 17.0 - tm * 3.1) * boilAmp;

            if (c > 0) dist += Math.abs(y - py);

            // Brightest at the rim, and both hotter and tighter there the
            // further it has torn. The gradient itself crosses from linear to
            // squared on `tear`, which is what keeps the heat *on* the edge
            // instead of washing down the whole shell — the rim is the part
            // still being driven, and the ragged bright line descending is what
            // carries the read.
            //
            // Written as a blend from the original rather than replacing it, so
            // a shell that has not started tearing is lit exactly as it always
            // was. Every term in this function has that property: at `tear` = 0
            // the closed hemisphere is unchanged to the last bit.
            const rim = 1 - u;
            const grad = rim + (rim * rim - rim) * tear;
            const foam = clamp01(0.30 + (0.60 + 0.90 * tear) * grad);

            water.column(
                s, c, this.ix, y, this.iz, R * prof * boil,
                1, 0, 0, 0,
                dist, u, foam,
                1
            );
            py = y;
        }

        // Dense at the flash and thinning to gauze as it gives way, so the far
        // wall of the shell shows through the near one on the way out — which
        // is most of what keeps it a volume rather than a painted dome.
        water.setParams(s, PROFILE_TUBE, 0.62 + 0.30 * env, clamp01(env * 1.5), COLS);
    }

    /**
     * The fireball under the shell.
     *
     * Every other light in this detonation is blue-white — the flash is
     * `0.88, 0.95, 1.0` and the interior glow `0.52, 0.74, 1.0` — so before
     * this there was no warm anything in the `dome` path at all. `_burn` exists
     * but is the pillar's, and is column-shaped: it fills a 90 m stem. This is
     * the same idea at the other proportion, a low churning mass at the crater
     * that stays well inside the shell.
     *
     * **The point of it is that it is seen *through* the dome.** The shell
     * draws at `0.62 + 0.30 * env` milkiness and a matching alpha, so it
     * transmits — a hot core under a cold shockwave is the strongest contrast
     * available in this effect, and it costs one particle population and one
     * light because the ember `kind` and the warm-light precedent were both
     * already here.
     *
     * It also has to be *out* before the wall is all that is left. A fireball
     * still burning when the surge has taken over is a fire being dragged
     * across the field by a wall of snow.
     */
    _domeBurn(dt, t) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp) return;
        const P = this.power;

        // Alight through the shell's whole standing life and gone a little
        // before it — `DOME_HOLD + DOME_TEAR` is 1.41 s and this is spent by
        // about 1.27, so the last of the dome is already cooling when it goes.
        const k = smooth01(t / 0.10) * (1 - smooth01((t - 0.22) / 1.05));
        if (k <= 0.01) return;

        this._burnOwed += dt * 300.0 * ctx.sprayScale * k * P;
        let count = this._burnOwed | 0;
        if (count <= 0) return;
        this._burnOwed -= count;
        if (count > 48) count = 48;

        // Bounded by the front as it stands *now*, not by where the front is
        // eventually going. That distinction is the whole of this line and it
        // was wrong first time round: capping against `_frontMax` let the ball
        // out through the shell for the first tenth of a second on any blast
        // under about 200 m, because the front starts at zero and grows while
        // the fireball is running its own clock. Measured, a 60 m front at full
        // power had a core three and a half times its radius.
        //
        // 0.45 of the live radius keeps it comfortably inside at every instant;
        // the absolute term then stops a 200 m blast from having a 90 m
        // fireball, which stops being a core and becomes the explosion. Only
        // that term carries the power — the radius one is scaled by `R` already.
        const R = this._frontRadius(t, this._frontMax);
        const rr = Math.min(R * 0.45, (5.0 + 30.0 * smooth01(t / 0.8)) * P);

        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            // Square root, so the disc is filled evenly rather than crowded at
            // the middle — the naive uniform radius bunches everything at the
            // axis and the ball reads as a bright spot with a halo.
            const r = Math.sqrt(Math.random()) * rr;
            // Squared, so most of the mass sits low and it thins upward. Fire
            // rises, but the part of it that is *bright* is at the bottom.
            const h = Math.random() * Math.random();
            sp.emit(
                this.ix + Math.cos(a) * r,
                this.iy + 1.5 + h * rr * 0.95,
                this.iz + Math.sin(a) * r,
                Math.cos(a) * (2.0 + Math.random() * 7.0),
                5.0 + Math.random() * 20.0,
                Math.sin(a) * (2.0 + Math.random() * 7.0),
                2.2 + Math.random() * 5.0,
                1.2 + Math.random() * 1.6,
                2,
                0.55 + Math.random() * 0.5
            );
        }
    }

    /** Snow thrown up along the ring where the shell meets the ground. */
    _frontGround(dt, R, env, P) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp || R < 3) return;

        // Driven by the wall rather than the dome, so it keeps going after the
        // shell has thinned out — the surge is still ploughing along the ground
        // for seconds after the dome above it is gone.
        const k = Math.max(env, 1 - smooth01((this.t - 1.0) / 2.6));
        if (k < 0.02) return;

        this._discOwed += dt * 380.0 * ctx.sprayScale * k * P;
        let count = this._discOwed | 0;
        if (count <= 0) return;
        this._discOwed -= count;
        if (count > 36) count = 36;

        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const ca = Math.cos(a), sa = Math.sin(a);
            // Straddling the front rather than sitting on it: the wall has real
            // thickness and the snow it is turning over is spread across it.
            const rr = R * (0.86 + Math.random() * 0.22);
            const x = this.ix + ca * rr;
            const z = this.iz + sa * rr;
            const g = ctx.terrain.heightAt(x, z);
            const out = (9 + Math.random() * 24) * P;
            sp.emit(
                x, g + Math.random() * 3.0, z,
                ca * out + (Math.random() - 0.5) * 5,
                7 + Math.random() * 26,
                sa * out + (Math.random() - 0.5) * 5,
                1.0 + Math.random() * 2.8,
                1.8 + Math.random() * 2.6,
                Math.random() < 0.18 ? 1 : 0,
                0.5
            );
        }
    }

    /**
     * Bolts crawling over the shell, and along the wall once it is alone.
     *
     * @param {number} tear 0..1 — the rim's elevation, which the discharge
     *   tracks. See below for why it is not simply the base any more.
     */
    _domeArcs(dt, R, env, tear, P) {
        const arcs = this.ctx.arcs;
        if (!arcs || R < 4) return;

        const k = Math.max(env, 0.35 * (1 - smooth01((this.t - 0.9) / 1.8)));
        if (k < 0.04) return;

        this._blastArcOwed += dt * 170.0 * k * P;
        let count = this._blastArcOwed | 0;
        if (count <= 0) return;
        this._blastArcOwed -= count;
        if (count > 12) count = 12;

        // The rim's elevation in radians, which is where the discharge wants to
        // be once the shell has started venting from the top. It also does the
        // one thing the surface of revolution cannot do for itself: the rim is
        // a mathematically perfect circle, and a scatter of bolts sitting on it
        // is what stops the eye reading it as one.
        const rimE = Math.asin(clamp01(1 - tear));

        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            // Biased toward the base: the shell is being driven from the ground
            // and the discharge belongs where the energy is, not on the cap.
            // As the shell tears, a share of it migrates up to the rim instead
            // — that edge is now the part being driven, and leaving every bolt
            // at the foot of a shell whose top is coming apart puts the light
            // in the one place nothing is happening.
            const onRim = tear > 0.05 && Math.random() < 0.30 + 0.45 * tear;
            const e0 = onRim
                ? clamp01(rimE / 1.57 + (Math.random() - 0.5) * 0.16) * 1.57
                : Math.random() * Math.random() * 1.35;
            const e1 = clamp01(e0 / 1.35 + (Math.random() - 0.35) * 0.30) * 1.35;
            const span = (Math.random() - 0.5) * 0.55;
            const p0x = Math.cos(a) * Math.cos(e0), p0y = Math.sin(e0);
            const p0z = Math.sin(a) * Math.cos(e0);
            const p1x = Math.cos(a + span) * Math.cos(e1), p1y = Math.sin(e1);
            const p1z = Math.sin(a + span) * Math.cos(e1);
            arcs.spawn(
                false,
                this.ix + p0x * R, this.iy + p0y * R, this.iz + p0z * R,
                this.ix + p1x * R, this.iy + p1y * R, this.iz + p1z * R,
                R * 0.07, (0.3 + Math.random() * 1.1) * P,
                0.08 + Math.random() * 0.16,
                1.4 + Math.random() * 1.1,
                0
            );
        }
    }

    /**
     * Snow thrown up where the rim scythes through the surface.
     *
     * The front is a plane and the snow is a landscape, so they meet along a
     * curve rather than at a ring — and that curve is the only place the effect
     * touches anything. Walking the rim and testing each sample against the
     * heightfield finds it for the cost of a few `heightAt` lookups, and gets
     * the dune-following for free.
     */
    _discGround(dt, R, env, P) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp || R < 3 || env < 0.02) return;

        this._discOwed += dt * 340.0 * ctx.sprayScale * env * P;
        let count = this._discOwed | 0;
        if (count <= 0) return;
        this._discOwed -= count;
        if (count > 34) count = 34;

        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const ca = Math.cos(a), sa = Math.sin(a);
            const ox = this._drx * ca + this._dux * sa;
            const oy = this._dry * ca + this._duy * sa;
            const oz = this._drz * ca + this._duz * sa;

            const x = this.ix + ox * R;
            const y = this.iy + DISC_LIFT + oy * R;
            const z = this.iz + oz * R;
            const g = ctx.terrain.heightAt(x, z);
            // Only where the rim is actually in the snow. The band is wide
            // because the rim moves 5 m between frames at this speed.
            if (Math.abs(y - g) > 16) continue;

            const out = (10 + Math.random() * 26) * P;
            sp.emit(
                x + (Math.random() - 0.5) * 6, g + Math.random() * 2.5,
                z + (Math.random() - 0.5) * 6,
                ox * out + (Math.random() - 0.5) * 5,
                6 + Math.random() * 22,
                oz * out + (Math.random() - 0.5) * 5,
                0.9 + Math.random() * 2.6,
                1.6 + Math.random() * 2.4,
                Math.random() < 0.18 ? 1 : 0,
                0.5
            );
        }
    }

    /** Bolts skittering along the rim as it goes. */
    _discArcs(dt, R, env, P) {
        const arcs = this.ctx.arcs;
        if (!arcs || R < 4 || env < 0.05) return;

        this._blastArcOwed += dt * 150.0 * env * P;
        let count = this._blastArcOwed | 0;
        if (count <= 0) return;
        this._blastArcOwed -= count;
        if (count > 10) count = 10;

        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            // A short chord of the rim, so the bolt runs *along* the front
            // rather than across it — the front is a surface and the lightning
            // has to look like it is travelling in that surface.
            const span = (0.06 + Math.random() * 0.16) * (Math.random() < 0.5 ? -1 : 1);
            const rr = R * (0.90 + Math.random() * 0.10);
            const p0 = a, p1 = a + span;
            const b0x = this._drx * Math.cos(p0) + this._dux * Math.sin(p0);
            const b0y = this._dry * Math.cos(p0) + this._duy * Math.sin(p0);
            const b0z = this._drz * Math.cos(p0) + this._duz * Math.sin(p0);
            const b1x = this._drx * Math.cos(p1) + this._dux * Math.sin(p1);
            const b1y = this._dry * Math.cos(p1) + this._duy * Math.sin(p1);
            const b1z = this._drz * Math.cos(p1) + this._duz * Math.sin(p1);
            arcs.spawn(
                false,
                this.ix + b0x * rr, this.iy + DISC_LIFT + b0y * rr, this.iz + b0z * rr,
                this.ix + b1x * rr, this.iy + DISC_LIFT + b1y * rr, this.iz + b1z * rr,
                R * 0.05, (0.3 + Math.random() * 1.0) * P,
                0.07 + Math.random() * 0.14,
                1.4 + Math.random() * 1.0,
                0
            );
        }
    }

    /**
     * The discharge at the instant of impact.
     *
     * Everything the charge was holding arrives at once. These are an order of
     * magnitude bigger than the bolts around the ball — tens of metres long and
     * a metre wide — because they are being read at a quarter of a kilometre,
     * where the ball's centimetre-wide filaments would not survive one pixel.
     *
     * Struck outward and *upward* rather than radially: the column is what the
     * eye follows, and lightning climbing it says the energy went up with it.
     */
    _strike() {
        const arcs = this.ctx.arcs;
        if (!arcs) return;
        const P = this.power;

        const n = 16 + Math.round(34 * P);
        for (let i = 0; i < n; i++) {
            // Spread round the circle by index rather than at random, with the
            // jitter added on top. Fifty bolts placed by `random()` alone leave
            // gaps and clumps that read as an accident; one per sector plus a
            // sector of jitter covers the crater and still looks unplanned.
            const a = (i / n) * Math.PI * 2 + Math.random() * (Math.PI * 2 / n);
            const out = (14 + Math.random() * 54) * P;
            const up = (10 + Math.random() * 66) * P;
            const from = 1.5 + Math.random() * 7.0;
            arcs.spawn(
                false,
                this.ix + Math.cos(a) * from, this.iy + 0.5 + Math.random() * 6.0,
                this.iz + Math.sin(a) * from,
                this.ix + Math.cos(a) * out, this.iy + up, this.iz + Math.sin(a) * out,
                9.0 * P, (0.45 + Math.random() * 1.6) * P,
                0.16 + Math.random() * 0.30,
                1.5 + Math.random() * 1.2,
                // Warm, so they sit inside the fireball rather than on top of
                // it — see the note in `arc.fragment.wgsl`.
                0.55
            );
        }
    }

    /**
     * Lightning still running up the column behind the first strike.
     *
     * Dies away over about two seconds, a little slower than the flame does, so
     * the hand-off reads as fire first, then discharge, then lit powder — a
     * column that is visibly cooling through three stages rather than one.
     */
    _pillarArcs(dt, t) {
        const arcs = this.ctx.arcs;
        if (!arcs) return;
        const P = this.power;

        const k = smooth01(t / 0.12) * (1 - smooth01((t - 0.45) / 2.3));
        if (k <= 0.01) return;

        this._blastArcOwed += dt * 240.0 * k * P;
        let count = this._blastArcOwed | 0;
        if (count <= 0) return;
        this._blastArcOwed -= count;
        if (count > 18) count = 18;

        const top = PILLAR_H * P * (0.42 + 0.58 * smooth01(t / 1.4));

        for (let i = 0; i < count; i++) {
            // Biased low: the throat is where the column is being driven from,
            // and a bolt at the cap has nothing under it to have come from.
            const h0 = Math.random() * Math.random();
            const h1 = clamp01(h0 + 0.10 + Math.random() * 0.30);
            const a0 = Math.random() * Math.PI * 2;
            const a1 = a0 + (Math.random() - 0.5) * 1.6;
            const r0 = PILLAR_R * P * (0.30 + 0.95 * Math.random());
            const r1 = PILLAR_R * P * (0.30 + 1.10 * Math.random());

            arcs.spawn(
                false,
                this.ix + Math.cos(a0) * r0, this.iy + top * h0, this.iz + Math.sin(a0) * r0,
                this.ix + Math.cos(a1) * r1, this.iy + top * h1, this.iz + Math.sin(a1) * r1,
                PILLAR_R * P * 0.55, (0.35 + Math.random() * 1.0) * P,
                0.10 + Math.random() * 0.18,
                1.2 + Math.random() * 1.0,
                0.55
            );
        }
    }

    _updateBlast(dt) {
        const ctx = this.ctx;
        this.t += dt;
        const t = this.t;
        const P = this.power;

        if (t >= BLAST_LIFE) {
            this._end();
            return;
        }

        const rise = smooth01(t / RISE);
        const fall = 1 - smooth01((t - (BLAST_LIFE - 2.6)) / 2.6);
        const env = rise * fall;

        this._pillar(t, env);
        this._surge(t, RING_MAX * this.power);
        this._fallout(dt, t);
        this._burn(dt, t);
        this._pillarArcs(dt, t);
        this._shockFront(dt, true);

        // The core, low in the column — an explosion's light lives at its base,
        // and the cap being dimmer than the stem is the correct gradient rather
        // than a shortfall. Warm, because there is fire in it now: an orange
        // light running the snow's own subsurface term is what puts the glow
        // *through* the drifts around the crater instead of on them.
        //
        // The intensity looks absurd next to Bloom's 22 and it is the same
        // brightness. `spellAttenuation` is a *windowed* inverse square, so the
        // number is only meaningful against the radius it is paired with: over
        // 210 m the window costs four orders of magnitude that Bloom's 11 m never
        // pays.
        ctx.lights.add(
            this.ix, this.iy + PILLAR_H * P * 0.30 * rise, this.iz,
            210.0, 1.00, 0.50, 0.20, 9000.0 * env * P
        );
    }

    /**
     * The pillar.
     *
     * A stem with a cap on it. The cap is a bulb centred well up the column that
     * both climbs and widens as it goes, because a mushroom is not a shape — it
     * is what a shape does over four seconds, and freezing it at its final
     * silhouette is the difference between an explosion and a model of one.
     *
     * Radius closes to nothing at the top (the cap rolling over on itself) and at
     * the bottom, where the last few samples are below the snow line and the
     * pinch is buried.
     */
    _pillar(t, env) {
        const s = this.strandLance;
        if (s < 0) return;
        const water = this.ctx.water;
        const tm = this.ctx.time;
        const P = this.power;

        // The cap climbs from a third of the way up to the top over the first
        // couple of seconds, and spreads as it climbs.
        const climb = smooth01(t / 2.1);
        const capH = 0.52 + 0.30 * climb;
        const capW = 0.55 + 0.60 * climb;
        const top = PILLAR_H * P * (0.42 + 0.58 * smooth01(t / 1.4)) * env;

        // A slow lean, so the column is not an axis-aligned primitive.
        const leanX = Math.sin(t * 0.5 + 1.3) * 0.055;
        const leanZ = Math.cos(t * 0.42) * 0.055;

        let px = 0, py = 0, pz = 0;
        let rx = 1, ry = 0, rz = 0;
        let t0x = 0, t0y = -1, t0z = 0;
        let dist = 0;

        for (let c = 0; c < COLS; c++) {
            const u = c / (COLS - 1);
            const h = 1 - u;

            const lean = h * h;
            const x = this.ix + leanX * lean * top;
            const z = this.iz + leanZ * lean * top;
            // Started below the surface so the base pinch is buried in the snow
            // rather than showing as a disc standing on it.
            const y = this.iy - 5.0 + (top + 5.0) * h;

            if (c > 0) {
                let t1x = x - px, t1y = y - py, t1z = z - pz;
                const l = Math.hypot(t1x, t1y, t1z) || 1e-4;
                t1x /= l; t1y /= l; t1z /= l;
                dist += l;
                transport(_rgt, 0, rx, ry, rz, t0x, t0y, t0z, t1x, t1y, t1z);
                rx = _rgt[0]; ry = _rgt[1]; rz = _rgt[2];
                t0x = t1x; t0y = t1y; t0z = t1z;
            } else {
                rx = 1; ry = 0; rz = 0;
            }

            // cap  a bulb, closing to nothing at the very top
            // stem the throat feeding it
            // foot the base surge root, widest at the ground
            const cap = bell(clamp01((h - (capH - 0.30)) / 0.42)) * capW;
            const stem = 0.30 * (1 - smooth01((h - 0.06) / 0.55));
            const foot = 0.80 * (1 - smooth01(h / 0.13));
            // Boiling, keyed to world height so it does not travel with the cap.
            const boil = 0.86 + 0.20 * Math.sin(h * 11.0 + t * 2.4)
                       + 0.12 * Math.sin(h * 27.0 - t * 3.7);
            // Closes the buried base sample.
            const shut = 1 - smooth01((u - 0.94) / 0.06);

            const radius = PILLAR_R * P * (cap + stem + foot) * boil * shut * env;

            water.column(
                s, c, x, y, z, radius,
                rx, ry, rz, tm * 0.5 + h * 2.0,
                dist, u,
                // The cap is where it is coming apart; the throat is clean.
                clamp01(0.30 + 0.62 * smooth01((h - capH + 0.34) / 0.36)),
                1
            );

            px = x; py = y; pz = z;
        }

        // Nearly opaque. This is pulverised snow, not water — the small amount of
        // transparency left is what lets the far side of the cap show through the
        // near side, which is most of what keeps it a volume at this distance.
        water.setParams(s, PROFILE_TUBE, 0.90, clamp01(env * 1.5), COLS);
    }

    /**
     * The base surge: a low wall of powder running outward along the ground.
     *
     * A flattened tube swept round a circle. The reference frame handed in is the
     * outward radial, which for a planar circle *is* the parallel transport of
     * it — so the section's up axis comes out vertical, and `flatten` then
     * squashes exactly the axis that should be squashed. A wall of blast debris
     * is four times wider than it is tall.
     */
    _surge(t, maxR) {
        const s = this.strandRing;
        if (s < 0) return;
        const ctx = this.ctx;
        const water = ctx.water;
        const terrain = ctx.terrain;
        const P = this.power;

        const life = clamp01(t / RING_LIFE);
        if (life >= 1) {
            water.setParams(s, PROFILE_TUBE, 0.9, 0, 0);
            return;
        }

        // Fast out of the crater and decelerating hard, which is what a surge
        // running into still air does. The radius is handed in rather than
        // derived here, because under the dome it is also the hemisphere's own
        // radius and the two must be the same number — see `DOME_HOLD`.
        const R = this._frontRadius(t, maxR);
        // It thickens as it slows, then goes to nothing.
        //
        // Twenty metres, against the 7.5 this was originally tuned at. Doubling
        // the *radius* alone made the wall shorter to look at, not taller: the
        // ring now stands twice as far away, so the same wall subtends half the
        // angle it used to and the surge reads as a thinning line on the
        // horizon. Holding its apparent height means scaling with the distance
        // it is seen from, which is why this is nearly three times the original
        // rather than twice.
        const thick = 20.0 * P * smooth01(t / 0.7) * (1 - smooth01((life - 0.45) / 0.55));
        if (thick < 0.05 || R < 1) {
            water.setParams(s, PROFILE_TUBE, 0.9, 0, 0);
            return;
        }

        let rx = 1, ry = 0, rz = 0;
        let dist = 0;
        let px = 0, pz = 0, py = 0;

        for (let c = 0; c < COLS; c++) {
            const u = c / (COLS - 1);
            const ang = this._seam + u * Math.PI * 2;
            const cs = Math.cos(ang);
            const sn = Math.sin(ang);

            const x = this.ix + cs * R;
            const z = this.iz + sn * R;
            // Lifted by less than half the section's own height, so the wall
            // still meets the snow along its base rather than floating clear of
            // it — a 22 m wall hovering even a few metres up stops being a
            // ground surge and becomes a ring of cloud.
            const y = terrain.heightAt(x, z) + thick * 0.30;

            if (c > 0) dist += Math.hypot(x - px, y - py, z - pz);

            // The outward radial. Passed straight in rather than transported —
            // see the note above.
            rx = cs; ry = 0; rz = sn;

            // Tapers to nothing at the seam. The exponent keeps the wall at full
            // thickness around most of the circle and spends the taper in the
            // last few samples at each end.
            const taper = Math.pow(bell(u), 0.30);
            const lump = 0.80 + 0.34 * Math.sin(ang * 5.0 + t * 1.6)
                       + 0.16 * Math.sin(ang * 13.0 - t * 2.3);

            // The last argument is `flatten`, which scales the section's
            // vertical axis — it is the surge's *height*, and the reason the
            // ring was low. At 0.26 the wall was four times wider than tall,
            // which is the right proportion for blast debris seen from close
            // by and the wrong one for a thing being read at 300 m, where the
            // silhouette against the sky is all there is. At 0.55 it is a
            // little over two to one: still plainly a spreading wall rather
            // than a smoke ring, and now about 22 m tall instead of 4.
            water.column(
                s, c, x, y, z, thick * taper * lump,
                rx, ry, rz, 0,
                dist, u, 0.55, 0.55
            );

            px = x; py = y; pz = z;
        }

        water.setParams(
            s, PROFILE_TUBE, 0.93,
            clamp01((1 - smooth01((life - 0.45) / 0.55)) * 1.3),
            COLS
        );
    }

    /** The instant of impact: everything the crater throws. */
    _blastThrow() {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp) return;
        const P = this.power;

        // Big grains, and they have to be. A 6 cm puff at 250 m is a fraction of
        // a pixel; what reads at this range is a mass of powder metres across,
        // which is also what is actually up there.
        const spread = 26 * P;
        const n = (560 * ctx.sprayScale * P) | 0;
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * spread;
            const clod = Math.random() < 0.22 ? 1 : 0;
            // Steep near the axis, flat out at the rim: the column goes up, the
            // surge goes out, and they are the same emission.
            const steep = 1 - r / Math.max(spread, 1e-3);
            const up = (14 + Math.random() * 58 * steep) * P;
            const out = (16 + Math.random() * 42 * (1 - steep * 0.7)) * P;

            sp.emit(
                this.ix + Math.cos(a) * r,
                this.iy + 1.5 + Math.random() * 14 * P,
                this.iz + Math.sin(a) * r,
                Math.cos(a) * out,
                up,
                Math.sin(a) * out,
                clod ? 0.7 + Math.random() * 1.4 : 1.4 + Math.random() * 3.6,
                5.5 + Math.random() * 4.5,
                clod,
                // Very low: at this size and speed the grain is ballistic, and
                // the arc it draws is most of what says how big it is.
                0.14 + Math.random() * 0.16
            );
        }
    }

    /**
     * The fireball.
     *
     * A dense cluster of ember billboards at the crater, thrown up and outward.
     * There is no fire *mesh* — a rolling ball of flame is exactly the thing that
     * billboard clusters do better than geometry, because what makes it read is
     * the churn of overlapping puffs at different ages rather than any silhouette.
     *
     * They expand hard as they age (`particles.js` grows kind 2 at more than
     * twice the powder rate), so the cluster fills out into one mass instead of
     * staying a swarm of separate discs.
     */
    _fireball() {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp) return;
        const P = this.power;

        const core = 16 * P;
        const n = (420 * ctx.sprayScale * P) | 0;
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            // Cube root rather than square root: fire fills a volume, and biasing
            // toward the rim the way the debris does would leave a hole in it.
            const r = Math.pow(Math.random(), 0.34) * core;
            const steep = 1 - r / Math.max(core, 1e-3);
            const up = (9 + Math.random() * 30 * steep) * P;
            const out = (5 + Math.random() * 17) * P;

            sp.emit(
                this.ix + Math.cos(a) * r,
                this.iy + 1.0 + Math.random() * 10 * P,
                this.iz + Math.sin(a) * r,
                Math.cos(a) * out,
                up,
                Math.sin(a) * out,
                2.2 + Math.random() * 5.0,
                // Short next to the debris: fire is the first thing to go, and a
                // fireball still burning while the powder settles reads as a
                // bonfire rather than as a detonation.
                1.8 + Math.random() * 2.2,
                2,
                0.55 + Math.random() * 0.5
            );
        }
    }

    /**
     * Fire still coming up the throat behind the initial ball.
     *
     * Emitted along the rising column rather than at the crater, so the flame
     * climbs with the pillar instead of sitting at its foot.
     */
    _burn(dt, t) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp) return;
        const P = this.power;

        // Dies away over the first second and a half. The pillar outlives it by
        // four seconds, and that hand-off — flame to lit powder — is what makes
        // the column look like it is cooling.
        const k = smooth01(t / 0.18) * (1 - smooth01((t - 0.25) / 1.35));
        if (k <= 0.01) return;

        const rate = 260 * ctx.sprayScale * k * P;
        this._burnOwed += dt * rate;
        let count = this._burnOwed | 0;
        if (count <= 0) return;
        this._burnOwed -= count;
        if (count > 45) count = 45;

        const climb = smooth01(t / 2.1);
        const top = PILLAR_H * P * (0.42 + 0.58 * smooth01(t / 1.4));

        for (let i = 0; i < count; i++) {
            const h = Math.random() * Math.random();
            const a = Math.random() * Math.PI * 2;
            const r = (3.0 + 9.0 * h * climb) * P * (0.5 + Math.random() * 0.7);
            sp.emit(
                this.ix + Math.cos(a) * r,
                this.iy + 1.0 + top * h * 0.9,
                this.iz + Math.sin(a) * r,
                Math.cos(a) * (1.5 + Math.random() * 5.0),
                6.0 + Math.random() * 22.0,
                Math.sin(a) * (1.5 + Math.random() * 5.0),
                1.8 + Math.random() * 4.2,
                1.5 + Math.random() * 1.8,
                2,
                0.6 + Math.random() * 0.5
            );
        }
    }

    /** The column of debris still climbing, and then raining back down. */
    _fallout(dt, t) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp) return;
        const P = this.power;

        const k = smooth01(t / 0.35) * (1 - smooth01((t - 0.5) / (BLAST_LIFE - 1.2)));
        if (k <= 0.01) return;

        const rate = 190 * ctx.sprayScale * k * P;
        this._falloutOwed += dt * rate;
        let count = this._falloutOwed | 0;
        if (count <= 0) return;
        this._falloutOwed -= count;
        if (count > 40) count = 40;

        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * 42 * P;
            sp.emit(
                this.ix + Math.cos(a) * r,
                this.iy + (18 + Math.random() * 56) * P,
                this.iz + Math.sin(a) * r,
                Math.cos(a) * (2 + Math.random() * 9),
                2 + Math.random() * 16,
                Math.sin(a) * (2 + Math.random() * 9),
                1.2 + Math.random() * 3.0,
                4.5 + Math.random() * 4.0,
                0,
                0.5
            );
        }
    }

    // ----------------------------------------------------------------- arrival

    /**
     * The undrawn front, and what it does when it gets here.
     *
     * The one place the far blast touches the near field. Everything above this
     * happens a quarter of a kilometre away and can only be looked at; this is
     * the part the player is standing in.
     */
    _shockFront(dt, drawLight) {
        const ctx = this.ctx;
        this._shock += SHOCK_SPEED * dt;

        const ch = ctx.controller;
        const dx = ch.position.x - this.ix;
        const dz = ch.position.z - this.iz;
        const toPlayer = Math.hypot(dx, dz) || 1;

        this._checkArrival(this._shock);

        // A light riding the front, capped at the caster so it sweeps in and then
        // stays put rather than running off past them. This is what makes the
        // wait *visible*: the field lights up in a band moving toward you.
        //
        // Suppressed for the dome and the disc, which draw their fronts and
        // carry their own light on them — two would double-count in one place.
        if (drawLight === false) return;
        const reach = Math.min(this._shock, toPlayer);
        const fade = 1 - clamp01((this._shock - toPlayer) / 90);
        if (fade > 0.01) {
            const lx = this.ix + (dx / toPlayer) * reach;
            const lz = this.iz + (dz / toPlayer) * reach;
            ctx.lights.add(
                lx, ctx.terrain.heightAt(lx, lz) + 3.0, lz,
                60.0, 1.00, 0.72, 0.45, 44.0 * fade * this.power
            );
        }
    }

    /**
     * Fire the arrival once the front — whichever one this cast is drawing — has
     * reached the caster. Separated so the three detonations can each hand in
     * their own radius rather than each re-deriving who is standing where.
     *
     * @param {number} R metres the front has covered
     */
    _checkArrival(R) {
        const ch = this.ctx.controller;
        const dx = ch.position.x - this.ix;
        const dz = ch.position.z - this.iz;
        const toPlayer = Math.hypot(dx, dz) || 1;
        if (!this._shockHit && R >= toPlayer) {
            this._shockHit = true;
            this._arrive(dx / toPlayer, dz / toPlayer);
        }
    }

    /**
     * The front passing the caster.
     *
     * @param {number} nx @param {number} nz unit vector, blast toward caster
     */
    _arrive(nx, nz) {
        const ctx = this.ctx;
        const ch = ctx.controller;
        const P = this.power;

        // The payoff. Four times anything else in the demo asks for at full
        // charge, and it has most of a second of held frame in front of it to
        // earn that.
        ctx.rig.addTrauma(0.20 + 0.65 * P);

        // Snow stripped off the ground and thrown downrange — depression on the
        // near side of each brush, berm on the far side, which is the whole
        // difference between "a blast passed over this" and "something round
        // landed here".
        for (let i = 0; i < 14; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = 1.5 + Math.random() * 7.5;
            const x = ch.position.x + Math.cos(a) * r;
            const z = ch.position.z + Math.sin(a) * r;
            ctx.deform.brush(
                x, z,
                0.85 + Math.random() * 0.5,
                (0.30 + Math.random() * 0.22) * P,
                (0.34 + Math.random() * 0.26) * P,
                0.42 * P,
                0,
                Math.atan2(nz, -nx),
                2.6,
                1.0
            );
        }

        const sp = ctx.spray;
        if (!sp) return;
        const n = (420 * ctx.sprayScale * P) | 0;
        for (let i = 0; i < n; i++) {
            // A sheet crossing the caster rather than a puff around them: born
            // upwind of the player and driven through.
            const across = (Math.random() - 0.5) * 26;
            const along = -6 - Math.random() * 10;
            const x = ch.position.x + nx * along - nz * across;
            const z = ch.position.z + nz * along + nx * across;
            const gust = (13 + Math.random() * 16) * P;

            sp.emit(
                x,
                ctx.terrain.heightAt(x, z) + Math.random() * 4.5,
                z,
                nx * gust + (Math.random() - 0.5) * 3.5,
                0.8 + Math.random() * 4.5,
                nz * gust + (Math.random() - 0.5) * 3.5,
                0.06 + Math.random() * 0.16,
                1.3 + Math.random() * 1.5,
                0,
                1.0
            );
        }
    }

    // --------------------------------------------------------------- lifecycle

    /** @param {number} dt */
    update(dt) {
        if (!this.active) return;

        if (this.phase === P_CHARGE) this._updateCharge(dt);
        else if (this.phase === P_FLIGHT) this._updateFlight(dt);
        else if (this.phase === P_IMPLODE) this._updateImplode(dt);
        else if (this.phase === P_BLAST) {
            if (this._blastKind === "pillar") this._updateBlast(dt);
            else if (this._blastKind === "disc") this._updateDisc(dt);
            else this._updateDome(dt);
        }
    }

    _normaliseAim() {
        const l = Math.hypot(this._aimX, this._aimY, this._aimZ) || 1;
        this._aimX /= l;
        this._aimY /= l;
        this._aimZ /= l;
    }

    /**
     * Point the lance at the committed impact, from wherever the hands are now.
     *
     * Not along the camera forward, which is what the release handed in. The
     * hands are the better part of a metre off the eye axis and a good deal below
     * it; a lance that leaves parallel to the view is a lance that misses its own
     * impact point by that offset, and over a quarter of a kilometre the
     * divergence is plainly visible as the shot failing to arrive where it was
     * going.
     */
    _aimAtImpact() {
        const bx = this.ix - this.ox;
        const by = this.iy - this.oy;
        const bz = this.iz - this.oz;
        const blen = Math.hypot(bx, by, bz) || 1;
        this.dx = bx / blen;
        this.dy = by / blen;
        this.dz = bz / blen;
        this.range = blen;
    }

    /** Midpoint of the two hands, into `(ox, oy, oz)`. */
    _handMid() {
        const ctx = this.ctx;
        ctx.handPosition(0, _handL, 0);
        ctx.handPosition(1, _handR, 0);
        this.ox = (_handL[0] + _handR[0]) * 0.5;
        this.oy = (_handL[1] + _handR[1]) * 0.5;
        this.oz = (_handL[2] + _handR[2]) * 0.5;
    }

    _end() {
        this.active = false;
        this.held = false;
        this.phase = P_IDLE;
        this.power = 0;
        this._flare = 0;
        const water = this.ctx.water;
        if (this.strandLance >= 0) {
            water.release(this.strandLance);
            this.strandLance = -1;
        }
        if (this.strandRing >= 0) {
            water.release(this.strandRing);
            this.strandRing = -1;
        }
        if (this.ctx.circle) this.ctx.circle.hide();
    }

    cancel() {
        this._end();
        // Only on a cancel, not in `_end`. A blast that finishes normally leaves
        // its last few bolts to fade out on their own lifetimes; a cancel is the
        // spell being switched off and has to take them with it.
        if (this.ctx.arcs) this.ctx.arcs.clear();
    }
}
