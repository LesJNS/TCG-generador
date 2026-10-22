(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const R = window.TCGRender;

  const S = { config: null, repo: "", certificados: [], layout: null, base: null, siguiente: "" };
  const LOTE = 25; // certificados por commit

  // ---------- utilidades ----------
  function toast(msg, err) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast show" + (err ? " err" : "");
    clearTimeout(toast.h);
    toast.h = setTimeout(() => (t.className = "toast"), err ? 7000 : 2500);
  }

  class ErrorApi extends Error { constructor(msg, status) { super(msg); this.status = status; } }

  async function llamar(ruta, opciones) {
    let r;
    try { r = await fetch(ruta, { credentials: "same-origin", ...opciones }); }
    catch { throw new ErrorApi("Sin conexión con el servidor", 0); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && ruta !== "/api/login") mostrarLogin();
    if (!r.ok) throw new ErrorApi(j.error || r.statusText, r.status);
    return j;
  }

  const api = (ruta, cuerpo) => llamar(ruta, cuerpo === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo),
  });

  /** Sube un binario como blob de git; reintenta una vez ante fallos transitorios. */
  async function subirBlob(bytes) {
    for (let intento = 1; ; intento++) {
      try {
        const r = await llamar("/api/blob", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes });
        return r.sha;
      } catch (e) {
        if (intento >= 2 || (e.status >= 400 && e.status < 500)) throw e;
      }
    }
  }

  const cargarImg = (src) => new Promise((ok, fail) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => fail(new Error("No se pudo cargar " + src));
    i.src = src;
  });

  const aBytes = async (blob) => new Uint8Array(await blob.arrayBuffer());
  const canvasABlob = (c, tipo, q) => new Promise((ok) => c.toBlob(ok, tipo, q));

  // ---------- progreso ----------
  function progreso(texto, frac) {
    let o = $("progreso");
    if (!texto) { if (o) o.remove(); return; }
    if (!o) {
      o = document.createElement("div");
      o.id = "progreso"; o.className = "progreso";
      o.innerHTML = '<div><div class="t"></div><progress max="1" value="0"></progress></div>';
      document.body.appendChild(o);
    }
    o.querySelector(".t").textContent = texto;
    o.querySelector("progress").value = frac || 0;
  }

  // ---------- sesión ----------
  function mostrarLogin() { $("app").hidden = true; $("login").hidden = false; $("l-pass").focus(); }

  async function onLogin(ev) {
    ev.preventDefault();
    const b = $("l-btn"); b.disabled = true; $("l-error").textContent = "";
    try {
      await api("/api/login", { password: $("l-pass").value });
      $("l-pass").value = "";
      await entrar();
    } catch (e) { $("l-error").textContent = e.message; }
    finally { b.disabled = false; }
  }

  async function salir() {
    try { await api("/api/logout", {}); } catch { /* da igual */ }
    mostrarLogin();
  }

  // ---------- generación de archivos ----------
  const CANVAS_OCULTO = document.createElement("canvas");
  const CANVAS_MINI = document.createElement("canvas");

  function dibujar(canvas, datos) {
    return R.dibujarCertificado(canvas, S.base, S.layout, {
      nombre: datos.nombre || "NOMBRE DEL PARTICIPANTE",
      capacitacion: datos.capacitacion || "TÍTULO DE LA CAPACITACIÓN",
      fechas: datos.fechas || "Texto de fechas.",
      frase: datos.frase || S.config.fraseIntroPorDefecto,
      codigo: datos.codigo,
    }, S.config.baseUrl);
  }

  function pdfDe(canvases) {
    const { jsPDF } = window.jspdf;
    const [w, h] = S.layout.diapositiva_cm.map((x) => x * 10); // mm
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: [w, h], compress: true });
    canvases.forEach((c, i) => {
      if (i) doc.addPage([w, h], "landscape");
      doc.addImage(c.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, w, h, undefined, "FAST");
    });
    return new Uint8Array(doc.output("arraybuffer"));
  }

  async function construirArchivos(datos) {
    const c = CANVAS_OCULTO;
    dibujar(c, datos);
    const png = TCGPng.codificar(c);
    CANVAS_MINI.width = 1600; CANVAS_MINI.height = Math.round(1600 * c.height / c.width);
    const mctx = CANVAS_MINI.getContext("2d");
    mctx.imageSmoothingQuality = "high";
    mctx.drawImage(c, 0, 0, CANVAS_MINI.width, CANVAS_MINI.height);
    const jpg = await aBytes(await canvasABlob(CANVAS_MINI, "image/jpeg", 0.88));
    return { png, jpg, pdf: pdfDe([c]) };
  }

  /**
   * Sube los archivos de cada certificado y publica todo en commits de hasta LOTE certificados.
   * Devuelve la lista de códigos publicados. alProgreso(texto, fracción) es opcional.
   */
  async function publicar(lista, sobrescribir, alProgreso, alTerminar) {
    const total = lista.length * 3 + Math.ceil(lista.length / LOTE);
    let hecho = 0;
    const paso = (txt) => { if (alProgreso) alProgreso(txt, ++hecho / total); };
    const publicados = [];
    for (let i = 0; i < lista.length; i += LOTE) {
      const items = [];
      for (const datos of lista.slice(i, i + LOTE)) {
        if (alProgreso) alProgreso(`Preparando ${datos.codigo}…`, hecho / total);
        const a = await construirArchivos(datos);
        const item = { registro: datos };
        for (const k of ["png", "jpg", "pdf"]) {
          item[k] = await subirBlob(a[k]);
          paso(`Subiendo ${datos.codigo} (${k.toUpperCase()})…`);
        }
        items.push(item);
      }
      if (alProgreso) alProgreso("Publicando en GitHub…", hecho / total);
      await api("/api/publicar", { items, sobrescribir: !!sobrescribir });
      paso("Publicado");
      items.forEach((it) => publicados.push(it.registro.codigo));
      if (alTerminar) alTerminar(items.map((it) => it.registro.codigo));
    }
    return publicados;
  }

  // ---------- estado ----------
  async function recargar() {
    const e = await llamar("/api/estado");
    S.config = e.config; S.repo = e.repo; S.certificados = e.certificados; S.siguiente = e.siguienteCodigo;
    $("n-emitidos").textContent = `(${S.certificados.length})`;
    $("c-base").textContent = S.config.baseUrl;
    $("c-repo").textContent = S.repo;
    $("pill-repo").textContent = "Publica en " + S.repo;
    renderLista();
  }

  // ---------- vista previa ----------
  function datosForm() {
    return {
      codigo: $("f-codigo").value.trim().toUpperCase(),
      nombre: $("f-nombre").value, capacitacion: $("f-capacitacion").value,
      fechas: $("f-fechas").value, frase: $("f-frase").value, area: $("f-area").value,
    };
  }
  let pendiente = false;
  function setAviso(msg, clase) { const a = $("aviso"); a.textContent = msg; a.className = "aviso " + (clase || ""); }

  function actualizarPreview() {
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(() => {
      pendiente = false;
      const d = datosForm();
      const info = dibujar($("canvas"), d);
      $("url-qr").textContent = d.codigo ? `QR → ${S.config.baseUrl}/c/${d.codigo}` : "";
      $("info-preview").textContent = info.escala < 1 ? "El texto se redujo automáticamente para que quepa." : "";
      const existe = S.certificados.some((c) => c.codigo === d.codigo);
      setAviso(existe ? `El código ${d.codigo} ya existe: generar lo sobrescribirá.` : "", existe ? "err" : "");
    });
  }

  async function onGenerar(ev) {
    ev.preventDefault();
    const d = datosForm();
    const existe = S.certificados.some((c) => c.codigo === d.codigo);
    if (existe && !confirm(`El código ${d.codigo} ya existe. ¿Sobrescribir ese certificado?`)) return;
    const b = $("b-generar"); b.disabled = true;
    try {
      await publicar([d], existe, progreso);
      progreso();
      await recargar();
      toast(`Certificado ${d.codigo} publicado`);
      setAviso(`Publicado: ${S.config.baseUrl}/c/${d.codigo} (disponible cuando termine el despliegue del sitio, ~1 min)`, "ok");
      $("f-codigo").value = S.siguiente;
      ["f-nombre", "f-area"].forEach((i) => ($(i).value = ""));
      $("f-nombre").focus();
      actualizarPreview();
    } catch (e) { progreso(); setAviso(e.message, "err"); toast(e.message, true); }
    finally { b.disabled = false; }
  }

  // ---------- lista ----------
  function renderLista() {
    const q = $("buscar").value.trim().toLowerCase();
    const tb = $("tbody"); tb.innerHTML = "";
    const filas = S.certificados.filter((c) => !q || [c.codigo, c.nombre, c.capacitacion, c.area].join(" ").toLowerCase().includes(q));
    for (const c of filas) {
      const tr = document.createElement("tr");
      const celda = (t) => { const td = document.createElement("td"); td.textContent = t; tr.appendChild(td); return td; };
      celda(c.codigo); celda(c.nombre); celda(c.area || "—"); celda(c.fecha_emision);
      const tdE = celda(""); const sp = document.createElement("span");
      sp.className = "badge " + c.estado; sp.textContent = c.estado; tdE.appendChild(sp);
      const acc = celda(""); acc.className = "acc";
      const enlace = (txt, href) => { const a = document.createElement("a"); a.textContent = txt; a.href = href; a.target = "_blank"; a.rel = "noopener"; acc.appendChild(a); };
      enlace("Página", `${S.config.baseUrl}/c/${c.codigo}`);
      enlace("PNG", `${S.config.baseUrl}/${c.imagen}`);
      enlace("PDF", `${S.config.baseUrl}/${c.pdf}`);
      const btn = document.createElement("button");
      btn.className = "mini " + (c.estado === "vigente" ? "danger" : "");
      btn.textContent = c.estado === "vigente" ? "Revocar" : "Reactivar";
      btn.onclick = () => cambiarEstado(c);
      acc.appendChild(btn);
      tb.appendChild(tr);
    }
    $("vacio").hidden = filas.length > 0;
  }

  async function cambiarEstado(c) {
    const nuevo = c.estado === "vigente" ? "revocado" : "vigente";
    if (!confirm(`¿Marcar ${c.codigo} (${c.nombre}) como ${nuevo}?`)) return;
    try {
      progreso("Publicando cambio en GitHub…", 0.5);
      await api("/api/estado-cert", { codigo: c.codigo, estado: nuevo });
      progreso(); await recargar(); toast(`${c.codigo}: ${nuevo}`);
    } catch (e) { progreso(); toast(e.message, true); }
  }

  async function pdfImpresion() {
    const vig = S.certificados.filter((c) => c.estado === "vigente");
    if (!vig.length) return toast("No hay certificados vigentes", true);
    const b = $("b-impresion"); b.disabled = true;
    try {
      const cvs = [];
      for (const c of vig) {
        progreso(`Preparando ${cvs.length + 1}/${vig.length}…`, cvs.length / vig.length);
        await new Promise((r) => setTimeout(r, 0)); // deja respirar a la interfaz
        const cv = document.createElement("canvas");
        dibujar(cv, c);
        cvs.push(cv);
      }
      const bytes = pdfDe(cvs);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      a.download = "Certificados_TCG_impresion.pdf";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      progreso(); toast("PDF de impresión descargado");
    } catch (e) { progreso(); toast(e.message, true); }
    finally { b.disabled = false; }
  }

  // ---------- importación masiva ----------
  let filasCsv = [];
  let loteBloqueado = false; // tras publicar (o fallar) hay que cargar un CSV nuevo para no repetir el lote

  function parseCsv(texto) {
    texto = texto.replace(/^﻿/, "");
    const primera = texto.split(/\r?\n/, 1)[0];
    const sep = (primera.match(/;/g) || []).length > (primera.match(/,/g) || []).length ? ";" : ",";
    const filas = []; let f = [], c = "", q = false;
    for (let i = 0; i < texto.length; i++) {
      const ch = texto[i];
      if (q) {
        if (ch === '"' && texto[i + 1] === '"') { c += '"'; i++; }
        else if (ch === '"') q = false;
        else c += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { f.push(c); c = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && texto[i + 1] === "\n") i++;
        f.push(c); c = ""; if (f.some((x) => x.trim())) filas.push(f); f = [];
      } else c += ch;
    }
    f.push(c); if (f.some((x) => x.trim())) filas.push(f);
    return filas;
  }

  const norm = (s) => s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

  function cargarCsv(texto) {
    const filas = parseCsv(texto);
    if (filas.length < 2) throw new Error("El CSV no tiene filas de datos");
    const cab = filas[0].map(norm);
    const idx = (n) => cab.indexOf(n);
    const col = { nombre: idx("nombre"), capacitacion: idx("capacitacion"), fechas: idx("fechas"), area: idx("area") };
    if (col.nombre < 0 || col.capacitacion < 0 || col.fechas < 0) throw new Error("Faltan columnas: se requieren nombre, capacitacion y fechas (area es opcional)");
    filasCsv = filas.slice(1).map((r) => ({
      codigo: "",
      nombre: (r[col.nombre] || "").trim(), capacitacion: (r[col.capacitacion] || "").trim(),
      fechas: (r[col.fechas] || "").trim(), area: col.area >= 0 ? (r[col.area] || "").trim() : "",
      resultado: "",
    }));
    loteBloqueado = false;
    asignarCodigos();
    renderMasivo();
  }

  const completa = (f) => f.nombre && f.capacitacion && f.fechas;

  /** Solo las filas completas reciben código: las omitidas no dejan huecos en la numeración. */
  function asignarCodigos() {
    const m = S.siguiente.match(/^(.*-)(\d+)$/);
    if (!m) throw new Error("No se pudo calcular el siguiente código");
    let n = parseInt(m[2], 10);
    filasCsv.forEach((f) => { f.codigo = completa(f) ? m[1] + String(n++).padStart(3, "0") : ""; });
  }

  function renderMasivo() {
    const tb = $("m-tbody"); tb.innerHTML = "";
    filasCsv.forEach((f, i) => {
      const tr = document.createElement("tr");
      [i + 1, f.codigo, f.nombre, f.capacitacion, f.fechas, f.area, f.resultado].forEach((v) => {
        const td = document.createElement("td"); td.textContent = v; tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    const invalidas = filasCsv.filter((f) => !completa(f)).length;
    $("m-info").textContent = filasCsv.length
      ? `${filasCsv.length} filas${invalidas ? ` · ${invalidas} con datos incompletos (se omitirán)` : ""}` : "";
    $("b-masivo").disabled = loteBloqueado || !filasCsv.length || invalidas === filasCsv.length;
  }

  async function generarMasivo() {
    loteBloqueado = true;
    const b = $("b-masivo"); b.disabled = true;
    const frase = $("m-frase").value || S.config.fraseIntroPorDefecto;
    const validas = filasCsv.filter(completa);
    filasCsv.filter((f) => !completa(f)).forEach((f) => (f.resultado = "Omitido (datos incompletos)"));
    try {
      await publicar(validas.map((f) => ({ ...f, frase })), false, progreso,
        (codigos) => { validas.filter((f) => codigos.includes(f.codigo)).forEach((f) => (f.resultado = "✔ Publicado")); renderMasivo(); });
      progreso(); await recargar();
      $("f-codigo").value = S.siguiente; actualizarPreview(); // el formulario sigue con el código ya usado por el lote
      toast(`${validas.length} certificados publicados`);
    } catch (e) {
      progreso();
      validas.filter((f) => !f.resultado).forEach((f) => (f.resultado = "✖ " + e.message));
      renderMasivo(); toast(e.message, true);
      try { await recargar(); } catch { /* se verá al reintentar */ } // por si parte del lote sí se publicó
    }
  }

  // ---------- ajustes ----------
  async function regenerarTodos() {
    if (!S.certificados.length) return;
    if (!confirm(`Se regenerarán ${S.certificados.length} certificados (PNG, PDF y página) con la BASE_URL:\n${S.config.baseUrl}`)) return;
    const b = $("b-regenerar"); b.disabled = true;
    try {
      await publicar(S.certificados.slice(), true, progreso);
      progreso(); await recargar();
      $("c-info").textContent = `Listo: ${S.certificados.length} certificados regenerados con ${S.config.baseUrl}`;
      toast("Certificados regenerados");
    } catch (e) { progreso(); $("c-info").textContent = e.message; toast(e.message, true); }
    finally { b.disabled = false; }
  }

  // ---------- arranque ----------
  async function entrar() {
    await recargar();
    $("login").hidden = true; $("app").hidden = false;
    if (!$("f-codigo").value) $("f-codigo").value = S.siguiente;
    if (!$("f-frase").value) $("f-frase").value = S.config.fraseIntroPorDefecto;
    if (!$("m-frase").value) $("m-frase").value = S.config.fraseIntroPorDefecto;
    actualizarPreview();
  }

  async function init() {
    [S.layout, S.base] = await Promise.all([
      fetch("plantilla/layout.json").then((r) => r.json()),
      cargarImg("plantilla/certificado_base.png"),
    ]);
    $("form-login").addEventListener("submit", onLogin);
    $("b-salir").addEventListener("click", salir);
    document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
      document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== "tab-" + t.dataset.tab));
    }));
    ["f-nombre", "f-capacitacion", "f-fechas", "f-frase", "f-area", "f-codigo"].forEach((i) => $(i).addEventListener("input", actualizarPreview));
    $("form").addEventListener("submit", onGenerar);
    $("b-sugerir").addEventListener("click", () => { $("f-codigo").value = S.siguiente; actualizarPreview(); });
    $("buscar").addEventListener("input", renderLista);
    $("b-impresion").addEventListener("click", pdfImpresion);
    $("csv-file").addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { cargarCsv(await f.text()); } catch (err) { filasCsv = []; renderMasivo(); toast(err.message, true); }
    });
    $("b-masivo").addEventListener("click", generarMasivo);
    $("b-plantilla-csv").addEventListener("click", () => {
      const csv = "nombre,capacitacion,fechas,area\n\"Nombre Apellido Uno\",\"TÍTULO DE LA CAPACITACIÓN\",\"Realizadas los días 5 y 20 de octubre de 2026.\",TI\n";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
      a.download = "ejemplo_certificados.csv"; a.click();
    });
    $("b-regenerar").addEventListener("click", regenerarTodos);

    try { await entrar(); }
    catch (e) { if (e.status === 401) mostrarLogin(); else { mostrarLogin(); $("l-error").textContent = e.message; } }
  }

  init().catch((e) => document.body.insertAdjacentHTML("afterbegin", `<p style="padding:20px;color:#c0392b">Error al iniciar: ${e.message}</p>`));
})();
