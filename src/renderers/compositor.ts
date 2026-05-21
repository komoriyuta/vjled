import { bindFullscreenQuad, createFullscreenQuad, createProgram } from "./webgl";
import type { MixMode, MixSettings, SceneKeySettings } from "../types";

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_texA;
uniform sampler2D u_texB;
uniform float u_crossfade;
uniform float u_hasA;
uniform float u_hasB;
uniform int u_mixMode;
uniform float u_intensity;
uniform float u_feather;
uniform float u_keyAEnabled;
uniform float u_keyAThreshold;
uniform float u_keyASoftness;
uniform float u_keyASpill;
uniform float u_keyBEnabled;
uniform float u_keyBThreshold;
uniform float u_keyBSoftness;
uniform float u_keyBSpill;

float luminance(vec3 color) {
    return dot(color, vec3(0.299, 0.587, 0.114));
}

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec4 sampleClamp(sampler2D tex, vec2 uv) {
    return texture2D(tex, clamp(uv, vec2(0.0), vec2(1.0)));
}

vec4 applyBlackKey(vec4 src, float enabled, float threshold, float softness, float spill) {
    if (enabled < 0.5) return vec4(src.rgb, 1.0);
    float brightness = max(max(src.r, src.g), src.b);
    float matte = smoothstep(threshold, threshold + max(softness, 0.0001), brightness);
    vec3 cleaned = mix(src.rgb * matte, src.rgb, spill);
    return vec4(cleaned, src.a * matte);
}

vec3 overBlack(vec4 src) {
    return src.rgb * src.a;
}

vec3 blendOverlay(vec3 a, vec3 b) {
    return mix(2.0 * a * b, 1.0 - 2.0 * (1.0 - a) * (1.0 - b), step(0.5, a));
}

vec3 blendSoftLight(vec3 a, vec3 b) {
    return (1.0 - 2.0 * b) * a * a + 2.0 * b * a;
}

vec3 blendColor(vec3 a, vec3 b, int mode) {
    if (mode == 1) return min(a + b, vec3(1.0));
    if (mode == 2) return 1.0 - (1.0 - a) * (1.0 - b);
    if (mode == 3) return a * b;
    if (mode == 4) return blendOverlay(a, b);
    if (mode == 5) return blendSoftLight(a, b);
    if (mode == 6) return abs(a - b);
    if (mode == 7) return max(a, b);
    if (mode == 8) return min(a, b);
    return b;
}

float transitionMask(vec2 uv, vec4 a, float f, int mode) {
    float feather = max(u_feather, 0.001);
    if (mode == 9) return 1.0 - smoothstep(f - feather, f + feather, uv.x);
    if (mode == 10) return 1.0 - smoothstep(f - feather, f + feather, 1.0 - uv.x);
    if (mode == 11) return 1.0 - smoothstep(f - feather, f + feather, uv.y);
    if (mode == 12) return 1.0 - smoothstep(f - feather, f + feather, 1.0 - uv.y);
    if (mode == 13) {
        float d = distance(uv, vec2(0.5));
        return 1.0 - smoothstep(f * 0.72 - feather, f * 0.72 + feather, d);
    }
    if (mode == 14) {
        float d = abs(uv.x - 0.5) + abs(uv.y - 0.5);
        return 1.0 - smoothstep(f - feather, f + feather, d);
    }
    if (mode == 15) {
        float n = hash12(floor(uv * mix(36.0, 140.0, u_intensity)));
        return step(n, f);
    }
    if (mode == 16) {
        float l = luminance(a.rgb) * a.a;
        return smoothstep(1.0 - f - feather, 1.0 - f + feather, l);
    }
    if (mode == 17) {
        float d = uv.x + sin((uv.y * 18.0) + f * 18.849) * 0.08 * u_intensity;
        return 1.0 - smoothstep(f - feather, f + feather, d);
    }
    return f;
}

