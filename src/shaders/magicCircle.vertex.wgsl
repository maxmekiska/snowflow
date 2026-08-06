// The casting sigil — vertex placement.
//
// Three coaxial discs, one draw. The mesh carries no geometry: `position` is
// (cornerX, cornerY, discIndex) and the quad is placed here from the sigil's
// world frame, exactly as the spray billboards are placed from theirs.
//
// The frame is handed in rather than derived. The sigil stands perpendicular to
// the *aim*, not to the view — it is a thing the caster has put in the world and
// the lance leaves through it, so it has to foreshorten to an edge-on line when
// you look along the shot. A billboarded sigil always faces you, which reads as
// a HUD element pasted over the scene.

attribute position: vec3f;   // (cornerX, cornerY, discIndex)

uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;

uniform circleCenter: vec3f;
uniform circleRight: vec3f;
uniform circleUp: vec3f;
uniform circleAxis: vec3f;
uniform circleRadius: f32;

/// Per disc: (radius scale, spin rate, axial offset in metres, build delay).
uniform discParams: array<vec4f, 3>;

varying vQuad: vec2f;
varying vDisc: f32;
varying vWorld: vec3f;
varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let d = i32(vertexInputs.position.z);
    let p = uniforms.discParams[d];
    let corner = vertexInputs.position.xy;

    let radius = uniforms.circleRadius * p.x;
    let world = uniforms.circleCenter
        + uniforms.circleAxis * p.z
        + (uniforms.circleRight * corner.x + uniforms.circleUp * corner.y) * radius;

    vertexOutputs.vQuad = corner;
    vertexOutputs.vDisc = vertexInputs.position.z;
    vertexOutputs.vWorld = world;
    vertexOutputs.vViewDist = distance(world, uniforms.cameraPos);
    vertexOutputs.position = uniforms.viewProjection * vec4f(world, 1.0);
}
