const bcrypt = require("bcryptjs");
const User = require("../models/User");

// GET /users/me — return the authenticated user's profile
const getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select("-password -refreshToken -passwordResetToken -passwordResetExpires");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
};

// PATCH /users/me — update name and/or password
const updateProfile = async (req, res, next) => {
  try {
    const { name, currentPassword, password } = req.body || {};
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: "User not found" });

    // If changing password, verify current password first
    if (password) {
      const isMatch = await bcrypt.compare(currentPassword || "", user.password);
      if (!isMatch) {
        return res.status(401).json({ error: "Current password is incorrect" });
      }
      user.password = await bcrypt.hash(password, 10);
    }

    if (name !== undefined) user.name = name;
    await user.save();

    // Return user without sensitive fields
    const safeUser = user.toObject();
    delete safeUser.password;
    delete safeUser.refreshToken;
    delete safeUser.passwordResetToken;
    delete safeUser.passwordResetExpires;

    res.status(200).json({ message: "Profile updated", user: safeUser });
  } catch (err) {
    next(err);
  }
};

module.exports = { getMe, updateProfile };
