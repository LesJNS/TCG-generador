"use strict";
const { CONFIG, baseUrl, manejador, siguienteCodigo } = require("./_comun");
const gh = require("./_github");

module.exports = manejador({ metodo: "GET" }, async () => {
  const [texto, textoElim] = await Promise.all([gh.leerArchivo("data/certificados.json"), gh.leerArchivo("data/eliminados.json")]);
  const certificados = texto ? JSON.parse(texto) : [];
  const eliminados = textoElim ? JSON.parse(textoElim) : [];
  return {
    config: { ...CONFIG, baseUrl: baseUrl() },
    repo: gh.ajustes().repo,
    certificados,
    siguienteCodigo: siguienteCodigo(certificados, eliminados),
  };
});
