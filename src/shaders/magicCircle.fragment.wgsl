// -----------------------------------------------------------------------------
// The casting sigil — shading.
//
// Every mark on it is analytic. There is no glyph texture and no atlas: the
// rings, the tick fence, the rune band and the two counter-rotated hexagons are
// all distance fields evaluated in polar coordinates, which is what lets the
// thing be *drawn on* rather than faded in.
//
// That is the whole point of the pass. `build` runs 0 to 1 over the wind-up and
// every element is gated on a different slice of it, with a bright head running
// ahead of the angular sweep — so the sigil inscribes itself, outer ring first,
// and the ball only starts forming once it is written. A sigil that
// cross-fades from nothing is a decal; a sigil that is *constructed* is a
// spell being cast.
//
// Additive in effect though the material blends normally: the colour is HDR and
// the alpha is low, so overlapping strokes accumulate toward light without the
// saturation clamp a true alpha composite would put on them. Bloom thresholds in
// exposed units, so the brightest strokes glow and the fainter ones do not.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowAtmosphere>

varying vQuad: vec2f;
varying vDisc: f32;
varying vWorld: vec3f;
varying vViewDist: f32;

var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;

uniform cameraPos: vec3f;
uniform sunDir: vec3f;
uniform sunRadiance: vec3f;

uniform circleTime: f32;
/// 0 = nothing drawn, 1 = fully inscribed.
uniform circleBuild: f32;
/// Global fade. Also carries the release flare.
uniform circleAlpha: f32;
/// Extra brightness on the frame the lance leaves.
uniform circleFlare: f32;
uniform circleColor: vec3f;
uniform discParams: array<vec4f, 3>;
/// 0 = the casting sigil, 1 = the seismic front. See the note above `main`.
uniform circleMode: f32;

uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;

const TAU: f32 = 6.28318530718;

/// A soft band around `centre`, one unit tall at the centre line.
fn band(x: f32, centre: f32, halfWidth: f32) -> f32 {
    return 1.0 - smoothstep(0.0, halfWidth, abs(x - centre));
}

/// Polar radius of a regular `n`-gon of circumradius 1, at angle `theta`.
///
/// The standard trick: fold the angle into one sector and divide by the cosine
/// of the offset from that sector's bisector. Gives a polygon *outline* that can
/// be banded exactly like a ring, so the star costs the same as a circle.
fn polygonRadius(theta: f32, n: f32) -> f32 {
    let seg = TAU / n;
    let a = theta - seg * floor(theta / seg) - seg * 0.5;
    return cos(seg * 0.5) / max(cos(a), 1e-3);
}

