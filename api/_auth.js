"use strict";
/* Sesión por token firmado (HMAC-SHA256) que el navegador guarda en sessionStorage y envía en la cabecera
   Authorization. No hay cookie: al cerrar la pestaña el token desaparece y hay que ingresar la contraseña otra vez.
   Caducidad: 2 horas sin actividad (cada petición válida entrega un token renovado) y 8 horas como máximo desde el
   ingreso. La contraseña y el secreto viven solo en variables de entorno. */
const crypto = require("crypto");

const INACTIVIDAD_MS = 2 * 60 * 60 * 1000;
const MAXIMO_MS = 8 * 60 * 60 * 1000;

function secreto() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    const { HttpError } = require("./_comun");
    throw new HttpError(500, "Falta configurar SESSION_SECRET (mínimo 16 caracteres)");
  }
  return s;
}

const firmar = (texto) => crypto.createHmac("sha256", secreto()).update(texto).digest("base64url");
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest();

/** Comparación en tiempo constante (se comparan hashes para no filtrar la longitud). */
function passwordOk(candidata) {
  const real = process.env.ADMIN_PASSWORD;
  if (!real) {
    const { HttpError } = require("./_comun");
    throw new HttpError(500, "Falta configurar ADMIN_PASSWORD");
  }
  return crypto.timingSafeEqual(hash(candidata || ""), hash(real));
}

/** Token "inicio.vence.firma"; vence a las 2 h de inactividad pero nunca pasa de 8 h desde el inicio. */
function emitir(inicio) {
  const vence = Math.min(Date.now() + INACTIVIDAD_MS, inicio + MAXIMO_MS);
  const cuerpo = `${inicio}.${vence}`;
  return `${cuerpo}.${firmar(cuerpo)}`;
}

const crearSesion = () => emitir(Date.now());

/** Si la petición trae un token válido, devuelve uno renovado; si no, null. */
function renovar(req) {
  const m = /^Bearer ([\w.-]+)$/.exec(req.headers.authorization || "");
  if (!m) return null;
  const [inicio, vence, firma] = m[1].split(".");
  if (!/^\d+$/.test(inicio || "") || !/^\d+$/.test(vence || "") || !firma) return null;
  const esperado = Buffer.from(firmar(`${inicio}.${vence}`));
  const recibido = Buffer.from(firma);
  if (esperado.length !== recibido.length || !crypto.timingSafeEqual(esperado, recibido)) return null;
  const ahora = Date.now();
  if (Number(vence) < ahora || Number(inicio) + MAXIMO_MS < ahora) return null;
  return emitir(Number(inicio));
}

module.exports = { passwordOk, crearSesion, renovar };
