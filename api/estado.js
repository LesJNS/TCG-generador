"use strict";
const { CONFIG, baseUrl, manejador, siguienteCodigo } = require("./_comun");
const gh = require("./_github");

module.exports = manejador({ metodo: "GET" }, async () => {
  const texto = await gh.leerArchivo("data/certificados.json");
  const certificados = texto ? JSON.parse(texto) : [];
  return {
    config: { ...CONFIG, baseUrl: baseUrl() },
    repo: gh.ajustes().repo,
    certificados,
    siguienteCodigo: siguienteCodigo(certificados),
  };
});
