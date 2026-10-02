const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const generateAccessToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: process.env.ACCESS_TOKEN_EXPIRY, // "15m"
  });
};

// The jti (JWT ID) makes each refresh token unique. Without it the payload was
// identical for every token minted within the same second — jwt.sign defaults
// iat to whole seconds — so rotating a refresh token produced a byte-identical
// string and the "new" token was indistinguishable from the consumed one.
const generateRefreshToken = (userId) => {
  return jwt.sign(
    { userId, jti: crypto.randomUUID() },
    process.env.JWT_REFRESH_SECRET,
    {
      expiresIn: process.env.REFRESH_TOKEN_EXPIRY, // "7d"
    }
  );
};

module.exports = { generateAccessToken, generateRefreshToken };