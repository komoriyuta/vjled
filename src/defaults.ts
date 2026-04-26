import type { SceneType } from "./types";

export const DEFAULT_SHADERTOY = `// Shadertoy compatible - use mainImage()
// Ableton Link uniforms: iLinkBpm, iLinkBeat, iLinkPhase, iLinkQuantum, iLinkEnabled, iLinkPlaying
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord.xy / iResolution.xy;
    float beat = iLinkEnabled ? iLinkBeat : iTime * 2.0;
    float pulse = exp(-fract(beat) * 4.0);
    vec3 col = 0.5 + 0.5 * cos(beat * 0.25 + uv.xyx + vec3(0.0, 2.0, 4.0));
    col += pulse * 0.3;
    fragColor = vec4(col, 1.0);
}`;

export const DEFAULT_THREEJS = `// setup() is called once. Return a state object.
// update(state, time, dt, link) is called every frame.
// link: { bpm, beat, phase, quantum, peers, enabled, playing }
function setup(scene, camera, renderer) {
    camera.position.z = 3;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshNormalMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    return { mesh };
}

function update(state, time, dt, link) {
    const beat = link && link.enabled ? link.beat : time * 2.0;
    const pulse = 1.0 + 0.3 * Math.exp(-4.0 * (beat % 1.0));
    state.mesh.scale.set(pulse, pulse, pulse);
    state.mesh.rotation.x = beat * 0.25;
    state.mesh.rotation.y = beat * 0.35;
}`;

export const DEFAULT_P5 = `// p5.js instance mode
// Ableton Link globals: linkBpm, linkBeat, linkPhase, linkQuantum, linkEnabled, linkPlaying
function setup() {
    createCanvas(windowWidth, windowHeight);
    noStroke();
}

function draw() {
    background(20);
    var beat = linkEnabled ? linkBeat : millis() / 500;
    var pulse = 1.0 + 0.3 * exp(-4.0 * (beat % 1.0));
    var r = 80 * pulse;
    fill(255, 100, 150, 200);
    ellipse(
        width / 2 + sin(beat * 0.5) * 100,
        height / 2 + cos(beat * 0.7) * 80,
        r, r
    );
}`;

export const DEFAULT_VIDEO = "";

export function getDefaultCode(type: SceneType): string {
  switch (type) {
    case "glsl":
      return DEFAULT_SHADERTOY;
    case "threejs":
      return DEFAULT_THREEJS;
    case "p5":
      return DEFAULT_P5;
    case "video":
      return DEFAULT_VIDEO;
    default:
      return "";
  }
}
