# TCG-generador

Panel de administración **con contraseña** para emitir certificados de Towers Consulting Group (TCG).
Se despliega en Vercel y publica los certificados en el repositorio del sitio de verificación
(`LesJNS/tcg-certificados`), que Vercel vuelve a desplegar solo.

```
 navegador (admin)  ──►  Vercel: este proyecto (/api, con contraseña)  ──►  GitHub: tcg-certificados  ──►  Vercel: sitio público
   dibuja el certificado      valida sesión y hace el commit                  publico/certs, c, data       /c/TCG-CI-2026-001
```

- El certificado (PNG, PDF y vista JPG) se dibuja **en el navegador** del administrador, con la misma
  plantilla y estilos que el panel local.
- Cada archivo se sube por separado a `/api/blob` (Vercel limita cada petición a 4,5 MB) y luego
  `/api/publicar` reúne todo en **un solo commit** (un lote de hasta 40 certificados = un solo despliegue).
- El token de GitHub vive **solo** en variables de entorno del servidor; el navegador nunca lo ve.

## 1. Token de GitHub (permiso mínimo)

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate:

- *Repository access*: **Only select repositories** → `tcg-certificados`
- *Permissions → Repository → Contents*: **Read and write** (nada más)
- Caducidad: la que prefieras (anótala: cuando venza hay que renovar el token en Vercel).

## 2. Desplegar en Vercel

1. Vercel → **Add New → Project** → importa `LesJNS/TCG-generador`. *Root Directory* `./`, *Framework Preset* **Other**.
   (`vercel.json` ya indica que lo estático está en `public/` y las funciones en `api/`).
2. Antes de *Deploy*, en **Environment Variables** agrega (ver `.env.example`):

| Variable | Valor |
|---|---|
| `ADMIN_PASSWORD` | la contraseña de acceso al panel (larga; úsala solo aquí) |
| `SESSION_SECRET` | cadena aleatoria: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `GITHUB_TOKEN` | el token del paso 1 |
| `GITHUB_REPO` | `LesJNS/tcg-certificados` |
| `GITHUB_BRANCH` | `main` |
| `PUBLIC_DIR` | `publico` |
| `BASE_URL` | `https://tcg-certificados.vercel.app` (dirección pública del sitio; va dentro del QR) |

3. **Deploy**. Abre la URL del proyecto, ingresa la contraseña y emite.

Cambiar la contraseña: edita `ADMIN_PASSWORD` en Vercel y vuelve a desplegar. Para cerrar todas las
sesiones abiertas, cambia también `SESSION_SECRET`.

## 3. Uso

- **Emitir**: completa los campos y *Generar y publicar certificado*. La **empresa** y el **área** son
  opcionales y no se imprimen (solo quedan en el registro). El sitio público muestra el certificado cuando
  termina su despliegue (~1 minuto).
- **Emitidos**: tabla con Código, Participante, **Empresa**, Área, Emisión y Estado, un resumen
  (total / vigentes / revocados) y, por fila: **Previsualizar**, **Descargar ▾** (PNG o PDF al instante, con el QR
  actual), **Editar** y **⋯** (abrir página pública, Revocar/Reactivar, Eliminar).
  - *Buscar* por código, nombre, empresa, área o capacitación; *filtrar* por empresa, estado y rango de fechas de
    emisión; *ordenar* haciendo clic en el encabezado de cada columna.
  - **Previsualizar** abre el certificado en grande con sus datos; ← → para pasar al anterior o siguiente de la
    lista (respeta filtros y orden), y desde ahí puedes descargar el PNG o el PDF.
  - **Descarga por rango o selección**: marca casillas (la casilla de arriba marca todos los visibles) o deja
    sin marcar para usar todo lo que se ve; elige *PDF único*, *ZIP de PDF* o *ZIP de PNG* y pulsa **Descargar**.
    Los revocados no se incluyen. Máximo 60 certificados por descarga.
  - **Editar** (por fila) o **Asignar empresa/área…** (a la selección): cambia esos dos datos en un solo commit,
    sin tocar las imágenes ni los QR. En la edición masiva solo cambian los campos que llenes.
  - **Revocar / Reactivar** (commit al JSON).
  - **Eliminar** (por fila, o *Eliminar…* para la selección): pide escribir `ELIMINAR`, borra el registro y los
    archivos (PNG, JPG, PDF y la página `/c/CÓDIGO`) en un solo commit. Quien escanee su QR verá "no encontrado".
    El código se anota en `data/eliminados.json` y **no se reutiliza nunca** (así un QR ya impreso no puede
    apuntar a otra persona). Si el certificado ya se entregó, es mejor **Revocar**: el QR muestra "revocado".
