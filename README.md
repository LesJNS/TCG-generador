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

- **Emitir**: completa los campos y *Generar y publicar certificado*. El sitio público muestra el
  certificado cuando termina su despliegue (~1 minuto).
- **Emitidos**: búsqueda, **Revocar / Reactivar** (commit al JSON) y *PDF de impresión* (se descarga).
- **Importación masiva**: CSV `nombre, capacitacion, fechas, area`; todo el lote en un solo commit.
- **Ajustes**: muestra `BASE_URL` y el repo. Si cambia la dirección pública: edita `BASE_URL` en Vercel,
  redespliega este panel y pulsa **Regenerar todos** (los QR se rehacen; conserva códigos, fechas y estados).

## Seguridad

- Contraseña verificada en el servidor (comparación en tiempo constante); sesión en cookie `HttpOnly`,
  `Secure`, `SameSite=Strict`, firmada con HMAC y vigente 8 horas.
- Todas las rutas de `/api` (salvo `login` y `logout`) exigen sesión; validan `Origin` y tipo de contenido.
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
regeneración, PDF de impresión y cierre de sesión. Requiere Node 20+, `playwright`, `pillow`,
`opencv-python`, `pymupdf`.

## Estructura

```
api/          funciones de Vercel: login, logout, estado, blob, publicar, estado-cert (+ _auth, _github, _comun)
public/       panel (HTML/JS puros): index.html, app.js, render.js, png.js, vendor/, plantilla/
dev/          servidor de desarrollo, GitHub simulado y prueba de extremo a extremo
```

`public/plantilla/certificado_base.png` y `layout.json` son la plantilla fija (fondo, medallón, logo,
firmas) y las posiciones/estilos del texto y del QR; vienen del repo `tcg-certificados`.
