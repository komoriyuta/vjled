import type { SceneType } from "./types";

export const DEFAULT_SHADERTOY = `// Shadertoy compatible - use mainImage()
// Audio uniforms: iAudioVolume, iAudioBass, iAudioMid, iAudioTreble, iBpm, iBeat, iBeatPhase, iBeatCount, iFft[32]
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord.xy / iResolution.xy;
    vec3 col = 0.5 + 0.5 * cos(iTime * 0.3 + uv.xyx + vec3(0.0, 2.0, 4.0));
    if (iBpm > 0.0) {
        float pulse = exp(-iBeatPhase * 4.0) + iBeat;
        col += pulse * 0.3;
        col += vec3(iAudioBass, iAudioMid, iAudioTreble) * 0.4;
    }
    fragColor = vec4(col, 1.0);
}`;

export const DEFAULT_THREEJS = `// setup() is called once. Return a state object.
// update(state, time, dt, audio) is called every frame.
// audio: { volume, bass, mid, treble, bpm, beat, beatPhase, beatCount, fft }
function setup(scene, camera, renderer) {
    camera.position.z = 3;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshNormalMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    return { mesh };
}

function update(state, time, dt, audio) {
    state.mesh.rotation.x = time * 0.25;
    state.mesh.rotation.y = time * 0.35;
    const scale = 1.0 + (audio.bpm > 0 ? 0.3 * Math.exp(-audio.beatPhase * 4.0) + (audio.beat ? 0.2 : 0) : 0);
    state.mesh.scale.set(scale, scale, scale);
}`;

export const DEFAULT_P5 = `// p5.js instance mode
// Audio globals: audioVolume, audioBass, audioMid, audioTreble, bpm, beat, beatPhase, fft
function setup() {
    createCanvas(windowWidth, windowHeight);
    noStroke();
}

function draw() {
    background(20);
    var r = 80;
    if (bpm > 0) {
        var pulse = 1.0 + 0.3 * exp(-beatPhase * 4.0) + (beat ? 0.2 : 0);
        r = 80 * pulse;
    }
    fill(255, 100 + audioBass * 155, 150, 200);
    ellipse(
        width / 2 + sin(millis() / 1000 * 0.5) * 100,
        height / 2 + cos(millis() / 1000 * 0.7) * 80,
        r + audioVolume * 60, r + audioVolume * 60
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
