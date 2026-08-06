// Lightning arcs — ribbon placement.
//
// The mesh carries no geometry: `position` is (arcIndex, pointIndex, side) and
// every vertex is placed here from the arc data texture, exactly as the spray
// billboards are placed from theirs.
//
// A bolt is a view-facing ribbon rather than a tube. A tube would need a
// transported frame like the water body's, and would buy nothing: a bolt has no
// interior to look into and no silhouette worth resolving from more than one
// side — what it has is a hot core and a falloff across its width, which is a
// ribbon that always turns its face to the camera.
//
// A dead arc has zero half-width at every point, which collapses both sides of
// the ribbon onto the spine. The triangles then have no area and the rasteriser
// skips them, so the draw does not depend on how many arcs are alive.

attribute position: vec3f;   // (arcIndex, pointIndex, side)

uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;
uniform arcPoints: f32;

// Two rows per arc: `2a` is the path, one texel per point, and `2a + 1` holds
// the arc's constants in texel 0. Keeping the constants here rather than in a
// uniform array is what lets the pool be resized in one place — a
// `array<vec4f, N>` would have to agree with the JS constant by hand.
var arcTex: texture_2d<f32>;
var arcTexSampler: sampler;

varying vSide: f32;
varying vAlong: f32;
varying vArc: vec4f;
varying vSeed: f32;
varying vWorld: vec3f;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let a = i32(vertexInputs.position.x);
    let p = i32(vertexInputs.position.y);
    let side = vertexInputs.position.z;

    let n = i32(uniforms.arcPoints);
    let row = a * 2;
    let here = textureLoad(arcTex, vec2i(p, row), 0);
    // Central difference for the tangent, clamped at the ends. The path is
    // deliberately kinked, so a one-sided difference would swing the ribbon
    // through a large angle at every corner and pinch it.
    let prev = textureLoad(arcTex, vec2i(max(p - 1, 0), row), 0);
    let next = textureLoad(arcTex, vec2i(min(p + 1, n - 1), row), 0);

    var tang = next.xyz - prev.xyz;
    let tl = length(tang);
    if (tl < 1e-5) {
        tang = vec3f(0.0, 1.0, 0.0);
    } else {
        tang = tang / tl;
    }

    let view = normalize(here.xyz - uniforms.cameraPos);
    var perp = cross(tang, view);
    var pl = length(perp);
    if (pl < 1e-4) {
        // Sighting straight down the bolt. Any perpendicular will do — the
        // ribbon is edge-on and about to vanish into its own width anyway.
        // (`ref` would be the obvious name and is a WGSL reserved word.)
        let axis = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(tang.y) > 0.9);
        perp = cross(tang, axis);
        pl = max(length(perp), 1e-4);
    }
    perp = perp / pl;

    let world = here.xyz + perp * (side * here.w);

    vertexOutputs.vSide = side;
    vertexOutputs.vAlong = f32(p) / max(f32(n - 1), 1.0);
    vertexOutputs.vArc = textureLoad(arcTex, vec2i(0, row + 1), 0);
    vertexOutputs.vSeed = f32(a) * 0.6180339887;
    vertexOutputs.vWorld = world;
    vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);
}
