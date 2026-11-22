// Minimal WebGL2 helpers: programs with named uniforms, textures, framebuffers.

export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('这个浏览器不支持 WebGL2');
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);    // rows of byte textures (the land-cover grids) need not be a multiple of four wide
  return gl;
}

const FLOAT = 0x1406, INT = 0x1404, BOOL = 0x8b56, VEC2 = 0x8b50, VEC3 = 0x8b51, VEC4 = 0x8b52, IVEC2 = 0x8b53, IVEC3 = 0x8b54, IVEC4 = 0x8b55;

function compile(gl, type, source, name) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader), lines = source.split('\n'), cited = new Set();
    for (const m of log.matchAll(/ERROR: \d+:(\d+):/g)) for (let k = -1; k <= 1; k++) cited.add(Number(m[1]) + k);
    const excerpt = [...cited].sort((a, b) => a - b).filter(n => n >= 1 && n <= lines.length).map(n => `${n}: ${lines[n - 1]}`).join('\n');
    throw new Error(`${name}: 着色器编译失败\n${log.trim()}\n${excerpt}`);
  }
  return shader;
}

export class Program {
  constructor(gl, vertexSource, fragmentSource, name = 'program') {
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSource, name), fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource, name);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`${name}: 着色器链接失败\n${gl.getProgramInfoLog(program)}`);
    this.gl = gl;
    this.program = program;
    this.name = name;
    this.uniforms = new Map();
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const u = gl.getActiveUniform(program, i);
      this.uniforms.set(u.name.replace(/\[0\]$/, ''), { loc: gl.getUniformLocation(program, u.name), type: u.type });
    }
  }

  use() {
    this.gl.useProgram(this.program);
    return this;
  }

  // inactive uniforms (compiled away) are silently skipped; arrays of vectors are flattened
  set(name, value) {
    const u = this.uniforms.get(name);
    if (!u) return this;
    const gl = this.gl, loc = u.loc;
    const vec = value && Array.isArray(value) && Array.isArray(value[0]) ? value.flat() : value;
    switch (u.type) {
      case FLOAT: gl.uniform1f(loc, value); break;
      case INT: case BOOL: gl.uniform1iv(loc, Int32Array.of(...[].concat(value))); break; // one value, or a whole array
      case VEC2: gl.uniform2fv(loc, vec); break;
      case VEC3: gl.uniform3fv(loc, vec); break;
      case VEC4: gl.uniform4fv(loc, vec); break;
      case IVEC2: gl.uniform2iv(loc, value); break;
      case IVEC3: gl.uniform3iv(loc, value); break;
      case IVEC4: gl.uniform4iv(loc, value); break;
      default: gl.uniform1i(loc, value); // samplers
    }
    return this;
  }
}

// a 2D texture with nearest filtering and clamped edges, the only kind the renderer needs
export function texture(gl, internal, format, type, width, height, data) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, data || null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export const rgba8 = (gl, width, height) => texture(gl, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, width, height);
export const r8 = (gl, width, height) => texture(gl, gl.R8, gl.RED, gl.UNSIGNED_BYTE, width, height);
export const depth24 = (gl, width, height) => texture(gl, gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, width, height);

// colours: array of textures that become draw buffers 0..n-1; depth: optional depth texture
export function framebuffer(gl, colours, depth = null) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  colours.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
  gl.drawBuffers(colours.length ? colours.map((_, i) => gl.COLOR_ATTACHMENT0 + i) : [gl.NONE]);   // depth only, when there are no colours
  if (depth) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depth, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`帧缓冲不完整: 0x${status.toString(16)}`);
  return fbo;
}

// a vertex buffer holding one interleaved record per vertex; layout: [[attribute index, size], ...]
export function vertexBuffer(gl, data, layout) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const stride = layout.reduce((sum, [, size]) => sum + size, 0) * 4;
  let offset = 0;
  for (const [index, size] of layout) {
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(index, size, gl.FLOAT, false, stride, offset);
    offset += size * 4;
  }
  gl.bindVertexArray(null);
  return { vao, buffer, count: data.length / (stride / 4) };
}

let unitQuad = null;

// instanced geometry: a shared unit quad (-1..1, drawn as a four-vertex strip) on attribute 0,
// plus one interleaved record per instance on attributes 1..n
export function instanceBuffer(gl, data, layout) {
  if (!unitQuad) {
    unitQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, unitQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, unitQuad);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const stride = layout.reduce((sum, [, size]) => sum + size, 0) * 4;
  let offset = 0;
  for (const [index, size] of layout) {
    gl.enableVertexAttribArray(index);
    gl.vertexAttribPointer(index, size, gl.FLOAT, false, stride, offset);
    gl.vertexAttribDivisor(index, 1);
    offset += size * 4;
  }
  gl.bindVertexArray(null);
  return { vao, buffer, count: data.length / (stride / 4) };
}
