const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Falta la variable de entorno DATABASE_URL (cadena de conexion de Postgres).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Neon (y la mayoria de proveedores gratuitos de Postgres) exigen SSL.
  // rejectUnauthorized:false es lo habitual para conectarse a proveedores
  // gestionados como Neon/Supabase sin instalar su cadena de certificados
  // manualmente. Ponlo en false solo si te conectas a un Postgres local.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false }
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS colaboradores (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('colaborador','admin','visualizador')),
      ip TEXT,
      registered_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS solicitudes (
      id SERIAL PRIMARY KEY,
      folio TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL REFERENCES colaboradores(email),
      nombre TEXT NOT NULL,
      tipo TEXT NOT NULL CHECK(tipo IN ('Vacaciones','Home office','Incapacidad','Asistencia')),
      fecha_inicio TEXT,
      fecha_fin TEXT,
      motivo TEXT,
      adjunto_nombre TEXT,
      adjunto_mime TEXT,
      adjunto_data TEXT,
      estado TEXT NOT NULL DEFAULT 'pendiente' CHECK(estado IN ('pendiente','aprobada','rechazada','registrada')),
      asistencia_hora TEXT,
      asistencia_fecha TEXT,
      asistencia_ip TEXT,
      asistencia_por TEXT,
      created_at BIGINT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS reset_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      expires_at BIGINT NOT NULL
    );
  `);
}

module.exports = { pool, init };
