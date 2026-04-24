import type { SceneType } from "./types";

export const DEFAULT_SHADERTOY = `// Shadertoy compatible - use mainImage()
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord.xy / iResolution.xy;
    vec3 col = 0.5 + 0.5 * cos(iTime + uv.xyx + vec3(0.0, 2.0, 4.0));
    fragColor = vec4(col, 1.0);
}`;

export const DEFAULT_THREEJS = `// setup() is called once. Return a state object.
// update(state, time, dt) is called every frame.
function setup(scene, camera, renderer) {
    camera.position.z = 3;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshNormalMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    scene.add(mesh);
    return { mesh };
}

function update(state, time, dt) {
    state.mesh.rotation.x += dt * 0.5;
    state.mesh.rotation.y += dt * 0.7;
}`;

export const DEFAULT_P5 = `// p5.js instance mode
// p5 API available: p.setup, p.draw, p.createCanvas, etc.
// Or use global functions: setup(), draw()
function setup() {
    createCanvas(windowWidth, windowHeight);
    noStroke();
}

function draw() {
    background(20);
    fill(255, 100, 150, 200);
    ellipse(
        width / 2 + sin(millis() / 500) * 100,
        height / 2 + cos(millis() / 700) * 80,
        80, 80
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
