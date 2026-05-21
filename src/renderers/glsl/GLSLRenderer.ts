import type { Renderer } from "../types";
import type { AudioAnalysis } from "../../types";
import { bindFullscreenQuad, createFullscreenQuad, createProgram } from "../webgl";

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const SHADERTOY_PREAMBLE = `
precision highp float;
uniform float iTime;
uniform vec2  iResolution;
uniform vec4  iMouse;
uniform int   iFrame;
uniform float iBpm;
uniform float iBeat;
uniform float iBeatPhase;
uniform float iBeatCount;
uniform float iFft[32];

float fftAt(float index) {
    int i = int(clamp(floor(index + 0.5), 0.0, 31.0));
    if (i == 0) return iFft[0];
    if (i == 1) return iFft[1];
    if (i == 2) return iFft[2];
    if (i == 3) return iFft[3];
    if (i == 4) return iFft[4];
    if (i == 5) return iFft[5];
    if (i == 6) return iFft[6];
    if (i == 7) return iFft[7];
    if (i == 8) return iFft[8];
    if (i == 9) return iFft[9];
    if (i == 10) return iFft[10];
    if (i == 11) return iFft[11];
    if (i == 12) return iFft[12];
    if (i == 13) return iFft[13];
    if (i == 14) return iFft[14];
    if (i == 15) return iFft[15];
    if (i == 16) return iFft[16];
    if (i == 17) return iFft[17];
    if (i == 18) return iFft[18];
    if (i == 19) return iFft[19];
    if (i == 20) return iFft[20];
    if (i == 21) return iFft[21];
    if (i == 22) return iFft[22];
    if (i == 23) return iFft[23];
    if (i == 24) return iFft[24];
    if (i == 25) return iFft[25];
    if (i == 26) return iFft[26];
    if (i == 27) return iFft[27];
    if (i == 28) return iFft[28];
    if (i == 29) return iFft[29];
    if (i == 30) return iFft[30];
    return iFft[31];
}
`;

const SHADERTOY_POSTAMBLE = `
void main() {
    vec4 _fragColor;
    mainImage(_fragColor, gl_FragCoord.xy);
    gl_FragColor = _fragColor;
}
`;

function buildFragmentSource(userCode: string): string {
  const trimmed = normalizeShaderSource(userCode);
  if (trimmed.includes("void main(")) {
    return SHADERTOY_PREAMBLE + "\n" + trimmed;
  }
  if (trimmed.includes("mainImage")) {
    return SHADERTOY_PREAMBLE + "\n" + trimmed + "\n" + SHADERTOY_POSTAMBLE;
  }
  return SHADERTOY_PREAMBLE + "\n" + trimmed + "\n" + SHADERTOY_POSTAMBLE;
}

function normalizeShaderSource(userCode: string): string {
  return userCode
    .trim()
    .replace(/^\s*uniform\s+(?:float|int|vec2|vec3|vec4)\s+i(?:Time|Resolution|Mouse|Frame|Bpm|Beat|BeatPhase|BeatCount)\s*;\s*$/gm, "")
    .replace(/^\s*uniform\s+float\s+iFft\s*\[\s*32\s*\]\s*;\s*$/gm, "")
    .replace(/iFft\s*\[\s*int\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\]/g, "fftAt($1)")
    .replace(/iFft\s*\[\s*int\s*\(\s*mod\s*\(([^,\]]+),\s*32\.0\s*\)\s*\)\s*\]/g, "fftAt(mod($1, 32.0))");
}

export class GLSLRenderer implements Renderer {
  private gl: WebGLRenderingContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private program: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private uLocs: Record<string, WebGLUniformLocation | null> = {};
  private readonly fftUniform = new Float32Array(32);
  private frame = 0;
  private code = "";

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (!this.gl) return;
    this.quadBuffer = createFullscreenQuad(this.gl);
  }

  setCode(code: string): void {
    this.code = code;
    this.frame = 0;
    this.rebuildProgram();
  }

  private rebuildProgram(): void {
    const gl = this.gl;
    if (!gl) return;

    const source = buildFragmentSource(this.code);
    const prog = createProgram(gl, VERT, source);
    if (!prog) return;

    if (this.program) {
      gl.deleteProgram(this.program);
    }
    this.program = prog;
    this.uLocs = {};
    for (const name of ["iTime", "iResolution", "iMouse", "iFrame", "iBpm", "iBeat", "iBeatPhase", "iBeatCount", "iFft"]) {
      this.uLocs[name] = gl.getUniformLocation(prog, name);
    }
  }

  update(time: number, _dt: number, audio: AudioAnalysis): void {
    const gl = this.gl;
    const c = this.canvas;
    if (!gl || !c || !this.program || !this.quadBuffer) return;

    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    if (!bindFullscreenQuad(gl, this.program, this.quadBuffer)) return;

    if (this.uLocs.iTime != null) gl.uniform1f(this.uLocs.iTime, time);
    if (this.uLocs.iResolution != null) gl.uniform2f(this.uLocs.iResolution, c.width, c.height);
    if (this.uLocs.iFrame != null) gl.uniform1i(this.uLocs.iFrame, this.frame);
    if (this.uLocs.iBpm != null) gl.uniform1f(this.uLocs.iBpm, audio.bpm);
    if (this.uLocs.iBeat != null) gl.uniform1f(this.uLocs.iBeat, audio.beat ? 1 : 0);
    if (this.uLocs.iBeatPhase != null) gl.uniform1f(this.uLocs.iBeatPhase, audio.beatPhase);
    if (this.uLocs.iBeatCount != null) gl.uniform1f(this.uLocs.iBeatCount, audio.beatCount);
    if (this.uLocs.iFft != null) {
      this.fftUniform.fill(0);
      for (let i = 0; i < this.fftUniform.length && i < audio.fft.length; i++) {
        this.fftUniform[i] = audio.fft[i];
      }
      gl.uniform1fv(this.uLocs.iFft, this.fftUniform);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.frame++;
  }

  resize(w: number, h: number): void {
    if (this.canvas) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  destroy(): void {
    if (this.gl) {
      if (this.program) this.gl.deleteProgram(this.program);
      if (this.quadBuffer) this.gl.deleteBuffer(this.quadBuffer);
      this.gl.getExtension("WEBGL_lose_context")?.loseContext();
      this.program = null;
      this.quadBuffer = null;
    }
    this.gl = null;
    this.canvas = null;
  }
}
