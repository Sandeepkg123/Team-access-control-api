const express = require("express");
const router = express.Router();
const { signupValidator, loginValidator, forgotPasswordValidator, resetPasswordValidator } = require("../validators/authValidators");
const validate = require("../middleware/validate");
const { signup, login, refresh, logout, forgotPassword, resetPassword } = require("../controllers/authController");
const { loginLimiter, signupLimiter, refreshLimiter, forgotPasswordLimiter } = require("../middleware/rateLimiter");

router.post("/signup", signupLimiter, signupValidator, validate, signup);
router.post("/login", loginLimiter, loginValidator, validate, login);
router.post("/refresh", refreshLimiter, refresh);
router.post("/logout", logout);
router.post("/forgot-password", forgotPasswordLimiter, forgotPasswordValidator, validate, forgotPassword);
router.post("/reset-password", resetPasswordValidator, validate, resetPassword);

module.exports = router;