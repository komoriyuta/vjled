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
`;

const SHADERTOY_POSTAMBLE = `
void main() {
    vec4 _fragColor;
    mainImage(_fragColor, gl_FragCoord.xy);
    gl_FragColor = _fragColor;
}
`;

function buildFragmentSource(userCode: string): string {
  const trimmed = userCode.trim();
  if (trimmed.includes("void main(")) {
    return SHADERTOY_PREAMBLE + "\n" + trimmed;
  }
  if (trimmed.includes("mainImage")) {
    return SHADERTOY_PREAMBLE + "\n" + trimmed + "\n" + SHADERTOY_POSTAMBLE;
  }
  return SHADERTOY_PREAMBLE + "\n" + trimmed + "\n" + SHADERTOY_POSTAMBLE;
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

    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }

    const source = buildFragmentSource(this.code);
    const prog = createProgram(gl, VERT, source);
    if (!prog) return;

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
      this.program = null;
      this.quadBuffer = null;
    }
  }
}
