(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const R = window.TCGRender;

  const S = { config: null, repo: "", certificados: [], layout: null, base: null, siguiente: "", seleccion: new Set() };
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

  // El token de sesión vive en sessionStorage: se borra al cerrar la pestaña (no hay cookie persistente).
  let tokenEnMemoria = "";
  const leerToken = () => { try { return sessionStorage.getItem("tcg_sesion") || ""; } catch { return tokenEnMemoria; } };
  const guardarToken = (t) => { tokenEnMemoria = t; try { sessionStorage.setItem("tcg_sesion", t); } catch { /* sin storage: queda en memoria */ } };
  const borrarToken = () => { tokenEnMemoria = ""; try { sessionStorage.removeItem("tcg_sesion"); } catch { /* nada */ } };

  async function llamar(ruta, opciones) {
    opciones = opciones || {};
    const headers = { ...(opciones.headers || {}) };
    const token = leerToken();
    if (token) headers.Authorization = "Bearer " + token;
    let r;
    try { r = await fetch(ruta, { ...opciones, headers }); }
    catch { throw new ErrorApi("Sin conexión con el servidor", 0); }
    const renovado = r.headers.get("X-Sesion"); // cada respuesta válida extiende la sesión por inactividad
    if (renovado) guardarToken(renovado);
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && ruta !== "/api/login") { borrarToken(); mostrarLogin(); }
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
  /** Al cerrar sesión o vencer, no deja datos de certificados en pantalla ni en memoria. */
  function limpiarDatos() {
    S.certificados = []; S.seleccion.clear(); filasCsv = [];
    ["tbody", "m-tbody"].forEach((i) => ($(i).innerHTML = ""));
    ["f-nombre", "f-area", "f-empresa"].forEach((i) => ($(i).value = ""));
  }

  function mostrarLogin() { limpiarDatos(); $("app").hidden = true; $("login").hidden = false; $("l-pass").focus(); }

  async function onLogin(ev) {
    ev.preventDefault();
    const b = $("l-btn"); b.disabled = true; $("l-error").textContent = "";
    try {
      const r = await api("/api/login", { password: $("l-pass").value });
      guardarToken(r.token);
      $("l-pass").value = "";
      await entrar();
    } catch (e) { $("l-error").textContent = e.message; }
    finally { b.disabled = false; }
  }

  function salir() {
    borrarToken();
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

  const cederTurno = () => new Promise((r) => setTimeout(r, 0)); // deja respirar a la interfaz

  /** PDF de varias páginas dibujando de a un certificado (no acumula canvases en memoria). */
  async function pdfDeRegistros(lista, alProgreso) {
    const { jsPDF } = window.jspdf;
    const [w, h] = S.layout.diapositiva_cm.map((x) => x * 10);
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: [w, h], compress: true });
    for (let i = 0; i < lista.length; i++) {
      if (alProgreso) alProgreso(`Preparando ${i + 1}/${lista.length}…`, i / lista.length);
      await cederTurno();
      dibujar(CANVAS_OCULTO, lista[i]);
      if (i) doc.addPage([w, h], "landscape");
      doc.addImage(CANVAS_OCULTO.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, w, h, undefined, "FAST");
    }
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
    llenarEmpresas();
    renderLista();
  }

  // ---------- vista previa ----------
  function datosForm() {
    return {
      codigo: $("f-codigo").value.trim().toUpperCase(),
      nombre: $("f-nombre").value, capacitacion: $("f-capacitacion").value,
      fechas: $("f-fechas").value, frase: $("f-frase").value, empresa: $("f-empresa").value, area: $("f-area").value,
    };
  }
  let pendiente = false;
  function setAviso(msg, clase) { const a = $("aviso"); a.textContent = msg; a.className = "aviso " + (clase || ""); }

  function actualizarPreview(porEntrada) {
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(() => {
      pendiente = false;
      const d = datosForm();
      const info = dibujar($("canvas"), d);
      $("url-qr").textContent = d.codigo ? `QR → ${S.config.baseUrl}/c/${d.codigo}` : "";
      $("info-preview").textContent = info.escala < 1 ? "El texto se redujo automáticamente para que quepa." : "";
      const existe = S.certificados.some((c) => c.codigo === d.codigo);
      const a = $("aviso");
      if (existe) setAviso(`El código ${d.codigo} ya existe: generar lo sobrescribirá.`, "err");
      else if (a.classList.contains("err") || (porEntrada && a.classList.contains("ok"))) setAviso("", ""); // el aviso de éxito se conserva hasta que se vuelve a escribir
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
      ["f-nombre", "f-area"].forEach((i) => ($(i).value = "")); // la empresa se conserva: suele repetirse
      $("f-nombre").focus();
      actualizarPreview();
    } catch (e) { progreso(); setAviso(e.message, "err"); toast(e.message, true); }
    finally { b.disabled = false; }
  }

  // ---------- lista ----------
  const MAX_DESCARGA = 60; // límite por descarga para no agotar la memoria del navegador

  const orden = { campo: "codigo", dir: 1 };
  const clave = (c, campo) => String(c[campo] || "").toLowerCase();
  const comparar = (a, b) => a.localeCompare(b, "es", { numeric: true });

  function filtrados() {
    const q = $("buscar").value.trim().toLowerCase();
    const desde = $("f-desde").value, hasta = $("f-hasta").value;
    const emp = $("f-emp").value, est = $("f-est").value;
    return S.certificados
      .filter((c) =>
        (!q || [c.codigo, c.nombre, c.empresa, c.area, c.capacitacion].join(" ").toLowerCase().includes(q)) &&
        (!emp || (emp === "__sin__" ? !c.empresa : c.empresa === emp)) &&
        (!est || c.estado === est) &&
        (!desde || c.fecha_emision >= desde) && (!hasta || c.fecha_emision <= hasta))
      .sort((a, b) => comparar(clave(a, orden.campo), clave(b, orden.campo)) * orden.dir || comparar(a.codigo, b.codigo));
  }

  /** Rellena el filtro de empresas con las que existen (conserva la elección si sigue existiendo). */
  function llenarEmpresas() {
    const sel = $("f-emp"), actual = sel.value;
    const empresas = [...new Set(S.certificados.map((c) => c.empresa).filter(Boolean))].sort(comparar);
    sel.innerHTML = "";
    const op = (valor, texto) => { const o = document.createElement("option"); o.value = valor; o.textContent = texto; sel.appendChild(o); };
    op("", "Todas"); op("__sin__", "(Sin empresa)");
    empresas.forEach((e) => op(e, e));
    sel.value = [...sel.options].some((o) => o.value === actual) ? actual : "";
  }

  /** Qué se descargaría ahora: la selección o, si no hay, todo lo que se ve. Los revocados se omiten. */
  function objetivoDescarga() {
    const base = S.seleccion.size ? S.certificados.filter((c) => S.seleccion.has(c.codigo)) : filtrados();
    const lista = base.filter((c) => c.estado === "vigente");
    return { lista, omitidos: base.length - lista.length, porSeleccion: S.seleccion.size > 0 };
  }

  function actualizarSeleccion(filas) {
    filas = filas || filtrados();
    const todos = $("chk-todos");
    const marcados = filas.filter((c) => S.seleccion.has(c.codigo)).length;
    todos.checked = filas.length > 0 && marcados === filas.length;
    todos.indeterminate = marcados > 0 && marcados < filas.length;
    const o = objetivoDescarga();
    $("sel-info").textContent = (o.porSeleccion
      ? `${S.seleccion.size} seleccionado(s)`
      : `Sin selección: se descargan los ${o.lista.length} que se ven`) +
      (o.omitidos ? ` · ${o.omitidos} revocado(s) no se incluyen` : "");
    $("b-descargar").disabled = !o.lista.length;
    $("b-asignar").disabled = !S.seleccion.size;
    $("b-eliminar").disabled = !S.seleccion.size;
    document.querySelectorAll("#tbody tr").forEach((tr) => tr.classList.toggle("sel", S.seleccion.has(tr.dataset.codigo)));
  }

  // ---- menú flotante (una sola instancia, fuera de la tabla para que no lo recorte el desplazamiento)
  let menuDe = null;
  function cerrarMenu() {
    const m = $("menu-global");
    m.hidden = true; m.innerHTML = "";
    if (menuDe) { menuDe.setAttribute("aria-expanded", "false"); menuDe = null; }
  }
  function abrirMenu(btn, items) {
    if (menuDe === btn) return cerrarMenu();
    cerrarMenu();
    const m = $("menu-global");
    items.forEach(([texto, fn, clase]) => {
      const b = document.createElement("button");
      b.type = "button"; b.setAttribute("role", "menuitem"); b.className = "menu-item " + (clase || ""); b.textContent = texto;
      b.onclick = () => { cerrarMenu(); fn(); };
      m.appendChild(b);
    });
    m.hidden = false;
    const r = btn.getBoundingClientRect(), alto = m.offsetHeight, ancho = m.offsetWidth;
    const abajo = r.bottom + 4 + alto <= window.innerHeight;
    m.style.top = (abajo ? r.bottom + 4 : Math.max(4, r.top - 4 - alto)) + "px";
    m.style.left = Math.max(4, Math.min(r.right - ancho, window.innerWidth - ancho - 4)) + "px";
    btn.setAttribute("aria-expanded", "true");
    menuDe = btn;
    m.firstChild.focus({ preventScroll: true });
  }

  function renderLista() {
    const tb = $("tbody"); tb.innerHTML = "";
    cerrarMenu();
    const filas = filtrados();
    for (const c of [...S.seleccion]) if (!filas.some((f) => f.codigo === c)) S.seleccion.delete(c); // la selección siempre es visible
    for (const c of filas) {
      const tr = document.createElement("tr");
      tr.dataset.codigo = c.codigo;
      const celda = (t) => { const td = document.createElement("td"); td.textContent = t; tr.appendChild(td); return td; };
      const tdChk = celda(""); tdChk.className = "chk";
      const chk = document.createElement("input");
      chk.type = "checkbox"; chk.checked = S.seleccion.has(c.codigo); chk.setAttribute("aria-label", "Seleccionar " + c.codigo);
      chk.onchange = () => { chk.checked ? S.seleccion.add(c.codigo) : S.seleccion.delete(c.codigo); actualizarSeleccion(); };
      tdChk.appendChild(chk);
      celda(c.codigo).className = "cod";
      celda(c.nombre);
      const tdEmp = celda(c.empresa || "—"); if (!c.empresa) tdEmp.className = "vacio";
      const tdArea = celda(c.area || "—"); if (!c.area) tdArea.className = "vacio";
      celda(c.fecha_emision);
      const tdE = celda(""); const sp = document.createElement("span");
      sp.className = "badge " + c.estado; sp.textContent = c.estado; tdE.appendChild(sp);

      const acc = celda(""); acc.className = "acc";
      const caja = document.createElement("div"); caja.className = "acc-flex"; acc.appendChild(caja);
      const boton = (txt, fn, clase, etiqueta) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "mini " + (clase || ""); b.textContent = txt; b.onclick = fn;
        if (etiqueta) { b.setAttribute("aria-label", etiqueta); b.title = etiqueta; b.setAttribute("aria-haspopup", "true"); b.setAttribute("aria-expanded", "false"); }
        caja.appendChild(b); return b;
      };
      boton("Previsualizar", () => abrirVista(c.codigo), "primario");
      const dl = boton("Descargar ▾", () => abrirMenu(dl, [["PNG (alta resolución)", () => descargarUno(c, "png")], ["PDF", () => descargarUno(c, "pdf")]]), "", "Descargar este certificado");
      boton("Editar", () => abrirEditar([c.codigo]));
      const mas = boton("⋯", () => abrirMenu(mas, [
        ["Abrir página pública", () => window.open(`${S.config.baseUrl}/c/${c.codigo}`, "_blank", "noopener")],
        [c.estado === "vigente" ? "Revocar" : "Reactivar", () => cambiarEstado(c), c.estado === "vigente" ? "peligro" : ""],
        ["Eliminar…", () => abrirEliminar([c.codigo]), "peligro"],
      ]), "", "Más acciones");
      tb.appendChild(tr);
    }
    $("vacio").hidden = filas.length > 0;
    const vig = S.certificados.filter((c) => c.estado === "vigente").length;
    $("resumen").textContent = `${S.certificados.length} certificado(s) · ${vig} vigente(s) · ${S.certificados.length - vig} revocado(s)` +
      (filas.length !== S.certificados.length ? ` — mostrando ${filas.length}` : "");
    document.querySelectorAll("th[data-orden]").forEach((th) =>
      th.setAttribute("aria-sort", th.dataset.orden === orden.campo ? (orden.dir > 0 ? "ascending" : "descending") : "none"));
    actualizarSeleccion(filas);
  }

  // ---------- vista previa ----------
  function abrirVista(codigo) {
    const lista = filtrados();
    const i = lista.findIndex((c) => c.codigo === codigo);
    if (i < 0) return;
    const c = lista[i];
    $("v-codigo").textContent = c.codigo;
    const est = $("v-estado"); est.textContent = c.estado; est.className = "badge " + c.estado;
    $("v-pos").textContent = `${i + 1} de ${lista.length}`;
    dibujar($("v-canvas"), c);
    $("v-nombre").textContent = c.nombre;
    $("v-capacitacion").textContent = c.capacitacion;
    $("v-fechas").textContent = c.fechas;
    $("v-empresa").textContent = c.empresa || "—";
    $("v-area").textContent = c.area || "—";
    $("v-emision").textContent = c.fecha_emision;
    $("v-ant").disabled = i === 0;
    $("v-sig").disabled = i === lista.length - 1;
    $("v-pagina").href = `${S.config.baseUrl}/c/${c.codigo}`;
    const d = $("dlg-ver");
    d.dataset.codigo = c.codigo;
    if (!d.open) d.showModal();
  }

  function moverVista(delta) {
    const lista = filtrados();
    const i = lista.findIndex((c) => c.codigo === $("dlg-ver").dataset.codigo) + delta;
    if (i >= 0 && i < lista.length) abrirVista(lista[i].codigo);
  }

  const registroDeVista = () => S.certificados.find((c) => c.codigo === $("dlg-ver").dataset.codigo);

  async function cambiarEstado(c) {
    const nuevo = c.estado === "vigente" ? "revocado" : "vigente";
    if (!confirm(`¿Marcar ${c.codigo} (${c.nombre}) como ${nuevo}?`)) return;
    try {
      progreso("Publicando cambio en GitHub…", 0.5);
      await api("/api/estado-cert", { codigo: c.codigo, estado: nuevo });
      progreso(); await recargar(); toast(`${c.codigo}: ${nuevo}`);
    } catch (e) { progreso(); toast(e.message, true); }
  }

  // ---------- descargas ----------
  function bajar(datos, nombre, tipo) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([datos], { type: tipo }));
    a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 15000);
  }

  /** Dibuja el certificado con los datos del registro y devuelve el PNG o el PDF. */
  function archivoDe(c, tipo) {
    dibujar(CANVAS_OCULTO, c);
    return tipo === "png" ? TCGPng.codificar(CANVAS_OCULTO) : pdfDe([CANVAS_OCULTO]);
  }

  async function descargarUno(c, tipo) {
    try {
      progreso(`Preparando ${c.codigo} (${tipo.toUpperCase()})…`, 0.5);
      await cederTurno();
      bajar(archivoDe(c, tipo), `${c.codigo}.${tipo}`, tipo === "png" ? "image/png" : "application/pdf");
    } catch (e) { toast(e.message, true); }
    finally { progreso(); }
  }

  async function descargar() {
    const { lista, porSeleccion } = objetivoDescarga();
    if (!lista.length) return toast("No hay certificados vigentes para descargar", true);
    if (lista.length > MAX_DESCARGA) return toast(`Son ${lista.length} certificados: acota el rango o la selección (máximo ${MAX_DESCARGA} por descarga)`, true);
    const formato = $("d-formato").value;
    const desde = $("f-desde").value, hasta = $("f-hasta").value;
    const sufijo = porSeleccion ? "_seleccion" : desde || hasta ? `_${desde || "inicio"}_a_${hasta || "hoy"}` : "";
    const b = $("b-descargar"); b.disabled = true;
    try {
      if (formato === "pdf1") {
        bajar(await pdfDeRegistros(lista, progreso), `Certificados_TCG${sufijo}.pdf`, "application/pdf");
      } else {
        const ext = formato === "zip-png" ? "png" : "pdf";
        const archivos = {};
        for (let i = 0; i < lista.length; i++) {
          progreso(`Preparando ${i + 1}/${lista.length}…`, i / lista.length);
          await cederTurno();
          archivos[`${lista[i].codigo}.${ext}`] = archivoDe(lista[i], ext);
        }
        progreso("Comprimiendo…", 0.99);
        await cederTurno();
        bajar(window.fflate.zipSync(archivos, { level: 0 }), `Certificados_TCG${sufijo}_${ext.toUpperCase()}.zip`, "application/zip");
      }
      toast(`${lista.length} certificado(s) descargado(s)`);
    } catch (e) { toast(e.message, true); }
    finally { progreso(); actualizarSeleccion(); }
  }

  // ---------- eliminar ----------
  let porEliminar = [];

  function abrirEliminar(codigos) {
    const regs = S.certificados.filter((c) => codigos.includes(c.codigo));
    if (!regs.length) return;
    porEliminar = regs.map((c) => c.codigo);
    $("x-titulo").textContent = regs.length === 1 ? `Eliminar ${regs[0].codigo}` : `Eliminar ${regs.length} certificados`;
    $("x-lista").textContent = regs.map((c) => `${c.codigo} · ${c.nombre}${c.estado === "vigente" ? "" : " (revocado)"}`).join("\n");
    $("x-lista").style.whiteSpace = "pre-line";
    $("x-confirmar").value = "";
    $("x-ok").disabled = true;
    $("dlg-eliminar").showModal();
    $("x-confirmar").focus();
  }

  async function ejecutarEliminar(ev) {
    ev.preventDefault();
    if ($("x-confirmar").value.trim() !== "ELIMINAR") return;
    const codigos = porEliminar.slice();
    $("dlg-eliminar").close();
    try {
      progreso("Eliminando y publicando en GitHub…", 0.5);
      await api("/api/eliminar", { codigos });
      codigos.forEach((c) => S.seleccion.delete(c));
      progreso(); await recargar();
      toast(`${codigos.length} certificado(s) eliminado(s)`);
    } catch (e) { progreso(); toast(e.message, true); }
  }

  // ---------- editar empresa / área ----------
  let edicion = null;

  function abrirEditar(codigos) {
    const regs = S.certificados.filter((c) => codigos.includes(c.codigo));
    if (!regs.length) return;
    const uno = regs.length === 1;
    edicion = { codigos, uno };
    $("e-titulo").textContent = uno ? `Editar ${regs[0].codigo}` : `Asignar a ${regs.length} certificados`;
    $("e-ayuda").textContent = uno
      ? "Estos datos no se imprimen en el certificado."
      : "Solo se cambian los campos que llenes; los que dejes vacíos se mantienen como están.";
    $("e-empresa").value = uno ? regs[0].empresa || "" : "";
    $("e-area").value = uno ? regs[0].area || "" : "";
    $("dlg-editar").showModal();
    $("e-empresa").focus();
  }

  async function guardarEdicion(ev) {
    ev.preventDefault();
    const empresa = $("e-empresa").value.trim(), area = $("e-area").value.trim();
    const cuerpo = { codigos: edicion.codigos };
    if (edicion.uno) { cuerpo.empresa = empresa; cuerpo.area = area; }
    else { if (empresa) cuerpo.empresa = empresa; if (area) cuerpo.area = area; }
    if (cuerpo.empresa === undefined && cuerpo.area === undefined) return toast("No escribiste ningún dato para cambiar", true);
    $("dlg-editar").close();
    try {
      progreso("Publicando cambio en GitHub…", 0.5);
      await api("/api/editar", cuerpo);
      progreso(); await recargar(); toast(`Datos actualizados (${edicion.codigos.length})`);
    } catch (e) { progreso(); toast(e.message, true); }
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
    const col = { nombre: idx("nombre"), capacitacion: idx("capacitacion"), fechas: idx("fechas"), empresa: idx("empresa"), area: idx("area") };
    if (col.nombre < 0 || col.capacitacion < 0 || col.fechas < 0) throw new Error("Faltan columnas: se requieren nombre, capacitacion y fechas (empresa y area son opcionales)");
    filasCsv = filas.slice(1).map((r) => ({
      codigo: "",
      nombre: (r[col.nombre] || "").trim(), capacitacion: (r[col.capacitacion] || "").trim(),
      fechas: (r[col.fechas] || "").trim(), empresa: col.empresa >= 0 ? (r[col.empresa] || "").trim() : "",
      area: col.area >= 0 ? (r[col.area] || "").trim() : "",
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
      [i + 1, f.codigo, f.nombre, f.capacitacion, f.fechas, f.empresa, f.area, f.resultado].forEach((v) => {
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
    ["f-nombre", "f-capacitacion", "f-fechas", "f-frase", "f-empresa", "f-area", "f-codigo"].forEach((i) => $(i).addEventListener("input", () => actualizarPreview(true)));
    $("form").addEventListener("submit", onGenerar);
    $("b-sugerir").addEventListener("click", () => { $("f-codigo").value = S.siguiente; actualizarPreview(); });
    ["buscar", "f-desde", "f-hasta", "f-emp", "f-est"].forEach((i) => $(i).addEventListener("input", renderLista));
    $("b-limpiar").addEventListener("click", () => { ["buscar", "f-desde", "f-hasta", "f-emp", "f-est"].forEach((i) => ($(i).value = "")); renderLista(); });
    $("chk-todos").addEventListener("change", (e) => {
      filtrados().forEach((c) => (e.target.checked ? S.seleccion.add(c.codigo) : S.seleccion.delete(c.codigo)));
      renderLista();
    });
    document.querySelectorAll("th[data-orden]").forEach((th) => {
      const ordenar = () => {
        orden.dir = orden.campo === th.dataset.orden ? -orden.dir : 1;
        orden.campo = th.dataset.orden;
        renderLista();
      };
      th.addEventListener("click", ordenar);
      th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ordenar(); } });
    });
    document.addEventListener("click", (e) => { if (menuDe && e.target !== menuDe && !$("menu-global").contains(e.target)) cerrarMenu(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && menuDe) cerrarMenu(); });
    window.addEventListener("scroll", cerrarMenu, true);
    window.addEventListener("resize", cerrarMenu);
    $("menu-global").addEventListener("keydown", (e) => {
      const items = [...$("menu-global").children], i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
    $("v-cerrar").addEventListener("click", () => $("dlg-ver").close());
    $("v-ant").addEventListener("click", () => moverVista(-1));
    $("v-sig").addEventListener("click", () => moverVista(1));
    $("v-png").addEventListener("click", () => { const c = registroDeVista(); if (c) descargarUno(c, "png"); });
    $("v-pdf").addEventListener("click", () => { const c = registroDeVista(); if (c) descargarUno(c, "pdf"); });
    $("dlg-ver").addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") { e.preventDefault(); moverVista(-1); }
      if (e.key === "ArrowRight") { e.preventDefault(); moverVista(1); }
    });
    $("dlg-ver").addEventListener("click", (e) => { if (e.target === $("dlg-ver")) $("dlg-ver").close(); }); // clic fuera = cerrar
    $("b-descargar").addEventListener("click", descargar);
    $("b-asignar").addEventListener("click", () => abrirEditar([...S.seleccion]));
    $("form-editar").addEventListener("submit", guardarEdicion);
    $("e-cancelar").addEventListener("click", () => $("dlg-editar").close());
    $("b-eliminar").addEventListener("click", () => abrirEliminar([...S.seleccion]));
    $("x-confirmar").addEventListener("input", () => ($("x-ok").disabled = $("x-confirmar").value.trim() !== "ELIMINAR"));
    $("form-eliminar").addEventListener("submit", ejecutarEliminar);
    $("x-cancelar").addEventListener("click", () => $("dlg-eliminar").close());
    $("csv-file").addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { cargarCsv(await f.text()); } catch (err) { filasCsv = []; renderMasivo(); toast(err.message, true); }
    });
    $("b-masivo").addEventListener("click", generarMasivo);
    $("b-plantilla-csv").addEventListener("click", () => {
      const csv = "nombre,capacitacion,fechas,empresa,area\n\"Nombre Apellido Uno\",\"TÍTULO DE LA CAPACITACIÓN\",\"Realizadas los días 5 y 20 de octubre de 2026.\",\"Empresa Ejemplo S.A.\",TI\n";
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
