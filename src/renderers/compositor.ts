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

void main() {
    vec4 a = u_hasA > 0.5 ? texture2D(u_texA, v_uv) : vec4(0.0);
    vec4 b = u_hasB > 0.5 ? texture2D(u_texB, v_uv) : vec4(0.0);
    vec3 color = a.rgb * (1.0 - u_crossfade) + b.rgb * u_crossfade;
    gl_FragColor = vec4(color, 1.0);
}
`;

export class Compositor {
  private gl: WebGLRenderingContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private program: WebGLProgram | null = null;
  private texA: WebGLTexture | null = null;
  private texB: WebGLTexture | null = null;
  private u: Record<string, WebGLUniformLocation | null> = {};

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl", { alpha: false, preserveDrawingBuffer: true });
    if (!gl) return;
    this.gl = gl;

    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, VERT);
    gl.compileShader(vs);

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, FRAG);
    gl.compileShader(fs);

    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);

    this.program = prog;
    this.u = {
      u_texA: gl.getUniformLocation(prog, "u_texA"),
      u_texB: gl.getUniformLocation(prog, "u_texB"),
      u_crossfade: gl.getUniformLocation(prog, "u_crossfade"),
      u_hasA: gl.getUniformLocation(prog, "u_hasA"),
      u_hasB: gl.getUniformLocation(prog, "u_hasB"),
    };

    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    this.texA = gl.createTexture();
    this.texB = gl.createTexture();
    for (const tex of [this.texA, this.texB]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
  }

  private uploadTex(tex: WebGLTexture, unit: number, source: HTMLCanvasElement): void {
    const gl = this.gl!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  render(canvasA: HTMLCanvasElement | null, canvasB: HTMLCanvasElement | null, crossfade: number): void {
    const gl = this.gl;
    if (!gl || !this.program) return;

    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);

    if (canvasA && this.texA) {
      this.uploadTex(this.texA, 0, canvasA);
      if (this.u.u_texA != null) gl.uniform1i(this.u.u_texA, 0);
      if (this.u.u_hasA != null) gl.uniform1f(this.u.u_hasA, 1.0);
    } else {
      if (this.u.u_hasA != null) gl.uniform1f(this.u.u_hasA, 0.0);
    }

    if (canvasB && this.texB) {
      this.uploadTex(this.texB, 1, canvasB);
      if (this.u.u_texB != null) gl.uniform1i(this.u.u_texB, 1);
      if (this.u.u_hasB != null) gl.uniform1f(this.u.u_hasB, 1.0);
    } else {
      if (this.u.u_hasB != null) gl.uniform1f(this.u.u_hasB, 0.0);
    }

    if (this.u.u_crossfade != null) gl.uniform1f(this.u.u_crossfade, crossfade);

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
      if (this.program) gl.deleteProgram(this.program);
    }
    this.texA = null;
    this.texB = null;
    this.program = null;
  }
}