void main() {
    float f = clamp(u_crossfade, 0.0, 1.0);
    float strength = clamp(u_intensity, 0.0, 1.0);
    vec2 uv = v_uv;

    if (u_mixMode == 18) {
        float row = floor(uv.y * 48.0);
        float n = hash12(vec2(row, floor(f * 80.0)));
        uv.x += (n - 0.5) * 0.18 * strength * smoothstep(0.02, 0.95, f) * (1.0 - smoothstep(0.95, 1.0, f));
    }

    vec4 rawA = u_hasA > 0.5 ? sampleClamp(u_texA, uv) : vec4(0.0);
    vec4 rawB = u_hasB > 0.5 ? sampleClamp(u_texB, uv) : vec4(0.0);

    if (u_mixMode == 19) {
        float split = 0.018 * strength * sin(f * 3.14159265);
        rawB.r = sampleClamp(u_texB, uv + vec2(split, 0.0)).r;
        rawB.b = sampleClamp(u_texB, uv - vec2(split, 0.0)).b;
    }

    vec4 a = applyBlackKey(rawA, u_keyAEnabled, u_keyAThreshold, u_keyASoftness, u_keyASpill);
    vec4 b = applyBlackKey(rawB, u_keyBEnabled, u_keyBThreshold, u_keyBSoftness, u_keyBSpill);
    vec3 ca = overBlack(a);
    vec3 cb = overBlack(b);
    vec3 color;

    if (u_mixMode >= 1 && u_mixMode <= 8) {
        vec3 blended = blendColor(ca, cb, u_mixMode);
        color = mix(ca, blended, f * strength);
    } else if (u_mixMode >= 9) {
        float m = transitionMask(v_uv, a, f, u_mixMode);
        color = mix(ca, cb, m);
    } else {
        color = ca * (1.0 - f) + cb * f;
    }

    gl_FragColor = vec4(color, 1.0);
}
`;

export interface CompositorRenderOptions {
  crossfade: number;
  mix: MixSettings;
  keyA?: SceneKeySettings;
  keyB?: SceneKeySettings;
}

const DEFAULT_KEY: SceneKeySettings = {
  enabled: false,
  threshold: 0.08,
  softness: 0.08,
  spill: 0.2,
};

function mixModeId(mode: MixMode): number {
  switch (mode) {
    case "additive": return 1;
    case "screen": return 2;
    case "multiply": return 3;
    case "overlay": return 4;
    case "softLight": return 5;
    case "difference": return 6;
    case "lighten": return 7;
    case "darken": return 8;
    case "wipeLeft": return 9;
    case "wipeRight": return 10;
    case "wipeUp": return 11;
    case "wipeDown": return 12;
    case "circle": return 13;
    case "diamond": return 14;
    case "dissolve": return 15;
    case "luma": return 16;
    case "ripple": return 17;
    case "glitch": return 18;
    case "rgbSplit": return 19;
    case "crossfade":
    default:
      return 0;
  }
}

export class Compositor {
  private gl: WebGLRenderingContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private program: WebGLProgram | null = null;
  private quadBuffer: WebGLBuffer | null = null;
  private texA: WebGLTexture | null = null;
  private texB: WebGLTexture | null = null;
  private texASize: [number, number] | null = null;
  private texBSize: [number, number] | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", { alpha: false, preserveDrawingBuffer: true, antialias: false, powerPreference: "high-performance", desynchronized: true });
    if (!gl) return;
    this.gl = gl;

    const prog = createProgram(gl, VERT, FRAG);
    const quadBuffer = createFullscreenQuad(gl);
    if (!prog || !quadBuffer) return;
    this.program = prog;
    this.quadBuffer = quadBuffer;
    this.u = {
      u_texA: gl.getUniformLocation(prog, "u_texA"),
      u_texB: gl.getUniformLocation(prog, "u_texB"),
      u_crossfade: gl.getUniformLocation(prog, "u_crossfade"),
      u_hasA: gl.getUniformLocation(prog, "u_hasA"),
      u_hasB: gl.getUniformLocation(prog, "u_hasB"),
      u_mixMode: gl.getUniformLocation(prog, "u_mixMode"),
      u_intensity: gl.getUniformLocation(prog, "u_intensity"),
      u_feather: gl.getUniformLocation(prog, "u_feather"),
      u_keyAEnabled: gl.getUniformLocation(prog, "u_keyAEnabled"),
      u_keyAThreshold: gl.getUniformLocation(prog, "u_keyAThreshold"),
      u_keyASoftness: gl.getUniformLocation(prog, "u_keyASoftness"),
      u_keyASpill: gl.getUniformLocation(prog, "u_keyASpill"),
      u_keyBEnabled: gl.getUniformLocation(prog, "u_keyBEnabled"),
      u_keyBThreshold: gl.getUniformLocation(prog, "u_keyBThreshold"),
      u_keyBSoftness: gl.getUniformLocation(prog, "u_keyBSoftness"),
      u_keyBSpill: gl.getUniformLocation(prog, "u_keyBSpill"),
    };

    this.texA = gl.createTexture();
    this.texB = gl.createTexture();
    for (const tex of [this.texA, this.texB]) {
      if (!tex) continue;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
  }

  private uploadTex(tex: WebGLTexture, unit: number, source: HTMLCanvasElement, slot: "A" | "B"): void {
    const gl = this.gl;
    if (!gl) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const size = slot === "A" ? this.texASize : this.texBSize;
    if (!size || size[0] !== source.width || size[1] !== source.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      if (slot === "A") this.texASize = [source.width, source.height];
      else this.texBSize = [source.width, source.height];
      return;
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  private setKeyUniforms(prefix: "A" | "B", key: SceneKeySettings | undefined): void {
    const gl = this.gl;
    if (!gl) return;
    const value = key ?? DEFAULT_KEY;
    if (this.u[`u_key${prefix}Enabled`] != null) gl.uniform1f(this.u[`u_key${prefix}Enabled`], value.enabled ? 1.0 : 0.0);
    if (this.u[`u_key${prefix}Threshold`] != null) gl.uniform1f(this.u[`u_key${prefix}Threshold`], Math.max(0, Math.min(1, value.threshold)));
    if (this.u[`u_key${prefix}Softness`] != null) gl.uniform1f(this.u[`u_key${prefix}Softness`], Math.max(0.001, Math.min(0.5, value.softness)));
    if (this.u[`u_key${prefix}Spill`] != null) gl.uniform1f(this.u[`u_key${prefix}Spill`], Math.max(0, Math.min(1, value.spill)));
  }

  render(canvasA: HTMLCanvasElement | null, canvasB: HTMLCanvasElement | null, options: CompositorRenderOptions): void {
    const gl = this.gl;
    if (!gl || !this.program || !this.quadBuffer) return;

    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    if (canvasA && this.texA) {
      this.uploadTex(this.texA, 0, canvasA, "A");
      if (this.u.u_texA != null) gl.uniform1i(this.u.u_texA, 0);
      if (this.u.u_hasA != null) gl.uniform1f(this.u.u_hasA, 1.0);
    } else {
      if (this.u.u_hasA != null) gl.uniform1f(this.u.u_hasA, 0.0);
    }

    if (canvasB && this.texB) {
      this.uploadTex(this.texB, 1, canvasB, "B");
      if (this.u.u_texB != null) gl.uniform1i(this.u.u_texB, 1);
      if (this.u.u_hasB != null) gl.uniform1f(this.u.u_hasB, 1.0);
    } else {
      if (this.u.u_hasB != null) gl.uniform1f(this.u.u_hasB, 0.0);
    }

    if (this.u.u_crossfade != null) gl.uniform1f(this.u.u_crossfade, options.crossfade);
    if (this.u.u_mixMode != null) gl.uniform1i(this.u.u_mixMode, mixModeId(options.mix.mode));
    if (this.u.u_intensity != null) gl.uniform1f(this.u.u_intensity, Math.max(0, Math.min(1, options.mix.intensity)));
    if (this.u.u_feather != null) gl.uniform1f(this.u.u_feather, Math.max(0.001, Math.min(0.5, options.mix.feather)));
    this.setKeyUniforms("A", options.keyA);
    this.setKeyUniforms("B", options.keyB);

    if (!bindFullscreenQuad(gl, this.program, this.quadBuffer)) return;
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  resize(w: number, h: number): void {
    if (this.canvas) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  destroy(): void {
    const gl = this.gl;
    if (gl) {
      if (this.texA) gl.deleteTexture(this.texA);
      if (this.texB) gl.deleteTexture(this.texB);
      if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
      if (this.program) gl.deleteProgram(this.program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.texA = null;
    this.texB = null;
    this.texASize = null;
    this.texBSize = null;
    this.program = null;
    this.quadBuffer = null;
    this.gl = null;
    this.canvas = null;
  }
}
