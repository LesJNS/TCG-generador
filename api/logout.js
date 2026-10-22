"use strict";
const { manejador } = require("./_comun");
const auth = require("./_auth");

module.exports = manejador({ metodo: "POST", publico: true }, async (req, res) => {
  res.setHeader("Set-Cookie", auth.cookie(req, "", 0));
  return { ok: true };
});
