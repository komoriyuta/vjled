import p5 from "p5";
import type { Renderer } from "../types";

export class P5Renderer implements Renderer {
  private p5Instance: p5 | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private container: HTMLDivElement | null = null;
  private code = "";

  init(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.container = document.createElement("div");
    this.container.style.cssText = "position:fixed;top:-9999px;left:-9999px;pointer-events:none;";
    document.body.appendChild(this.container);
  }

  setCode(code: string): void {
    if (code === this.code && this.p5Instance) return;
    this.code = code;
    this.recreate();
  }

  private recreate(): void {
    this.destroyInstance();

    if (!this.container || !this.code) return;

    const userCode = this.code;

    try {
      const sketch = (p: p5) => {
        const wrapped = new Function(
          "p",
          `"use strict";
          var createCanvas = function() { return p.createCanvas.apply(p, arguments); };
          var background = function() { return p.background.apply(p, arguments); };
          var fill = function() { return p.fill.apply(p, arguments); };
          var noFill = function() { return p.noFill.apply(p, arguments); };
          var stroke = function() { return p.stroke.apply(p, arguments); };
          var noStroke = function() { return p.noStroke.apply(p, arguments); };
          var ellipse = function() { return p.ellipse.apply(p, arguments); };
          var rect = function() { return p.rect.apply(p, arguments); };
          var line = function() { return p.line.apply(p, arguments); };
          var textSize = function() { return p.textSize.apply(p, arguments); };
          var text = function() { return p.text.apply(p, arguments); };
          var sin = Math.sin;
          var cos = Math.cos;
          var abs = Math.abs;
          var PI = Math.PI;
          var TWO_PI = Math.PI * 2;
          var random = Math.random;
          var width = 0;
          var height = 0;
          var windowWidth = p.windowWidth;
          var windowHeight = p.windowHeight;
          var mouseX = 0;
          var mouseY = 0;
          var millis = function() { return p.millis(); };
          var frameCount = 0;

          ${userCode}

          if (typeof setup === 'function') {
            p.setup = function() {
              setup();
              width = p.width;
              height = p.height;
            };
          }
          if (typeof draw === 'function') {
            p.draw = function() {
              width = p.width;
              height = p.height;
              mouseX = p.mouseX;
              mouseY = p.mouseY;
              frameCount = p.frameCount;
              draw();
            };
          }`
        );
        wrapped(p);
      };

      this.p5Instance = new p5(sketch, this.container);
    } catch (e) {
      console.error("p5.js eval error:", e);
    }
  }

  update(_time: number, _dt: number): void {
    if (!this.canvas || !this.container) return;
    const pCanvas = this.container.querySelector("canvas");
    if (!pCanvas) return;
    const ctx = this.canvas.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(pCanvas, 0, 0, this.canvas.width, this.canvas.height);
    }
  }

  resize(w: number, h: number): void {
    if (this.p5Instance) {
      try {
        this.p5Instance.resizeCanvas(w, h);
      } catch {}
    }
  }

  private destroyInstance(): void {
    if (this.p5Instance) {
      this.p5Instance.remove();
      this.p5Instance = null;
    }
  }

  destroy(): void {
    this.destroyInstance();
    if (this.container) {
      this.container.remove();
      this.container = null;
    }
  }
}
