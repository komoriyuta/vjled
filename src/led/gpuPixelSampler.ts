import type { CalibrationPoint, LedConfig } from "../types";

const VERTEX_SHADER = `#version 300 es
in float aIndex;
in vec2 aTexCoord;

uniform float uCount;

out vec2 vTexCoord;

void main() {
  float x = ((aIndex + 0.5) / uCount) * 2.0 - 1.0;
  gl_Position = vec4(x, 0.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  vTexCoord = aTexCoord;
}
`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

uniform sampler2D uSource;
uniform float uBrightness;
uniform vec3 uGain;

in vec2 vTexCoord;
out vec4 outColor;

void main() {
  vec3 color = texture(uSource, vTexCoord).rgb;
  vec3 curved = min(vec3(1.0), color * uBrightness * uGain);
  outColor = vec4(curved * curved, 1.0);
}
`;

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader) ?? "unknown shader error";
    gl.deleteShader(shader);
    throw new Error(info);
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertex = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error("Failed to create program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) ?? "unknown program error";
    gl.deleteProgram(program);
    throw new Error(info);
  }
  return program;
}

function pointsKey(points: CalibrationPoint[]): string {
  return points.map((p) => `${p.lanternId}:${p.x.toFixed(6)},${p.y.toFixed(6)}`).join("|");
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export class GpuPixelSampler {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly texture: WebGLTexture;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly outputTexture: WebGLTexture;
  private readonly vao: WebGLVertexArrayObject;
  private readonly indexBuffer: WebGLBuffer;
  private readonly coordBuffer: WebGLBuffer;
  private readonly countLocation: WebGLUniformLocation;
  private readonly brightnessLocation: WebGLUniformLocation;
  private readonly gainLocation: WebGLUniformLocation;
  private cachedKey = "";
  private cachedCount = 0;
  private pixels = new Uint8Array(0);

  constructor() {
    this.canvas = document.createElement("canvas");
    const gl = this.canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is unavailable");

    this.gl = gl;
    this.program = createProgram(gl);
    this.texture = this.must(gl.createTexture(), "texture");
    this.framebuffer = this.must(gl.createFramebuffer(), "framebuffer");
    this.outputTexture = this.must(gl.createTexture(), "output texture");
    this.vao = this.must(gl.createVertexArray(), "vertex array");
    this.indexBuffer = this.must(gl.createBuffer(), "index buffer");
    this.coordBuffer = this.must(gl.createBuffer(), "coord buffer");
    this.countLocation = this.must(gl.getUniformLocation(this.program, "uCount"), "uCount");
    this.brightnessLocation = this.must(gl.getUniformLocation(this.program, "uBrightness"), "uBrightness");
    this.gainLocation = this.must(gl.getUniformLocation(this.program, "uGain"), "uGain");

    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "uSource"), 0);

    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindTexture(gl.TEXTURE_2D, this.outputTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  sample(
    source: HTMLCanvasElement,
    points: CalibrationPoint[],
    config: LedConfig,
  ): Map<number, [number, number, number]> {
    const gl = this.gl;
    if (points.length === 0) return new Map();

    this.ensurePoints(points);
    this.ensureOutput(points.length);

    gl.useProgram(this.program);
    gl.viewport(0, 0, points.length, 1);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outputTexture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      throw new Error("GPU pixel sampler framebuffer is incomplete");
    }
    gl.uniform1f(this.countLocation, points.length);
    gl.uniform1f(this.brightnessLocation, config.brightness);
    gl.uniform3f(this.gainLocation, config.colorGain[0], config.colorGain[1], config.colorGain[2]);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, points.length);
    gl.readPixels(0, 0, points.length, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixels);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    const colors = new Map<number, [number, number, number]>();
    for (let i = 0; i < points.length; i++) {
      const offset = i * 4;
      colors.set(points[i].lanternId, [
        this.pixels[offset],
        this.pixels[offset + 1],
        this.pixels[offset + 2],
      ]);
    }
    return colors;
  }

  destroy() {
    const gl = this.gl;
    gl.deleteBuffer(this.indexBuffer);
    gl.deleteBuffer(this.coordBuffer);
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.texture);
    gl.deleteTexture(this.outputTexture);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteProgram(this.program);
  }

  private ensurePoints(points: CalibrationPoint[]) {
    const key = pointsKey(points);
    if (key === this.cachedKey) return;

    const gl = this.gl;
    const indices = new Float32Array(points.length);
    const coords = new Float32Array(points.length * 2);
    for (let i = 0; i < points.length; i++) {
      indices[i] = i;
      coords[i * 2] = clampUnit(points[i].x);
      coords[i * 2 + 1] = 1 - clampUnit(points[i].y);
    }

    gl.bindVertexArray(this.vao);

    const indexLocation = gl.getAttribLocation(this.program, "aIndex");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(indexLocation);
    gl.vertexAttribPointer(indexLocation, 1, gl.FLOAT, false, 0, 0);

    const coordLocation = gl.getAttribLocation(this.program, "aTexCoord");
    gl.bindBuffer(gl.ARRAY_BUFFER, this.coordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, coords, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(coordLocation);
    gl.vertexAttribPointer(coordLocation, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
    this.cachedKey = key;
  }

  private ensureOutput(count: number) {
    if (count === this.cachedCount) return;

    const gl = this.gl;
    this.canvas.width = Math.max(1, count);
    this.canvas.height = 1;
    this.pixels = new Uint8Array(count * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.outputTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, count, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.cachedCount = count;
  }

  private must<T>(value: T | null, name: string): T {
    if (!value) throw new Error(`Failed to create ${name}`);
    return value;
  }
}
