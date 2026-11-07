import { useEffect, useRef } from 'react';
import { store } from '../lib/store';
import { hasFocus } from './ticker';

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }`;

// Fluid made of noise warped twice, in the very dark grays of the logo.
// Its speed follows the processor load.
const FRAG = `
precision mediump float;
uniform vec2 uRes; uniform float uT;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a*noise(p); p = p*2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return v;
}
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = uv * vec2(uRes.x/uRes.y, 1.0) * 1.35;
  float t = uT;
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3 - t)));
  vec2 r = vec2(fbm(p + 2.6*q + vec2(1.7, 9.2) + t*1.2), fbm(p + 2.6*q + vec2(8.3, 2.8) - t));
  float f = fbm(p + 2.8*r);

  // From #0B0C10 to #141519: the range between the logo's background and the gray inside its cross.
  float mask = smoothstep(0.28, 0.82, f);
  gl_FragColor = vec4(mix(vec3(0.043, 0.047, 0.063), vec3(0.078, 0.082, 0.098), mask), 1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}

export function FluidBackground({ motion }: { motion: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const motionRef = useRef(motion);
  motionRef.current = motion;

  useEffect(() => {
    const canvas = ref.current!;
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
    if (!gl) {
      canvas.style.display = 'none';
      return;
    }
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uT = gl.getUniformLocation(prog, 'uT');

    // Rendered at very low resolution: the fluid is smooth anyway and scaling softens it.
    const resize = () => {
      const w = Math.max(140, Math.round(window.innerWidth / 7));
      const h = Math.max(100, Math.round(window.innerHeight / 7));
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
      gl.uniform2f(uRes, w, h);
      // Resizing clears the canvas, and with animations off nothing else would redraw it.
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    resize();
    window.addEventListener('resize', resize);

    let raf = 0;
    let last = 0;
    let phase = Math.random() * 40;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      // The motion is very slow, so 12 frames per second look just as fluid and cost far less.
      const interval = hasFocus() ? 83 : 400;
      if (now - last < interval) return;
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      if (!motionRef.current) return;
      phase += dt * (0.018 + store.energy * 0.05);
      gl.uniform1f(uT, phase % 500);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    gl.uniform1f(uT, phase);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <>
      <canvas ref={ref} className="fluid" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />
    </>
  );
}
