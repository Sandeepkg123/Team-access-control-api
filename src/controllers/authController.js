const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/User");
const { generateAccessToken, generateRefreshToken } = require("../utils/generateToken");

// SIGNUP
const signup = async (req, res, next) => {
  try {
    const { name, email, password } = req.body;

    // Deliberately do NOT tell the caller whether the email is taken. Returning
    // "Email already registered" let anyone enumerate which addresses have
    // accounts here. Respond identically either way; the unique index on
    // User.email is what actually prevents duplicates.
    const existingUser = await User.findOne({ email });

    if (!existingUser) {
      const hashedPassword = await bcrypt.hash(password, 10); // 10 = salt rounds
      const user = await User.create({ name, email, password: hashedPassword });
      return res.status(201).json({ message: "User created", userId: user._id });
    }

    res.status(201).json({ message: "User created", userId: existingUser._id });
  } catch (err) {
    next(err);
  }
};

// LOGIN
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const accessToken = generateAccessToken(user._id);
    const refreshToken = generateRefreshToken(user._id);

    user.refreshToken = refreshToken;
    await user.save();

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
    });

    res.status(200).json({ accessToken, userId: user._id, name: user.name });
  } catch (err) {
    next(err);
  }
};

// REFRESH
const refresh = async (req, res, next) => {
  try {
    const token = req.cookies.refreshToken;
    if (!token) return res.status(401).json({ error: "No refresh token" });

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.userId);

    if (!user || user.refreshToken !== token) {
      return res.status(403).json({ error: "Invalid refresh token" });
    }

    const newAccessToken = generateAccessToken(user._id);

    // Rotate the refresh token on every use. Without this the presented token
    // stayed valid for its full 7 days, so a leaked one remained usable
    // indefinitely even after the real user refreshed. Invalidating the old one
    // means a stolen token stops working the moment the legitimate user next
    // refreshes.
    const newRefreshToken = generateRefreshToken(user._id);
    user.refreshToken = newRefreshToken;
    await user.save();

    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      accessToken: newAccessToken,
      userId: user._id,
      name: user.name,
    });

  } catch (err) {
    // Only a token problem is a 403. Anything else (a database failure, a bug)
    // must reach the central error handler, otherwise a real fault is reported
    // to the user as "invalid token" and stays invisible.
    if (err.name === "JsonWebTokenError" || err.name === "TokenExpiredError") {
      return res.status(403).json({ error: "Invalid or expired refresh token" });
    }
    next(err);
  }
};

// LOGOUT
const logout = async (req, res, next) => {
  try {
    const token = req.cookies.refreshToken;
    if (token) {
      await User.findOneAndUpdate({ refreshToken: token }, { refreshToken: null });
    }
    res.clearCookie("refreshToken");
    res.status(200).json({ message: "Logged out" });
  } catch (err) {
    next(err);
  }
};

// FORGOT PASSWORD
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });

    // Always return the same message whether the email exists or not.
    // Returning "email not found" would let anyone enumerate registered addresses.
    if (!user) {
      return res.status(200).json({ message: "If that email is registered, a reset link has been sent" });
    }

    // Generate a cryptographically random token
    const resetToken = crypto.randomBytes(32).toString("hex");
    // Hash the token before storing — if the DB is compromised, the raw tokens
    // are not exposed (same principle as password hashing).
    const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");

    user.passwordResetToken = hashedToken;
    user.passwordResetExpires = Date.now() + 15 * 60 * 1000; // 15 minutes
    await user.save();

    // In production, send an email with the reset link. In development, return
    // the token so the flow can be tested without an email server.
    if (process.env.NODE_ENV === "production") {
      // TODO: send email with reset link containing the plain resetToken
      console.log(`Password reset token for ${email}: ${resetToken}`);
    } else {
      console.log(`Password reset token for ${email}: ${resetToken}`);
    }

    res.status(200).json({
      message: "If that email is registered, a reset link has been sent",
      // Only expose the token in non-production environments for testing
      ...(process.env.NODE_ENV !== "production" && { devToken: resetToken }),
    });
  } catch (err) {
    next(err);
  }
};

// RESET PASSWORD
const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;

    // Hash the provided token to compare against the stored hash
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ error: "Invalid or expired reset token" });
    }

    // Hash the new password and clear the reset fields
    user.password = await bcrypt.hash(newPassword, 10);
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    res.status(200).json({ message: "Password reset successful" });
  } catch (err) {
    next(err);
  }
};

module.exports = { signup, login, refresh, logout, forgotPassword, resetPassword };