# Portal de registro de colaboradores (LFT) — backend + frontend

App completa (frontend + API) para el registro de colaboradores, solicitudes
de vacaciones/home office/incapacidad, autoregistro de asistencia con IP, y
recuperacion de contrasena. Probada de punta a punta contra Postgres real.

## Arquitectura, en una linea

Un solo servidor Node/Express sirve el frontend (`public/index.html`) y la
API (`/api/...`), y guarda todo en Postgres — incluyendo los archivos
adjuntos, guardados como texto (base64) dentro de la base de datos en vez de
en disco. Esto es deliberado: los planes gratuitos de hosting no tienen
disco persistente, asi que nada que dependa de escribir archivos en disco
sobrevive un reinicio ahi. Guardarlo en Postgres si sobrevive.

## Desplegar gratis (GitHub + Neon + Render)

Ningun paso de esto pide tarjeta de credito.

### 1. Sube el proyecto a GitHub
Crea un repositorio nuevo (puede ser privado) y sube esta carpeta.
```bash
git init
git add .
git commit -m "Portal de colaboradores"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git push -u origin main
```

### 2. Crea tu base de datos gratis en Neon
1. Entra a **neon.tech** y crea una cuenta (no pide tarjeta).
2. Crea un proyecto nuevo.
3. En el panel del proyecto, copia el **Connection string** — algo como
   `postgresql://usuario:password@ep-algo.neon.tech/neondb?sslmode=require`.
   Guardalo, lo necesitas en el paso 4.

### 3. Crea el servicio web gratis en Render
1. Entra a **render.com** y crea una cuenta (no pide tarjeta para el plan free).
2. "New" -> "Web Service" -> conecta tu repositorio de GitHub.
3. Configuracion:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free

### 4. Configura las variables de entorno en Render
En la seccion "Environment" de tu servicio, agrega:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | El connection string de Neon del paso 2 |
| `JWT_SECRET` | Genera uno con el comando de abajo |
| `ACCESS_CODE` | Tu propio codigo (no dejes 181010) |
| `COOKIE_SECURE` | `true` |
| `CLIENT_ORIGIN` | La URL que Render te asigne, ej. `https://tu-app.onrender.com` |
| `APP_URL` | La misma URL que Render te asigne |

Para generar el `JWT_SECRET`, corre esto en tu computadora:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Si quieres que la recuperacion de contrasena mande correos reales, agrega
tambien `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`
(por ejemplo con una cuenta gratuita de Brevo o SendGrid). Si los dejas
sin llenar, el enlace se imprime en los logs de Render en vez de enviarse
por correo — sirve para probar, no para produccion real.

### 5. Deploy
Guarda las variables, Render construye y despliega solo. En unos minutos
tu app queda viva en `https://tu-app.onrender.com` con el frontend y la
API juntos, en HTTPS automatico.

## Lo que debes saber sobre el plan gratuito

- **Se "duerme" tras 15 minutos sin trafico.** La primera peticion
  despues de eso tarda entre 30 y 50 segundos en responder mientras
  Render lo despierta. Para 24 personas usando el portal de vez en
  cuando, es un costo aceptable a cambio de que sea gratis. Si esto
  te molesta, el siguiente escalon de Render cuesta $7 USD/mes y
  elimina el problema.
- **Neon tambien se "duerme"** tras 5 minutos de inactividad, pero
  despierta en menos de un segundo — no lo notaras.
- **El plan gratis de Neon** incluye 0.5 GB de almacenamiento — de
  sobra para 24 colaboradores con solicitudes y adjuntos de hasta 2 MB.
- Cada vez que subas cambios a GitHub (`git push`), Render vuelve a
  desplegar automaticamente.

## Instalacion local (para probar antes de subir cambios)

```bash
npm install
cp .env.example .env
```

Llena `DATABASE_URL` (usa el mismo de Neon, o un Postgres local),
`JWT_SECRET` y `ACCESS_CODE` en `.env`. Luego:

```bash
npm start
```

Tu app queda en `http://localhost:4000` — frontend y API juntos.

## Endpoints principales

| Metodo | Ruta | Quien | Descripcion |
|---|---|---|---|
| POST | /api/auth/register | Publico | Crea cuenta. Requiere `codigo` si el rol es admin/visualizador |
| POST | /api/auth/login | Publico | Inicia sesion, entrega cookie de sesion |
| POST | /api/auth/logout | Con sesion | Cierra sesion |
| GET | /api/auth/me | Con sesion | Datos del usuario actual |
| POST | /api/auth/forgot-password | Publico | Genera enlace de restablecimiento |
| POST | /api/auth/reset-password | Publico (con token) | Cambia la contrasena |
| POST | /api/solicitudes | Con sesion | Crea una solicitud (multipart si lleva adjunto) |
| GET | /api/solicitudes | Con sesion | Colaborador ve las suyas; RH/visualizador ven todas |
| GET | /api/solicitudes/colaboradores | RH/visualizador | Lista de colaboradores registrados |
| PATCH | /api/solicitudes/:folio/estado | Solo RH | Aprueba o rechaza |
| POST | /api/solicitudes/:folio/asistencia | Solo RH | Registra hora local e IP |
| GET | /api/solicitudes/:folio/adjunto | Dueno/RH/visualizador | Descarga el archivo adjunto |

## Checklist antes de avisarle a tu equipo

- [ ] `ACCESS_CODE` cambiado del valor de prueba (181010)
- [ ] `JWT_SECRET` propio, generado con el comando de arriba
- [ ] `COOKIE_SECURE=true` en Render
- [ ] Probaste registrarte, iniciar sesion, y crear una solicitud tu misma
- [ ] Correo real configurado si quieres que "olvide mi contrasena" funcione sin que revises los logs
- [ ] Aviso de privacidad para tus colaboradores (LFPDPPP), ya que guardas IPs y datos personales

## Si mas adelante quieres quitar el "sueño" del plan gratis

Sube el servicio de Render al plan Starter ($7 USD/mes) — no necesitas
cambiar nada del codigo, solo cambiar el tipo de instancia desde el panel
de Render. Todo lo demas (Neon, GitHub, el dominio) sigue igual.
