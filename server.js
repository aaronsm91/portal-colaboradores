require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const { init } = require('./db');
const authRoutes = require('./routes/auth');
const solicitudesRoutes = require('./routes/solicitudes');

const requiredEnv = ['JWT_SECRET', 'ACCESS_CODE', 'DATABASE_URL'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Falta la variable de entorno ${key}. Copia .env.example a .env y llenala.`);
    process.exit(1);
  }
}

const app = express();

// Necesario para que req.ip refleje la IP real del cliente detras de un
// proxy/balanceador (Nginx, Render, Railway, etc.) en produccion.
app.set('trust proxy', 1);

// El frontend se sirve desde este mismo servidor (mismo origen), asi que
// CORS solo hace falta si algun dia separas frontend y backend en dominios
// distintos. Se deja configurado por si acaso.
app.use(cors({ origin: process.env.CLIENT_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/solicitudes', solicitudesRoutes);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Sirve el frontend (public/index.html y sus assets)
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Manejador de errores (incluye errores de multer, p.ej. archivo demasiado grande)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 400).json({ error: err.message || 'Ocurrio un error inesperado.' });
});

const PORT = process.env.PORT || 4000;

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Backend del portal de colaboradores corriendo en http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('No se pudo conectar a la base de datos:', err.message);
    process.exit(1);
  });
