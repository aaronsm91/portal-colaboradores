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
      role TEXT NOT NULL CHECK(role IN ('colaborador','admin','visualizador','supervisor')),
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
      tipo TEXT NOT NULL CHECK(tipo IN ('Vacaciones','Incidencia','Incapacidad','Asistencia')),
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
      asistencia_movimiento TEXT CHECK(asistencia_movimiento IN ('entrada','salida')),
      asistencia_lat DOUBLE PRECISION,
      asistencia_lng DOUBLE PRECISION,
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

  // --- Migraciones ---
  // Estas sentencias permiten que una base de datos creada ANTES de este
  // cambio (con 'Home office' y sin columnas de entrada/salida/ubicacion)
  // se actualice sola la primera vez que el servidor arranca con este
  // codigo. Si la tabla se acaba de crear arriba desde cero, estas
  // sentencias simplemente no encuentran nada que cambiar.
  await pool.query(`ALTER TABLE solicitudes ADD COLUMN IF NOT EXISTS asistencia_movimiento TEXT;`);
  await pool.query(`ALTER TABLE solicitudes ADD COLUMN IF NOT EXISTS asistencia_lat DOUBLE PRECISION;`);
  await pool.query(`ALTER TABLE solicitudes ADD COLUMN IF NOT EXISTS asistencia_lng DOUBLE PRECISION;`);

  // Se quita primero la restriccion vieja (que no permite 'Incidencia' aun)
  // para poder convertir cualquier solicitud de prueba que haya quedado
  // con el tipo anterior 'Home office', y luego se agrega la restriccion
  // nueva ya con 'Incidencia' permitido.
  await pool.query(`ALTER TABLE solicitudes DROP CONSTRAINT IF EXISTS solicitudes_tipo_check;`);
  await pool.query(`UPDATE solicitudes SET tipo = 'Incidencia' WHERE tipo = 'Home office';`);
  await pool.query(`
    ALTER TABLE solicitudes ADD CONSTRAINT solicitudes_tipo_check
    CHECK (tipo IN ('Vacaciones','Incidencia','Incapacidad','Asistencia')) NOT VALID;
  `);

  await pool.query(`ALTER TABLE solicitudes DROP CONSTRAINT IF EXISTS solicitudes_asistencia_movimiento_check;`);
  await pool.query(`
    ALTER TABLE solicitudes ADD CONSTRAINT solicitudes_asistencia_movimiento_check
    CHECK (asistencia_movimiento IS NULL OR asistencia_movimiento IN ('entrada','salida')) NOT VALID;
  `);

  // Agrega el rol 'supervisor' (acceso de solo lectura, unicamente al
  // reporte de asistencia de hoy -- sin ver colaboradores, solicitudes
  // ni incidencias). Como solo se agrega una opcion nueva, los datos
  // existentes ya cumplen la restriccion sin necesidad de "NOT VALID".
  await pool.query(`ALTER TABLE colaboradores DROP CONSTRAINT IF EXISTS colaboradores_role_check;`);
  await pool.query(`
    ALTER TABLE colaboradores ADD CONSTRAINT colaboradores_role_check
    CHECK (role IN ('colaborador','admin','visualizador','supervisor'));
  `);
}

module.exports = { pool, init };
