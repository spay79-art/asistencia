# App de asistencia (instalable)

App para el celular del portero: marcar presentes y visitas de las reuniones, también sin señal. Se instala con
su propio ícono y abre a pantalla completa, como una app nativa. Es una PWA (HTML, CSS y JavaScript, sin
compilación) que habla con el mismo Apps Script de Software Iglesia por `doPost`. Del servidor, solo puede usar el
ingreso y las operaciones del celular (`movil.*`).

| Archivo | Para qué |
| --- | --- |
| `index.html`, `estilos.css`, `app.js` | La app |
| `config.js` | Dirección del servidor (opcional: el QR ya la trae) |
| `manifest.webmanifest` | Nombre, ícono y pantalla completa (lo que permite instalarla) |
| `sw.js` | Guarda la app en el teléfono para que abra sin señal |
| `iconos/` | Íconos (se regeneran con `python iconos/generar.py`) |

## Publicarla en GitHub Pages (gratis)

1. Crea una cuenta en <https://github.com> (si no tienes) y un repositorio **público** llamado, por ejemplo,
   `asistencia`.
2. En el repositorio: **Add file → Upload files** y arrastra **todo el contenido** de esta carpeta `movil/`
   (incluida la carpeta `iconos/`). Pulsa **Commit changes**.
3. **Settings → Pages**: en "Branch" elige `main` y `/ (root)`, y guarda. En un par de minutos queda en
   `https://TU-USUARIO.github.io/asistencia/`.
4. En Software Iglesia, en *Configuración → App de asistencia*, pega esa dirección y guarda.
5. Asegúrate de que la Web App esté **implementada** con acceso "Cualquier usuario". La app usa la dirección
   `/exec`, no `/dev`: cada vez que cambie el servidor hay que publicar una **nueva versión** (*Implementar →
   Gestionar implementaciones → editar → Nueva versión*).

## Instalarla en el celular

1. En el computador: *Asistencia → QR para celulares*. Imprime el código o muéstralo en pantalla.
2. El portero lo escanea con la cámara. Se abre la app y queda conectada sola.
3. Para dejar el ícono en la pantalla de inicio:
   - **Android (Chrome):** aparece "Instalar app", o menú ⋮ → **Instalar aplicación**.
   - **iPhone (Safari):** botón Compartir → **Agregar a pantalla de inicio**.
4. Entra con el correo y la clave de portero.

## Actualizar la app

Sube los archivos cambiados al repositorio. En `sw.js`, aumenta `VERSION` (por ejemplo, `asistencia-v2`) para
que los teléfonos tomen la versión nueva la próxima vez que abran la app con señal.
