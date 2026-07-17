const express = require("express");
const router = express.Router();
const { signupValidator, loginValidator } = require("../validators/authValidators");
const validate = require("../middleware/validate");
const { signup, login, refresh, logout } = require("../controllers/authController");
const {loginLimiter} = require("../middleware/rateLimiter");

router.post("/signup", signupValidator, validate, signup);
router.post("/login",loginLimiter, loginValidator, validate, login);
router.post("/refresh", refresh);
router.post("/logout", logout);

module.exports = router;