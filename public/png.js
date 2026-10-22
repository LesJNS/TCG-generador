/* Codificador PNG con filtros adaptativos (RGB, 8 bits). El que trae el navegador (canvas.toBlob) produce
   ~4,7 MB por certificado; este deja ~2,6 MB, lo que permite subirlo bajo el límite de 4,5 MB de Vercel. */
(function (global) {
  "use strict";

  const TABLA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = TABLA_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function chunk(tipo, datos) {
    const out = new Uint8Array(12 + datos.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, datos.length);
    for (let i = 0; i < 4; i++) out[4 + i] = tipo.charCodeAt(i);
    out.set(datos, 8);
    v.setUint32(8 + datos.length, crc32(out.subarray(4, 8 + datos.length)));
    return out;
  }

  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  /** Quita el canal alfa y devuelve las filas RGB. */
  function aRgb(imageData) {
    const { width: w, height: h, data } = imageData;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2];
    }
    return rgb;
  }

  function filtrar(rgb, w, h) {
    const bpp = 3, n = w * bpp;
    const salida = new Uint8Array(h * (n + 1));
    const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(n));
    const vacia = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      const fila = rgb.subarray(y * n, (y + 1) * n);
      const arriba = y ? rgb.subarray((y - 1) * n, y * n) : vacia;
      let c0 = 0, c1 = 0, c2 = 0, c3 = 0, c4 = 0;
      const [k0, k1, k2, k3, k4] = cand;
      for (let x = 0; x < n; x++) {
        const a = x >= bpp ? fila[x - bpp] : 0;
        const b = arriba[x];
        const c = x >= bpp ? arriba[x - bpp] : 0;
        const v = fila[x];
        const f1 = (v - a) & 255, f2 = (v - b) & 255, f3 = (v - ((a + b) >> 1)) & 255, f4 = (v - paeth(a, b, c)) & 255;
        k0[x] = v; k1[x] = f1; k2[x] = f2; k3[x] = f3; k4[x] = f4;
        c0 += v < 128 ? v : 256 - v;   // suma de |valor con signo|
        c1 += f1 < 128 ? f1 : 256 - f1;
        c2 += f2 < 128 ? f2 : 256 - f2;
        c3 += f3 < 128 ? f3 : 256 - f3;
        c4 += f4 < 128 ? f4 : 256 - f4;
      }
      const costes = [c0, c1, c2, c3, c4];
      let mejor = 0;
      for (let k = 1; k < 5; k++) if (costes[k] < costes[mejor]) mejor = k;
      salida[y * (n + 1)] = mejor;
      salida.set(cand[mejor], y * (n + 1) + 1);
    }
    return salida;
  }

  /** canvas -> Uint8Array con un PNG válido. */
  function codificar(canvas, nivel) {
    const { width: w, height: h } = canvas;
    const imagen = canvas.getContext("2d").getImageData(0, 0, w, h);
    const comprimido = global.fflate.zlibSync(filtrar(aRgb(imagen), w, h), { level: nivel || 6 });
    const ihdr = new Uint8Array(13);
    const v = new DataView(ihdr.buffer);
    v.setUint32(0, w); v.setUint32(4, h);
    ihdr[8] = 8; ihdr[9] = 2; // 8 bits, RGB
    const partes = [
      Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
      chunk("IHDR", ihdr), chunk("IDAT", comprimido), chunk("IEND", new Uint8Array(0)),
    ];
    const total = partes.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of partes) { out.set(p, o); o += p.length; }
    return out;
  }

  global.TCGPng = { codificar };
})(window);