- **Importación masiva**: CSV `nombre, capacitacion, fechas` y, opcionalmente, `empresa, area`; todo el lote en
  un solo commit.
- **Ajustes**: muestra `BASE_URL` y el repo. Si cambia la dirección pública: edita `BASE_URL` en Vercel,
  redespliega este panel y pulsa **Regenerar todos** (los QR se rehacen; conserva códigos, fechas y estados).

## Seguridad

- Contraseña verificada en el servidor (comparación en tiempo constante). La sesión es un **token firmado
  (HMAC)** que el navegador guarda en `sessionStorage` y envía en la cabecera `Authorization`: **no hay cookie**,
  así que **al cerrar la pestaña hay que volver a ingresar la contraseña** (recargar la pestaña no la pierde).
- El token **caduca a las 2 horas sin actividad** (cada petición válida lo renueva) y, en cualquier caso, a las
  **8 horas** del ingreso. Salir borra el token y los datos de la pantalla. Cambiar `SESSION_SECRET` invalida
  todos los tokens.
- Todas las rutas de `/api` (salvo `login`) exigen el token; validan `Origin` y tipo de contenido.
- Cabeceras de seguridad (`vercel.json`): CSP estricta (solo scripts propios, sin `unsafe-eval`, sin iframes),
  `X-Frame-Options`, `nosniff`, `no-referrer` y `noindex`.
- Cada intento fallido de login espera ~0,8 s. Para una defensa real contra fuerza bruta, activa una regla
  de límite de tasa para `/api/login` en Vercel → Firewall.
- Hay **una sola contraseña compartida**: no distingue quién emitió. Los commits salen a nombre del dueño
  del token. Si necesitas auditoría por persona, hay que añadir usuarios.
- El panel (HTML/JS) es público pero no contiene secretos; sin sesión no puede leer ni escribir nada.

## Probar sin Vercel ni GitHub

```
python dev/probar_panel.py
```

Arranca un GitHub simulado (`dev/github_falso.js`, sembrado con `../publico`) y el servidor de desarrollo
(`dev/servidor.js`), y recorre: login y errores de seguridad, emisión (PNG sin pérdida, QR decodificado
en PNG/JPG/PDF), revocar, importación masiva en un commit, conflicto de commits con reintento,
regeneración, eliminación, empresa y edición masiva, filtros por fecha, descargas (PNG/PDF directos, ZIP y PDF único con QR
decodificado) y cierre de sesión. Requiere Node 20+, `playwright`, `pillow`,
`opencv-python`, `pymupdf`.

## Estructura

```
api/          funciones de Vercel: login, estado, blob, publicar, estado-cert, editar, eliminar (+ _auth, _github, _comun)
public/       panel (HTML/JS puros): index.html, app.js, render.js, png.js, vendor/, plantilla/
dev/          servidor de desarrollo, GitHub simulado y prueba de extremo a extremo
```

`public/plantilla/certificado_base.png` y `layout.json` son la plantilla fija (fondo, medallón, logo,
firmas) y las posiciones/estilos del texto y del QR; vienen del repo `tcg-certificados`.
