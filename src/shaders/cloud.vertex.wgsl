// Cloud deck billboards.
//
// The same addressing the spray uses, for the same reason: `position` is
// (puffIndex, cornerX, cornerY) and carries no geometry, so the vertex buffer is
// built once and the per-frame traffic is eight floats per puff.
//
// One difference that matters. The spray's texture rows are indexed by particle
// slot; these are indexed by *depth order*. Eight hundred alpha-blended discs
// two hundred metres across cannot be drawn in pool order — the blend is not
// commutative and the deck comes apart into visibly stacked cards. The CPU sorts
// an index array back-to-front and writes the rows in that order, so by the time
// the data arrives here "puff 0" simply means "the furthest one". Nothing in
// this file knows or cares.

attribute position: vec3f;

uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;
uniform camRight: vec3f;
uniform camUp: vec3f;

var cloudTex: texture_2d<f32>;
var cloudTexSampler: sampler;

varying vWorld: vec3f;
varying vCorner: vec2f;
varying vState: vec4f;   // (seed, topness, alpha, unused)
varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let i = i32(vertexInputs.position.x);
    let corner = vertexInputs.position.yz;

    let a = textureLoad(cloudTex, vec2i(i, 0), 0);  // (x, y, z, radius)
    let b = textureLoad(cloudTex, vec2i(i, 1), 0);  // (seed, topness, alpha, 0)

    // Zero radius collapses all four corners onto a point and the rasteriser
    // produces no fragments at all. That is the *only* thing standing between
    // the ground game and eight hundred screen-filling quads of overdraw, so the
    // CPU zeroes the radius rather than the alpha whenever the deck is not
    // present — an invisible cloud still costs its fill if the quad has area.
    let radius = a.w;

    // Spin, hashed off the seed. Rotating the corner used for *placement* while
    // handing the fragment stage the unrotated one turns the sprite without
    // turning the shape function with it, so two puffs sharing a seed still
    // differ on screen.
    let ang = b.x * 6.28318530718;
    let cs = cos(ang);
    let sn = sin(ang);
    let rc = vec2f(corner.x * cs - corner.y * sn, corner.x * sn + corner.y * cs);

    let world = a.xyz + (uniforms.camRight * rc.x + uniforms.camUp * rc.y) * radius;

    vertexOutputs.vWorld = world;
    vertexOutputs.vCorner = corner;
    vertexOutputs.vState = b;
    vertexOutputs.vViewDist = distance(world, uniforms.cameraPos);
    vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);
}
