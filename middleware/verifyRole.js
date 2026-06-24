const verifyRole = (...allowedRoles) => {
  return (req, res, next) => {
    const userRole = req.user?.role;

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).send({ 
        message: `Forbidden: Only ${allowedRoles.join("/")} can access this` 
      });
    }

    next();
  };
};

module.exports = verifyRole;