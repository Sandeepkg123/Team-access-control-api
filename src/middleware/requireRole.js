const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    const userRole = req.membership.role;

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({ error: "Insufficient permissions for this action" });
    }

    next();
  };
};

module.exports = requireRole;