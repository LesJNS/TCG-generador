"use strict";
/* Sesión por cookie firmada (HMAC-SHA256). La contraseña y el secreto viven solo en variables de entorno. */
const crypto = require("crypto");

const COOKIE = "tcg_sesion";
const DURACION_MS = 8 * 60 * 60 * 1000; // 8 horas

function secreto() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    const { HttpError } = require("./_comun");
    throw new HttpError(500, "Falta configurar SESSION_SECRET (mínimo 16 caracteres)");
  }
  return s;
}

const firmar = (exp) => crypto.createHmac("sha256", secreto()).update(String(exp)).digest("base64url");

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

function crearSesion() {
  const exp = Date.now() + DURACION_MS;
  return `${exp}.${firmar(exp)}`;
}

function leerCookie(req) {
  const m = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  return m ? m.slice(COOKIE.length + 1) : "";
}

function sesionValida(req) {
  const [exp, firma] = leerCookie(req).split(".");
  if (!exp || !firma || !/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const esperado = Buffer.from(firmar(exp));
  const recibido = Buffer.from(firma);
  return esperado.length === recibido.length && crypto.timingSafeEqual(esperado, recibido);
}

function cookie(req, valor, maxAgeSeg) {
  const seguro = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${COOKIE}=${valor}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeg}${seguro}`;
}

module.exports = { passwordOk, crearSesion, sesionValida, cookie, DURACION_MS };
