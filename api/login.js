"use strict";
const { manejador, leerCuerpo, HttpError } = require("./_comun");
const auth = require("./_auth");

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = manejador({ metodo: "POST", publico: true }, async (req, res) => {
  const { password } = await leerCuerpo(req, { max: 4096 });
  if (typeof password !== "string" || !auth.passwordOk(password)) {
    await espera(800); // frena la fuerza bruta; además conviene activar el límite de tasa de Vercel
    throw new HttpError(401, "Contraseña incorrecta");
  }
  res.setHeader("Set-Cookie", auth.cookie(req, auth.crearSesion(), auth.DURACION_MS / 1000));
  return { ok: true };
});
