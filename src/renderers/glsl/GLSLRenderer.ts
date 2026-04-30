import type { Renderer } from "../types";
import type { AudioAnalysis, LinkState } from "../../types";

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
uniform float iLinkBpm;
uniform float iLinkBeat;
uniform float iLinkPhase;
uniform float iLinkQuantum;
uniform float iLinkPeers;
uniform bool  iLinkEnabled;
uniform bool  iLinkPlaying;
uniform float iAudioVolume;
uniform float iAudioBass;
uniform float iAudioMid;
uniform float iAudioTreble;
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
  private uLocs: Record<string, WebGLUniformLocation | null> = {};
  private frame = 0;
  private code = "";
  private linkState: LinkState | null = null;

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (!this.gl) return;
    this.setupQuad();
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
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, source);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const err = gl.getShaderInfoLog(fs);
      console.error("GLSL error:\n", err);
      gl.deleteShader(fs);
      return;
    }

    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, VERT);
    gl.compileShader(vs);

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);

    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error("GLSL link error:", gl.getProgramInfoLog(prog));
      gl.deleteProgram(prog);
      return;
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    this.program = prog;
    this.uLocs = {};
    for (const name of ["iTime", "iResolution", "iMouse", "iFrame", "iLinkBpm", "iLinkBeat", "iLinkPhase", "iLinkQuantum", "iLinkPeers", "iLinkEnabled", "iLinkPlaying", "iAudioVolume", "iAudioBass", "iAudioMid", "iAudioTreble", "iBpm", "iBeat", "iBeatPhase", "iBeatCount", "iFft"]) {
      this.uLocs[name] = gl.getUniformLocation(prog, name);
    }
  }

  setLinkState(state: LinkState | null): void {
    this.linkState = state;
  }

  private setupQuad(): void {
    const gl = this.gl!;
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  }

  update(time: number, _dt: number, audio: AudioAnalysis): void {
    const gl = this.gl;
    const c = this.canvas;
    if (!gl || !c || !this.program) return;

    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    const posLoc = gl.getAttribLocation(this.program, "a_pos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    if (this.uLocs.iTime != null) gl.uniform1f(this.uLocs.iTime, time);
    if (this.uLocs.iResolution != null) gl.uniform2f(this.uLocs.iResolution, c.width, c.height);
    if (this.uLocs.iFrame != null) gl.uniform1i(this.uLocs.iFrame, this.frame);
    if (this.uLocs.iLinkBpm != null) gl.uniform1f(this.uLocs.iLinkBpm, this.linkState?.bpm ?? 120);
    if (this.uLocs.iLinkBeat != null) gl.uniform1f(this.uLocs.iLinkBeat, this.linkState?.beat ?? 0);
    if (this.uLocs.iLinkPhase != null) gl.uniform1f(this.uLocs.iLinkPhase, this.linkState?.phase ?? 0);
    if (this.uLocs.iLinkQuantum != null) gl.uniform1f(this.uLocs.iLinkQuantum, this.linkState?.quantum ?? 4);
    if (this.uLocs.iLinkPeers != null) gl.uniform1f(this.uLocs.iLinkPeers, this.linkState?.peers ?? 0);
    if (this.uLocs.iLinkEnabled != null) gl.uniform1i(this.uLocs.iLinkEnabled, this.linkState?.enabled ? 1 : 0);
    if (this.uLocs.iLinkPlaying != null) gl.uniform1i(this.uLocs.iLinkPlaying, this.linkState?.playing ? 1 : 0);
    if (this.uLocs.iAudioVolume != null) gl.uniform1f(this.uLocs.iAudioVolume, audio.volume);
    if (this.uLocs.iAudioBass != null) gl.uniform1f(this.uLocs.iAudioBass, audio.bass);
    if (this.uLocs.iAudioMid != null) gl.uniform1f(this.uLocs.iAudioMid, audio.mid);
    if (this.uLocs.iAudioTreble != null) gl.uniform1f(this.uLocs.iAudioTreble, audio.treble);
    if (this.uLocs.iBpm != null) gl.uniform1f(this.uLocs.iBpm, audio.bpm);
    if (this.uLocs.iBeat != null) gl.uniform1f(this.uLocs.iBeat, audio.beat ? 1 : 0);
    if (this.uLocs.iBeatPhase != null) gl.uniform1f(this.uLocs.iBeatPhase, audio.beatPhase);
    if (this.uLocs.iBeatCount != null) gl.uniform1f(this.uLocs.iBeatCount, audio.beatCount);
    if (this.uLocs.iFft != null) gl.uniform1fv(this.uLocs.iFft, new Float32Array(audio.fft.slice(0, 32)));

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
    if (this.gl && this.program) {
      this.gl.deleteProgram(this.program);
      this.program = null;
    }
  }
}