/// Two things are drawn by this one shader, and they share it rather than
/// getting a material each because they are the same *pipeline* — same blend,
/// same depth state, same cull mode, same three coaxial quads. A second material
/// would mean a second warm-up for a render state already covered, which is the
/// trap `WaterBody.warmUp` documents. A uniform branch costs nothing: the module
/// compiles once and no new pipeline is keyed off it.
///
/// `circleMode` 0 is the casting sigil. 1 is the seismic front — the same three
/// discs read as a shock: an outer one carrying the leading edge and two inner
/// ones trailing it as ripples, sized by their own radius scale.
@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let q = input.vQuad;
    let r = length(q);
    if (r > 1.0) { discard; }

    let d = i32(input.vDisc);
    let p = uniforms.discParams[d];
    let t = uniforms.circleTime;

    // Each disc spins at its own rate, and the middle one spins backwards. Two
    // counter-rotating fences at slightly different radii is most of what makes
    // a flat sigil read as machinery rather than as a sticker.
    let spin = t * p.y;
    var theta = atan2(q.y, q.x) + spin;
    theta = theta - TAU * floor(theta / TAU);

    let ang01 = theta / TAU;

    var color = vec3f(0.0);
    var alpha = 0.0;

    if (uniforms.circleMode > 0.5) {
        // ---------------------------------------------------- seismic front
        // Per-disc weight taken from its own radius scale, so the outer disc
        // carries the leading edge and the two inner ones trail behind it as
        // spent ripples rather than as three equal hoops.
        let ring = p.x * p.x;

        // The leading edge is a discontinuity and has to stay one. This is the
        // whole read of the effect: a front that fades out over its last few
        // percent is a puff of gas, and no amount of brightness recovers it.
        let front = 1.0 - smoothstep(0.965, 1.0, r);
        // Hollow. The interior is already spent, and what is left of it is a
        // faint sheet whose only job is to say the front is a *surface* rather
        // than a wire hoop — take it out and the disc reads as a ring.
        let body = smoothstep(0.06, 0.90, r);
        // The hot rim, sitting just inside the cut.
        let rim = 1.0 - smoothstep(0.0, 0.070, abs(r - 0.945));

        // A couple of percent out of round. A mathematically perfect circle is
        // the tell that this is a quad with a shader on it.
        let wob = 0.86 + 0.28 * noise2(vec2f(ang01 * 9.0 + p.z * 5.0, t * 0.6));
        // Radial striation, which is what stops the interior reading as tint.
        let streak = 0.55 + 0.45 * noise2(vec2f(ang01 * 52.0, r * 3.5 - t * 2.2));

        let ink = (body * 0.26 * streak + rim * 2.5) * front * wob * ring;
        if (ink < 0.004) { discard; }

        // Blue-white, hottest at the rim, with the flash pushing hard through
        // the first fraction of a second and then leaving it alone.
        let hotCol = vec3f(5.6, 8.0, 11.2);
        color = uniforms.circleColor * ink * 3.4
              + hotCol * rim * front * ring * (1.6 + 5.0 * uniforms.circleFlare);
        alpha = clamp(ink * 0.55, 0.0, 1.0) * uniforms.circleAlpha;
    } else {
        // Build progress for this disc. The outer disc is inscribed first and the
        // inner ones follow, so the sigil closes inward toward where the ball will
        // be.
        let b = clamp((uniforms.circleBuild - p.w) / max(1.0 - p.w, 1e-3), 0.0, 1.0);
        if (b <= 0.0) { discard; }

        // The angular sweep that draws the strokes on. Runs a full turn over the
        // first two thirds of this disc's build, then stops gating anything.
        let sweep = clamp(b / 0.66, 0.0, 1.0);
        let drawn = step(ang01, sweep);
        // The head of the sweep, which is much brighter than the line it is laying.
        let headD = abs(ang01 - sweep);
        let head = (1.0 - smoothstep(0.0, 0.035, headD)) * step(sweep, 0.999) * 2.4;

        var ink = 0.0;

        // ---- the two boundary rings ------------------------------------------
        ink += band(r, 0.985, 0.012) * drawn;
        ink += band(r, 0.885, 0.008) * drawn * 0.75;

        // ---- the tick fence between them --------------------------------------
        // Sixty-four ticks, every fourth one long. A uniform fence reads as a
        // dotted line; the long ticks give it a cardinal structure and a direction
        // of rotation you can actually see.
        let tickPhase = fract(ang01 * 64.0);
        let tickOn = 1.0 - smoothstep(0.16, 0.30, abs(tickPhase - 0.5));
        let quarter = step(0.75, fract(ang01 * 16.0));
        let tickInner = mix(0.925, 0.900, quarter);
        let inFence = step(tickInner, r) * step(r, 0.980);
        ink += tickOn * inFence * drawn * 0.9;

        // ---- the rune band ----------------------------------------------------
        // Hashed dashes at two scales, gated to an annulus. Legible as writing at a
        // glance and as nothing in particular on inspection, which is the correct
        // amount of legibility for a rune.
        let runeGate = step(0.615, r) * step(r, 0.815);
        let runeA = step(0.62, noise2(vec2f(ang01 * 92.0, floor(r * 9.0) + p.z * 7.0)));
        let runeB = step(0.70, noise2(vec2f(ang01 * 41.0 + 13.0, 3.1)));
        ink += (runeA * 0.55 + runeB * 0.45) * runeGate * drawn * 0.85;
        ink += band(r, 0.600, 0.006) * drawn * 0.6;

        // ---- the star ---------------------------------------------------------
        // Two hexagons, one rotated half a sector against the other. Fades in over
        // the last third of the build, after the rings that frame it.
        let starIn = smoothstep(0.62, 1.0, b);
        let hexA = polygonRadius(theta, 6.0) * 0.46;
        let hexB = polygonRadius(theta + TAU / 12.0, 6.0) * 0.46;
        ink += band(r, hexA, 0.010) * starIn;
        ink += band(r, hexB, 0.010) * starIn;
        ink += band(r, 0.475, 0.006) * starIn * 0.7;

        // ---- the core ---------------------------------------------------------
        // A soft disc of light where the ball sits, so the sigil is not a hole.
        ink += (1.0 - smoothstep(0.0, 0.30, r)) * starIn * 0.55;

        ink += head * (band(r, 0.985, 0.02) + band(r, 0.885, 0.02));

        if (ink < 0.004) { discard; }

        // A slow radial shimmer, so a held charge is never a still image.
        let shimmer = 0.86 + 0.24 * noise2(vec2f(ang01 * 18.0, r * 6.0 - t * 1.4));
        ink *= shimmer;

        // Hotter toward the centre and on the flare, which is what makes the release
        // read as the sigil discharging rather than switching off.
        let hotK = clamp(ink * (0.55 + uniforms.circleFlare * 2.2), 0.0, 1.0);
        var c = uniforms.circleColor * ink * (7.0 + 26.0 * uniforms.circleFlare);
        c = mix(c, vec3f(1.0, 1.0, 1.0) * ink * 14.0, hotK * 0.5);
        color = c;

        // Low alpha against an HDR colour: overlapping strokes accumulate toward
        // light instead of clamping, which is an additive look without a second
        // blend state.
        alpha = clamp(ink * 0.62, 0.0, 1.0) * uniforms.circleAlpha;
    }

    let V = normalize(input.vWorld - uniforms.cameraPos);
    color = applyAerial(
        color, uniforms.cameraPos, input.vWorld, V, uniforms.sunDir,
        skyLUT, skyLUTSampler, uniforms.sunRadiance,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    fragmentOutputs.color = vec4f(color, alpha);
}
