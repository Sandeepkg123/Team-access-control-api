const express = require("express");
const router = express.Router();
const { signupValidator, loginValidator } = require("../validators/authValidators");
const validate = require("../middleware/validate");
const { signup, login, refresh, logout } = require("../controllers/authController");
const { loginLimiter, signupLimiter, refreshLimiter } = require("../middleware/rateLimiter");

router.post("/signup", signupLimiter, signupValidator, validate, signup);
router.post("/login", loginLimiter, loginValidator, validate, login);
router.post("/refresh", refreshLimiter, refresh);
router.post("/logout", logout);

module.exports = router;