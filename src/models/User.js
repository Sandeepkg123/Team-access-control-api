const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true }, // will store HASHED password, never plain
  refreshToken: { type: String }, // stores current valid refresh token
}, { timestamps: true });

module.exports = mongoose.model("User", userSchema);