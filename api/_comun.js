"use strict";
/* Utilidades compartidas por las funciones de /api. Los archivos que empiezan con "_" no son rutas. */

const CONFIG = {
  emisor: "Towers Consulting Group (TCG)",
  prefijoCodigo: "TCG-CI",
  fraseIntroPorDefecto: "Ha participado en las capacitaciones de:",
  firmantes: [
    { nombre: "Juan Carlos Torres Napa", cargo: "Chief Data & AI Officer - TCG" },
    { nombre: "Ángela Carpio Zamudio", cargo: "Data & Analytics Manager - TCG" },
  ],
};

const RE_CODIGO = /^[A-Z0-9][A-Z0-9-]{2,40}$/;
const RE_SHA = /^[0-9a-f]{40}$/;

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const baseUrl = () => (process.env.BASE_URL || "https://tcg-certificados.vercel.app").replace(/\/+$/, "");

function responder(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

/** Lee el cuerpo: Vercel ya lo trae en req.body; en el servidor de desarrollo se lee del stream. */
async function leerCuerpo(req, { raw = false, max = 4.4 * 1024 * 1024 } = {}) {
  let b = req.body;
  if (b === undefined) {
    const partes = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > max) throw new HttpError(413, "El cuerpo supera el límite permitido");
      partes.push(c);
    }
    b = Buffer.concat(partes);
  }
  if (raw) {
    if (typeof b === "string") b = Buffer.from(b, "binary");
    if (!Buffer.isBuffer(b)) throw new HttpError(400, "Se esperaba un cuerpo binario");
    if (b.length > max) throw new HttpError(413, "El cuerpo supera el límite permitido");
    return b;
  }
  if (Buffer.isBuffer(b)) b = b.toString("utf8");
  if (typeof b === "string") {
    try { return b ? JSON.parse(b) : {}; } catch { throw new HttpError(400, "JSON inválido"); }
  }
  return b || {};
}

/** Protecciones comunes: método, origen (CSRF) y tipo de contenido. */
function validarPeticion(req, { metodo, tipo }) {
  if (req.method !== metodo) throw new HttpError(405, "Método no permitido");
  if (metodo === "POST") {
    const origen = req.headers.origin;
    if (origen) {
      let host;
      try { host = new URL(origen).host; } catch { throw new HttpError(403, "Origen no permitido"); }
      if (host !== req.headers.host) throw new HttpError(403, "Origen no permitido");
    }
    const ct = req.headers["content-type"] || "";
    if (!ct.startsWith(tipo || "application/json")) throw new HttpError(415, "Tipo de contenido no admitido");
  }
}

/** Envuelve un handler: valida la petición, exige sesión (salvo publico) y traduce errores. */
function manejador({ metodo, tipo, publico = false }, fn) {
  const auth = require("./_auth");
  return async function (req, res) {
    try {
      validarPeticion(req, { metodo, tipo });
      if (!publico && !auth.sesionValida(req)) throw new HttpError(401, "Sesión no iniciada");
      const salida = await fn(req, res);
      if (salida !== undefined && !res.writableEnded) responder(res, 200, salida);
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (!res.writableEnded) {
        responder(res, e.status || 500, { ok: false, error: e.status ? e.message : "Error interno" });
      }
    }
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const ordenar = (lista) => lista.sort((a, b) => a.codigo.localeCompare(b.codigo, "es", { numeric: true }));

function siguienteCodigo(lista) {
  const pref = `${CONFIG.prefijoCodigo}-${new Date().getFullYear()}-`;
  let max = 0;
  for (const c of lista) {
    if (c.codigo.startsWith(pref)) {
      const n = parseInt(c.codigo.slice(pref.length), 10);
      if (n > max) max = n;
    }
  }
  return pref + String(max + 1).padStart(3, "0");
}

function validarRegistro(r) {
  const err = [];
  if (!r || typeof r !== "object") return ["registro vacío"];
  if (!RE_CODIGO.test(r.codigo || "")) err.push("código inválido");
  for (const k of ["nombre", "capacitacion", "fechas", "frase"]) {
    if (typeof r[k] !== "string" || !r[k].trim()) err.push(`falta ${k}`);
    else if (r[k].length > 400) err.push(`${k} demasiado largo`);
  }
  if (r.area != null && String(r.area).length > 200) err.push("área demasiado larga");
  return err;
}

/** Página /c/CODIGO con metadatos Open Graph propios (los rastreadores no ejecutan JS). */
function paginaCredencial(plantilla, reg, base) {
  const url = `${base}/c/${reg.codigo}`;
  const img = `${base}/certs/${reg.codigo}.jpg`;
  const titulo = `Certificado ${reg.codigo} · ${reg.emisor}`;
  const desc = `Certificado verificable emitido por ${reg.emisor}: ${reg.capacitacion}.`;
  const og = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(reg.emisor)}">`,
    `<meta property="og:title" content="${esc(titulo)}">`,
    `<meta property="og:description" content="${esc(desc)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    `<meta property="og:image" content="${esc(img)}">`,
    `<meta property="og:image:width" content="1600">`,
    `<meta property="og:image:height" content="900">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:image" content="${esc(img)}">`,
  ].join("\n");
  // function replacers: evitan que "$&" y similares en los datos se interpreten
  return plantilla
    .replace(/<!--OG-->[\s\S]*?<!--\/OG-->/, () => `<!--OG-->\n${og}\n<!--/OG-->`)
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(titulo)}</title>`);
}

module.exports = {
  CONFIG, RE_CODIGO, RE_SHA, HttpError, baseUrl, responder, leerCuerpo,
  manejador, ordenar, siguienteCodigo, validarRegistro, paginaCredencial,
};
