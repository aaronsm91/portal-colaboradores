const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.session;
  if (!token) {
    return res.status(401).json({ error: 'No has iniciado sesion.' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sesion invalida o expirada.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'No tienes permiso para esta accion.' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
